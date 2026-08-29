import type {
  ObserveRuntimeContainedTurnOutcome,
  RuntimeContainedTurnView,
  RuntimeContainedTurnAccess,
  SubmitRuntimeContainedTurnInput,
  SubmitRuntimeContainedTurnOutcome,
} from "../contracts/runtime-access.js";
import { raceWithAbort } from "./runtime-access-lifecycle.js";

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

const copyProviderIdentity = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 && value.length <= MAX_PROVIDER_IDENTITY_LENGTH
    ? value
    : undefined;

const mapContainedTurnView = (turn: OwnerTurnObservation): RuntimeContainedTurnView | undefined => {
  try {
    const provider = copyProviderIdentity(turn.provider);
    if (provider === undefined) {
      return;
    }
    return Object.freeze({
      ...(turn.artifactManifestRef === undefined ? {} : { artifactManifestRef: turn.artifactManifestRef }),
      commandId: turn.commandId,
      effectId: turn.effectId,
      operationId: turn.operationId,
      output: Object.freeze(turn.output.map(chunk => Object.freeze({
        cursor: chunk.cursor,
        kind: chunk.kind,
        text: chunk.text,
      }))),
      provider,
      ...(turn.resultRef === undefined ? {} : { resultRef: turn.resultRef }),
      status: turn.status,
    });
  } catch {
    return;
  }
};

const copyObservation = (
  outcome: OwnerObservationOutcome,
): ObserveRuntimeContainedTurnOutcome => {
  if (outcome.status === "not_found") {
    return Object.freeze({ status: "not_found" as const });
  }
  const turn = mapContainedTurnView(outcome.turn);
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

const mapBeforeAcceptance = (
  outcome: OwnerSubmitOutcome,
): SubmitRuntimeContainedTurnOutcome => {
  if (outcome.status === "observed") {
    return Object.freeze({ operationId: outcome.turn.operationId, status: "accepted" as const });
  }
  if (outcome.status === "denied") {
    return Object.freeze({ status: "denied" as const });
  }
  return outcome.status === "conflict"
    ? Object.freeze({ code: outcome.code, status: "conflict" as const })
    : Object.freeze({ code: outcome.code, status: "unsupported" as const });
};

export interface ContainedTurnRuntimeAccessDependencies {
  readonly assertActive: () => void;
  readonly capability: ContainedTurnCapabilityBundle | undefined;
  readonly hostSignal: AbortSignal;
  readonly isDisposed: () => boolean;
  readonly onAccepted: (operation: ContainedTurnCompositionOperationRef) => void;
  readonly onSettled: (operationId: string) => void;
  readonly requestCancellation: (operation: ContainedTurnCompositionOperationRef) => Promise<unknown>;
  readonly scope: ContainedTurnCompositionScope | undefined;
  readonly trackCall: <T>(operation: Promise<T>) => Promise<T>;
}

export const createContainedTurnRuntimeAccess = (
  dependencies: ContainedTurnRuntimeAccessDependencies,
): RuntimeContainedTurnAccess => Object.freeze({
  cancel: async (
    operationId: string,
    options?: { readonly signal?: AbortSignal },
  ) => {
    dependencies.assertActive();
    if (dependencies.capability === undefined || dependencies.scope === undefined) {
      return unavailableOutcome;
    }
    const signal = options?.signal === undefined
      ? dependencies.hostSignal
      : AbortSignal.any([dependencies.hostSignal, options.signal]);
    signal.throwIfAborted();
    const operation = dependencies.capability.cancel.execute({
      operationId,
      scope: dependencies.scope,
    }, { signal });
    return copyObservation(await raceWithAbort(dependencies.trackCall(operation), signal));
  },
  observe: async (operationId: string) => {
    dependencies.assertActive();
    if (dependencies.capability === undefined || dependencies.scope === undefined) {
      return unavailableOutcome;
    }
    const outcome = await dependencies.trackCall(dependencies.capability.observe.execute({
      operationId,
      scope: dependencies.scope,
    }));
    return copyObservation(outcome);
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
      let responded = false;
      const accepted = (operation: ContainedTurnCompositionOperationRef): void => {
        dependencies.onAccepted(operation);
        if (!responded) {
          responded = true;
          resolve(Object.freeze({ operationId: operation.operationId, status: "accepted" as const }));
        }
        if (dependencies.isDisposed()) {
          void dependencies.requestCancellation(operation);
        }
      };
      const completion = dependencies.trackCall(dependencies.capability!.submit.execute({
        ...input,
        scope: dependencies.scope!,
      }, { onAccepted: accepted, signal }));
      void (async () => {
        try {
          const outcome = await completion;
          if (outcome.status === "observed") {
            dependencies.onSettled(outcome.turn.operationId);
          }
          if (!responded) {
            responded = true;
            resolve(mapBeforeAcceptance(outcome));
          }
        } catch (error) {
          if (!responded) {
            responded = true;
            reject(error);
          }
        }
      })();
    });
    return raceWithAbort(response, signal);
  },
});
