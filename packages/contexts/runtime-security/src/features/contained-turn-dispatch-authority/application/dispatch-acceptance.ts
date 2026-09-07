import type { DispatchAcceptanceIntent, DispatchAcceptancePolicy, DispatchAcceptanceDecision,
  DispatchAcceptanceStore, DispatchPolicyReadPort } from './ports/outbound/dispatch-acceptance-owner.js';
import { isBoundedDispatchIdentifier } from './dispatch-consumption-models.js';
import { sameScope, validDispatchOwnerEvidenceRef } from '../domain/dispatch-authority-head.js';
import { snapshotExactDispatchRecord } from '../domain/dispatch-exact-record.js';

export const acceptanceCanonical = (value: unknown): string => {
  if (value === null || typeof value !== 'object') {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) {throw new TypeError('invalid acceptance value');}
    return encoded;
  }
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${acceptanceCanonical(
    (value as Record<string, unknown>)[key])}`).join(',')}}`;
};
export const sameAcceptance = (left: unknown, right: unknown): boolean =>
  acceptanceCanonical(left) === acceptanceCanonical(right);
export const validAcceptanceIntent = (input: DispatchAcceptanceIntent): boolean =>
  snapshotExactDispatchRecord(input, ['operationId', 'scope', 'providerId', 'intentDigest', 'policyRevision']) !== undefined &&
  snapshotExactDispatchRecord(input.scope, ['tenantId', 'projectId', 'scopeDigest']) !== undefined &&
  [input.operationId, input.scope.tenantId, input.scope.projectId, input.scope.scopeDigest,
    input.providerId, input.intentDigest, input.policyRevision].every(isBoundedDispatchIdentifier);
export const policyPermits = (policy: DispatchAcceptancePolicy, intent: DispatchAcceptanceIntent,
  now: number): boolean =>
  snapshotExactDispatchRecord(policy, ['scope', 'providerId', 'intentDigest', 'policyRevision',
    'enabled', 'revoked', 'constraintsDigest', 'containmentPolicyDigest',
    'validFromControlTime', 'claimBeforeControlTime']) !== undefined &&
  snapshotExactDispatchRecord(policy.scope, ['tenantId', 'projectId', 'scopeDigest']) !== undefined &&
  sameScope(policy.scope, intent.scope) && policy.providerId === intent.providerId &&
  policy.intentDigest === intent.intentDigest && policy.policyRevision === intent.policyRevision &&
  policy.enabled === true && policy.revoked === false &&
  [policy.constraintsDigest, policy.containmentPolicyDigest].every(isBoundedDispatchIdentifier) &&
  Number.isSafeInteger(now) && now >= 0 &&
  Number.isSafeInteger(policy.validFromControlTime) && policy.validFromControlTime >= 0 &&
  Number.isSafeInteger(policy.claimBeforeControlTime) &&
  policy.validFromControlTime <= now && now < policy.claimBeforeControlTime;

export interface DispatchAcceptanceOperations {
  readonly decisions: DispatchAcceptanceStore;
  readonly policy: DispatchPolicyReadPort;
  readonly now: () => number;
  readonly digestCanonical: (value: string) => string;
}
export const evaluateDispatchAcceptance = async (intent: DispatchAcceptanceIntent,
  ops: DispatchAcceptanceOperations): Promise<DispatchAcceptanceDecision | undefined> => {
  if (!validAcceptanceIntent(intent)) {return;}
  const policy = await ops.policy.read(intent);
  if (policy === undefined || !policyPermits(policy, intent, ops.now())) {return;}
  const decisionDigest = ops.digestCanonical(acceptanceCanonical({
    purpose: 'runtime-security.dispatch-acceptance/v1', intent, policy,
  }));
  if (!isBoundedDispatchIdentifier(decisionDigest)) {return;}
  const decision = Object.freeze({ ...intent, policy, decisionDigest,
    ownerEvidenceRef: `runtime-security-evidence:v1:${decisionDigest}` });
  if (!validDispatchOwnerEvidenceRef(decision.ownerEvidenceRef)) {return;}
  const retained = await ops.decisions.retain(decision);
  return sameAcceptance(retained, decision) ? decision : undefined;
};
