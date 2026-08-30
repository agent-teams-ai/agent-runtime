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
  value.isWellFormed() && !/\s/u.test(value) && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);

const isTurnStatus = (value: unknown): value is OwnerTurnObservation["status"] =>
  value === "accepted" || value === "cancelled" || value === "failed" ||
  value === "reconcile_required" || value === "running" || value === "succeeded";

const contractViolation = (
  code: ConstructorParameters<typeof ContainedTurnOwnerContractError>[0],
): never => {throw new ContainedTurnOwnerContractError(code);};

const copyProviderIdentity = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 && value.length <= MAX_PROVIDER_IDENTITY_LENGTH &&
    value.isWellFormed() && !/[\u0000-\u001f\u007f-\u009f]/u.test(value)
    ? value
    : undefined;

const mapContainedTurnView = (
  turn: OwnerTurnObservation,
  expectedOperationId?: string,
): RuntimeContainedTurnView | undefined => {
  try {
    if (!isBoundedIdentity(turn.operationId)) {
      return contractViolation("invalid_operation_id");
    }
    if (!isBoundedIdentity(turn.commandId) || !isBoundedIdentity(turn.effectId)) {
      return;
    }
    if (expectedOperationId !== undefined && turn.operationId !== expectedOperationId) {
      return contractViolation("operation_id_mismatch");
    }
    const provider = copyProviderIdentity(turn.provider);
    if (provider === undefined || !isTurnStatus(turn.status) || !Array.isArray(turn.output) ||
      turn.output.length > MAX_OUTPUT_CHUNKS) {
      return;
    }
    const artifactManifestRef = turn.artifactManifestRef;
    const resultRef = turn.resultRef;
    if ((artifactManifestRef !== undefined && !isBoundedIdentity(artifactManifestRef)) ||
      (resultRef !== undefined && !isBoundedIdentity(resultRef))) {
      return;
    }
    let previousCursor = -1;
    for (const chunk of turn.output) {
      if (typeof chunk !== "object" || chunk === null || !Number.isSafeInteger(chunk.cursor) ||
        chunk.cursor <= previousCursor || (chunk.kind !== "assistant" && chunk.kind !== "diagnostic" &&
          chunk.kind !== "progress") || typeof chunk.text !== "string" ||
        chunk.text.length > MAX_OUTPUT_TEXT_LENGTH || !chunk.text.isWellFormed()) {
        return;
      }
      previousCursor = chunk.cursor;
    }
    const output = turn.output.map(chunk => Object.freeze({
      cursor: chunk.cursor,
      kind: chunk.kind,
      text: chunk.text,
    }));
    return Object.freeze({
      ...(artifactManifestRef === undefined ? {} : { artifactManifestRef }),
      commandId: turn.commandId,
      effectId: turn.effectId,
      operationId: turn.operationId,
      output: Object.freeze(output),
      provider,
      ...(resultRef === undefined ? {} : { resultRef }),
      status: turn.status,
    });
  } catch (error) {
    if (error instanceof ContainedTurnOwnerContractError) {
      throw error;
    }
    return;
  }
};

const copyObservation = (
  outcome: OwnerObservationOutcome,
  expectedOperationId: string,
): ObserveRuntimeContainedTurnOutcome => {
  try {
    if (typeof outcome !== "object" || outcome === null) {
      return contractViolation("malformed_owner_outcome");
    }
    if (outcome.status === "not_found") {
      return Object.freeze({ status: "not_found" as const });
    }
    const turn = mapContainedTurnView(outcome.turn, expectedOperationId);
    return turn === undefined
      ? unavailableOutcome
      : Object.freeze({ status: "observed" as const, turn });
  } catch (error) {
    if (error instanceof ContainedTurnOwnerContractError) {
      throw error;
    }
    return contractViolation("malformed_owner_outcome");
  }
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
  try {
    const operationId: unknown = operation.operationId;
    if (!isBoundedIdentity(operationId)) {
      return contractViolation("invalid_operation_id");
    }
    return Object.freeze({
      operationId,
      scope: Object.freeze({ ...boundScope }),
    });
  } catch (error) {
    if (error instanceof ContainedTurnOwnerContractError) {
      throw error;
    }
    return contractViolation("malformed_owner_outcome");
  }
};

const isTerminalTurnStatus = (status: OwnerTurnObservation["status"]): boolean =>
  status === "cancelled" || status === "failed" || status === "succeeded";

interface CopiedSubmitOutcome {
  readonly observation?: OwnerSubmitObservation;
  readonly outcome: SubmitRuntimeContainedTurnOutcome;
}

const copySubmitOutcome = (
  outcome: OwnerSubmitOutcome,
): CopiedSubmitOutcome => {
  try {
    if (typeof outcome !== "object" || outcome === null) {
      return contractViolation("malformed_owner_outcome");
    }
    const record = outcome as Readonly<Record<string, unknown>>;
    const status = record.status;
    if (status === "observed") {
      const turn = record.turn;
      if (typeof turn !== "object" || turn === null) {
        return contractViolation("malformed_owner_outcome");
      }
      const turnRecord = turn as Readonly<Record<string, unknown>>;
      const operationId = turnRecord.operationId;
      const turnStatus = turnRecord.status;
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
    const code = record.code;
    if (status === "conflict" && code === "command_fingerprint_conflict") {
      return Object.freeze({ outcome: Object.freeze({ code, status: "conflict" as const }) });
    }
    if (status === "unsupported" && (code === "mode_unsupported" ||
      code === "provider_mismatch" || code === "provider_unsupported")) {
      return Object.freeze({ outcome: Object.freeze({ code, status: "unsupported" as const }) });
    }
    return contractViolation("malformed_owner_outcome");
  } catch (error) {
    if (error instanceof ContainedTurnOwnerContractError) {
      throw error;
    }
    return contractViolation("malformed_owner_outcome");
  }
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
  cancel: async (
    operationId: string,
    options?: { readonly signal?: AbortSignal },
  ) => {
    dependencies.assertActive();
    if (!isBoundedIdentity(operationId)) {
      return contractViolation("invalid_operation_id");
    }
    if (dependencies.capability === undefined || dependencies.scope === undefined) {
      return unavailableOutcome;
    }
    const signal = options?.signal === undefined
      ? dependencies.hostSignal
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
  submit: async (
    rawInput: SubmitRuntimeContainedTurnInput,
    options?: { readonly signal?: AbortSignal },
  ) => {
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
