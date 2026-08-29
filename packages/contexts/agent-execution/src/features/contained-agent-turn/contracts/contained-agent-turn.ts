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
    options?: { readonly signal?: AbortSignal },
  ): Promise<SubmitContainedTurnOutcome>;
}

export interface ObserveContainedTurn {
  execute(operationId: string): Promise<ObserveContainedTurnOutcome>;
}

export interface RequestContainedTurnCancellation {
  execute(
    operationId: string,
    options?: { readonly signal?: AbortSignal },
  ): Promise<RequestContainedTurnCancellationOutcome>;
}

export interface ContainedTurnFeatureApi {
  readonly cancel: RequestContainedTurnCancellation;
  readonly observe: ObserveContainedTurn;
  readonly submit: SubmitContainedTurn;
}
