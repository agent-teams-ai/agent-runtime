// oxlint-disable max-lines -- this anti-corruption boundary keeps owner snapshots and validation colocated.
import type {
  ObserveRuntimeContainedTurnOutcome,
  RuntimeContainedTurnView,
  RuntimeContainedTurnAccess,
  SubmitRuntimeContainedTurnInput,
  SubmitRuntimeContainedTurnOutcome,
} from "../contracts/runtime-access.js";
import { raceWithAbort } from "./runtime-access-lifecycle.js";
import { ContainedTurnOwnerContractError } from "./agent-runtime-host-disposal.js";

export interface ContainedTurnCompositionScope {
  readonly projectId: string;
  readonly tenantId: string;
}

interface ContainedTurnCompositionOperationRef {
  readonly operationId: string;
  readonly scope: ContainedTurnCompositionScope;
}

interface OwnerTurnObservation {
  readonly artifactManifestRef?: string;
  readonly commandId: string;
  readonly effectId: string;
  readonly operationId: string;
  readonly output: readonly {
    readonly cursor: number;
    readonly kind: "assistant" | "diagnostic" | "progress";
    readonly text: string;
  }[];
  readonly provider: string;
  readonly resultRef?: string;
  readonly status: "accepted" | "cancelled" | "failed" | "reconcile_required" | "running" | "succeeded";
}

interface OwnerSubmitObservation {
  readonly operationId: string;
  readonly status: OwnerTurnObservation["status"];
}

type OwnerObservationOutcome =
  | { readonly status: "not_found" }
  | { readonly status: "observed"; readonly turn: OwnerTurnObservation };

type OwnerSubmitOutcome =
  | { readonly code: "command_fingerprint_conflict"; readonly status: "conflict" }
  | { readonly code: "mode_unsupported" | "provider_mismatch" | "provider_unsupported"; readonly status: "unsupported" }
  | { readonly status: "denied" }
  | { readonly status: "observed"; readonly turn: OwnerSubmitObservation };

export interface ContainedTurnCapabilityBundle {
  readonly cancel: {
    execute(
      input: ContainedTurnCompositionOperationRef,
      options?: { readonly signal?: AbortSignal },
    ): Promise<OwnerObservationOutcome>;
  };
  readonly observe: {
    execute(input: ContainedTurnCompositionOperationRef): Promise<OwnerObservationOutcome>;
  };
  readonly submit: {
    execute(
      input: {
        readonly commandId: string;
        readonly expectedProvider: string;
        readonly intent: {
          readonly mode: "analysis" | "workspace-write";
          readonly prompt: string;
        };
        readonly scope: ContainedTurnCompositionScope;
      },
      options?: {
        readonly onAccepted?: (operation: ContainedTurnCompositionOperationRef) => void;
        readonly signal?: AbortSignal;
      },
    ): Promise<OwnerSubmitOutcome>;
  };
}

const unavailableOutcome = Object.freeze({
  code: "capability_unavailable" as const,
  status: "unsupported" as const,
});

const providerUnsupportedOutcome = Object.freeze({
  code: "provider_unsupported" as const,
  status: "unsupported" as const,
});

const MAX_PROVIDER_IDENTITY_LENGTH = 128;
const MAX_OWNER_IDENTITY_LENGTH = 512;
const MAX_OUTPUT_CHUNKS = 10_000;
const MAX_OUTPUT_TEXT_LENGTH = 1_000_000;

const isBoundedIdentity = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= MAX_OWNER_IDENTITY_LENGTH &&
  // oxlint-disable-next-line no-control-regex -- the owner identity contract excludes exact C0/C1 ranges.
  value.isWellFormed() && !/\s/u.test(value) && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);

const isTurnStatus = (value: unknown): value is OwnerTurnObservation["status"] =>
  value === "accepted" || value === "cancelled" || value === "failed" ||
  value === "reconcile_required" || value === "running" || value === "succeeded";

const contractViolation = (
  code: ConstructorParameters<typeof ContainedTurnOwnerContractError>[0],
): never => {throw new ContainedTurnOwnerContractError(code);};

const copyProviderIdentity = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 && value.length <= MAX_PROVIDER_IDENTITY_LENGTH &&
    // oxlint-disable-next-line no-control-regex -- the owner identity contract excludes exact C0/C1 ranges.
    value.isWellFormed() && !/[\u0000-\u001f\u007f-\u009f]/u.test(value)
    ? value
    : undefined;

interface OwnerOutputChunkSnapshot {
  readonly cursor: unknown;
  readonly kind: unknown;
  readonly text: unknown;
}

interface OwnerTurnSnapshot {
  readonly artifactManifestRef: unknown;
  readonly commandId: unknown;
  readonly effectId: unknown;
  readonly operationId: unknown;
  readonly output: readonly (OwnerOutputChunkSnapshot | undefined)[] | undefined;
  readonly provider: unknown;
  readonly resultRef: unknown;
  readonly status: unknown;
}

type OwnerSnapshot<T> =
  | Readonly<{ kind: "contract_violation" }>
  | Readonly<{ kind: "snapshot"; value: T }>;

const ownerContractViolation = Object.freeze({ kind: "contract_violation" as const });

const snapshotOwnerOutput = (
  value: unknown,
): readonly (OwnerOutputChunkSnapshot | undefined)[] | undefined => {
  if (!Array.isArray(value)) {
    return;
  }
  const length: unknown = value.length;
  if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0 ||
    length > MAX_OUTPUT_CHUNKS) {
    return;
  }
  const output: (OwnerOutputChunkSnapshot | undefined)[] = [];
  for (let index = 0; index < length; index += 1) {
    const rawChunk: unknown = value[index];
    if (typeof rawChunk !== "object" || rawChunk === null) {
      output.push(undefined);
      continue;
    }
    const chunk = rawChunk as Readonly<Record<string, unknown>>;
    const cursor = chunk.cursor;
    const kind = chunk.kind;
    const text = chunk.text;
    output.push(Object.freeze({ cursor, kind, text }));
  }
  return Object.freeze(output);
};

const snapshotOwnerTurn = (value: unknown): OwnerTurnSnapshot | undefined => {
  if (typeof value !== "object" || value === null) {
    return;
  }
  const turn = value as Readonly<Record<string, unknown>>;
  return Object.freeze({
    artifactManifestRef: turn.artifactManifestRef,
    commandId: turn.commandId,
    effectId: turn.effectId,
    operationId: turn.operationId,
    output: snapshotOwnerOutput(turn.output),
    provider: turn.provider,
    resultRef: turn.resultRef,
    status: turn.status,
  });
};

interface OwnerObservationOutcomeSnapshot {
  readonly status: unknown;
  readonly turn: OwnerTurnSnapshot | undefined;
}

const snapshotOwnerObservationOutcome = (
  outcome: unknown,
): OwnerSnapshot<OwnerObservationOutcomeSnapshot> => {
  try {
    if (typeof outcome !== "object" || outcome === null) {
      return ownerContractViolation;
    }
    const record = outcome as Readonly<Record<string, unknown>>;
    const status = record.status;
    const rawTurn = record.turn;
    return Object.freeze({
      kind: "snapshot" as const,
      value: Object.freeze({ status, turn: snapshotOwnerTurn(rawTurn) }),
    });
  } catch {
    return ownerContractViolation;
  }
};

// oxlint-disable-next-line complexity -- this anti-corruption boundary validates every detached DTO field.
const mapContainedTurnView = (
  turn: OwnerTurnSnapshot,
  expectedOperationId?: string,
): RuntimeContainedTurnView | undefined => {
  const {
    artifactManifestRef, commandId, effectId, operationId, output: ownerOutput,
    provider: ownerProvider, resultRef, status,
  } = turn;
  if (!isBoundedIdentity(operationId)) {
    return contractViolation("invalid_operation_id");
  }
  if (!isBoundedIdentity(commandId) || !isBoundedIdentity(effectId)) {
    return;
  }
  if (expectedOperationId !== undefined && operationId !== expectedOperationId) {
    return contractViolation("operation_id_mismatch");
  }
  const provider = copyProviderIdentity(ownerProvider);
  if (provider === undefined || !isTurnStatus(status) || ownerOutput === undefined) {
    return;
  }
  if ((artifactManifestRef !== undefined && !isBoundedIdentity(artifactManifestRef)) ||
    (resultRef !== undefined && !isBoundedIdentity(resultRef))) {
    return;
  }
  const output: RuntimeContainedTurnView["output"][number][] = [];
  let previousCursor = -1;
  for (const chunk of ownerOutput) {
    const cursor = chunk?.cursor;
    const kind = chunk?.kind;
    const text = chunk?.text;
    if (typeof cursor !== "number" || !Number.isSafeInteger(cursor) || cursor <= previousCursor ||
      (kind !== "assistant" && kind !== "diagnostic" && kind !== "progress") ||
      typeof text !== "string" || text.length > MAX_OUTPUT_TEXT_LENGTH || !text.isWellFormed()) {
      return;
    }
    previousCursor = cursor;
    output.push(Object.freeze({ cursor, kind, text }));
  }
  return Object.freeze({
    ...(artifactManifestRef === undefined ? {} : { artifactManifestRef }),
    commandId,
    effectId,
    operationId,
    output: Object.freeze(output),
    provider,
    ...(resultRef === undefined ? {} : { resultRef }),
    status,
  });
};

const copyObservation = (
  outcome: OwnerObservationOutcome,
  expectedOperationId: string,
): ObserveRuntimeContainedTurnOutcome => {
  const snapshot = snapshotOwnerObservationOutcome(outcome);
  if (snapshot.kind === "contract_violation") {
    return contractViolation("malformed_owner_outcome");
  }
  if (snapshot.value.status === "not_found") {
    return Object.freeze({ status: "not_found" as const });
  }
  if (snapshot.value.status !== "observed" || snapshot.value.turn === undefined) {
    return contractViolation("malformed_owner_outcome");
  }
  const turn = mapContainedTurnView(snapshot.value.turn, expectedOperationId);
  return turn === undefined
    ? unavailableOutcome
    : Object.freeze({ status: "observed" as const, turn });
};

const copyInput = (input: SubmitRuntimeContainedTurnInput): SubmitRuntimeContainedTurnInput | undefined => {
  try {
    const expectedProvider = copyProviderIdentity(input.expectedProvider);
    if (expectedProvider === undefined) {
      return;
    }
    const intent = input.intent;
    return Object.freeze({
      commandId: input.commandId,
      expectedProvider,
      intent: Object.freeze({ mode: intent.mode, prompt: intent.prompt }),
    });
  } catch {
    return;
  }
};

const copyAcceptedOperation = (
  operation: ContainedTurnCompositionOperationRef,
  boundScope: ContainedTurnCompositionScope,
): ContainedTurnCompositionOperationRef => {
  let snapshot: OwnerSnapshot<unknown>;
  try {
    snapshot = Object.freeze({ kind: "snapshot", value: operation.operationId });
  } catch {
    snapshot = ownerContractViolation;
  }
  if (snapshot.kind === "contract_violation") {
    return contractViolation("malformed_owner_outcome");
  }
  if (!isBoundedIdentity(snapshot.value)) {
    return contractViolation("invalid_operation_id");
  }
  return Object.freeze({
    operationId: snapshot.value,
    scope: Object.freeze({ ...boundScope }),
  });
};

const isTerminalTurnStatus = (status: OwnerTurnObservation["status"]): boolean =>
  status === "cancelled" || status === "failed" || status === "succeeded";

interface CopiedSubmitOutcome {
  readonly observation?: OwnerSubmitObservation;
  readonly outcome: SubmitRuntimeContainedTurnOutcome;
}

interface OwnerSubmitOutcomeSnapshot {
  readonly code: unknown;
  readonly status: unknown;
  readonly turn: Readonly<{ operationId: unknown; status: unknown }> | undefined;
}

const snapshotOwnerSubmitOutcome = (
  outcome: unknown,
): OwnerSnapshot<OwnerSubmitOutcomeSnapshot> => {
  try {
    if (typeof outcome !== "object" || outcome === null) {
      return ownerContractViolation;
    }
    const record = outcome as Readonly<Record<string, unknown>>;
    const status = record.status;
    const code = record.code;
    const rawTurn = record.turn;
    let turn: OwnerSubmitOutcomeSnapshot["turn"];
    if (typeof rawTurn === "object" && rawTurn !== null) {
      const turnRecord = rawTurn as Readonly<Record<string, unknown>>;
      turn = Object.freeze({ operationId: turnRecord.operationId, status: turnRecord.status });
    }
    return Object.freeze({
      kind: "snapshot" as const,
      value: Object.freeze({ code, status, turn }),
    });
  } catch {
    return ownerContractViolation;
  }
};

const copySubmitOutcome = (
  outcome: OwnerSubmitOutcome,
): CopiedSubmitOutcome => {
  const snapshot = snapshotOwnerSubmitOutcome(outcome);
  if (snapshot.kind === "contract_violation") {
    return contractViolation("malformed_owner_outcome");
  }
  const { code, status, turn } = snapshot.value;
  if (status === "observed") {
    if (turn === undefined) {
      return contractViolation("malformed_owner_outcome");
    }
    const { operationId, status: turnStatus } = turn;
    if (!isBoundedIdentity(operationId)) {
      return contractViolation("invalid_operation_id");
    }
    if (!isTurnStatus(turnStatus)) {
      return contractViolation("malformed_owner_outcome");
    }
    return Object.freeze({
      observation: Object.freeze({ operationId, status: turnStatus }),
      outcome: Object.freeze({ operationId, status: "accepted" as const }),
    });
  }
  if (status === "denied") {
    return Object.freeze({ outcome: Object.freeze({ status: "denied" as const }) });
  }
  if (status === "conflict" && code === "command_fingerprint_conflict") {
    return Object.freeze({ outcome: Object.freeze({ code, status: "conflict" as const }) });
  }
  if (status === "unsupported" && (code === "mode_unsupported" ||
    code === "provider_mismatch" || code === "provider_unsupported")) {
    return Object.freeze({ outcome: Object.freeze({ code, status: "unsupported" as const }) });
  }
  return contractViolation("malformed_owner_outcome");
};

export interface ContainedTurnRuntimeAccessDependencies {
  readonly assertActive: () => void;
  readonly capability: ContainedTurnCapabilityBundle | undefined;
  readonly hostSignal: AbortSignal;
  readonly isDisposed: () => boolean;
  readonly onAccepted: (
    operation: ContainedTurnCompositionOperationRef,
    ownerCall: object,
  ) => void;
  readonly onObserved: (
    operationId: string,
    status: OwnerTurnObservation["status"] | "contract_violation",
  ) => void;
  readonly requestCancellation: (operation: ContainedTurnCompositionOperationRef) => Promise<unknown>;
  readonly scope: ContainedTurnCompositionScope | undefined;
  readonly executeCall: <T>(operation: () => Promise<T>) => Promise<T>;
}

export const createContainedTurnRuntimeAccess = (
  dependencies: ContainedTurnRuntimeAccessDependencies,
): RuntimeContainedTurnAccess => Object.freeze({
  cancel: async (operationId: string, options?: { readonly signal?: AbortSignal }) => {
    dependencies.assertActive();
    if (!isBoundedIdentity(operationId)) {
      return contractViolation("invalid_operation_id");
    }
    if (dependencies.capability === undefined || dependencies.scope === undefined) {
      return unavailableOutcome;
    }
    const signal = options?.signal === undefined ? dependencies.hostSignal
      : AbortSignal.any([dependencies.hostSignal, options.signal]);
    signal.throwIfAborted();
    const outcome = copyObservation(
      await raceWithAbort(dependencies.executeCall(() => dependencies.capability!.cancel.execute({
        operationId,
        scope: dependencies.scope!,
      }, { signal })), signal),
      operationId,
    );
    if (outcome.status === "observed") {
      dependencies.onObserved(outcome.turn.operationId, outcome.turn.status);
    }
    return outcome;
  },
  observe: async (operationId: string) => {
    dependencies.assertActive();
    if (!isBoundedIdentity(operationId)) {
      return contractViolation("invalid_operation_id");
    }
    if (dependencies.capability === undefined || dependencies.scope === undefined) {
      return unavailableOutcome;
    }
    const outcome = copyObservation(
      await dependencies.executeCall(() => dependencies.capability!.observe.execute({
        operationId,
        scope: dependencies.scope!,
      })),
      operationId,
    );
    if (outcome.status === "observed") {
      dependencies.onObserved(outcome.turn.operationId, outcome.turn.status);
    }
    return outcome;
  },
  submit: async (rawInput: SubmitRuntimeContainedTurnInput, options?: { readonly signal?: AbortSignal }) => {
    dependencies.assertActive();
    const input = copyInput(rawInput);
    if (input === undefined) {
      return providerUnsupportedOutcome;
    }
    if (dependencies.capability === undefined || dependencies.scope === undefined) {
      return unavailableOutcome;
    }
    const signal = options?.signal === undefined
      ? dependencies.hostSignal
      : AbortSignal.any([dependencies.hostSignal, options.signal]);
    signal.throwIfAborted();
    const response = new Promise<SubmitRuntimeContainedTurnOutcome>((resolve, reject) => {
      const ownerCall = Object.freeze({});
      let acceptedOperationId: string | undefined;
      let acceptanceOpen = true;
      let responded = false;
      const trackAcceptedOperation = (
        rawOperation: ContainedTurnCompositionOperationRef,
        observedStatus?: OwnerTurnObservation["status"],
      ): string => {
        const operation = copyAcceptedOperation(rawOperation, dependencies.scope!);
        if (acceptedOperationId !== undefined && acceptedOperationId !== operation.operationId) {
          dependencies.onObserved(acceptedOperationId, "contract_violation");
          return contractViolation("operation_id_mismatch");
        }
        dependencies.onAccepted(operation, ownerCall);
        if (observedStatus !== undefined) {
          dependencies.onObserved(operation.operationId, observedStatus);
        }
        if (dependencies.isDisposed() &&
          (observedStatus === undefined || !isTerminalTurnStatus(observedStatus))) {
          void dependencies.requestCancellation(operation);
        }
        return operation.operationId;
      };
      const resolveAcceptance = (operationId: string): void => {
        if (acceptedOperationId !== undefined && acceptedOperationId !== operationId) {
          return contractViolation("operation_id_mismatch");
        }
        acceptedOperationId = operationId;
        if (!responded) {
          responded = true;
          resolve(Object.freeze({ operationId, status: "accepted" as const }));
        }
      };
      const accepted = (operation: ContainedTurnCompositionOperationRef): void => {
        if (!acceptanceOpen) {
          return;
        }
        const operationId = trackAcceptedOperation(operation);
        if (operationId !== undefined) {
          resolveAcceptance(operationId);
        }
      };
      let completion: Promise<OwnerSubmitOutcome>;
      try {
        completion = dependencies.executeCall(() => dependencies.capability!.submit.execute({
          ...input,
          scope: dependencies.scope!,
        }, { onAccepted: accepted, signal }));
      } catch (error) {
        acceptanceOpen = false;
        reject(error);
        return;
      }
      const handleCompletion = async (): Promise<void> => {
        try {
          const outcome = await completion;
          acceptanceOpen = false;
          const copied = copySubmitOutcome(outcome);
          if (copied.observation !== undefined) {
            if (acceptedOperationId !== undefined &&
              copied.observation.operationId !== acceptedOperationId) {
              dependencies.onObserved(acceptedOperationId, "contract_violation");
              throw new ContainedTurnOwnerContractError("operation_id_mismatch");
            }
            const operationId = trackAcceptedOperation(Object.freeze({
              operationId: copied.observation.operationId,
              scope: dependencies.scope!,
            }), copied.observation.status);
            if (acceptedOperationId === undefined) {
              resolveAcceptance(operationId);
            }
          }
          if (!responded) {
            responded = true;
            resolve(copied.outcome);
          }
        } catch (error) {
          acceptanceOpen = false;
          if (!responded) {
            responded = true;
            reject(error);
          }
        }
      };
      void handleCompletion().catch(() => {});
    });
    return raceWithAbort(response, signal);
  },
});
