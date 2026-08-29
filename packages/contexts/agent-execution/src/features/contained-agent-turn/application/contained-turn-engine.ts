import {
  containedTurnAuthorityVectorDigest,
  containedTurnCommandFingerprint,
  containedTurnProviderAccessSnapshotDigest,
  containedTurnScopeDigest,
  type ContainedTurnAuthorityVector,
  type ContainedTurnIntent,
  type ContainedTurnProvider,
  type ContainedTurnScope,
} from "../domain/contained-turn-authority.js";
import { encodeContainedTurnCanonicalValue, type ContainedTurnCanonicalValue } from "../domain/contained-turn-codecs.js";
import { containedTurnIdentity } from "../domain/contained-turn-identities.js";
import type { ContainedTurnKernelOperation } from "../domain/contained-turn-kernel-model.js";
import { assertContainedTurnExactRecord, detachAndFreezeContainedTurnValue } from "../domain/contained-turn-record.js";
import { containedTurnSatisfactionDigest } from "../domain/contained-turn-satisfaction.js";
import {
  createContainedTurnOperation,
  mutateContainedTurnOperation,
  type ContainedTurnKernelMutation,
} from "../domain/contained-turn-transitions.js";
import { validateContainedTurnKernelDependencies, type ContainedTurnKernelDependencies, type CommitContainedTurnKernelOperationOutcome } from "./ports/outbound/contained-turn-ports.js";

export interface ContainedTurnApplicationSubmitInput {
  readonly commandId: string;
  readonly expectedProvider: ContainedTurnProvider;
  readonly intent: ContainedTurnIntent;
  readonly scope: ContainedTurnScope;
}

export interface ContainedTurnApplicationRefInput {
  readonly operationId: string;
  readonly scope: ContainedTurnScope;
}

export interface ContainedTurnApplicationView {
  readonly artifactManifestRef?: string;
  readonly commandId: string;
  readonly effectId: string;
  readonly operationId: string;
  readonly output: readonly { readonly cursor: number; readonly kind: "assistant" | "diagnostic" | "progress"; readonly text: string }[];
  readonly provider: ContainedTurnProvider;
  readonly resultRef?: string;
  readonly revision: number;
  readonly status: "accepted" | "cancelled" | "failed" | "reconcile_required" | "running" | "succeeded";
}

export type ContainedTurnApplicationSubmitOutcome =
  | { readonly code: "command_fingerprint_conflict"; readonly status: "conflict" }
  | { readonly code: "mode_unsupported" | "provider_mismatch" | "provider_unsupported"; readonly status: "unsupported" }
  | { readonly status: "denied" }
  | { readonly operation: ContainedTurnKernelOperation; readonly status: "observed" };

export type ContainedTurnApplicationObserveOutcome =
  | { readonly status: "not_found" }
  | { readonly operation: ContainedTurnKernelOperation; readonly status: "observed" };

export interface ContainedTurnApplicationApi {
  cancel(input: ContainedTurnApplicationRefInput): Promise<ContainedTurnApplicationObserveOutcome>;
  observe(input: ContainedTurnApplicationRefInput): Promise<ContainedTurnApplicationObserveOutcome>;
  submit(input: ContainedTurnApplicationSubmitInput): Promise<ContainedTurnApplicationSubmitOutcome>;
}

const sameScope = (operation: ContainedTurnKernelOperation, scope: ContainedTurnScope): boolean =>
  operation.scope.projectId === scope.projectId && operation.scope.tenantId === scope.tenantId;

const sameSnapshot = (left: unknown, right: unknown): boolean =>
  encodeContainedTurnCanonicalValue(left as ContainedTurnCanonicalValue) ===
  encodeContainedTurnCanonicalValue(right as ContainedTurnCanonicalValue);

const commit = async (
  dependencies: ContainedTurnKernelDependencies,
  operation: ContainedTurnKernelOperation,
  mutation: ContainedTurnKernelMutation,
): Promise<CommitContainedTurnKernelOperationOutcome> => {
  const candidate = mutateContainedTurnOperation(operation, mutation);
  return dependencies.operationStore.commit({
    candidate,
    expectedRevision: operation.revision,
    operationId: operation.operationId,
  });
};

class ContainedTurnCasLostError extends Error {}

const advance = async (
  dependencies: ContainedTurnKernelDependencies,
  operation: ContainedTurnKernelOperation,
  mutation: ContainedTurnKernelMutation,
): Promise<ContainedTurnKernelOperation> => {
  const outcome = await commit(dependencies, operation, mutation);
  if (outcome.kind === "applied") {return outcome.operation;}
  throw new ContainedTurnCasLostError("contained-turn transition lost its single CAS");
};

const closeExecution = async (
  dependencies: ContainedTurnKernelDependencies,
  initial: ContainedTurnKernelOperation,
): Promise<ContainedTurnKernelOperation> => {
  if (initial.dispatch.kind !== "claimed" || initial.workspaceId === undefined || initial.custodyId === undefined || initial.providerProcessStart.kind !== "execution_started") {return initial;}
  const attemptId = initial.dispatch.attemptId;
  const custodyId = initial.custodyId;
  const startProofId = initial.providerProcessStart.proofId;
  const workspaceId = initial.workspaceId;
  let current = initial;
  const outcome = await dependencies.provider.execute({
    adapterSnapshot: current.adapterSnapshot,
    attemptId,
    authorityVectorDigest: current.acceptedAuthorityVectorDigest,
    custodyId,
    effectId: current.effectId,
    emit: async output => {current = await advance(dependencies, current, { kind: "append_output", output });},
    intent: current.intent,
    isCancellationRequested: async () => (await dependencies.operationStore.read(current.operationId))?.cancellation.kind === "requested",
    operationId: current.operationId,
    providerAccessSnapshot: current.providerAccessSnapshot,
    startProofId,
    workspaceId,
  });
  if (outcome.kind === "indeterminate") {
    return advance(dependencies, current, { evidenceId: outcome.evidenceId, kind: "record_ambiguity" });
  }
  current = await advance(dependencies, current, { kind: "record_provider_acceptance", proof: outcome.acceptanceProof });
  current = await advance(dependencies, current, { executionProof: outcome.executionClosureProof, kind: "close_provider_execution", terminalObservationProof: outcome.terminalObservationProof });
  current = await advance(dependencies, current, { kind: "drain_output", proof: outcome.outputDrainProof });
  current = await advance(dependencies, current, { kind: "resolve_effect", proof: outcome.effectProof });
  const artifacts = await dependencies.artifacts.seal({ operationId: current.operationId, output: current.output.chunks, workspaceId });
  current = await advance(dependencies, current, { artifactManifestRef: artifacts.artifactProof.binding.artifactManifestRef, kind: "seal_artifact", proof: artifacts.artifactProof });
  current = await advance(dependencies, current, { kind: "publish_result", proof: artifacts.resultProof, resultRef: artifacts.resultProof.binding.resultRef });
  const workspaceProof = await dependencies.workspace.close({ operationId: current.operationId, workspaceId });
  current = await advance(dependencies, current, { kind: "close_workspace", proof: workspaceProof });
  const containment = await dependencies.custody.requestContainment({ attemptId, custodyId, operationId: current.operationId });
  if (containment.kind === "indeterminate") {
    return advance(dependencies, current, { evidenceId: containment.evidenceId, kind: "record_ambiguity" });
  }
  current = await advance(dependencies, current, { kind: "record_containment", proof: containment.proof });
  const terminalProof = await dependencies.operationStore.terminalProof({ operation: current, satisfactionDigest: containedTurnSatisfactionDigest(current) });
  return advance(dependencies, current, { kind: "finalize", proof: terminalProof });
};

const closeWithoutExecution = async (
  dependencies: ContainedTurnKernelDependencies,
  initial: ContainedTurnKernelOperation,
): Promise<ContainedTurnKernelOperation> => {
  if (initial.workspaceId === undefined || initial.providerExecution.kind !== "closed") {return initial;}
  const workspaceId = initial.workspaceId;
  let current = initial;
  const artifacts = await dependencies.artifacts.seal({
    operationId: current.operationId,
    output: current.output.chunks,
    workspaceId,
  });
  current = await advance(dependencies, current, {
    artifactManifestRef: artifacts.artifactProof.binding.artifactManifestRef,
    kind: "seal_artifact",
    proof: artifacts.artifactProof,
  });
  current = await advance(dependencies, current, {
    kind: "publish_result",
    proof: artifacts.resultProof,
    resultRef: artifacts.resultProof.binding.resultRef,
  });
  const workspaceProof = await dependencies.workspace.close({ operationId: current.operationId, workspaceId });
  current = await advance(dependencies, current, { kind: "close_workspace", proof: workspaceProof });
  const terminalProof = await dependencies.operationStore.terminalProof({
    operation: current,
    satisfactionDigest: containedTurnSatisfactionDigest(current),
  });
  return advance(dependencies, current, { kind: "finalize", proof: terminalProof });
};

const dispatch = async (
  dependencies: ContainedTurnKernelDependencies,
  initial: ContainedTurnKernelOperation,
): Promise<ContainedTurnKernelOperation> => {
  if (initial.workspaceId === undefined) {return initial;}
  const workspaceId = initial.workspaceId;
  const [access, security] = await Promise.all([
    dependencies.providerAccess.revalidateForDispatch({ acceptedSnapshot: initial.providerAccessSnapshot, operationId: initial.operationId, scope: initial.scope }),
    dependencies.security.revalidateForDispatch({ decisionDigest: initial.acceptedAuthorityVector.securityDecisionDigest, operationId: initial.operationId, scope: initial.scope, securityAuthorityRevision: initial.acceptedAuthorityVector.securityAuthorityRevision }),
  ]);
  const preventionProofId = access.kind === "prevented" ? access.preventionProofId : security.kind === "prevented" ? security.preventionProofId : undefined;
  if (preventionProofId !== undefined) {
    const proofs = await dependencies.operationStore.proofsForPrevention({ operation: initial, preventionProofId });
    if (proofs.noDispatchProof.proofId !== preventionProofId) {
      throw new TypeError("dispatch prevention must preserve the exact authority proof identity");
    }
    const current = await advance(dependencies, initial, { ...proofs, kind: "prevent_dispatch" });
    return closeWithoutExecution(dependencies, current);
  }
  if (access.kind !== "current" || security.kind !== "current" || !sameSnapshot(access.snapshot, initial.providerAccessSnapshot)) {return initial;}
  const prepared = await dependencies.operationStore.prepareDispatch(initial);
  const custody = await dependencies.custody.open({
    adapterSnapshot: initial.adapterSnapshot,
    attemptId: prepared.attemptId,
    authorityVectorDigest: initial.acceptedAuthorityVectorDigest,
    custodyId: prepared.custodyId,
    operationId: initial.operationId,
    providerAccessSnapshot: initial.providerAccessSnapshot,
    workspaceId,
  });
  const operationBinding = { authorityVectorDigest: initial.acceptedAuthorityVectorDigest, operationId: initial.operationId };
  const providerAccessDispatchProof = {
    binding: { ...operationBinding, acceptedSnapshotDigest: containedTurnProviderAccessSnapshotDigest(initial.providerAccessSnapshot), resolutionDigest: access.dispatchResolutionDigest },
    kind: "provider_access_dispatch" as const,
    proofId: access.dispatchProofId,
  };
  const runtimeSecurityDispatchProof = {
    binding: { ...operationBinding, acceptedSecurityDecisionDigest: initial.acceptedAuthorityVector.securityDecisionDigest, currentSecurityDecisionDigest: security.dispatchDecisionDigest, securityAuthorityRevision: initial.acceptedAuthorityVector.securityAuthorityRevision },
    kind: "runtime_security_dispatch" as const,
    proofId: security.proofId,
  };
  const attemptBinding = { ...operationBinding, attemptId: prepared.attemptId, effectId: initial.effectId };
  const claimed = await advance(dependencies, initial, {
    attemptId: prepared.attemptId,
    claimProof: { binding: { ...attemptBinding, providerAccessDispatchProofId: access.dispatchProofId, runtimeSecurityDispatchProofId: security.proofId }, kind: "dispatch_claim", proofId: prepared.claimProofId },
    custodyId: prepared.custodyId,
    cutoffProof: { binding: operationBinding, kind: "cutoff", proofId: prepared.cutoffProofId },
    hostBootId: custody.hostBootId,
    hostCustodyProof: custody.hostCustodyProof,
    hostInstanceId: custody.hostInstanceId,
    kind: "claim_dispatch",
    providerAccessDispatchProof,
    runtimeSecurityDispatchProof,
  });
  if (claimed.dispatch.kind !== "claimed" || claimed.custodyId === undefined) {return claimed;}
  const start = await dependencies.custody.start({ attemptId: claimed.dispatch.attemptId, custodyId: claimed.custodyId, operationId: claimed.operationId });
  if (start.kind === "indeterminate") {return advance(dependencies, claimed, { evidenceId: start.evidenceId, kind: "record_process_start_unknown" });}
  const started = await advance(dependencies, claimed, {
    kind: start.kind === "execution_started" ? "record_process_start" : "record_process_no_start",
    proof: start.proof,
  } as ContainedTurnKernelMutation);
  if (start.kind === "execution_started") {return closeExecution(dependencies, started);}
  const proofs = await dependencies.operationStore.proofsForProcessNoStart(started);
  const closed = await advance(dependencies, started, { ...proofs, kind: "close_process_no_start" });
  return closeWithoutExecution(dependencies, closed);
};

export const createContainedTurnEngine = (dependencies: ContainedTurnKernelDependencies): ContainedTurnApplicationApi => {
  validateContainedTurnKernelDependencies(dependencies);
  const authority: ContainedTurnKernelDependencies = Object.freeze({
    operationStore: dependencies.operationStore,
    security: dependencies.security,
    providerAccess: dependencies.providerAccess,
    workspace: dependencies.workspace,
    artifacts: dependencies.artifacts,
    custody: dependencies.custody,
    provider: dependencies.provider,
  });
  const observe = async (input: ContainedTurnApplicationRefInput): Promise<ContainedTurnApplicationObserveOutcome> => {
    assertContainedTurnExactRecord("contained-turn observation", input, ["operationId", "scope"]);
    const operationId = containedTurnIdentity("operation", input.operationId);
    const operation = await authority.operationStore.read(operationId);
    return operation === undefined || !sameScope(operation, input.scope) ? { status: "not_found" } : { operation, status: "observed" };
  };
  const api: ContainedTurnApplicationApi = {
    cancel: async input => {
      const observed = await observe(input);
      if (observed.status === "not_found") {return observed;}
      if (observed.operation.terminal.kind === "final" || observed.operation.cancellation.kind === "requested") {
        return observed;
      }
      const prepared = await authority.operationStore.prepareCancellation(observed.operation);
      const next = mutateContainedTurnOperation(observed.operation, { command: prepared.command, cutoffProof: prepared.cutoffProof, kind: "request_cancellation", proof: prepared.proof });
      const result = await authority.operationStore.requestCancellation({ candidate: next, command: prepared.command, expectedRevision: observed.operation.revision });
      return result.kind === "not_found" ? { status: "not_found" } : { operation: result.kind === "applied" ? result.operation : result.current, status: "observed" };
    },
    observe,
    submit: async raw => {
      assertContainedTurnExactRecord("contained-turn submit", raw, ["commandId", "expectedProvider", "intent", "scope"]);
      const input = detachAndFreezeContainedTurnValue(raw);
      const adapter = authority.provider.adapterSnapshot;
      const manifest = authority.provider.manifest;
      if (adapter.provider !== input.expectedProvider) {return { code: "provider_mismatch", status: "unsupported" };}
      if (manifest.effectClass !== "contained_unmediated_effect") {return { code: "provider_unsupported", status: "unsupported" };}
      if (!manifest.supportedModes.includes(input.intent.mode)) {return { code: "mode_unsupported", status: "unsupported" };}
      const commandId = containedTurnIdentity("command", input.commandId);
      const commandFingerprint = containedTurnCommandFingerprint({ intent: input.intent, provider: adapter.provider, scope: input.scope });
      const identity = await authority.operationStore.identifyAcceptance({ commandFingerprint, commandId });
      if (identity.kind === "fingerprint_conflict") {return { code: "command_fingerprint_conflict", status: "conflict" };}
      if (identity.kind === "replayed") {return { operation: identity.operation, status: "observed" };}
      const [access, security] = await Promise.all([
        authority.providerAccess.resolveForAcceptance({ intent: input.intent, provider: adapter.provider, scope: input.scope }),
        authority.security.authorizeForAcceptance({ intent: input.intent, provider: adapter.provider, scope: input.scope }),
      ]);
      if (access.kind !== "resolved" || security.kind !== "allowed") {return { status: "denied" };}
      const vector: ContainedTurnAuthorityVector = {
        adapterSnapshot: adapter,
        capabilityManifestRevision: manifest.manifestRevision,
        containmentPolicyDigest: security.containmentPolicyDigest,
        operationAuthorityRevision: identity.operationAuthorityRevision,
        providerAccessSnapshot: access.snapshot,
        scopeDigest: containedTurnScopeDigest(input.scope),
        securityAuthorityRevision: security.authorityRevision,
        securityDecisionDigest: security.decisionDigest,
      };
      const digest = containedTurnAuthorityVectorDigest(vector);
      const binding = { authorityVectorDigest: digest, operationId: identity.operationId };
      const candidate = createContainedTurnOperation({
        acceptanceProof: { binding: { ...binding, commandFingerprint, commandId }, kind: "acceptance", proofId: identity.acceptanceProofId },
        acceptedAuthorityVector: vector,
        adapterSnapshot: adapter,
        capabilityManifest: manifest,
        commandId,
        effectId: identity.effectId,
        intent: input.intent,
        operationId: identity.operationId,
        providerAccessAcceptanceProof: {
          binding: {
            ...binding,
            resolutionDigest: access.acceptanceResolutionDigest,
            snapshotDigest: containedTurnProviderAccessSnapshotDigest(access.snapshot),
          },
          kind: "provider_access_acceptance",
          proofId: access.acceptanceProofId,
        },
        providerAccessSnapshot: access.snapshot,
        runtimeSecurityAcceptanceProof: { binding: { ...binding, securityAuthorityRevision: security.authorityRevision, securityDecisionDigest: security.decisionDigest }, kind: "runtime_security_acceptance", proofId: security.acceptanceProofId },
        schemaVersion: 1,
        scope: input.scope,
      });
      const accepted = await authority.operationStore.accept(candidate);
      if (accepted.kind === "fingerprint_conflict") {return { code: "command_fingerprint_conflict", status: "conflict" };}
      if (accepted.kind === "replayed") {return { operation: accepted.operation, status: "observed" };}
      let workspace: Awaited<ReturnType<ContainedTurnKernelDependencies["workspace"]["create"]>>;
      try {
        workspace = await authority.workspace.create({ operationId: accepted.operation.operationId, scope: accepted.operation.scope });
      } catch {
        return { operation: accepted.operation, status: "observed" };
      }
      try {
        const bound = await advance(authority, accepted.operation, { kind: "bind_workspace", workspaceId: workspace.workspaceId });
        return { operation: await dispatch(authority, bound), status: "observed" };
      } catch (error) {
        if (!(error instanceof ContainedTurnCasLostError)) {throw error;}
        const observed = await authority.operationStore.read(accepted.operation.operationId);
        return { operation: observed ?? accepted.operation, status: "observed" };
      }
    },
  };
  return Object.freeze(api);
};

export const containedTurnApplicationView = (operation: ContainedTurnKernelOperation): ContainedTurnApplicationView => Object.freeze({
  ...(operation.artifactManifestRef === undefined ? {} : { artifactManifestRef: operation.artifactManifestRef }),
  commandId: operation.commandId,
  effectId: operation.effectId,
  operationId: operation.operationId,
  output: Object.freeze(operation.output.chunks.map(chunk => Object.freeze({ cursor: chunk.cursor, kind: chunk.kind, text: chunk.text }))),
  provider: operation.adapterSnapshot.provider,
  ...(operation.resultRef === undefined ? {} : { resultRef: operation.resultRef }),
  revision: operation.revision,
  status: operation.terminal.kind === "final" ? operation.terminal.outcome : operation.reconciliation.kind === "required" ? "reconcile_required" : operation.dispatch.kind === "claimed" ? "running" : "accepted",
});
