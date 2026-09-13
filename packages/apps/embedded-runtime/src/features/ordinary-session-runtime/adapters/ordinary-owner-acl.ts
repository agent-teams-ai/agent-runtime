import type {OrdinaryProviderAccessPort, OrdinarySecurityPort, OrdinaryOperation} from "@agent-teams/agent-execution/composition";
import {createOrdinaryCodexAuthCapture, type OrdinaryCodexAuthObservation, type createPostgresOrdinaryProviderAccessOwner} from "@agent-teams/provider-access/composition";
import type {createOrdinarySecurityOwner} from "@agent-teams/runtime-security/composition";

const binding = (operation: OrdinaryOperation) => ({operationId: operation.operationId, attemptId: operation.attemptId, executionProfile: operation.executionProfile, capabilityManifestRevision: operation.capabilityManifestRevision});
export function bindOrdinarySecurityOwner(owner: ReturnType<typeof createOrdinarySecurityOwner>): OrdinarySecurityPort {
  return {async resolveAndConsume(operation, signal) {
    signal.throwIfAborted();
    if (operation.input.expectedProvider !== "codex" || operation.input.intent.mode !== "workspace-write") {throw new Error("ordinary_security_profile_mismatch");}
    const grant = await owner.resolveAndConsume({...binding(operation), scope: {tenantId: operation.scope.tenantId, projectId: operation.scope.projectId}, provider: "codex", mode: "workspace-write", effectClass: operation.effectClass});
    const a = grant.authority;
    return {grantId: a.grantId, expiresAt: a.expiresAt, authority: {operationId: a.operationId, attemptId: a.attemptId, executionProfile: a.executionProfile, capabilityManifestRevision: a.capabilityManifestRevision, owner: a.owner, grantId: a.grantId, ownerReceiptId: a.ownerReceiptId, consumptionDigest: a.consumptionDigest, consumptionRevision: a.consumptionRevision, authorityDigest: a.authorityDigest, expiresAt: a.expiresAt, scope: {tenantId: a.scope.tenantId, projectId: a.scope.projectId}, provider: a.provider},
      async admitOutput(output) {return grant.admitOutput(output.text);}, async admitArtifact(snapshot) {return grant.admitArtifact(snapshot.resultBytes);},
      async settle(disposition) {const s = await grant.settle(disposition); return {operationId: s.operationId, attemptId: s.attemptId, executionProfile: s.executionProfile, capabilityManifestRevision: s.capabilityManifestRevision, kind: "security_grant_settled", grantId: s.grantId, ownerReceiptId: s.ownerReceiptId, settlementReceiptId: s.settlementReceiptId, disposition: s.disposition};},
    };
  }};
}
export function bindOrdinaryProviderAccessOwner(owner: ReturnType<typeof createPostgresOrdinaryProviderAccessOwner>, options: {readonly executable: string; readonly sourceDirectory: string; readonly privateRoot: string; readonly record: (observation: OrdinaryCodexAuthObservation) => void}): OrdinaryProviderAccessPort {
  return {async resolveAndConsume(operation, signal) {
    signal.throwIfAborted();
    const capture = createOrdinaryCodexAuthCapture({operationRef: operation.operationId, executable: options.executable, sourceDirectory: options.sourceDirectory, privateRoot: options.privateRoot, generation: 1, signal, deadline: performance.now() + 60000, record: options.record});
    const grant = await owner.consume({...binding(operation), tenantId: operation.scope.tenantId, projectId: operation.scope.projectId, effectClass: operation.effectClass}, capture, signal);
    const a = grant.authority;
    return {grantId: grant.grantId, expiresAt: grant.expiresAt, authority: {operationId: a.operationId, attemptId: a.attemptId, executionProfile: a.executionProfile, capabilityManifestRevision: a.capabilityManifestRevision, owner: "provider_access", grantId: a.grantId, ownerReceiptId: a.ownerReceiptId, consumptionDigest: a.consumptionDigest, consumptionRevision: a.consumptionRevision, authorityDigest: a.authorityDigest, expiresAt: a.expiresAt, scope: {tenantId: a.tenantId, projectId: a.projectId}, provider: "codex"},
      async materialize(_workspace, materializeSignal) {materializeSignal.throwIfAborted(); const m = await grant.materialize(); materializeSignal.throwIfAborted(); return {brokerEndpoint: m.brokerEndpoint, materializationId: m.materializationId, generation: m.generation, environment: {AR_ORDINARY_BROKER_CAPABILITY: m.environment.AR_ORDINARY_BROKER_CAPABILITY}};},
      async retire() {const r = await grant.retire(); return {...binding(operation), kind: "credential_retired", materializationId: r.materializationId, generation: r.generation, retiredAt: r.retiredAt};},
      async settle(disposition) {const s = await grant.settle(disposition); return {...binding(operation), kind: "provider_grant_settled", grantId: s.grantId, ownerReceiptId: s.ownerReceiptId, settlementReceiptId: s.settlementReceiptId, disposition: s.disposition};},
    };
  }};
}
