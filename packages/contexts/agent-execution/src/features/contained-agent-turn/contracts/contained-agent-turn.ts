export type ContainedTurnProvider = "claude" | "codex";

export type ContainedTurnMode = "analysis" | "workspace-write";

export interface ContainedTurnScope {
  readonly projectId: string;
  readonly tenantId: string;
}

export interface ContainedTurnProviderBinding {
  readonly adapterRevision: string;
  readonly binaryRevision: string;
  readonly capabilityManifestRevision: string;
  readonly credentialBindingDigest: string;
  readonly provider: ContainedTurnProvider;
  readonly providerRouteRef: string;
}

export interface SubmitContainedTurnInput {
  readonly commandId: string;
  readonly expectedProvider: ContainedTurnProvider;
  readonly intent: {
    readonly mode: ContainedTurnMode;
    readonly prompt: string;
  };
  readonly scope: ContainedTurnScope;
}

export interface ContainedTurnOperationRef {
  readonly operationId: string;
  readonly scope: ContainedTurnScope;
}

export interface ObserveContainedTurnInput extends ContainedTurnOperationRef {}

export interface RequestContainedTurnCancellationInput extends ContainedTurnOperationRef {}

export interface SubmitContainedTurnOptions {
  readonly onAccepted?: (operation: ContainedTurnOperationRef) => void;
  readonly signal?: AbortSignal;
}

export type ContainedTurnOutputKind = "assistant" | "diagnostic" | "progress";

export interface ContainedTurnOutputView {
  readonly cursor: number;
  readonly kind: ContainedTurnOutputKind;
  readonly text: string;
}

export type ContainedTurnStatus =
  | "accepted"
  | "cancelled"
  | "failed"
  | "reconcile_required"
  | "running"
  | "succeeded";

export interface ContainedTurnView {
  readonly artifactManifestRef?: string;
  readonly commandId: string;
  readonly effectId: string;
  readonly operationId: string;
  readonly output: readonly ContainedTurnOutputView[];
  readonly provider: ContainedTurnProvider;
  readonly resultRef?: string;
  readonly revision: number;
  readonly status: ContainedTurnStatus;
}

export type SubmitContainedTurnOutcome =
  | {
      readonly code: "command_fingerprint_conflict";
      readonly status: "conflict";
    }
  | {
      readonly code: "mode_unsupported" | "provider_mismatch" | "provider_unsupported";
      readonly status: "unsupported";
    }
  | { readonly status: "denied" }
  | {
      readonly status: "observed";
      readonly turn: ContainedTurnView;
    };

export type ObserveContainedTurnOutcome =
  | { readonly status: "not_found" }
  | { readonly status: "observed"; readonly turn: ContainedTurnView };

export type RequestContainedTurnCancellationOutcome =
  | { readonly status: "not_found" }
  | {
      readonly status: "observed";
      readonly turn: ContainedTurnView;
    };

export interface SubmitContainedTurn {
  execute(
    input: SubmitContainedTurnInput,
    options?: SubmitContainedTurnOptions,
  ): Promise<SubmitContainedTurnOutcome>;
}

export interface ObserveContainedTurn {
  execute(input: ObserveContainedTurnInput): Promise<ObserveContainedTurnOutcome>;
}

export interface RequestContainedTurnCancellation {
  execute(
    input: RequestContainedTurnCancellationInput,
    options?: { readonly signal?: AbortSignal },
  ): Promise<RequestContainedTurnCancellationOutcome>;
}

export interface ContainedTurnFeatureApi {
  readonly cancel: RequestContainedTurnCancellation;
  readonly observe: ObserveContainedTurn;
  readonly submit: SubmitContainedTurn;
}
