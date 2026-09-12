import type { DispatchAuthorityHead, DispatchAuthorityScope, DispatchConsumeRequest } from '../../../domain/dispatch-authority-head.js';
import type { DispatchConsumptionRepository } from './dispatch-consumption-repository.js';

export interface DispatchAcceptanceIntent {
  readonly operationId: string;
  readonly scope: DispatchAuthorityScope;
  readonly providerId: string;
  readonly intentDigest: string;
  readonly policyRevision: string;
}

/** Deployment-owned immutable rule. Revisions never change meaning or become
 * active again after revocation. The read must reflect current revocation.
 * Deployment must fence an in-flight operation with the existing RS
 * revokeAuthority CAS (including absence) when revocation must race consumption
 * atomically. A policy read alone is not a cross-transaction revocation fence. */
export interface DispatchAcceptancePolicy {
  readonly scope: DispatchAuthorityScope;
  readonly providerId: string;
  readonly intentDigest: string;
  readonly policyRevision: string;
  readonly enabled: boolean;
  readonly revoked: boolean;
  readonly constraintsDigest: string;
  readonly containmentPolicyDigest: string;
  readonly validFromControlTime: number;
  readonly claimBeforeControlTime: number;
}
export interface DispatchAcceptanceDecision extends DispatchAcceptanceIntent {
  readonly decisionDigest: string;
  readonly ownerEvidenceRef: string;
  readonly policy: DispatchAcceptancePolicy;
}
export interface DispatchAcceptanceStore {
  read(intent: DispatchAcceptanceIntent): Promise<DispatchAcceptanceDecision | undefined>;
  /** Insert once per scoped OperationId. Return the retained original on conflict.
   * Resolve only after durable acknowledgement. Never update/delete decisions. */
  retain(decision: DispatchAcceptanceDecision): Promise<DispatchAcceptanceDecision>;
}
export interface DispatchPolicyReadPort {
  read(intent: DispatchAcceptanceIntent): Promise<DispatchAcceptancePolicy | undefined>;
}
export type DispatchPublicationKey = Pick<DispatchConsumeRequest,
  'scope' | 'operationId' | 'providerId' | 'authorityGeneration'>;
export interface DispatchPublicationRepository extends DispatchConsumptionRepository {
  readAuthority(key: DispatchPublicationKey): Promise<{
    readonly headVersion: string; readonly authority?: DispatchAuthorityHead;
  }>;
  replaceAuthority(head: DispatchAuthorityHead, expectedHeadVersion: string): Promise<{
    readonly status: 'applied' | 'conflict'; readonly headVersion: string;
  }>;
}
/** Private AE owner projection, sent only after acknowledged operation acceptance
 * and preparation/custody. These facts bind execution, never grant permission.
 * AE must derive both digests from its retained exact prepared subject. */
export interface DispatchAcceptedPreparation {
  readonly acceptance: DispatchAcceptanceIntent;
  readonly decisionDigest: string;
  readonly authorityGeneration: string;
  readonly providerBindingDigest: string;
  readonly claimBindingDigest: string;
  readonly requestDigest: string;
  readonly grantRequestId: string;
}
