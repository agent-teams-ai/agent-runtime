import type { DispatchConsumeResult } from './dispatch-consumption-models.js';
import type { DispatchAcceptedPreparation, DispatchPublicationRepository } from './ports/outbound/dispatch-acceptance-owner.js';
import type { DispatchAcceptanceOperations } from './dispatch-acceptance.js';
import { acceptanceCanonical, policyPermits, sameAcceptance, validAcceptanceIntent } from './dispatch-acceptance.js';
import type { DispatchAuthorityHead, DispatchConsumeRequest } from '../domain/dispatch-authority-head.js';
import { preventionReason, snapshotDispatchAuthorityHead, validConsumeInput } from '../domain/dispatch-authority-head.js';
import { snapshotExactDispatchRecord } from '../domain/dispatch-exact-record.js';

/** Publish once, never rebase a conflicting CAS. An exact owner read is the only
 * recovery from an unacknowledged publication; consumption owns all replay truth. */
export const authorizedDispatchHead = async (prepared: DispatchAcceptedPreparation,
  request: DispatchConsumeRequest, ops: DispatchAcceptanceOperations): Promise<DispatchAuthorityHead | undefined> => {
  if (!snapshotExactDispatchRecord(prepared, ['acceptance', 'decisionDigest', 'authorityGeneration',
    'providerBindingDigest', 'claimBindingDigest', 'requestDigest', 'grantRequestId']) ||
    !validAcceptanceIntent(prepared.acceptance) || !validConsumeInput(request)) {return undefined;}
  const intent = prepared.acceptance;
  const decision = await ops.decisions.read(intent);
  if (decision === undefined) {return undefined;}
  const policy = await ops.policy.read(intent);
  if (policy === undefined || !policyPermits(policy, intent, ops.now()) ||
    !sameAcceptance(policy, decision.policy) ||
    !sameAcceptance(intent, { operationId: decision.operationId, scope: decision.scope,
      providerId: decision.providerId, intentDigest: decision.intentDigest,
      policyRevision: decision.policyRevision }) ||
    decision.decisionDigest !== prepared.decisionDigest ||
    decision.decisionDigest !== ops.digestCanonical(acceptanceCanonical({
      purpose: 'runtime-security.dispatch-acceptance/v1', intent, policy,
    })) || decision.ownerEvidenceRef !== `runtime-security-evidence:v1:${decision.decisionDigest}`) {return undefined;}
  const head: DispatchAuthorityHead = {
    decision: 'accepted', purpose: 'contained-turn.provider-dispatch/v1',
    operationId: intent.operationId, scope: intent.scope, providerId: intent.providerId,
    authorityRevision: policy.policyRevision, acceptedAuthorityDigest: decision.decisionDigest,
    authorityHeadDigest: decision.decisionDigest, constraintsDigest: policy.constraintsDigest,
    containmentPolicyDigest: policy.containmentPolicyDigest,
    authorityGeneration: prepared.authorityGeneration,
    providerBindingDigest: prepared.providerBindingDigest, claimBindingDigest: prepared.claimBindingDigest,
    requestDigest: prepared.requestDigest, claimBeforeControlTime: policy.claimBeforeControlTime,
    revoked: false, ownerEvidenceRef: decision.ownerEvidenceRef,
  };
  if (request.operationId !== intent.operationId || !sameAcceptance(request.scope, intent.scope) ||
    request.grantRequestId !== prepared.grantRequestId ||
    preventionReason(request, head, ops.now()) !== undefined) {return undefined;}
  return head;
};

export const publishDispatchAuthority = async (prepared: DispatchAcceptedPreparation,
  request: DispatchConsumeRequest, ops: DispatchAcceptanceOperations,
  repository: DispatchPublicationRepository): Promise<boolean> => {
  const head = await authorizedDispatchHead(prepared, request, ops);
  if (head === undefined) {return false;}
  // A raced historical result needs no publication. The existing consumer checks
  // its exact fingerprint and returns immutable history, including not_found.
  const prior = await repository.observe({ scope: request.scope, providerId: request.providerId,
          authorityGeneration: request.authorityGeneration, operationId: request.operationId,
          grantRequestId: request.grantRequestId });
  if (prior !== undefined) {return true;}
  const key = { scope: head.scope, operationId: head.operationId,
    providerId: head.providerId, authorityGeneration: head.authorityGeneration };
  const current = await repository.readAuthority(key);
  const exact = (value: typeof current) => value.headVersion === '1' &&
    snapshotDispatchAuthorityHead(value.authority) !== undefined && sameAcceptance(value.authority, head);
  if (exact(current)) {return true;}
  if (current.headVersion !== '0' || current.authority !== undefined) {return false;}
  try {
    const result = await repository.replaceAuthority(head, '0');
    if (result.status === 'applied' && result.headVersion === '1') {return true;}
  } catch {
    // COMMIT may have happened. Never issue another write after uncertainty.
  }
  return exact(await repository.readAuthority(key));
};

export const publishAndConsumeForDispatch = async (prepared: DispatchAcceptedPreparation,
  request: DispatchConsumeRequest, ops: DispatchAcceptanceOperations,
  repository: DispatchPublicationRepository,
  consume: (input: DispatchConsumeRequest) => Promise<DispatchConsumeResult>): Promise<DispatchConsumeResult> => {
  const prior = await repository.observe({ scope: request.scope, providerId: request.providerId,
    authorityGeneration: request.authorityGeneration, operationId: request.operationId,
    grantRequestId: request.grantRequestId });
  // Immutable historical outcomes are validated by the existing consumer, even
  // after expiry/revocation. They confer no new deadline or permission to retry.
  if (prior !== undefined) {return consume(request);}
  if (!await publishDispatchAuthority(prepared, request, ops, repository) ||
      await authorizedDispatchHead(prepared, request, ops) === undefined) {
    return { status: 'indeterminate', reason: 'owner_unavailable' };
  }
  return consume(request);
};
