// oxlint-disable max-lines
import assert from "node:assert/strict";
import test from "node:test";

import { createContainedTurnFeature } from "../dist/features/contained-agent-turn/composition/feature-module-factory.js";
import { digestContainedTurnCanonicalValue } from "../dist/features/contained-agent-turn/domain/contained-turn-codecs.js";
import { containedTurnIdentity } from "../dist/features/contained-agent-turn/domain/contained-turn-identities.js";
import { containedTurnSatisfactionDigest } from "../dist/features/contained-agent-turn/domain/contained-turn-satisfaction.js";
import { appendContainedTurnOutputForOwnerStore } from "../dist/features/contained-agent-turn/domain/contained-turn-output-transitions.js";
import { mutateContainedTurnOperation } from "../dist/features/contained-agent-turn/domain/contained-turn-transitions.js";
import type { ContainedTurnKernelOperation } from "../dist/features/contained-agent-turn/domain/contained-turn-kernel-model.js";
import type { ContainedTurnProof } from "../dist/features/contained-agent-turn/domain/contained-turn-proofs.js";
import type { ContainedTurnKernelDependencies } from "../dist/features/contained-agent-turn/application/ports/outbound/contained-turn-ports.js";
import { containedTurnProviderAccessSnapshotDigest, CONTAINED_TURN_REQUIRED_PROOF_KINDS } from "../dist/features/contained-agent-turn/domain/contained-turn-authority.js";
import { containedTurnDispatchClaimBindingDigest } from "../dist/features/contained-agent-turn/domain/contained-turn-dispatch-authority.js";
import { recordContainedTurnPreparationCleanup, retireContainedTurnDispatchPreparation, type ContainedTurnDispatchPreparation } from "../dist/features/contained-agent-turn/domain/contained-turn-dispatch-preparation.js";
import { containedTurnPreparationToken } from "../dist/features/contained-agent-turn/application/contained-turn-preparation-cleanup.js";

const identity = <Namespace extends Parameters<typeof containedTurnIdentity>[0]>(namespace: Namespace, suffix: string) =>
  containedTurnIdentity(namespace, `${String(namespace).replaceAll("_", "-")}:${suffix}`);
const proofId = (suffix: string) => identity("proof", suffix);
const operationId = identity("operation", "one");
const effectId = identity("effect", "one");
const attemptId = identity("attempt", "one");
const custodyId = identity("custody", "one");
const workspaceId = identity("workspace", "one");
const hostBootId = identity("host_boot", "one");
const hostInstanceId = identity("host_instance", "one");
const executionGenerationId = identity("execution_generation", "one");
const writerFence = identity("writer_fence", "one");

interface ClaimAuthorityObservation {
  readonly acceptedProviderAccessSnapshotDigest: string;
  readonly acceptedSecurityDecisionDigest: string;
  readonly providerAccessDispatchProofId: string;
  readonly providerAccessRevision: number;
  readonly runtimeSecurityDispatchProofId: string;
  readonly securityAuthorityRevision: string;
}

const adapterSnapshot = Object.freeze({
  adapterRevision: "adapter:one",
  binaryRevision: "binary:one",
  capabilityManifestRevision: "manifest:one",
  provider: "codex" as const,
});
const providerAccessSnapshot = Object.freeze({
  accessRef: "access:one",
  credentialBindingDigest: digestContainedTurnCanonicalValue({ binding: "one" }),
  credentialBindingRef: "credential-binding:one",
  credentialGeneration: 1,
  ownerAuthorityDigest: "authority-digest:one",
  projectId: "project:one",
  provider: "codex" as const,
  providerAccountRef: "account:one",
  providerRouteRef: "route:one",
  revision: 1,
  tenantId: "tenant:one",
});
const manifest = Object.freeze({
  effectCardinality: "one_coarse_effect_per_operation" as const,
  effectClass: "contained_unmediated_effect" as const,
  manifestRevision: adapterSnapshot.capabilityManifestRevision,
  manifestVersion: 1 as const,
  provider: "codex" as const,
  providerAttemptCardinality: "at_most_one" as const,
  requiredProofKinds: CONTAINED_TURN_REQUIRED_PROOF_KINDS,
  resourceScopeRevision: "resource-scope:one",
  supportedModes: Object.freeze(["analysis"] as const),
  unknownCapabilityPolicy: "fail_closed" as const,
});

const operationBinding = (operation: ContainedTurnKernelOperation) => ({
  authorityVectorDigest: operation.acceptedAuthorityVectorDigest,
  operationId: operation.operationId,
});
const attemptBinding = (operation: ContainedTurnKernelOperation) => {
  assert.equal(operation.dispatch.kind, "claimed");
  return { ...operationBinding(operation), attemptId, effectId: operation.effectId };
};

const assertOwnerAuthority = (
  authority: Parameters<ContainedTurnKernelDependencies["operationStore"]["commit"]>[0]["authority"],
  operation: ContainedTurnKernelOperation,
): void => assert.deepEqual(authority, {
  commandId: operation.commandId,
  effectId: operation.effectId,
  operationId: operation.operationId,
  scope: operation.scope,
});

const awaitFixtureGate = async <Value>(
  gate: Promise<void>,
  submission: Promise<Value>,
): Promise<void> => {
  const outcome = await Promise.race([
    gate.then(() => ({ kind: "started" as const })),
    submission.then(value => ({ kind: "settled" as const, value })),
  ]);
  assert.equal(outcome.kind, "started", "submission settled before the fixture gate was reached");
};

// The fixture deliberately assembles the exact closed set of owner ports in one place.
// oxlint-disable-next-line max-lines-per-function
const createDependencies = (options: Readonly<{
  artifactIndeterminate?: boolean;
  custodyOpenThrows?: boolean;
  claimCommitThenThrow?: boolean;
  dispatchPrevented?: boolean;
  emitBeforeGate?: boolean;
  forgeReceipt?: boolean;
  indeterminateFirstCommit?: boolean;
  maliciousFakeSuccess?: boolean;
  neverExecution?: boolean;
  neverStart?: boolean;
  providerGate?: Promise<void>;
  providerStarted?: () => void;
  revalidationThrows?: boolean;
  staleClaimAuthority?: boolean;
  staleOwnerAfterClaim?: boolean;
  throwAfterStart?: boolean;
  containmentIndeterminate?: boolean;
  workspaceGate?: Promise<void>;
  workspaceClosureIndeterminate?: boolean;
  workspaceStarted?: () => void;
}> = {}): {
  claimAuthorities: ClaimAuthorityObservation[];
  containmentCalls: { value: number };
  completionBoundaryReleases: { value: number };
  createdWorkspaces: ContainedTurnKernelOperation["workspaceId"][];
  custodyReleases: Array<Parameters<ContainedTurnKernelDependencies["custody"]["releaseReservation"]>[0]>;
  current: () => ContainedTurnKernelOperation | undefined;
  dependencies: ContainedTurnKernelDependencies;
  openedCustodies: typeof custodyId[];
  providerCalls: { value: number };
  workspaceQuarantines: Array<Parameters<ContainedTurnKernelDependencies["workspace"]["quarantine"]>[0]>;
} => {
  let current: ContainedTurnKernelOperation | undefined;
  let commitCount = 0;
  let workspaceCreateCount = 0;
  let preparation: ContainedTurnDispatchPreparation | undefined;
  const claimAuthorities: ClaimAuthorityObservation[] = [];
  const containmentCalls = { value: 0 };
  const completionBoundaryReleases = { value: 0 };
  const createdWorkspaces: ContainedTurnKernelOperation["workspaceId"][] = [];
  const custodyReleases: Array<Parameters<ContainedTurnKernelDependencies["custody"]["releaseReservation"]>[0]> = [];
  const openedCustodies: typeof custodyId[] = [];
  const providerCalls = { value: 0 };
  const workspaceQuarantines: Array<Parameters<ContainedTurnKernelDependencies["workspace"]["quarantine"]>[0]> = [];
  const operationStore: ContainedTurnKernelDependencies["operationStore"] = {
    accept: async (candidate, authority) => {
      assertOwnerAuthority(authority, candidate);
      current = candidate;
      return { kind: "accepted", operation: candidate };
    },
    appendOutput: async input => {
      if (current === undefined) {return { kind: "not_found" };}
      assertOwnerAuthority(input.authority, current);
      if (current.revision !== input.expectedRevision) {return { current, kind: "stale" };}
      current = appendContainedTurnOutputForOwnerStore(current, input.output);
      return { kind: "applied", operation: current };
    },
    commit: async input => {
      if (current === undefined) {return { kind: "not_found" };}
      assertOwnerAuthority(input.authority, current);
      if (current.revision !== input.expectedRevision) {return { current, kind: "stale" };}
      commitCount += 1;
      if (options.indeterminateFirstCommit === true && commitCount === 1) {
        const evidenceId = identity("evidence", "lost-store-ack");
        current = mutateContainedTurnOperation(current, { evidenceId, kind: "record_reconciliation_debt", source: "store_commit" });
        return { debtOperation: current, evidenceId, kind: "indeterminate" };
      }
      current = input.candidate;
      return { kind: "applied", operation: current };
    },
    claimPreparedDispatch: async input => {
      if (current === undefined) {return { kind: "not_found" };}
      assertOwnerAuthority(input.authority, current);
      if (current.revision !== input.expectedOperationRevision || options.staleClaimAuthority === true) {
        return { current, kind: "stale" };
      }
      const subject = input.subject;
      const providerAccessDispatchProof = {
        binding: {
          ...operationBinding(current),
          acceptedSnapshotDigest: containedTurnProviderAccessSnapshotDigest(current.providerAccessSnapshot),
          resolutionDigest: digestContainedTurnCanonicalValue({ current: true }),
        },
        kind: "provider_access_dispatch" as const,
        proofId: proofId("provider-access-dispatch"),
      };
      const runtimeSecurityDispatchProof = {
        binding: {
          ...operationBinding(current),
          acceptedSecurityDecisionDigest: current.acceptedAuthorityVector.securityDecisionDigest,
          currentSecurityDecisionDigest: digestContainedTurnCanonicalValue({ current: true }),
          securityAuthorityRevision: current.acceptedAuthorityVector.securityAuthorityRevision,
        },
        kind: "runtime_security_dispatch" as const,
        proofId: proofId("security-dispatch"),
      };
      claimAuthorities.push({
        acceptedProviderAccessSnapshotDigest: providerAccessDispatchProof.binding.acceptedSnapshotDigest,
        acceptedSecurityDecisionDigest: current.acceptedAuthorityVector.securityDecisionDigest,
        providerAccessDispatchProofId: providerAccessDispatchProof.proofId,
        providerAccessRevision: current.providerAccessSnapshot.revision,
        runtimeSecurityDispatchProofId: runtimeSecurityDispatchProof.proofId,
        securityAuthorityRevision: current.acceptedAuthorityVector.securityAuthorityRevision,
      });
      current = mutateContainedTurnOperation(current, {
        attemptId: subject.attemptId,
        claimProof: {
          binding: {
            ...operationBinding(current),
            attemptId: subject.attemptId,
            effectId: current.effectId,
            preparationToken: subject.preparationToken,
            providerAccessDispatchProofId: providerAccessDispatchProof.proofId,
            runtimeSecurityDispatchProofId: runtimeSecurityDispatchProof.proofId,
          },
          kind: "dispatch_claim",
          proofId: proofId("claim"),
        },
        custodyId: subject.custodyId,
        cutoffProof: { binding: operationBinding(current), kind: "cutoff", proofId: proofId("cutoff") },
        executionGenerationId: subject.executionGenerationId,
        hostBootId: subject.hostBootId,
        hostCustodyProof: input.hostCustodyProof,
        hostInstanceId: subject.hostInstanceId,
        kind: "claim_dispatch",
        preparationToken: subject.preparationToken,
        providerAccessDispatchProof,
        runtimeSecurityDispatchProof,
        writerFence,
      });
      preparation = preparation === undefined ? undefined : { ...preparation, kind: "claimed" };
      if (options.claimCommitThenThrow === true) {throw new Error("claim committed; acknowledgement lost");}
      if (options.staleOwnerAfterClaim === true) {return { current, kind: "stale" };}
      return { kind: "claimed", operation: current, startAuthority: "test-start-authority:one" };
    },
    identifyAcceptance: async () => ({
      acceptanceProofId: proofId("acceptance"),
      effectId,
      kind: "available",
      operationAuthorityRevision: "operation-authority:one",
      operationId,
    }),
    prepareCancellation: async ({ authority, operation }) => {
      assertOwnerAuthority(authority, operation);
      const scopeDigest = operation.acceptedAuthorityVector.scopeDigest;
      const cancellationCommandId = identity("cancellation_command", "one");
      const command = {
        cancellationCommandId,
        fingerprint: digestContainedTurnCanonicalValue({ cancellationCommandId, operationId, scopeDigest, version: 1 }) as never,
        operationId,
        scopeDigest,
      };
      return {
        command,
        cutoffProof: { binding: { ...operationBinding(operation), cancellationCommandId }, kind: "cutoff", proofId: proofId("cancel-cutoff") },
        preventionProofId: proofId("cancel-no-dispatch"),
        proof: { binding: { ...operationBinding(operation), cancellationCommandId, cancellationFingerprint: command.fingerprint }, kind: "cancellation", proofId: proofId("cancellation") },
      };
    },
    prepareDispatch: async ({ authority, operation }) => {
      assertOwnerAuthority(authority, operation);
      preparation = {
        attemptId, custodyId, kind: "active", operationCutoffRevision: operation.operationCutoff.revision,
        operationId, preparationToken: containedTurnPreparationToken({ attemptId, custodyId, operationId }), preparedOperationRevision: operation.revision,
        providerAccessGrantRequestId: "provider-access-grant:one", runtimeSecurityGrantRequestId: "runtime-security-grant:one",
        workspaceId: operation.workspaceId as typeof workspaceId,
      };
      return { attemptId, claimProofId: proofId("claim"), custodyId, cutoffProofId: proofId("cutoff"), executionGenerationId, writerFence };
    },
    recordDispatchPreparationCleanup: async input => {
      if (preparation === undefined) {throw new Error("missing test preparation");}
      preparation = recordContainedTurnPreparationCleanup(preparation, input);
      return preparation;
    },
    retireDispatchPreparation: async input => {
      if (current === undefined) {return { evidenceId: identity("evidence", "retire-missing"), kind: "indeterminate" };}
      if (current.dispatch.kind === "claimed" && current.dispatch.preparationToken === input.preparationToken) {
        return { kind: "claimed", operation: current };
      }
      if (preparation === undefined || preparation.kind !== "active") {
        return { current, kind: "stale" };
      }
      preparation = retireContainedTurnDispatchPreparation(preparation, "test-retirement");
      return { kind: "retired", preparation: preparation as Extract<ContainedTurnDispatchPreparation, { kind: "cleanup_pending" }> };
    },
    proofsForAcceptedEffect: async ({ authority, operation }) => {
      assertOwnerAuthority(authority, operation);
      if (options.maliciousFakeSuccess === true) {
        return { evidenceId: identity("evidence", "owner-cannot-confirm-fake-success"), kind: "indeterminate" };
      }
      const binding = attemptBinding(operation);
      return {
        kind: "proved",
        acceptanceProof: { binding: { ...binding, disposition: "accepted" }, kind: "provider_acceptance", proofId: proofId("provider-acceptance") },
        effectProof: { binding: { ...binding, disposition: "committed" }, kind: "effect_resolution", proofId: proofId("effect") },
      };
    },
    proofsForPrevention: async ({ authority, operation, preventionProofId }) => {
      assertOwnerAuthority(authority, operation);
      const cutoffProof = operation.proofs.find(proof => proof.kind === "cutoff" && (
        operation.cancellation.kind === "requested"
          ? proof.binding.cancellationCommandId === operation.cancellation.command.cancellationCommandId
          : proof.proofId === preventionProofId
      )) as Extract<ContainedTurnProof, { kind: "cutoff" }> | undefined;
      return ({
      containmentProof: { binding: { ...operationBinding(operation), effectId }, kind: "containment_not_required", proofId: proofId("containment-not-required") },
      cutoffProof: cutoffProof ?? { binding: operationBinding(operation), kind: "cutoff", proofId: proofId("prevention-cutoff") },
      effectProof: { binding: { ...operationBinding(operation), disposition: "not_committed", effectId }, kind: "effect_no_start", proofId: proofId("effect-no-start") },
      executionProof: { binding: { ...operationBinding(operation), effectId }, kind: "no_start", proofId: proofId("no-start") },
      hostCustodyProof: { binding: { ...operationBinding(operation), effectId }, kind: "host_custody_no_start", proofId: proofId("host-custody-no-start") },
      noDispatchProof: { binding: { ...operationBinding(operation), effectId }, kind: "no_dispatch", proofId: preventionProofId },
      outputProof: { binding: { ...operationBinding(operation), finalCursor: 0 }, kind: "output_no_start_drain", proofId: proofId("output-no-start") },
      providerProof: { binding: { ...operationBinding(operation), effectId }, kind: "provider_not_started", proofId: proofId("provider-not-started") },
      });
    },
    proofsForProcessNoStart: async ({ authority, operation }) => {
      assertOwnerAuthority(authority, operation);
      throw new Error("not used by success conformance");
    },
    read: async requested => requested.operationId === operationId &&
        requested.scope.projectId === current?.scope.projectId && requested.scope.tenantId === current.scope.tenantId
      ? current
      : undefined,
    requestCancellation: async input => {
      if (current === undefined) {return { kind: "not_found" };}
      assertOwnerAuthority(input.authority, current);
      if (current.revision !== input.expectedRevision) {return { current, kind: "stale" };}
      current = input.candidate;
      return { kind: "applied", operation: current };
    },
    terminalProof: async input => {
      assertOwnerAuthority(input.authority, input.operation);
      assert.equal(input.satisfactionDigest, containedTurnSatisfactionDigest(input.operation));
      if (input.operation.providerExecution.kind !== "closed") {
        throw new TypeError("terminal fixture requires closed provider execution");
      }
      return {
        binding: {
          ...operationBinding(input.operation),
          requiredReceiptSetDigest: input.operation.requiredReceiptSetDigest,
          requiredReceiptSetVersion: input.operation.requiredReceiptSet.setVersion,
          satisfactionDigest: input.satisfactionDigest,
          terminalOutcome: input.operation.providerExecution.outcome,
        },
        kind: "terminal_truth",
        proofId: proofId("terminal"),
      };
    },
  };
  const dependencies: ContainedTurnKernelDependencies = {
    operationStore,
    security: {
      consumeForDispatch: async ({ subject }) => ({
        kind: "consumed",
        receipt: {
          claimBindingDigest: containedTurnDispatchClaimBindingDigest(subject),
          grantRequestDigest: digestContainedTurnCanonicalValue({ owner: "runtime_security", request: "one" }),
          grantRequestId: "runtime-security-grant:one",
          owner: "runtime_security",
          ownerAuthorityDigest: digestContainedTurnCanonicalValue({ owner: "runtime_security", authority: "one" }),
          ownerReceiptDigest: digestContainedTurnCanonicalValue({ owner: "runtime_security", receipt: "one" }),
          validThroughOperationCutoffRevision: subject.operationCutoffRevision,
        },
      }),
      settleConsumedGrant: async () => ({ kind: "settled" }),
      authorizeForAcceptance: async () => ({
        acceptanceProofId: proofId("security-acceptance"),
        authorityRevision: "security-authority:one",
        containmentPolicyDigest: digestContainedTurnCanonicalValue({ containment: "one" }),
        decisionDigest: digestContainedTurnCanonicalValue({ allowed: true }),
        kind: "allowed",
      }),
      revalidateForDispatch: async () => ({ dispatchDecisionDigest: digestContainedTurnCanonicalValue({ current: true }), kind: "current", proofId: proofId("security-dispatch") }),
    },
    providerAccess: {
      consumeForDispatch: async ({ subject }) => options.revalidationThrows === true
        ? Promise.reject(new Error("provider access consumption failed"))
        : options.dispatchPrevented === true
          ? { kind: "prevented" as const, preventionProofId: proofId("provider-access-prevention") }
          : ({
            kind: "consumed" as const,
            receipt: {
              claimBindingDigest: containedTurnDispatchClaimBindingDigest(subject),
              grantRequestDigest: digestContainedTurnCanonicalValue({ owner: "provider_access", request: "one" }),
              grantRequestId: "provider-access-grant:one",
              owner: "provider_access" as const,
              ownerAuthorityDigest: digestContainedTurnCanonicalValue({ owner: "provider_access", authority: "one" }),
              ownerReceiptDigest: digestContainedTurnCanonicalValue({ owner: "provider_access", receipt: "one" }),
              validThroughOperationCutoffRevision: subject.operationCutoffRevision,
            },
          }),
      resolveForAcceptance: async () => ({
        acceptanceProofId: proofId("provider-access-acceptance"),
        acceptanceResolutionDigest: digestContainedTurnCanonicalValue({ resolved: true }),
        kind: "resolved",
        snapshot: providerAccessSnapshot,
      }),
      revalidateForDispatch: async () => ({
        ...(options.dispatchPrevented === true
          ? { kind: "prevented" as const, preventionProofId: proofId("provider-access-prevention"), reason: "access_revoked" as const }
          : options.revalidationThrows === true
            ? await Promise.reject(new Error("provider access revalidation failed"))
            : {
              dispatchProofId: proofId("provider-access-dispatch"),
              dispatchResolutionDigest: digestContainedTurnCanonicalValue({ current: true }),
              kind: "current" as const,
              snapshot: providerAccessSnapshot,
            }),
      }),
      settleConsumedGrant: async () => ({ kind: "settled" }),
    },
    workspace: {
      ensureClosed: async input => {
        if (options.workspaceClosureIndeterminate === true) {
          return { evidenceId: identity("evidence", "workspace-closure-unknown"), kind: "indeterminate" };
        }
        const outcome = await dependencies.workspace.close({ operationId: input.operationId, workspaceId: input.workspaceId });
        return outcome.kind === "closed"
          ? { kind: "proved", proof: outcome.proof, requestDigest: input.requestDigest, requestId: input.requestId }
          : outcome;
      },
      queryClosure: input => dependencies.workspace.ensureClosed(input),
      close: async input => ({ kind: "closed", proof: { binding: { ...operationBinding(current as ContainedTurnKernelOperation), workspaceId: input.workspaceId }, kind: "workspace_closure", proofId: proofId("workspace-closure") } }),
      create: async () => {
        workspaceCreateCount += 1;
        const createdWorkspaceId = workspaceCreateCount === 1
          ? workspaceId
          : identity("workspace", `one-${workspaceCreateCount}`);
        createdWorkspaces.push(createdWorkspaceId);
        if (workspaceCreateCount === 1) {
          options.workspaceStarted?.();
          await options.workspaceGate;
        }
        return { workspaceId: createdWorkspaceId };
      },
      quarantine: async input => {workspaceQuarantines.push(input);},
    },
    artifacts: {
      ensureSealed: async input => {
        const outcome = await dependencies.artifacts.seal(input);
        return outcome.kind === "sealed"
          ? { kind: "proved", proof: { artifactProof: outcome.artifactProof, resultProof: outcome.resultProof }, requestDigest: input.requestDigest, requestId: input.requestId }
          : outcome;
      },
      querySeal: input => dependencies.artifacts.ensureSealed({ ...input, output: current?.output.chunks ?? [] }),
      seal: async input => options.artifactIndeterminate === true
        ? { evidenceId: identity("evidence", "artifact-unknown"), kind: "indeterminate" }
        : ({
        artifactProof: { binding: { ...operationBinding(current as ContainedTurnKernelOperation), artifactManifestRef: "artifact:one", workspaceId: input.workspaceId }, kind: "artifact_manifest_seal", proofId: proofId("artifact") },
        kind: "sealed",
        resultProof: { binding: { ...operationBinding(current as ContainedTurnKernelOperation), resultRef: "result:one" }, kind: "result_publication", proofId: proofId("result") },
      }),
    },
    custody: {
      attestContainment: async input => {
        if (options.containmentIndeterminate === true) {
          return { evidenceId: identity("evidence", "containment-attestation-unknown"), kind: "indeterminate" };
        }
        const outcome = await dependencies.custody.requestContainment(input);
        return outcome.kind === "contained"
          ? { kind: "proved", proof: outcome.proof, requestDigest: input.requestDigest, requestId: input.requestId }
          : outcome;
      },
      attestExecutionClosure: async input => {
        const operation = current as ContainedTurnKernelOperation;
        assert.equal(input.attemptId, attemptId);
        assert.equal(input.custodyId, custodyId);
        assert.equal(input.finalCursor, operation.output.chunks.length);
        assert.equal(input.operationId, operationId);
        const binding = attemptBinding(operation);
        return {
          executionClosureProof: { binding: { ...binding, outcome: "succeeded" }, kind: "execution_closure", proofId: proofId("execution") },
          kind: "proved",
          outputDrainProof: { binding: { ...binding, finalCursor: input.finalCursor }, kind: "output_drain", proofId: proofId("output-drain") },
          terminalObservationProof: { binding: { ...binding, outcome: "succeeded" }, kind: "provider_terminal_observation", proofId: proofId("terminal-observation") },
        };
      },
      completionBoundary: input => {
        const expires = (input.phase === "start" && options.neverStart === true) ||
          (input.phase === "execution" && options.neverExecution === true);
        let timer: NodeJS.Immediate | undefined;
        return {
          expiration: expires
            ? new Promise(resolve => {timer = setImmediate(() => {resolve({ evidenceId: identity("evidence", `${input.phase}-deadline`), kind: "expired" });});})
            : new Promise(() => {}),
          release: () => {
            completionBoundaryReleases.value += 1;
            if (timer !== undefined) {clearImmediate(timer);}
          },
        };
      },
      ensurePhysicalContainment: async input => {
        const outcome = await dependencies.custody.requestPhysicalContainment(input);
        return outcome.kind === "contained"
          ? { kind: "proved", proof: outcome.proof, requestDigest: input.requestDigest, requestId: input.requestId }
          : outcome;
      },
      open: async () => {
        openedCustodies.push(custodyId);
        if (options.custodyOpenThrows === true) {throw new Error("custody failed after reserving identity");}
        return {
          custodyId,
          hostBootId,
          hostCustodyProof: { binding: { ...operationBinding(current as ContainedTurnKernelOperation), attemptId, effectId, custodyId }, kind: "host_custody", proofId: proofId("host-custody") },
          hostInstanceId,
        };
      },
      releaseReservation: async input => {custodyReleases.push(input);},
      releaseRetiredReservation: async input => {
        custodyReleases.push({
          attemptId: input.cleanupPermit.attemptId,
          custodyId: input.cleanupPermit.custodyId,
          operationId: input.cleanupPermit.operationId,
          reason: "claim_lost",
          workspaceId: input.cleanupPermit.workspaceId,
        });
        return { kind: "released" };
      },
      queryContainmentAttestation: input => dependencies.custody.attestContainment(input),
      queryPhysicalContainment: input => dependencies.custody.ensurePhysicalContainment(input),
      requestContainment: async () => {
        containmentCalls.value += 1;
        const operation = current as ContainedTurnKernelOperation;
        if (operation.output.fence.kind === "open") {
          return { evidenceId: identity("evidence", "containment-pending"), kind: "indeterminate" };
        }
        const proof = (kind: ContainedTurnProof["kind"]) => operation.proofs.find(candidate => candidate.kind === kind)?.proofId as ReturnType<typeof proofId>;
        return {
          kind: "contained",
          proof: {
            binding: {
              ...attemptBinding(operation),
              adapterRevision: operation.adapterSnapshot.adapterRevision,
              artifactManifestSealProofId: proof("artifact_manifest_seal"),
              binaryRevision: operation.adapterSnapshot.binaryRevision,
              capabilityManifestRevision: operation.capabilityManifest.manifestRevision,
              containmentPolicyDigest: operation.acceptedAuthorityVector.containmentPolicyDigest,
              credentialBindingDigest: operation.providerAccessSnapshot.credentialBindingDigest,
              custodyId,
               cutoffProofId: operation.operationCutoff.kind === "closed" && "proofId" in operation.operationCutoff
                 ? operation.operationCutoff.proofId
                 : operation.admissionFence.kind === "fenced" ? operation.admissionFence.proofId : proof("cutoff"),
              executionClosureProofId: proof("execution_closure"),
              finalCursor: operation.output.chunks.length,
              hostBootId,
              hostInstanceId,
              immutableScopeDigest: operation.acceptedAuthorityVector.scopeDigest,
              outputDrainProofId: proof("output_drain"),
              physicalContainmentProofId: proof("physical_containment"),
              providerRouteRef: operation.providerAccessSnapshot.providerRouteRef,
              terminalObservationProofId: proof("provider_terminal_observation"),
               workspaceId: operation.workspaceId as typeof workspaceId,
            },
            kind: "containment",
            proofId: proofId("containment"),
          },
        };
      },
      requestPhysicalContainment: async () => {
        containmentCalls.value += 1;
        return {
          kind: "contained",
          proof: { binding: { ...attemptBinding(current as ContainedTurnKernelOperation), custodyId, hostBootId, hostInstanceId }, kind: "physical_containment", proofId: proofId("physical-containment") },
        };
      },
      start: async input => {
        if (options.neverStart === true) {return new Promise(() => {});}
        const proof = { binding: { ...attemptBinding(current as ContainedTurnKernelOperation), custodyId, hostBootId, hostInstanceId }, kind: "provider_process_start" as const, proofId: proofId("process-start") };
        let reportStart!: () => void;
        const observation = new Promise<import("../dist/features/contained-agent-turn/application/ports/outbound/contained-turn-ports.js").ContainedTurnKernelProcessStartObservation>(resolve => {
          reportStart = () => {resolve({ kind: "execution_started", proof });};
        });
        const execution = input.execute({
          createProcess: createProcess => {const process = createProcess(); reportStart(); return process;},
          observation,
        });
        const observed = await observation;
        assert.equal(observed.kind, "execution_started");
        return { execution, kind: "execution_started", proof };
      },
    },
    provider: {
      adapterSnapshot,
      manifest,
      execute: async input => {
        providerCalls.value += 1;
        input.start.createProcess(() => Object.freeze({}));
        if (options.neverExecution === true) {return new Promise(() => {});}
        if (options.maliciousFakeSuccess === true) {return { kind: "completed", outcome: "succeeded" };}
        if (options.throwAfterStart === true) {throw new Error("provider crashed after the sole delegated start");}
        if (options.emitBeforeGate === true) {await input.emit({ cursor: 0, kind: "assistant", text: "before cancellation" });}
        options.providerStarted?.();
        await options.providerGate;
        if (await input.isCancellationRequested()) {
          return { evidenceId: identity("evidence", "provider-after-cancellation"), kind: "indeterminate" };
        }
        await input.emit({ cursor: 0, kind: "assistant", text: "ok" });
        if (options.forgeReceipt === true) {
          return {
            acceptanceProof: { forged: true },
            kind: "completed",
            outcome: "succeeded",
          } as never;
        }
        return { kind: "completed", outcome: "succeeded" };
      },
    },
  };
  return { claimAuthorities, completionBoundaryReleases, containmentCalls, createdWorkspaces, custodyReleases, current: () => current, dependencies, openedCustodies, providerCalls, workspaceQuarantines };
};

test("seven-port conformance reaches terminal truth through only ordered kernel APIs", async () => {
  const { current, dependencies, providerCalls } = createDependencies();
  const feature = createContainedTurnFeature(dependencies);
  const result = await feature.submit.execute({
    commandId: "command:one",
    expectedProvider: "codex",
    intent: { mode: "analysis", prompt: "inspect disposable state" },
    scope: { projectId: "project:one", tenantId: "tenant:one" },
  });
  assert.equal(result.status, "observed");
  if (result.status !== "observed") {return;}
  assert.equal(result.turn.status, "succeeded", JSON.stringify(current(), undefined, 2));
  assert.deepEqual(result.turn.output, [{ cursor: 0, kind: "assistant", text: "ok" }]);
  assert.equal(providerCalls.value, 1);
  assert.deepEqual(await feature.observe.execute({ operationId, scope: { projectId: "project:one", tenantId: "tenant:one" } }), result);
});

test("final dispatch claim CAS carries Provider Access and Runtime Security authority fences", async () => {
  const { claimAuthorities, dependencies } = createDependencies();
  await createContainedTurnFeature(dependencies).submit.execute({
    commandId: "command:one",
    expectedProvider: "codex",
    intent: { mode: "analysis", prompt: "inspect disposable state" },
    scope: { projectId: "project:one", tenantId: "tenant:one" },
  });
  assert.equal(claimAuthorities.length, 1);
  assert.equal(claimAuthorities[0]?.providerAccessRevision, 1);
  assert.equal(claimAuthorities[0]?.securityAuthorityRevision, "security-authority:one");
  assert.equal(claimAuthorities[0]?.providerAccessDispatchProofId, proofId("provider-access-dispatch"));
  assert.equal(claimAuthorities[0]?.runtimeSecurityDispatchProofId, proofId("security-dispatch"));
});

test("authority change at the final dispatch CAS prevents provider start", async () => {
  const { custodyReleases, dependencies, providerCalls } = createDependencies({ staleClaimAuthority: true });
  const outcome = await createContainedTurnFeature(dependencies).submit.execute({
    commandId: "command:one",
    expectedProvider: "codex",
    intent: { mode: "analysis", prompt: "inspect disposable state" },
    scope: { projectId: "project:one", tenantId: "tenant:one" },
  });
  assert.equal(outcome.status, "observed");
  assert.equal(providerCalls.value, 0);
  assert.deepEqual(custodyReleases.map(release => release.reason), ["claim_lost"]);
});

test("prevention after custody reservation releases the exact reservation before no-dispatch closure", async () => {
  const { current, custodyReleases, dependencies, openedCustodies, providerCalls } = createDependencies({ dispatchPrevented: true });
  const outcome = await createContainedTurnFeature(dependencies).submit.execute({
    commandId: "command:one",
    expectedProvider: "codex",
    intent: { mode: "analysis", prompt: "prevent after preparation" },
    scope: { projectId: "project:one", tenantId: "tenant:one" },
  });
  assert.equal(outcome.status, "observed");
  assert.deepEqual(openedCustodies, [custodyId]);
  assert.deepEqual(custodyReleases.map(release => release.reason), ["claim_lost"]);
  assert.equal(current()?.dispatch.kind, "prevented");
  assert.equal(providerCalls.value, 0);
});

test("thrown dispatch revalidation releases the exact custody reservation and fails closed", async () => {
  const { custodyReleases, dependencies, openedCustodies, providerCalls } = createDependencies({ revalidationThrows: true });
  const outcome = await createContainedTurnFeature(dependencies).submit.execute({
    commandId: "command:one",
    expectedProvider: "codex",
    intent: { mode: "analysis", prompt: "throw during revalidation" },
    scope: { projectId: "project:one", tenantId: "tenant:one" },
  });
  assert.equal(outcome.status, "observed");
  assert.deepEqual(openedCustodies, [custodyId]);
  assert.deepEqual(custodyReleases.map(release => release.reason), ["claim_lost"]);
  assert.equal(providerCalls.value, 0);
});

test("custody open failure after reservation identity allocation executes bounded release", async () => {
  const { custodyReleases, dependencies, openedCustodies, providerCalls } = createDependencies({ custodyOpenThrows: true });
  const outcome = await createContainedTurnFeature(dependencies).submit.execute({
    commandId: "command:one",
    expectedProvider: "codex",
    intent: { mode: "analysis", prompt: "throw after custody reservation" },
    scope: { projectId: "project:one", tenantId: "tenant:one" },
  });
  assert.equal(outcome.status, "observed");
  assert.deepEqual(openedCustodies, [custodyId]);
  assert.deepEqual(custodyReleases.map(release => release.reason), ["open_failed"]);
  assert.equal(providerCalls.value, 0);
});

test("durable acceptance is published before provider execution and accepted cancellation requests Host containment", async () => {
  let releaseProvider!: () => void;
  const providerGate = new Promise<void>(resolve => {releaseProvider = resolve;});
  let providerStarted!: () => void;
  const started = new Promise<void>(resolve => {providerStarted = resolve;});
  let accepted: import("../dist/index.js").ContainedTurnOperationRef | undefined;
  const { containmentCalls, dependencies } = createDependencies({ emitBeforeGate: true, providerGate, providerStarted });
  const feature = createContainedTurnFeature(dependencies);
  const submission = feature.submit.execute({
    commandId: "command:one",
    expectedProvider: "codex",
    intent: { mode: "analysis", prompt: "inspect disposable state" },
    scope: { projectId: "project:one", tenantId: "tenant:one" },
  }, { onAccepted: operation => {accepted = operation;} });
  await awaitFixtureGate(started, submission);
  assert.equal(accepted?.operationId, operationId);
  let cancellation!: Awaited<ReturnType<typeof feature.cancel.execute>>;
  try {
    cancellation = await feature.cancel.execute(accepted as import("../dist/index.js").ContainedTurnOperationRef);
  } catch (error) {
    assert.fail(error instanceof Error ? error.stack : String(error));
  } finally {releaseProvider();}
  assert.equal(cancellation.status, "observed");
  assert.equal(containmentCalls.value, 1);
  if (cancellation.status === "observed") {
    assert.equal(cancellation.turn.output.length, 1);
    assert.equal(cancellation.turn.status, "running");
  }
  const completed = await submission;
  assert.equal(completed.status, "observed");
  if (completed.status === "observed") {assert.equal(completed.turn.status, "reconcile_required");}
});

test("abort after durable acceptance requests application cancellation without relying on onAccepted", async () => {
  let releaseProvider!: () => void;
  const providerGate = new Promise<void>(resolve => {releaseProvider = resolve;});
  let providerStarted!: () => void;
  const started = new Promise<void>(resolve => {providerStarted = resolve;});
  const controller = new AbortController();
  const { containmentCalls, dependencies } = createDependencies({ providerGate, providerStarted });
  const submission = createContainedTurnFeature(dependencies).submit.execute({
    commandId: "command:one",
    expectedProvider: "codex",
    intent: { mode: "analysis", prompt: "inspect disposable state" },
    scope: { projectId: "project:one", tenantId: "tenant:one" },
  }, { signal: controller.signal });
  await awaitFixtureGate(started, submission);
  try {
    controller.abort();
    while (containmentCalls.value === 0) {await new Promise<void>(resolve => {setImmediate(resolve);});}
    assert.equal(containmentCalls.value, 1);
  } finally {releaseProvider();}
  const completed = await submission;
  assert.equal(completed.status, "observed");
  if (completed.status === "observed") {assert.equal(completed.turn.status, "reconcile_required");}
});

test("lost store acknowledgement is returned only with durable reconciliation debt and no provider retry", async () => {
  const { dependencies, providerCalls } = createDependencies({ indeterminateFirstCommit: true });
  const outcome = await createContainedTurnFeature(dependencies).submit.execute({
    commandId: "command:one",
    expectedProvider: "codex",
    intent: { mode: "analysis", prompt: "inspect disposable state" },
    scope: { projectId: "project:one", tenantId: "tenant:one" },
  });
  assert.equal(outcome.status, "observed");
  if (outcome.status === "observed") {assert.equal(outcome.turn.status, "reconcile_required");}
  assert.equal(providerCalls.value, 0);
});

test("[oracle-06-seal-outbox-recovery] unknown artifact sealing persists reconciliation debt without terminal failure or retry", async () => {
  const { dependencies, providerCalls } = createDependencies({ artifactIndeterminate: true });
  const outcome = await createContainedTurnFeature(dependencies).submit.execute({
    commandId: "command:one",
    expectedProvider: "codex",
    intent: { mode: "analysis", prompt: "inspect disposable state" },
    scope: { projectId: "project:one", tenantId: "tenant:one" },
  });
  assert.equal(outcome.status, "observed");
  if (outcome.status === "observed") {assert.equal(outcome.turn.status, "reconcile_required");}
  assert.equal(providerCalls.value, 1);
});

for (const [stage, options] of [
  ["workspace", { workspaceClosureIndeterminate: true }],
  ["containment", { containmentIndeterminate: true }],
] as const) {
  test(`durable ${stage} closure debt projects only reconcile_required`, async () => {
    const { current, dependencies } = createDependencies(options);
    const outcome = await createContainedTurnFeature(dependencies).submit.execute({
      commandId: "command:one",
      expectedProvider: "codex",
      intent: { mode: "analysis", prompt: `observe ${stage} closure debt` },
      scope: { projectId: "project:one", tenantId: "tenant:one" },
    });
    assert.equal(outcome.status, "observed");
    if (outcome.status === "observed") {assert.equal(outcome.turn.status, "reconcile_required");}
    assert.equal(current()?.closureRecovery.kind, "required");
  });
}

test("provider observations cannot inject Kernel-owned receipt fields", async () => {
  const { current, dependencies, providerCalls } = createDependencies({ forgeReceipt: true });
  const outcome = await createContainedTurnFeature(dependencies).submit.execute({
    commandId: "command:one",
    expectedProvider: "codex",
    intent: { mode: "analysis", prompt: "attempt to forge trusted closure" },
    scope: { projectId: "project:one", tenantId: "tenant:one" },
  });
  assert.equal(outcome.status, "observed");
  if (outcome.status === "observed") {assert.equal(outcome.turn.status, "reconcile_required");}
  assert.equal(providerCalls.value, 1);
  assert.equal(current()?.proofs.some(proof => [
    "provider_acceptance", "execution_closure", "output_drain", "effect_resolution",
  ].includes(proof.kind)), false);
});

test("a malicious provider's immediate fake success observation cannot mint owner truth or terminalize", async () => {
  const { current, dependencies, providerCalls } = createDependencies({ maliciousFakeSuccess: true });
  const outcome = await createContainedTurnFeature(dependencies).submit.execute({
    commandId: "command:one",
    expectedProvider: "codex",
    intent: { mode: "analysis", prompt: "report fake success immediately" },
    scope: { projectId: "project:one", tenantId: "tenant:one" },
  });
  assert.equal(outcome.status, "observed");
  if (outcome.status === "observed") {assert.equal(outcome.turn.status, "reconcile_required");}
  assert.equal(providerCalls.value, 1);
  assert.equal(current()?.terminal.kind, "open");
  assert.equal(current()?.providerAcceptance.kind, "unknown");
  assert.equal(current()?.effect.kind, "ambiguous");
  assert.equal(current()?.proofs.some(proof => proof.kind === "terminal_truth"), false);
});

test("a never-settling custody start is bounded, contained, and releases its completion boundary", async () => {
  const { completionBoundaryReleases, current, dependencies, providerCalls } = createDependencies({ neverStart: true });
  const outcome = await createContainedTurnFeature(dependencies).submit.execute({
    commandId: "command:one",
    expectedProvider: "codex",
    intent: { mode: "analysis", prompt: "never settle custody start" },
    scope: { projectId: "project:one", tenantId: "tenant:one" },
  });
  assert.equal(outcome.status, "observed");
  if (outcome.status === "observed") {assert.equal(outcome.turn.status, "reconcile_required");}
  assert.equal(providerCalls.value, 0);
  assert.equal(completionBoundaryReleases.value, 1);
  assert.equal(current()?.physicalContainment.kind, "contained");
});

test("a never-settling provider execution is bounded without redispatch or a tracked submission", async () => {
  const { completionBoundaryReleases, current, dependencies, providerCalls } = createDependencies({ neverExecution: true });
  const outcome = await createContainedTurnFeature(dependencies).submit.execute({
    commandId: "command:one",
    expectedProvider: "codex",
    intent: { mode: "analysis", prompt: "never settle execution" },
    scope: { projectId: "project:one", tenantId: "tenant:one" },
  });
  assert.equal(outcome.status, "observed");
  if (outcome.status === "observed") {assert.equal(outcome.turn.status, "reconcile_required");}
  assert.equal(providerCalls.value, 1);
  assert.equal(completionBoundaryReleases.value, 2);
  assert.equal(current()?.physicalContainment.kind, "contained");
  assert.equal(current()?.terminal.kind, "open");
});

test("throw after the sole dispatch claim preserves ambiguity and never becomes not-accepted or retryable", async () => {
  const { current, dependencies, providerCalls } = createDependencies({ throwAfterStart: true });
  const outcome = await createContainedTurnFeature(dependencies).submit.execute({
    commandId: "command:one",
    expectedProvider: "codex",
    intent: { mode: "analysis", prompt: "crash after dispatch" },
    scope: { projectId: "project:one", tenantId: "tenant:one" },
  });
  assert.equal(outcome.status, "observed");
  if (outcome.status === "observed") {assert.equal(outcome.turn.status, "reconcile_required");}
  assert.equal(providerCalls.value, 1);
  assert.equal(current()?.dispatch.kind, "claimed");
  assert.equal(current()?.providerAcceptance.kind, "unknown");
  assert.equal(current()?.terminal.kind, "open");
});

for (const [name, options] of [
  ["commit-then-throw", { claimCommitThenThrow: true }],
  ["stale owner response after commit", { staleOwnerAfterClaim: true }],
] as const) {
  test(`${name} records exact reconciliation debt and contains without provider dispatch`, async () => {
    const { containmentCalls, current, dependencies, providerCalls } = createDependencies(options);
    const outcome = await createContainedTurnFeature(dependencies).submit.execute({
      commandId: "command:one",
      expectedProvider: "codex",
      intent: { mode: "analysis", prompt: "lose the durable claim acknowledgement" },
      scope: { projectId: "project:one", tenantId: "tenant:one" },
    });
    assert.equal(outcome.status, "observed");
    if (outcome.status === "observed") {assert.equal(outcome.turn.status, "reconcile_required");}
    assert.equal(providerCalls.value, 0);
    assert.equal(current()?.dispatch.kind, "claimed");
    assert.equal(current()?.providerProcessStart.kind, "unknown");
    assert.equal(current()?.reconciliation.kind, "required");
    assert.equal(current()?.physicalContainment.kind, "contained");
    assert.equal(containmentCalls.value, 1);
  });
}

test("cancellation racing the first workspace creation reaches proved-no-start terminal closure", async () => {
  let releaseWorkspace!: () => void;
  const workspaceGate = new Promise<void>(resolve => {releaseWorkspace = resolve;});
  let workspaceStarted!: () => void;
  const started = new Promise<void>(resolve => {workspaceStarted = resolve;});
  let accepted: import("../dist/index.js").ContainedTurnOperationRef | undefined;
  const { createdWorkspaces, current, dependencies, providerCalls, workspaceQuarantines } = createDependencies({ workspaceGate, workspaceStarted });
  const feature = createContainedTurnFeature(dependencies);
  const submission = feature.submit.execute({
    commandId: "command:one",
    expectedProvider: "codex",
    intent: { mode: "analysis", prompt: "cancel before workspace binding" },
    scope: { projectId: "project:one", tenantId: "tenant:one" },
  }, { onAccepted: operation => {accepted = operation;} });
  await awaitFixtureGate(started, submission);
  try {
    const cancellation = await feature.cancel.execute(accepted as import("../dist/index.js").ContainedTurnOperationRef);
    assert.equal(cancellation.status, "observed");
    if (cancellation.status === "observed") {
      assert.equal(cancellation.turn.status, "cancelled", JSON.stringify(current(), undefined, 2));
    }
  } finally {releaseWorkspace();}
  const settled = await submission;
  assert.equal(settled.status, "observed");
  if (settled.status === "observed") {assert.equal(settled.turn.status, "cancelled");}
  assert.equal(providerCalls.value, 0);
  assert.equal(createdWorkspaces.length, 2);
  assert.equal(workspaceQuarantines.length, 1);
  assert.equal(workspaceQuarantines[0]?.workspaceId, createdWorkspaces[0]);
  assert.equal(current()?.workspaceId, createdWorkspaces[1]);
});

test("composition rejects every non-exact seven-port dependency bag before effects", () => {
  const { dependencies, providerCalls } = createDependencies();
  const inherited = Object.create(dependencies) as ContainedTurnKernelDependencies;
  assert.throws(() => createContainedTurnFeature(inherited), /ordinary object prototype/u);
  const symbol = Object.assign({ ...dependencies }, { [Symbol("hidden")]: true }) as ContainedTurnKernelDependencies;
  assert.throws(() => createContainedTurnFeature(symbol), /symbol keys/u);
  const nonEnumerable = { ...dependencies };
  Object.defineProperty(nonEnumerable, "hidden", { enumerable: false, value: true });
  assert.throws(() => createContainedTurnFeature(nonEnumerable), /enumerable data properties/u);
  const prototypeExtra = Object.assign(Object.create({ hidden: true }), dependencies) as ContainedTurnKernelDependencies;
  assert.throws(() => createContainedTurnFeature(prototypeExtra), /ordinary object prototype/u);
  assert.equal(providerCalls.value, 0);
});
