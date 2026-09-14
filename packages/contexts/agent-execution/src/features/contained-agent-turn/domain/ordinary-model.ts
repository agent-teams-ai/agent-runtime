import type {ContainedTurnScope} from "./contained-turn-authority.js";
import type {ContainedTurnKernelOutputKind} from "./contained-turn-kernel-model.js";
export interface OrdinaryInput {readonly commandId: string; readonly expectedProvider: string; readonly intent: {readonly mode: "analysis" | "workspace-write"; readonly prompt: string}; readonly scope: ContainedTurnScope}
export interface OrdinaryOutput {readonly cursor: number; readonly kind: ContainedTurnKernelOutputKind; readonly text: string}
export type OrdinaryStatus = "accepted" | "running" | "succeeded" | "failed" | "cancelled" | "reconcile_required";

export const ORDINARY_PROFILE = Object.freeze({executionProfile: "user-session-v1", effectClass: "ordinary_user_session_effect", capabilityManifestRevision: "ordinary-codex-macos-arm64-0.153.4-v1"} as const);
export interface OrdinaryBinding {
  readonly operationId: string;
  readonly attemptId: string;
  readonly executionProfile: typeof ORDINARY_PROFILE.executionProfile;
  readonly capabilityManifestRevision: typeof ORDINARY_PROFILE.capabilityManifestRevision;
}
export type OrdinaryReceipt = OrdinaryBinding & (
  | {readonly kind: "dispatch_claim"; readonly reservationId: string; readonly claimId: string; readonly committedRevision: number; readonly preparationDigest: string}
  | {readonly kind: "provider_terminal"; readonly terminalStatus: "completed" | "failed" | "cancelled"; readonly threadId: string; readonly turnId: string}
  | {readonly kind: "output_drain"; readonly finalSequence: number; readonly stdoutClosed: true; readonly stderrClosed: true}
  | {readonly kind: "process_group_closed"; readonly reservationId: string; readonly pid: number; readonly processGroupId: number; readonly ownershipToken: string; readonly exitObserved: true; readonly groupEmptyObserved: true}
  | {readonly kind: "workspace_snapshot"; readonly workspaceId: string; readonly snapshotDigest: string; readonly sourceDigest: string; readonly inventoryDigest: string; readonly stable: true}
  | {readonly kind: "artifact_published"; readonly workspaceId: string; readonly snapshotDigest: string; readonly artifactDigest: string; readonly artifactManifestRef: string; readonly resultRef: string; readonly byteLength: number}
  | {readonly kind: "credential_retired"; readonly materializationId: string; readonly generation: number; readonly retiredAt: string}
  | {readonly kind: "provider_grant_settled"; readonly grantId: string; readonly ownerReceiptId: string; readonly settlementReceiptId: string; readonly disposition: "claim_committed" | "abandoned_without_claim"}
  | {readonly kind: "security_grant_settled"; readonly grantId: string; readonly ownerReceiptId: string; readonly settlementReceiptId: string; readonly disposition: "claim_committed" | "abandoned_without_claim"}
);
export type OrdinaryReceiptOf<K extends OrdinaryReceipt["kind"]> = Extract<OrdinaryReceipt, {readonly kind: K}>;
export interface OrdinaryOperation extends OrdinaryBinding {
  readonly schemaVersion: 3;
  readonly effectClass: typeof ORDINARY_PROFILE.effectClass;
  readonly effectId: string;
  readonly commandId: string;
  readonly fingerprint: string;
  readonly scope: ContainedTurnScope;
  readonly input: OrdinaryInput;
  readonly preparation: OrdinaryPreparation | null;
  readonly revision: number;
  readonly status: OrdinaryStatus;
  readonly cancellationRequested: boolean;
  readonly output: readonly OrdinaryOutput[];
  readonly receipts: readonly OrdinaryReceipt[];
}

/** Non-secret owner facts projected by the anti-corruption layer; owner receipt remains owned there. */
export interface OrdinaryAuthoritySnapshot extends OrdinaryBinding {
  readonly owner: "provider_access" | "runtime_security";
  readonly grantId: string;
  readonly ownerReceiptId: string;
  readonly consumptionDigest: string;
  readonly consumptionRevision: number;
  readonly authorityDigest: string;
  readonly expiresAt: number;
  readonly scope: ContainedTurnScope;
  readonly provider: string;
}
export interface OrdinaryPreparation {
  readonly providerAccess: OrdinaryAuthoritySnapshot;
  readonly security: OrdinaryAuthoritySnapshot;
  readonly reservationId: string;
  readonly workspaceId: string;
  readonly materializationId: string;
  readonly credentialGeneration: number;
}

export interface OrdinaryOperationRef {readonly operationId: string; readonly scope: ContainedTurnScope}
export interface OrdinaryView {
  readonly operationId: string; readonly effectId: string; readonly commandId: string; readonly provider: string;
  readonly revision: number; readonly status: OrdinaryStatus; readonly output: readonly OrdinaryOutput[];
  readonly executionProfile: typeof ORDINARY_PROFILE.executionProfile;
  readonly effectClass: typeof ORDINARY_PROFILE.effectClass;
  readonly capabilityManifestRevision: typeof ORDINARY_PROFILE.capabilityManifestRevision;
  readonly artifactManifestRef?: string; readonly resultRef?: string;
}
