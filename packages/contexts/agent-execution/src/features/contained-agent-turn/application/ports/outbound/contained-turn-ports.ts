import type {
  ContainedTurnOutputKind,
  ContainedTurnProvider,
  ContainedTurnProviderBinding,
  ContainedTurnScope,
} from "../../../contracts/contained-agent-turn.js";
import type {
  ContainedTurnMutation,
  ContainedTurnOperation,
} from "../../../domain/contained-turn-operation.js";

export interface AcceptContainedTurnCommandInput {
  readonly commandId: string;
  readonly intent: ContainedTurnOperation["intent"];
  readonly providerBinding: ContainedTurnProviderBinding;
  readonly scope: ContainedTurnScope;
  readonly securityDecision: ContainedTurnOperation["securityDecision"];
}

export type AcceptContainedTurnCommandOutcome =
  | { readonly kind: "accepted"; readonly operation: ContainedTurnOperation }
  | { readonly kind: "replayed"; readonly operation: ContainedTurnOperation }
  | { readonly kind: "conflict" };

export type CompareAndSetContainedTurnOutcome =
  | { readonly kind: "applied"; readonly operation: ContainedTurnOperation }
  | { readonly kind: "not_found" }
  | { readonly current: ContainedTurnOperation; readonly kind: "stale" };

export type ClaimContainedTurnDispatchOutcome =
  | { readonly kind: "claimed"; readonly operation: ContainedTurnOperation }
  | { readonly kind: "not_found" }
  | { readonly current: ContainedTurnOperation; readonly kind: "stale" };

export interface ContainedTurnOperationStore {
  accept(input: AcceptContainedTurnCommandInput): Promise<AcceptContainedTurnCommandOutcome>;
  claimDispatch(input: {
    readonly cutoffReceiptRef: string;
    readonly expectedRevision: number;
    readonly operationId: string;
  }): Promise<ClaimContainedTurnDispatchOutcome>;
  compareAndSet(input: {
    readonly expectedRevision: number;
    readonly mutation: ContainedTurnMutation;
    readonly operationId: string;
  }): Promise<CompareAndSetContainedTurnOutcome>;
  preventDispatch(input: {
    readonly expectedRevision: number;
    readonly operationId: string;
    readonly proofRef: string;
  }): Promise<CompareAndSetContainedTurnOutcome>;
  read(operationId: string): Promise<ContainedTurnOperation | undefined>;
  requestCancellation(input: {
    readonly expectedRevision: number;
    readonly operationId: string;
  }): Promise<CompareAndSetContainedTurnOutcome>;
  terminalize(input: {
    readonly expectedRevision: number;
    readonly operationId: string;
  }): Promise<CompareAndSetContainedTurnOutcome>;
}

export interface ContainedTurnSecurityPort {
  authorize(input: {
    readonly intent: ContainedTurnOperation["intent"];
    readonly provider: ContainedTurnProvider;
    readonly scope: ContainedTurnScope;
  }): Promise<
    | { readonly kind: "allowed"; readonly authorityRevision: string; readonly decisionDigest: string }
    | { readonly kind: "denied" }
  >;
  revalidate(input: {
    readonly authorityRevision: string;
    readonly decisionDigest: string;
    readonly operationId: string;
    readonly scope: ContainedTurnScope;
  }): Promise<
    | { readonly kind: "allowed"; readonly proofRef: string }
    | { readonly kind: "prevented"; readonly proofRef: string }
  >;
}

export interface ContainedTurnWorkspacePort {
  close(workspaceRef: string): Promise<{ readonly receiptRef: string }>;
  create(input: {
    readonly operationId: string;
    readonly scope: ContainedTurnScope;
  }): Promise<{ readonly workspaceRef: string }>;
  quarantine(input: {
    readonly evidenceRef: string;
    readonly workspaceRef: string;
  }): Promise<void>;
}

export interface ContainedTurnArtifactPort {
  seal(input: {
    readonly operationId: string;
    readonly output: readonly { readonly cursor: number; readonly kind: ContainedTurnOutputKind; readonly text: string }[];
    readonly workspaceRef: string;
  }): Promise<{
    readonly manifestReceiptRef: string;
    readonly manifestRef: string;
    readonly resultReceiptRef: string;
    readonly resultRef: string;
  }>;
}

export interface ContainedTurnCustodyHandle {
  readonly custodyRef: string;
}

export interface ProviderProcessCustodyPort {
  open(input: {
    readonly attemptId: string;
    readonly operationId: string;
    readonly providerBinding: ContainedTurnProviderBinding;
    readonly workspaceRef: string;
  }): Promise<ContainedTurnCustodyHandle>;
  requestContainment(input: {
    readonly attemptId: string;
    readonly custodyRef?: string;
    readonly operationId: string;
  }): Promise<
    | { readonly kind: "contained"; readonly receiptRef: string }
    | { readonly evidenceRef: string; readonly kind: "unproven" }
  >;
}

export interface ContainedTurnAdapterCapabilityManifest {
  readonly effectClass: "contained_unmediated_effect";
  readonly providerBinding: ContainedTurnProviderBinding;
  readonly supportedModes: readonly ("analysis" | "workspace-write")[];
}

export type ContainedTurnProviderExecutionOutcome =
  | {
      readonly acceptanceReceiptRef: string;
      readonly effectDisposition: "committed" | "not_committed";
      readonly effectReceiptRef: string;
      readonly executionReceiptRef: string;
      readonly kind: "completed";
      readonly outcome: "cancelled" | "failed" | "succeeded";
      readonly outputDrainReceiptRef: string;
    }
  | {
      readonly effectReceiptRef: string;
      readonly executionReceiptRef: string;
      readonly kind: "not_accepted";
      readonly outputDrainReceiptRef: string;
      readonly providerReceiptRef: string;
    }
  | { readonly evidenceRef: string; readonly kind: "ambiguous" };

export interface ContainedTurnProviderPort {
  readonly manifest: ContainedTurnAdapterCapabilityManifest;
  execute(input: {
    readonly attemptId: string;
    readonly custody: ContainedTurnCustodyHandle;
    readonly effectId: string;
    readonly intent: ContainedTurnOperation["intent"];
    readonly operationId: string;
    readonly workspaceRef: string;
    readonly isCancellationRequested: () => Promise<boolean>;
    readonly emit: (chunk: {
      readonly cursor: number;
      readonly kind: ContainedTurnOutputKind;
      readonly text: string;
    }) => Promise<void>;
  }): Promise<ContainedTurnProviderExecutionOutcome>;
}
