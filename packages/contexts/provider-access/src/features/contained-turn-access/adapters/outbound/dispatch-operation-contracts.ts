import type { ContainedTurnProviderAccessBinding } from "../../contracts/contained-turn-provider-access.js";
import type { DispatchBindingHead, DispatchScopeValue, DispatchProvider } from "../../domain/dispatch-consumption.js";
import type { MaterializationAuthorizationBinding } from "../../application/ports/outbound/materialization-authorization-repository.js";

/** Private trusted AE acknowledgement projection. This DTO is not proof of AE COMMIT. */
export interface PaAcceptedPreparation {
  readonly operationId: string;
  readonly scope: DispatchScopeValue;
  readonly provider: DispatchProvider;
  readonly acceptedAuthorityDigest: string;
  readonly acceptanceEvidenceRef: string;
  readonly acceptedBinding: ContainedTurnProviderAccessBinding;
  readonly providerBindingDigest: string;
  readonly grantRequestId: string;
  readonly claimBindingDigest: string;
  readonly requestDigest: string;
}
/** Independently provisioned PA/operator policy; never selected from request expectations. */
export interface PaDispatchIssuanceSelection {
  readonly issuanceRef: string;
  readonly binding: MaterializationAuthorizationBinding;
  readonly materializationHeadVersion: number;
  readonly validFromControlTime: number;
  readonly claimBeforeControlTime: number;
  readonly expiresAtControlTime: number;
}
export interface PaOperationPublication {
  readonly version: 2;
  readonly prepared: PaAcceptedPreparation;
  readonly issuance: PaDispatchIssuanceSelection;
  readonly head: DispatchBindingHead;
}
export interface PaOperationOwner { readonly scope: DispatchScopeValue; readonly provider: DispatchProvider }
export type PaOperationRecordKind = "issuance" | "publication" | "attempt" | "grant" | "consumption" | "settlement";
export interface PaOperationTransaction {
  checkOpen(): void;
  /** Both owner and actual materialization locks precede this sample. */
  readonly controlTime: number;
  readonly materialization: Readonly<{binding: MaterializationAuthorizationBinding; version: number}> | undefined;
  read(kind: PaOperationRecordKind, key: string): Promise<unknown>;
  insert(kind: PaOperationRecordKind, key: string, value: unknown): Promise<void>;
}
export interface PaOperationStore {
  transact<T>(owner: PaOperationOwner, work: (tx: PaOperationTransaction) => Promise<T>): Promise<T>;
}
