import { setTimeout as delay } from "node:timers/promises";

import type {
  ContainedTurnCapabilityBundle,
  ContainedTurnCompositionScope,
} from "./contained-turn-runtime-access.js";

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
  public readonly status: AgentRuntimeHostDisposalStatus;

  public constructor(
    activeCallCount: number,
    status: AgentRuntimeHostDisposalStatus = "disposal_incomplete",
    containedTurns: readonly AgentRuntimeHostContainedTurnDisposalIssue[] = [],
  ) {
    super(status === "disposal_incomplete"
      ? "Agent Runtime Host disposal deadline elapsed with active calls"
      : "Agent Runtime Host disposal could not prove contained-turn termination");
    this.name = "AgentRuntimeHostDisposalIncompleteError";
    this.activeCallCount = activeCallCount;
    this.containedTurns = Object.freeze(containedTurns.map(issue => Object.freeze({
      operationId: issue.operationId,
      status: issue.status,
    })));
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

const settleActiveCalls = async (activeCalls: ReadonlySet<Promise<unknown>>): Promise<void> => {
  while (activeCalls.size > 0) {
    await Promise.allSettled(activeCalls);
  }
};

const rejectAtDisposalDeadline = async (
  activeCalls: ReadonlySet<Promise<unknown>>,
  containedTurns: () => readonly AgentRuntimeHostContainedTurnDisposalIssue[],
): Promise<never> => {
  await delay(1_000, null, { ref: false });
  throw new AgentRuntimeHostDisposalIncompleteError(
    activeCalls.size,
    "disposal_incomplete",
    containedTurns(),
  );
};

export const createAgentRuntimeHostDisposalLifecycle = (
  containedTurn: ContainedTurnCapabilityBundle | undefined,
): AgentRuntimeHostDisposalLifecycle => {
  const hostAbort = new AbortController();
  const activeCalls = new Set<Promise<unknown>>();
  const activeContainedTurns = new Map<string, ActiveContainedTurn>();
  const operationOwners = new Map<string, object>();
  const shutdownCancellations = new Map<string, Promise<unknown>>();
  let disposed = false;
  let disposal: Promise<void> | undefined;

  const executeCall = <T>(operation: () => Promise<T>): Promise<T> => {
    let resolveCall!: (value: T | PromiseLike<T>) => void;
    let rejectCall!: (reason: unknown) => void;
    const executingCall = new Promise<T>((resolve, reject) => {
      resolveCall = resolve;
      rejectCall = reject;
    });
    activeCalls.add(executingCall);
    void executingCall.finally(() => activeCalls.delete(executingCall)).catch(() => {});
    try {
      Promise.resolve(operation()).then(resolveCall, rejectCall);
    } catch (error) {
      rejectCall(error);
    }
    return executingCall;
  };

  const containedTurnDisposalIssues = (): readonly AgentRuntimeHostContainedTurnDisposalIssue[] =>
    [...activeContainedTurns.values()]
      .map(active => Object.freeze({
        operationId: active.operation.operationId,
        status: active.status,
      }))
      .toSorted((left, right) => {
        const leftPoints = [...left.operationId].map(point => point.codePointAt(0)!);
        const rightPoints = [...right.operationId].map(point => point.codePointAt(0)!);
        for (let index = 0; index < Math.min(leftPoints.length, rightPoints.length); index += 1) {
          if (leftPoints[index] !== rightPoints[index]) {
            return leftPoints[index]! - rightPoints[index]!;
          }
        }
        return leftPoints.length - rightPoints.length;
      });

  const registerContainedTurn = (operation: ContainedTurnOperation, ownerCall: object): void => {
    const knownOwner = operationOwners.get(operation.operationId);
    const existing = activeContainedTurns.get(operation.operationId);
    if (knownOwner === ownerCall) {
      return;
    }
    if (knownOwner !== undefined) {
      activeContainedTurns.set(operation.operationId, Object.freeze(existing === undefined ? {
        operation: Object.freeze({
          operationId: operation.operationId,
          scope: Object.freeze({ ...operation.scope }),
        }),
        ownerCall: knownOwner,
        status: "contract_violation",
      } : { ...existing, status: "contract_violation" }));
      throw new ContainedTurnOwnerContractError("duplicate_operation_id");
    }
    operationOwners.set(operation.operationId, ownerCall);
    activeContainedTurns.set(operation.operationId, Object.freeze({
      operation: Object.freeze({
        operationId: operation.operationId,
        scope: Object.freeze({ ...operation.scope }),
      }),
      ownerCall,
      status: "accepted",
    }));
  };

  const recordContainedTurnStatus = (
    operationId: string,
    status: AgentRuntimeHostContainedTurnStatus,
  ): void => {
    const active = activeContainedTurns.get(operationId);
    if (active === undefined) {
      return;
    }
    if (active.status === "contract_violation") {
      return;
    }
    if (isTerminalContainedTurnStatus(status)) {
      activeContainedTurns.delete(operationId);
      return;
    }
    if (status === "accepted" || status === "contract_violation" || status === "running" ||
      status === "reconcile_required") {
      activeContainedTurns.set(operationId, Object.freeze({
        operation: active.operation,
        ownerCall: active.ownerCall,
        status,
      }));
    }
  };

  const recordCancellationFailure = (
    operationId: string,
    status: "cancellation_failed" | "not_found" | "operation_mismatch",
  ): void => {
    const active = activeContainedTurns.get(operationId);
    if (active !== undefined && active.status !== "contract_violation") {
      activeContainedTurns.set(operationId, Object.freeze({
        operation: active.operation,
        ownerCall: active.ownerCall,
        status,
      }));
    }
  };

  const requestContainedTurnCancellation = (operation: ContainedTurnOperation): Promise<unknown> => {
    const existing = shutdownCancellations.get(operation.operationId);
    if (existing !== undefined) {
      return existing;
    }
    if (containedTurn === undefined) {
      recordCancellationFailure(operation.operationId, "cancellation_failed");
      const unavailable = Promise.resolve();
      shutdownCancellations.set(operation.operationId, unavailable);
      return unavailable;
    }
    let resolveCancellation!: (value: unknown) => void;
    let rejectCancellation!: (reason: unknown) => void;
    const cancellation = new Promise<unknown>((resolve, reject) => {
      resolveCancellation = resolve;
      rejectCancellation = reject;
    });
    shutdownCancellations.set(operation.operationId, cancellation);
    void cancellation.catch(() => {});
    const execution = executeCall(async () => {
      try {
        const outcome = await containedTurn.cancel.execute(operation);
        if (outcome.status === "not_found") {
          recordCancellationFailure(operation.operationId, "not_found");
        } else if (outcome.turn.operationId !== operation.operationId) {
          recordCancellationFailure(operation.operationId, "operation_mismatch");
        } else {
          recordContainedTurnStatus(operation.operationId, outcome.turn.status);
        }
        return outcome;
      } catch (error) {
        recordCancellationFailure(operation.operationId, "cancellation_failed");
        throw error;
      }
    });
    void execution.then(resolveCancellation, rejectCancellation);
    return cancellation;
  };

  const finishDisposal = async (): Promise<void> => {
    await settleActiveCalls(activeCalls);
    const containedTurns = containedTurnDisposalIssues();
    if (containedTurns.length > 0) {
      throw new AgentRuntimeHostDisposalIncompleteError(
        0,
        "termination_unproven",
        containedTurns,
      );
    }
  };

  const dispose = (): Promise<void> => {
    if (disposal !== undefined) {
      return disposal;
    }
    let resolveDisposal!: () => void;
    let rejectDisposal!: (reason: unknown) => void;
    disposal = new Promise<void>((resolve, reject) => {
      resolveDisposal = resolve;
      rejectDisposal = reject;
    });
    disposed = true;
    try {
      hostAbort.abort(new DOMException("Agent Runtime Host is disposed", "AbortError"));
      for (const active of activeContainedTurns.values()) {
        void requestContainedTurnCancellation(active.operation);
      }
      void Promise.race([
        finishDisposal(),
        rejectAtDisposalDeadline(activeCalls, containedTurnDisposalIssues),
      ]).then(resolveDisposal, rejectDisposal);
    } catch (error) {
      rejectDisposal(error);
    }
    return disposal;
  };

  return Object.freeze({
    assertActive() {
      if (disposed) {
        throw new AgentRuntimeHostLifecycleError("host_disposed");
      }
    },
    dispose,
    executeCall,
    isDisposed: () => disposed,
    recordContainedTurnStatus,
    registerContainedTurn,
    requestContainedTurnCancellation,
    signal: hostAbort.signal,
  });
};
