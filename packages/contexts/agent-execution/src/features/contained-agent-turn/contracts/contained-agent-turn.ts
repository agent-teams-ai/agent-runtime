/** Opaque provider identity. Concrete support is selected by the outer adapter. */
export type ContainedTurnProvider = string;

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

/**
 * Outer adapter compatibility DTO. It is not an internal authority snapshot;
 * mapping must split Provider Access facts from adapter-owned revisions.
 */
export interface ContainedTurnProviderBindingMapping {
  readonly adapter: Readonly<{
    adapterRevision: string;
    binaryRevision: string;
    capabilityManifestRevision: string;
    provider: ContainedTurnProvider;
  }>;
  readonly providerAccess: Readonly<{
    credentialBindingDigest: string;
    providerRouteRef: string;
  }>;
}

/** Field-explicit ACL output for the consumer-owned Provider Access port. */
export interface ContainedTurnProviderAccessSnapshotMapping {
  readonly accessRef: string;
  readonly credentialBindingDigest: string;
  readonly credentialBindingRef: string;
  readonly credentialGeneration: number;
  readonly projectId: string;
  readonly provider: ContainedTurnProvider;
  readonly providerAccountRef: string;
  readonly providerRouteRef: string;
  readonly revision: number;
  readonly tenantId: string;
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

/** Field-explicit inbound mapping shape; outer DTOs are never spread into domain state. */
export interface ContainedTurnSubmitCommandMapping {
  readonly commandId: string;
  readonly mode: ContainedTurnMode;
  readonly projectId: string;
  readonly prompt: string;
  readonly provider: ContainedTurnProvider;
  readonly tenantId: string;
}

/** Field-explicit reference mapping used by both observe and cancellation commands. */
export interface ContainedTurnOperationRefMapping {
  readonly operationId: string;
  readonly projectId: string;
  readonly tenantId: string;
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

/** Field-explicit outbound projection; internal records and proof ledgers never escape. */
export interface ContainedTurnViewMapping {
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
