import type { CredentialRenderingBinding, CredentialRenderingOwner, CredentialRenderingSelection,
  OperationCredentialMaterialAdmission } from "./credential-rendering-contracts.js";

/** Credential rendering for exactly one operation: the renderer plus the two control actions the ordinary owner may use. */
export interface OrdinaryPaOperationMaterialization {
  readonly owner: Readonly<CredentialRenderingOwner>;
  readonly control: Readonly<{
    replaceBinding(binding: CredentialRenderingBinding, expectedHeadVersion: number): Promise<number | undefined>;
    readonly materialAdmission?: OperationCredentialMaterialAdmission;
  }>;
}
/**
 * Per-operation materialization seam, kept apart from the grant store while the contained-turn
 * materialization tables stay shared. The caller disposes `owner` once the operation is retired.
 */
export interface OrdinaryPaMaterializationStores {
  forOperation(selection: CredentialRenderingSelection): OrdinaryPaOperationMaterialization;
}
