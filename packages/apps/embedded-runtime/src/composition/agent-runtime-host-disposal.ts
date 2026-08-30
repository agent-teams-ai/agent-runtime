import { setTimeout as delay } from "node:timers/promises";

import {
  CONTAINED_TURN_DISPOSAL_DIAGNOSTIC_LIMIT,
  type ContainedTurnDisposalDiagnostics,
  projectContainedTurnDisposalDiagnostics,
} from "./agent-runtime-host-disposal-diagnostics.js";
import type { ContainedTurnCompositionScope } from "./trusted-runtime-access-scope.js";
import type { ContainedTurnCapabilityBundle } from "./contained-turn-runtime-access.js";

export type AgentRuntimeHostDisposalStatus =
  | "disposal_incomplete"
  | "termination_unproven";

export type AgentRuntimeHostContainedTurnDisposalStatus =
  | "accepted"
  | "cancellation_failed"
  | "contract_violation"
  | "not_found"
  | "operation_mismatch"
  | "reconcile_required"
  | "running";

export interface AgentRuntimeHostContainedTurnDisposalIssue {
  readonly operationId: string;
  readonly status: AgentRuntimeHostContainedTurnDisposalStatus;
}

type AgentRuntimeHostContainedTurnStatus =
  | AgentRuntimeHostContainedTurnDisposalStatus
  | "cancelled"
  | "failed"
  | "succeeded";

type ContainedTurnOperation = Readonly<{
  operationId: string;
  scope: ContainedTurnCompositionScope;
}>;

interface ActiveContainedTurn {
  readonly operation: ContainedTurnOperation;
  readonly ownerCall: object;
  readonly status: AgentRuntimeHostContainedTurnDisposalStatus;
}

export interface AgentRuntimeHostDisposalLifecycle {
  readonly signal: AbortSignal;
  assertActive(): void;
  dispose(): Promise<void>;
  isDisposed(): boolean;
  recordContainedTurnStatus(
    operationId: string,
    status: AgentRuntimeHostContainedTurnStatus,
  ): void;
  registerContainedTurn(operation: ContainedTurnOperation, ownerCall: object): void;
  requestContainedTurnCancellation(operation: ContainedTurnOperation): Promise<unknown>;
  executeCall<T>(operation: () => Promise<T>): Promise<T>;
}

const isTerminalContainedTurnStatus = (
  status: AgentRuntimeHostContainedTurnStatus,
): status is "cancelled" | "failed" | "succeeded" =>
  status === "cancelled" || status === "failed" || status === "succeeded";

export class AgentRuntimeHostDisposalIncompleteError extends Error {
  public readonly activeCallCount: number;
  public readonly containedTurns: readonly AgentRuntimeHostContainedTurnDisposalIssue[];
  public readonly omittedContainedTurnCount: number;
  public readonly status: AgentRuntimeHostDisposalStatus;

  public constructor(
    activeCallCount: number,
    status: AgentRuntimeHostDisposalStatus = "disposal_incomplete",
    containedTurns: readonly AgentRuntimeHostContainedTurnDisposalIssue[] = [],
    omittedContainedTurnCount = 0,
  ) {
    super(status === "disposal_incomplete"
      ? "Agent Runtime Host disposal deadline elapsed with active calls"
      : "Agent Runtime Host disposal could not prove contained-turn termination");
    this.name = "AgentRuntimeHostDisposalIncompleteError";
    this.activeCallCount = activeCallCount;
    const projectedContainedTurns = containedTurns.slice(
      0,
      CONTAINED_TURN_DISPOSAL_DIAGNOSTIC_LIMIT,
    );
    this.containedTurns = Object.freeze(projectedContainedTurns.map(issue => Object.freeze({
      operationId: issue.operationId,
      status: issue.status,
    })));
    this.omittedContainedTurnCount = omittedContainedTurnCount +
      containedTurns.length - projectedContainedTurns.length;
    this.status = status;
    Object.freeze(this);
  }
}

export type AgentRuntimeHostLifecycleErrorCode = "host_disposed";

export class AgentRuntimeHostLifecycleError extends Error {
  public readonly code: AgentRuntimeHostLifecycleErrorCode;

  public constructor(code: AgentRuntimeHostLifecycleErrorCode) {
    super("Agent Runtime Host is disposed");
    this.name = "AgentRuntimeHostLifecycleError";
    this.code = code;
    Object.freeze(this);
  }
}

export type ContainedTurnOwnerContractErrorCode =
  | "duplicate_operation_id"
  | "invalid_operation_id"
  | "malformed_owner_outcome"
  | "owner_invocation_failed"
  | "operation_id_mismatch";

export class ContainedTurnOwnerContractError extends Error {
  public readonly code: ContainedTurnOwnerContractErrorCode;

  public constructor(code: ContainedTurnOwnerContractErrorCode) {
    super("Contained-turn owner contract violation");
    this.name = "ContainedTurnOwnerContractError";
    this.code = code;
    Object.freeze(this);
  }
}

export const containedTurnOwnerInvocationFailed =
  new ContainedTurnOwnerContractError("owner_invocation_failed");

class HostCallLedger {
  readonly #activeCalls = new Set<Promise<unknown>>();

  public readonly execute = <T>(operation: () => Promise<T>): Promise<T> => {
    let resolveCall!: (value: T | PromiseLike<T>) => void;
    let rejectCall!: (reason: unknown) => void;
    const executingCall = new Promise<T>((resolve, reject) => {
      resolveCall = resolve;
      rejectCall = reject;
    });
    this.#activeCalls.add(executingCall);
    void executingCall.finally(() => this.#activeCalls.delete(executingCall)).catch(() => {});
    try {
      Promise.resolve(operation()).then(resolveCall, rejectCall);
    } catch (error) {
      rejectCall(error);
    }
    return executingCall;
  };

  public get activeCount(): number {
    return this.#activeCalls.size;
  }

  public async settle(): Promise<void> {
    while (this.#activeCalls.size > 0) {
      await Promise.allSettled(this.#activeCalls);
    }
  }
}

type CancellationProof =
  | Readonly<{ kind: "contract_violation" }> | Readonly<{ kind: "not_found" }>
  | Readonly<{ kind: "nonterminal"; status: "accepted" | "reconcile_required" | "running" }>
  | Readonly<{ kind: "operation_mismatch" }> | Readonly<{
    kind: "terminal"; status: "cancelled" | "failed" | "succeeded";
  }>;

interface CancellationOutputChunkSnapshot {
  readonly cursor: unknown;
  readonly kind: unknown;
  readonly text: unknown;
}

interface CancellationTurnSnapshot {
  readonly artifactManifestRef: unknown;
  readonly commandId: unknown;
  readonly effectId: unknown;
  readonly operationId: unknown;
  readonly output: readonly (CancellationOutputChunkSnapshot | undefined)[] | undefined;
  readonly provider: unknown;
  readonly resultRef: unknown;
  readonly revision: unknown;
  readonly status: unknown;
}

type CancellationOutcomeSnapshot =
  | Readonly<{ kind: "contract_violation" }>
  | Readonly<{ kind: "snapshot"; status: unknown; turn: CancellationTurnSnapshot | undefined }>;

const cancellationContractViolation = Object.freeze({ kind: "contract_violation" as const });
const MAX_OWNER_IDENTITY_LENGTH = 512;
const MAX_PROVIDER_IDENTITY_LENGTH = 128;
const MAX_OUTPUT_CHUNKS = 10_000;
const MAX_OUTPUT_TEXT_LENGTH = 1_000_000;

const snapshotCancellationOutput = (
  value: unknown,
): readonly (CancellationOutputChunkSnapshot | undefined)[] | undefined => {
  if (!Array.isArray(value)) {
    return;
  }
  const length: unknown = value.length;
  if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0 ||
    length > MAX_OUTPUT_CHUNKS) {
    return;
  }
  const output: (CancellationOutputChunkSnapshot | undefined)[] = [];
  for (let index = 0; index < length; index += 1) {
    const rawChunk: unknown = value[index];
    if (typeof rawChunk !== "object" || rawChunk === null) {
      output.push(undefined);
      continue;
    }
    const chunk = rawChunk as Readonly<Record<string, unknown>>;
    output.push(Object.freeze({ cursor: chunk.cursor, kind: chunk.kind, text: chunk.text }));
  }
  return Object.freeze(output);
};

const snapshotCancellationOutcome = (rawOutcome: unknown): CancellationOutcomeSnapshot => {
  try {
    if (typeof rawOutcome !== "object" || rawOutcome === null) {
      return cancellationContractViolation;
    }
    const outcome = rawOutcome as Readonly<Record<string, unknown>>;
    const status = outcome.status;
    const rawTurn = outcome.turn;
    let turn: CancellationTurnSnapshot | undefined;
    if (typeof rawTurn === "object" && rawTurn !== null) {
      const record = rawTurn as Readonly<Record<string, unknown>>;
      turn = Object.freeze({
        artifactManifestRef: record.artifactManifestRef,
        commandId: record.commandId,
        effectId: record.effectId,
        operationId: record.operationId,
        output: snapshotCancellationOutput(record.output),
        provider: record.provider,
        resultRef: record.resultRef,
        revision: record.revision,
        status: record.status,
      });
    }
    return Object.freeze({ kind: "snapshot" as const, status, turn });
  } catch {
    return cancellationContractViolation;
  }
};

const isBoundedOwnerIdentity = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= MAX_OWNER_IDENTITY_LENGTH &&
  // oxlint-disable-next-line no-control-regex -- the owner identity contract excludes exact C0/C1 ranges.
  value.isWellFormed() && !/\s/u.test(value) && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);

const isBoundedProviderIdentity = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= MAX_PROVIDER_IDENTITY_LENGTH &&
  // oxlint-disable-next-line no-control-regex -- the owner identity contract excludes exact C0/C1 ranges.
  value.isWellFormed() && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);

type CancellationTurnStatus =
  | "accepted" | "cancelled" | "failed"
  | "reconcile_required" | "running" | "succeeded";

// oxlint-disable-next-line complexity -- terminal proof validates the complete detached owner DTO.
const validateCancellationTurn = (
  turn: CancellationTurnSnapshot,
): Readonly<{ operationId: string; status: CancellationTurnStatus }> | undefined => {
  const {
    artifactManifestRef, commandId, effectId, operationId, output, provider, resultRef, revision,
    status,
  } = turn;
  if (!isBoundedOwnerIdentity(operationId) || !isBoundedOwnerIdentity(commandId) ||
    !isBoundedOwnerIdentity(effectId) || !isBoundedProviderIdentity(provider) || output === undefined ||
    (artifactManifestRef !== undefined && !isBoundedOwnerIdentity(artifactManifestRef)) ||
    (resultRef !== undefined && !isBoundedOwnerIdentity(resultRef)) ||
    typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0 ||
    (status !== "accepted" && status !== "cancelled" && status !== "failed" &&
      status !== "reconcile_required" && status !== "running" && status !== "succeeded")) {
    return;
  }
  if (isTerminalContainedTurnStatus(status) &&
    (artifactManifestRef === undefined || resultRef === undefined)) {
    return;
  }
  let previousCursor = -1;
  for (const chunk of output) {
    const cursor = chunk?.cursor;
    const kind = chunk?.kind;
    const text = chunk?.text;
    if (typeof cursor !== "number" || !Number.isSafeInteger(cursor) || cursor <= previousCursor ||
      (kind !== "assistant" && kind !== "diagnostic" && kind !== "progress") ||
      typeof text !== "string" || text.length > MAX_OUTPUT_TEXT_LENGTH || !text.isWellFormed()) {
      return;
    }
    previousCursor = cursor;
  }
  return Object.freeze({ operationId, status });
};

const snapshotCancellationProof = (
  rawOutcome: unknown,
  expectedOperationId: string,
): CancellationProof => {
  const snapshot = snapshotCancellationOutcome(rawOutcome);
  if (snapshot.kind === "contract_violation") {
    return Object.freeze({ kind: "contract_violation" });
  }
  if (snapshot.status === "not_found") {
    return Object.freeze({ kind: "not_found" });
  }
  if (snapshot.status !== "observed" || snapshot.turn === undefined) {
    return Object.freeze({ kind: "contract_violation" });
  }
  const turn = validateCancellationTurn(snapshot.turn);
  if (turn === undefined) {
    return Object.freeze({ kind: "contract_violation" });
  }
  if (turn.operationId !== expectedOperationId) {
    return Object.freeze({ kind: "operation_mismatch" });
  }
  if (turn.status === "cancelled" || turn.status === "failed" || turn.status === "succeeded") {
    return Object.freeze({ kind: "terminal", status: turn.status });
  }
  return Object.freeze({ kind: "nonterminal", status: turn.status });
};

class ContainedTurnOwnershipLedger {
  readonly #active = new Map<string, ActiveContainedTurn>();
  readonly #cancellations = new Map<string, Promise<unknown>>();
  readonly #containedTurn: ContainedTurnCapabilityBundle | undefined;
  readonly #executeCall: HostCallLedger["execute"];
  readonly #owners = new Map<string, object>();

  public constructor(
    containedTurn: ContainedTurnCapabilityBundle | undefined,
    executeCall: HostCallLedger["execute"],
  ) {
    this.#containedTurn = containedTurn;
    this.#executeCall = executeCall;
  }

  public readonly diagnostics = (): ContainedTurnDisposalDiagnostics =>
    projectContainedTurnDisposalDiagnostics(this.#active);

  public readonly register = (operation: ContainedTurnOperation, ownerCall: object): void => {
    const knownOwner = this.#owners.get(operation.operationId);
    const existing = this.#active.get(operation.operationId);
    if (knownOwner === ownerCall) {
      return;
    }
    if (knownOwner !== undefined) {
      this.#active.set(operation.operationId, Object.freeze(existing === undefined ? {
        operation: Object.freeze({
          operationId: operation.operationId,
          scope: Object.freeze({ ...operation.scope }),
        }),
        ownerCall: knownOwner,
        status: "contract_violation",
      } : { ...existing, status: "contract_violation" }));
      throw new ContainedTurnOwnerContractError("duplicate_operation_id");
    }
    this.#owners.set(operation.operationId, ownerCall);
    this.#active.set(operation.operationId, Object.freeze({
      operation: Object.freeze({
        operationId: operation.operationId,
        scope: Object.freeze({ ...operation.scope }),
      }),
      ownerCall,
      status: "accepted",
    }));
  };

  public readonly recordStatus = (
    operationId: string,
    status: AgentRuntimeHostContainedTurnStatus,
  ): void => {
    const active = this.#active.get(operationId);
    if (active === undefined) {
      return;
    }
    if (isTerminalContainedTurnStatus(status)) {
      this.#active.delete(operationId);
      return;
    }
    if (active.status === "contract_violation") {
      return;
    }
    if (status === "accepted" || status === "contract_violation" || status === "running" ||
      status === "reconcile_required") {
      this.#active.set(operationId, Object.freeze({
        operation: active.operation,
        ownerCall: active.ownerCall,
        status,
      }));
    }
  };

  readonly #recordCancellationFailure = (
    operationId: string,
    status: "cancellation_failed" | "contract_violation" | "not_found" | "operation_mismatch",
  ): void => {
    const active = this.#active.get(operationId);
    if (active !== undefined && active.status !== "contract_violation") {
      this.#active.set(operationId, Object.freeze({
        operation: active.operation,
        ownerCall: active.ownerCall,
        status,
      }));
    }
  };

  public readonly requestCancellation = (operation: ContainedTurnOperation): Promise<unknown> => {
    const existing = this.#cancellations.get(operation.operationId);
    if (existing !== undefined) {
      return existing;
    }
    if (this.#containedTurn === undefined) {
      this.#recordCancellationFailure(operation.operationId, "cancellation_failed");
      const unavailable = Promise.resolve();
      this.#cancellations.set(operation.operationId, unavailable);
      return unavailable;
    }
    let resolveCancellation!: (value: unknown) => void;
    let rejectCancellation!: (reason: unknown) => void;
    const cancellation = new Promise<unknown>((resolve, reject) => {
      resolveCancellation = resolve;
      rejectCancellation = reject;
    });
    this.#cancellations.set(operation.operationId, cancellation);
    void cancellation.catch(() => {});
    const execution = this.#executeCall(async () => {
      let outcome: unknown;
      try {
        outcome = await this.#containedTurn!.cancel.execute(operation);
      } catch {
        this.#recordCancellationFailure(operation.operationId, "cancellation_failed");
        throw containedTurnOwnerInvocationFailed;
      }
      const proof = snapshotCancellationProof(outcome, operation.operationId);
      if (proof.kind === "terminal") {
        this.recordStatus(operation.operationId, proof.status);
      } else if (proof.kind === "nonterminal") {
        this.recordStatus(operation.operationId, proof.status);
      } else if (proof.kind === "contract_violation") {
        this.#recordCancellationFailure(operation.operationId, "contract_violation");
        throw new ContainedTurnOwnerContractError("malformed_owner_outcome");
      } else {
        this.#recordCancellationFailure(operation.operationId, proof.kind);
      }
      return proof;
    });
    void execution.then(resolveCancellation, rejectCancellation);
    return cancellation;
  };

  public requestCancellationForAll(): void {
    for (const active of this.#active.values()) {
      void this.requestCancellation(active.operation);
    }
  }
}

class HostDisposalOrchestrator {
  readonly #calls: HostCallLedger;
  readonly #containedTurns: ContainedTurnOwnershipLedger;
  readonly #hostAbort = new AbortController();
  #disposal: Promise<void> | undefined;
  #disposed = false;

  public constructor(calls: HostCallLedger, containedTurns: ContainedTurnOwnershipLedger) {
    this.#calls = calls;
    this.#containedTurns = containedTurns;
  }

  public get signal(): AbortSignal {
    return this.#hostAbort.signal;
  }

  public assertActive(): void {
    if (this.#disposed) {
      throw new AgentRuntimeHostLifecycleError("host_disposed");
    }
  }

  public readonly dispose = (): Promise<void> => {
    if (this.#disposal !== undefined) {
      return this.#disposal;
    }
    let resolveDisposal!: () => void;
    let rejectDisposal!: (reason: unknown) => void;
    this.#disposal = new Promise<void>((resolve, reject) => {
      resolveDisposal = resolve;
      rejectDisposal = reject;
    });
    this.#disposed = true;
    try {
      this.#hostAbort.abort(new DOMException("Agent Runtime Host is disposed", "AbortError"));
      this.#containedTurns.requestCancellationForAll();
      void Promise.race([
        this.#finishDisposal(),
        this.#rejectAtDeadline(),
      ]).then(resolveDisposal, rejectDisposal);
    } catch (error) {
      rejectDisposal(error);
    }
    return this.#disposal;
  };

  readonly #finishDisposal = async (): Promise<void> => {
    await this.#calls.settle();
    const { containedTurns, omittedContainedTurnCount } = this.#containedTurns.diagnostics();
    if (containedTurns.length > 0) {
      throw new AgentRuntimeHostDisposalIncompleteError(
        0,
        "termination_unproven",
        containedTurns,
        omittedContainedTurnCount,
      );
    }
  };

  readonly #rejectAtDeadline = async (): Promise<never> => {
    await delay(1_000, null, { ref: false });
    const { containedTurns, omittedContainedTurnCount } = this.#containedTurns.diagnostics();
    throw new AgentRuntimeHostDisposalIncompleteError(
      this.#calls.activeCount,
      "disposal_incomplete",
      containedTurns,
      omittedContainedTurnCount,
    );
  };

  public isDisposed(): boolean {
    return this.#disposed;
  }
}

export const createAgentRuntimeHostDisposalLifecycle = (
  containedTurn: ContainedTurnCapabilityBundle | undefined,
): AgentRuntimeHostDisposalLifecycle => {
  const calls = new HostCallLedger();
  const containedTurns = new ContainedTurnOwnershipLedger(containedTurn, calls.execute);
  const disposal = new HostDisposalOrchestrator(calls, containedTurns);
  return Object.freeze({
    assertActive: () => disposal.assertActive(),
    dispose: disposal.dispose,
    executeCall: calls.execute,
    isDisposed: () => disposal.isDisposed(),
    recordContainedTurnStatus: containedTurns.recordStatus,
    registerContainedTurn: containedTurns.register,
    requestContainedTurnCancellation: containedTurns.requestCancellation,
    signal: disposal.signal,
  });
};
