import type {OrdinaryBinding, OrdinaryOperation, OrdinaryReceipt, OrdinaryReceiptOf, OrdinaryAuthoritySnapshot, OrdinaryPreparation, OrdinaryOperationRef, OrdinaryInput, OrdinaryOutput} from "../domain/ordinary-model.js";

export interface OrdinaryOperationStore {
  accept(input: OrdinaryInput): Promise<{readonly kind: "accepted" | "duplicate"; readonly operation: OrdinaryOperation} | {readonly kind: "conflict"} | {readonly kind: "unknown"; readonly candidateOperationId: string; readonly evidenceId: string}>;
  prepare(operation: OrdinaryOperation, preparation: OrdinaryPreparation): Promise<OrdinaryOperation>;
  read(ref: OrdinaryOperationRef): Promise<OrdinaryOperation | undefined>;
  claim(operation: OrdinaryOperation): Promise<{readonly kind: "claimed"; readonly operation: OrdinaryOperation; readonly receipt: OrdinaryReceiptOf<"dispatch_claim">} | {readonly kind: "not_claimed" | "unknown"}>;
  cancel(ref: OrdinaryOperationRef): Promise<OrdinaryOperation | undefined>;
  append(operation: OrdinaryOperation, output: Omit<OrdinaryOutput, "cursor">): Promise<OrdinaryOperation>;
  finish(operation: OrdinaryOperation, receipts: readonly OrdinaryReceipt[]): Promise<OrdinaryOperation>;
  reconcile(operation: OrdinaryOperation, receipts: readonly OrdinaryReceipt[]): Promise<OrdinaryOperation>;
}
/** Ephemeral adapter handles. Never serialize these or spread them into operation state. */
export interface OrdinaryWorkspaceHandle {readonly workspaceId: string; readonly cwd: string; readonly homeDirectory: string}
export interface OrdinaryCredentialMaterial {readonly brokerEndpoint: string; readonly materializationId: string; readonly generation: number; readonly environment: Readonly<Record<string, string>>}
export interface OrdinaryProviderGrant {
  readonly grantId: string;
  readonly expiresAt: number;
  readonly authority: OrdinaryAuthoritySnapshot;
  materialize(workspace: OrdinaryWorkspaceHandle, signal: AbortSignal): Promise<OrdinaryCredentialMaterial>;
  retire(): Promise<OrdinaryReceiptOf<"credential_retired">>;
  settle(disposition: "claim_committed" | "abandoned_without_claim"): Promise<OrdinaryReceiptOf<"provider_grant_settled">>;
}
export interface OrdinarySecurityGrant {
  readonly grantId: string;
  readonly expiresAt: number;
  readonly authority: OrdinaryAuthoritySnapshot;
  admitOutput(output: Omit<OrdinaryOutput, "cursor">): Promise<boolean>;
  admitArtifact(snapshot: OrdinaryWorkspaceSnapshot): Promise<boolean>;
  settle(disposition: "claim_committed" | "abandoned_without_claim"): Promise<OrdinaryReceiptOf<"security_grant_settled">>;
}
export interface OrdinaryProviderAccessPort {resolveAndConsume(operation: OrdinaryOperation, signal: AbortSignal): Promise<OrdinaryProviderGrant>}
export interface OrdinarySecurityPort {resolveAndConsume(operation: OrdinaryOperation, signal: AbortSignal): Promise<OrdinarySecurityGrant>}
export interface OrdinaryWorkspaceSnapshot {readonly receipt: OrdinaryReceiptOf<"workspace_snapshot">; readonly resultBytes: Uint8Array}
export interface OrdinaryWorkspacePort {
  prepare(operation: OrdinaryOperation, signal: AbortSignal): Promise<OrdinaryWorkspaceHandle>;
  snapshot(operation: OrdinaryOperation, workspace: OrdinaryWorkspaceHandle): Promise<OrdinaryWorkspaceSnapshot>;
  close(workspace: OrdinaryWorkspaceHandle): Promise<void>;
}
export interface OrdinaryArtifactsPort {publish(operation: OrdinaryOperation, snapshot: OrdinaryWorkspaceSnapshot): Promise<OrdinaryReceiptOf<"artifact_published">>}
export interface OrdinaryTransport {
  readonly lines: AsyncIterable<string>;
  write(message: string): Promise<void>;
  closeInput(): Promise<void>;
}
export interface OrdinaryProcessReservation {
  readonly reservationId: string;
  start(claim: OrdinaryReceiptOf<"dispatch_claim">, signal: AbortSignal): Promise<OrdinaryTransport>;
  close(finalSequence: number): Promise<readonly [OrdinaryReceiptOf<"output_drain">, OrdinaryReceiptOf<"process_group_closed">] | {readonly kind: "not_started"; readonly reservationId: string}>;
}
/** Execution deadlines use performance.now(); authority expiresAt uses epoch milliseconds. */
export interface OrdinaryProcessPort {
  reserve(input: {readonly binding: OrdinaryBinding; readonly workspace: OrdinaryWorkspaceHandle; readonly credential: OrdinaryCredentialMaterial; readonly deadline: number}): Promise<OrdinaryProcessReservation>;
}
export interface OrdinaryProviderPort {
  readonly supported: {readonly provider: string; readonly mode: "workspace-write"; readonly executionProfile: "user-session-v1"; readonly capabilityManifestRevision: "ordinary-codex-macos-arm64-0.153.4-v1"};
  execute(input: {readonly operation: OrdinaryOperation; readonly transport: OrdinaryTransport; readonly workspace: OrdinaryWorkspaceHandle; readonly signal: AbortSignal; readonly deadline: number; readonly emit: (output: Omit<OrdinaryOutput, "cursor">) => Promise<void>}): Promise<OrdinaryReceiptOf<"provider_terminal">>;
}
export interface OrdinaryTurnDependencies {
  readonly operationStore: OrdinaryOperationStore;
  readonly security: OrdinarySecurityPort;
  readonly providerAccess: OrdinaryProviderAccessPort;
  readonly workspace: OrdinaryWorkspacePort;
  readonly artifacts: OrdinaryArtifactsPort;
  readonly process: OrdinaryProcessPort;
  readonly provider: OrdinaryProviderPort;
}
export const ORDINARY_DEPENDENCY_NAMES = Object.freeze(["operationStore", "security", "providerAccess", "workspace", "artifacts", "process", "provider"] as const);
