import type { ContainedTurnAcceptedAuthorityHandoff } from "../application/ports/outbound/contained-turn-ports.js";
import { containedTurnAcceptanceIntentDigestV1 } from "../application/contained-turn-engine.js";
import { containedTurnCommandFingerprint, validateContainedTurnManifest, containedTurnAuthorityVectorDigest, containedTurnProviderAccessSnapshotDigest, containedTurnScopeDigest, validateContainedTurnAuthorityShape, type ContainedTurnProviderAccessSnapshot } from "../domain/contained-turn-authority.js";
import { digestContainedTurnCanonicalValue as hash } from "../domain/contained-turn-codecs.js";
import { completeContainedTurnDispatchGrantSubject, type ContainedTurnDispatchGrantSubject } from "../domain/contained-turn-dispatch-authority.js";
import { assertContainedTurnExactRecord } from "../domain/contained-turn-record.js";
import { validateContainedTurnIdentity } from "../domain/contained-turn-identities.js";
import type { OuterBinding } from "./provider-access-anti-corruption.js";
import { authorityValue } from "./authority-owner-boundary.js";

export const reverseProviderBinding = (snapshot: ContainedTurnProviderAccessSnapshot): OuterBinding & {readonly provider: "claude" | "codex"} => {
  if (snapshot.provider !== "claude" && snapshot.provider !== "codex") {throw new TypeError("unsupported PA provider");}
  return Object.freeze({
  accessRef: snapshot.accessRef, credentialBindingDigest: snapshot.ownerAuthorityDigest,
  credentialBindingRef: snapshot.credentialBindingRef, credentialGeneration: snapshot.credentialGeneration,
  projectId: snapshot.projectId, provider: snapshot.provider, providerAccountRef: snapshot.providerAccountRef,
  providerRouteRef: snapshot.providerRouteRef, revision: snapshot.revision, tenantId: snapshot.tenantId,
});
};
const same = (left: unknown, right: unknown) => hash(left as never) === hash(right as never);
const validateAcceptanceProof = (accepted: ContainedTurnAcceptedAuthorityHandoff, provider: string): void => {
  const proof = accepted.acceptanceProof;
  assertContainedTurnExactRecord("acceptance proof", proof, ["binding", "kind", "proofId"]);
  assertContainedTurnExactRecord("acceptance binding", proof.binding, ["authorityVectorDigest", "operationId", "commandId", "commandFingerprint"]);
  validateContainedTurnIdentity("proof", proof.proofId);
  validateContainedTurnIdentity("command", proof.binding.commandId);
  if (proof.kind !== "acceptance" || proof.binding.operationId !== accepted.operationId ||
      proof.binding.authorityVectorDigest !== accepted.acceptedAuthorityVectorDigest ||
      proof.binding.commandFingerprint !== containedTurnCommandFingerprint({intent: accepted.intent, provider, scope: accepted.scope})) {
    throw new TypeError("accepted proof identity mismatch");
  }
};
/** Validates identity only. Authority to call this seam comes from acknowledged AE execution. */
export const acceptedAuthority = (input: Readonly<{accepted: ContainedTurnAcceptedAuthorityHandoff; subject: ContainedTurnDispatchGrantSubject}>) => {
  const {accepted, subject} = authorityValue(input);
  assertContainedTurnExactRecord("accepted handoff", accepted, ["operationId", "scope", "acceptanceProof", "acceptedAuthorityVector", "acceptedAuthorityVectorDigest", "intent", "constraints", "intentDigest", "constraintsDigest"]);
  const vector = accepted.acceptedAuthorityVector;
  const snapshot = vector.providerAccessSnapshot;
  validateContainedTurnAuthorityShape({acceptedAuthorityVector: vector, adapterSnapshot: accepted.constraints.adapterSnapshot,
    intent: accepted.intent, providerAccessSnapshot: snapshot, scope: accepted.scope});
  assertContainedTurnExactRecord("accepted constraints", accepted.constraints, ["adapterSnapshot", "capabilityManifest", "intentMode"]);
  validateAcceptanceProof(accepted, subject.provider);
  validateContainedTurnIdentity("operation", accepted.operationId);
  validateContainedTurnManifest(accepted.constraints.capabilityManifest, accepted.constraints.adapterSnapshot);
  const scopeDigest = containedTurnScopeDigest(accepted.scope);
  if (accepted.operationId !== subject.operationId || !same(accepted.scope, subject.scope) ||
      containedTurnAuthorityVectorDigest(vector) !== accepted.acceptedAuthorityVectorDigest ||
      containedTurnAcceptanceIntentDigestV1(accepted.intent) !== accepted.intentDigest || hash(accepted.constraints as never) !== accepted.constraintsDigest ||
      accepted.constraints.intentMode !== accepted.intent.mode || !same(accepted.constraints.adapterSnapshot, vector.adapterSnapshot) ||
      accepted.constraints.capabilityManifest.manifestRevision !== vector.capabilityManifestRevision ||
      snapshot.credentialBindingDigest !== hash({ownerDigest: snapshot.ownerAuthorityDigest}) ||
      snapshot.provider !== subject.provider || vector.adapterSnapshot.provider !== subject.provider ||
      snapshot.tenantId !== accepted.scope.tenantId || snapshot.projectId !== accepted.scope.projectId ||
      vector.scopeDigest !== scopeDigest || subject.scopeDigest !== scopeDigest) {throw new TypeError("accepted owner facts mismatch");}
  const bindingDigest = containedTurnProviderAccessSnapshotDigest(snapshot);
  const {providerAccessRequest: _pa, runtimeSecurityRequest: _rs, ...base} = subject;
  const expected = completeContainedTurnDispatchGrantSubject({...base,
    providerAccessExpectation: {acceptedAuthorityDigest: accepted.acceptedAuthorityVectorDigest, accessRef: snapshot.accessRef,
      authorityHeadDigest: snapshot.ownerAuthorityDigest, bindingDigest, bindingRevision: snapshot.revision,
      credentialBindingDigest: snapshot.credentialBindingDigest, credentialBindingRef: snapshot.credentialBindingRef,
      credentialGeneration: snapshot.credentialGeneration, providerAccountRef: snapshot.providerAccountRef, providerRouteRef: snapshot.providerRouteRef},
    runtimeSecurityExpectation: {acceptedAuthorityDigest: vector.securityDecisionDigest, authorityGeneration: vector.operationAuthorityRevision,
      authorityHeadDigest: vector.securityDecisionDigest, authorityRevision: vector.securityAuthorityRevision,
      constraintsDigest: accepted.constraintsDigest, containmentPolicyDigest: vector.containmentPolicyDigest,
      providerBindingDigest: bindingDigest, providerId: snapshot.provider},
  });
  if (!same(expected, subject)) {throw new TypeError("accepted subject or owner request mismatch");}
  return {accepted, subject, bindingDigest};
};
export const acceptedProviderPreparation = (input: Parameters<typeof acceptedAuthority>[0] & {readonly grantRequestId: string}) => {
  const safe = authorityValue(input);
  const {accepted, subject, bindingDigest} = acceptedAuthority(safe);
  if (safe.grantRequestId !== subject.providerAccessRequest.grantRequestId) {throw new TypeError("PA request identity mismatch");}
  const acceptedBinding = reverseProviderBinding(accepted.acceptedAuthorityVector.providerAccessSnapshot);
  return Object.freeze({operationId: accepted.operationId,
    scope: Object.freeze({...accepted.scope, scopeDigest: containedTurnScopeDigest(accepted.scope)}), provider: acceptedBinding.provider,
    acceptedAuthorityDigest: accepted.acceptedAuthorityVectorDigest, acceptanceEvidenceRef: accepted.acceptanceProof.proofId,
    acceptedBinding, providerBindingDigest: bindingDigest,
    grantRequestId: subject.providerAccessRequest.grantRequestId, claimBindingDigest: subject.providerAccessRequest.claimBindingDigest,
    requestDigest: subject.providerAccessRequest.requestDigest});
};
