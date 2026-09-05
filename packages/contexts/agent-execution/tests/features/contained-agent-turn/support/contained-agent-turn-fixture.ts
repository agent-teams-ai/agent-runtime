/* oxlint-disable max-lines -- The test-only factory keeps its exact owner-port composition in one fixture. */
import assert from "node:assert/strict";
import { digestContainedTurnCanonicalValue } from "../../../../dist/features/contained-agent-turn/domain/contained-turn-codecs.js";
import { containedTurnIdentity } from "../../../../dist/features/contained-agent-turn/domain/contained-turn-identities.js";
import { containedTurnSatisfactionDigest } from "../../../../dist/features/contained-agent-turn/domain/contained-turn-satisfaction.js";
import { appendContainedTurnOutputForOwnerStore } from "../../../../dist/features/contained-agent-turn/domain/contained-turn-output-transitions.js";
import { mutateContainedTurnOperation } from "../../../../dist/features/contained-agent-turn/domain/contained-turn-transitions.js";
import type { ContainedTurnKernelOperation } from "../../../../dist/features/contained-agent-turn/domain/contained-turn-kernel-model.js";
import type { ContainedTurnProof } from "../../../../dist/features/contained-agent-turn/domain/contained-turn-proofs.js";
import type { ContainedTurnKernelDependencies } from "../../../../dist/features/contained-agent-turn/application/ports/outbound/contained-turn-ports.js";
import { containedTurnProviderAccessSnapshotDigest, CONTAINED_TURN_REQUIRED_PROOF_KINDS } from "../../../../dist/features/contained-agent-turn/domain/contained-turn-authority.js";
import { containedTurnDispatchClaimBindingDigest, validateContainedTurnConsumedGrantReceipts } from "../../../../dist/features/contained-agent-turn/domain/contained-turn-dispatch-authority.js";
import { containedTurnPreparationClosureBinding, CONTAINED_TURN_PREPARATION_CLOSURE_LIMIT, bindContainedTurnPreparationGrantRequests, claimContainedTurnDispatchPreparation, recordContainedTurnPreparationCleanup, retireContainedTurnDispatchPreparation, type ContainedTurnDispatchPreparation } from "../../../../dist/features/contained-agent-turn/domain/contained-turn-dispatch-preparation.js";
import { containedTurnPreparationToken } from "../../../../dist/features/contained-agent-turn/application/contained-turn-preparation-cleanup.js";
import { committedDispatchProofV1 } from "../../../../dist/features/contained-agent-turn/domain/committed-dispatch-proof-v1.js";

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
  if (operation.dispatch.kind !== "claimed") {throw new TypeError("fixture attempt binding requires claim");}
  return {
    ...operationBinding(operation),
    attemptId: operation.dispatch.attemptId,
    effectId: operation.effectId,
  };
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

type ClaimPreparedDispatchInput = Parameters<
  ContainedTurnKernelDependencies["operationStore"]["claimPreparedDispatch"]
>[0];

const matchesPreparedDispatch = (
  preparation: ContainedTurnDispatchPreparation | undefined,
  current: ContainedTurnKernelOperation,
  input: ClaimPreparedDispatchInput,
): preparation is ContainedTurnDispatchPreparation => preparation !== undefined &&
  preparation.kind === "active" &&
  preparation.operationId === current.operationId &&
  preparation.operationId === input.subject.operationId &&
  preparation.preparationToken === input.subject.preparationToken &&
  preparation.attemptId === input.subject.attemptId &&
  preparation.custodyId === input.subject.custodyId &&
  preparation.workspaceId === current.workspaceId &&
  preparation.workspaceId === input.subject.workspaceId &&
  preparation.operationCutoffRevision === input.subject.operationCutoffRevision &&
  preparation.preparedOperationRevision === input.expectedOperationRevision;

// The fixture deliberately assembles the exact closed set of owner ports in one place.
// oxlint-disable-next-line max-lines-per-function
const createDependencies = (options: Readonly<{
  artifactIndeterminate?: boolean;
  custodyOpenThrows?: boolean;
  claimCommitThenThrow?: boolean;
  claimIndeterminate?: boolean;
  dispatchPrevented?: boolean;
  emitBeforeGate?: boolean;
  forgeReceipt?: boolean;
  indeterminateFirstCommit?: boolean;
  maliciousFakeSuccess?: boolean;
  neverExecution?: boolean;
  neverStart?: boolean;
  providerGate?: Promise<void>;
  potentialAcceptance?: boolean;
  providerSettlementIndeterminateOnce?: boolean;
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
  custodyStartInputs: Array<Parameters<ContainedTurnKernelDependencies["custody"]["start"]>[0]>;
  custodyReleases: Array<Parameters<ContainedTurnKernelDependencies["custody"]["releaseReservation"]>[0]>;
  current: () => ContainedTurnKernelOperation | undefined;
  dependencies: ContainedTurnKernelDependencies;
  openedCustodies: typeof custodyId[];
  providerCalls: { value: number };
  providerExecuteInputs: Array<Parameters<ContainedTurnKernelDependencies["provider"]["execute"]>[0]>;
  workspaceQuarantines: Array<Parameters<ContainedTurnKernelDependencies["workspace"]["quarantine"]>[0]>;
} => {
  let current: ContainedTurnKernelOperation | undefined;
  let commitCount = 0;
  let workspaceCreateCount = 0;
  let preparationCount = 0;
  const preparations = new Map<string, ContainedTurnDispatchPreparation>();
  const claimAuthorities: ClaimAuthorityObservation[] = [];
  const containmentCalls = { value: 0 };
  const completionBoundaryReleases = { value: 0 };
  const createdWorkspaces: ContainedTurnKernelOperation["workspaceId"][] = [];
  const custodyStartInputs: Array<Parameters<ContainedTurnKernelDependencies["custody"]["start"]>[0]> = [];
  const custodyReleases: Array<Parameters<ContainedTurnKernelDependencies["custody"]["releaseReservation"]>[0]> = [];
  const openedCustodies: typeof custodyId[] = [];
  const providerCalls = { value: 0 };
  const providerExecuteInputs: Array<Parameters<ContainedTurnKernelDependencies["provider"]["execute"]>[0]> = [];
  let providerSettlementCount = 0;
  const workspaceQuarantines: Array<Parameters<ContainedTurnKernelDependencies["workspace"]["quarantine"]>[0]> = [];
  const operationStore: ContainedTurnKernelDependencies["operationStore"] = {
    preventIntent: async () => ({ kind: "denied" }),
    accept: async (candidate, authority) => {
      assertOwnerAuthority(authority, candidate);
      if (options.potentialAcceptance === true) {
        return {
          candidateOperation: candidate,
          evidenceId: identity("evidence", "potential-acceptance"),
          kind: "potential_acceptance",
        };
      }
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
        current = input.candidate;
        current = mutateContainedTurnOperation(current, { evidenceId, kind: "record_reconciliation_debt", source: "store_commit" });
        return { debtOperation: current, evidenceId, kind: "indeterminate" };
      }
      current = input.candidate;
      return { kind: "applied", operation: current };
    },
    claimPreparedDispatch: async input => {
      const receipts = validateContainedTurnConsumedGrantReceipts(
        input.subject, input.consumedGrantReceipts,
      );
      if (current === undefined) {return { kind: "not_found" };}
      assertOwnerAuthority(input.authority, current);
      if (current.dispatch.kind === "claimed" &&
          current.dispatch.preparationToken === input.subject.preparationToken) {
        return { kind: "observed_claim", operation: current };
      }
      let preparation = preparations.get(input.subject.preparationToken);
      if (!matchesPreparedDispatch(preparation, current, input)) {
        return { current, kind: "stale" };
      }
      preparation = bindContainedTurnPreparationGrantRequests(preparation, {
        providerAccessConsumptionReceipt: receipts[0],
        providerAccessGrantRequestId: receipts[0].grantRequestId,
        runtimeSecurityConsumptionReceipt: receipts[1],
        runtimeSecurityGrantRequestId: receipts[1].grantRequestId,
      });
      preparations.set(preparation.preparationToken, preparation);
      if (current.revision !== input.expectedOperationRevision || options.staleClaimAuthority === true) {
        return { current, kind: "stale" };
      }
      if (current.effectId !== input.subject.effectId ||
          input.subject.providerAccessRequest.claimBindingDigest !== receipts[0].claimBindingDigest ||
          current.acceptedAuthorityVector.scopeDigest !== input.subject.scopeDigest) {
        return { current, kind: "stale" };
      }
      const subject = input.subject;
      const providerAccessDispatchProof = {
        binding: {
          ...operationBinding(current),
          acceptedSnapshotDigest: containedTurnProviderAccessSnapshotDigest(current.providerAccessSnapshot),
          resolutionDigest: digestContainedTurnCanonicalValue(receipts[0] as never),
        },
        kind: "provider_access_dispatch" as const,
        proofId: proofId("provider-access-dispatch"),
      };
      const runtimeSecurityDispatchProof = {
        binding: {
          ...operationBinding(current),
          acceptedSecurityDecisionDigest: current.acceptedAuthorityVector.securityDecisionDigest,
          currentSecurityDecisionDigest: digestContainedTurnCanonicalValue(receipts[1] as never),
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
      if (options.claimIndeterminate === true) {
        return { evidenceId: identity("evidence", "dispatch-claim-indeterminate"), kind: "indeterminate" };
      }
      const claimProof = {
        binding: {
          ...operationBinding(current), attemptId: subject.attemptId, effectId: current.effectId,
          preparationToken: subject.preparationToken,
          providerAccessDispatchProofId: providerAccessDispatchProof.proofId,
          runtimeSecurityDispatchProofId: runtimeSecurityDispatchProof.proofId,
        },
        kind: "dispatch_claim" as const,
        proofId: proofId("claim"),
      };
      current = mutateContainedTurnOperation(current, {
        attemptId: subject.attemptId,
        claimProof,
        custodyId: subject.custodyId,
        cutoffProof: { binding: operationBinding(current), kind: "cutoff", proofId: proofId("cutoff") },
        executionGenerationId: subject.executionGenerationId,
        hostBootId: subject.hostBootId,
        hostCustodyProof: input.hostCustodyProof,
        consumedGrantReceipts: input.consumedGrantReceipts,
        hostInstanceId: subject.hostInstanceId,
        kind: "claim_dispatch",
        preparationToken: subject.preparationToken,
        providerAccessDispatchProof,
        runtimeSecurityDispatchProof,
        writerFence,
      });
      preparation = claimContainedTurnDispatchPreparation(preparation);
      preparations.set(preparation.preparationToken, preparation);
      if (options.claimCommitThenThrow === true) {throw new Error("claim committed; acknowledgement lost");}
      if (options.staleOwnerAfterClaim === true) {return { current, kind: "stale" };}
      if (current.dispatch.kind !== "claimed" || current.admissionFence.kind !== "fenced") {
        throw new TypeError("fixture committed claim is incomplete");
      }
      return { committedDispatchProof: committedDispatchProofV1({
        acceptedAuthorityVectorDigest: current.acceptedAuthorityVectorDigest,
        admissionCutoffProofId: current.admissionFence.proofId, attemptId: current.dispatch.attemptId,
        commandFingerprint: current.commandFingerprint, commandId: current.commandId,
        committedOperationRevision: current.revision, custodyId: subject.custodyId,
        dispatchClaimProofId: current.dispatch.claimProofId, effectId: current.effectId,
        executionGenerationId: current.dispatch.executionGenerationId, hostBootId: subject.hostBootId,
        hostCustodyProofId: input.hostCustodyProof.proofId, hostInstanceId: subject.hostInstanceId,
        operationCutoffRevision: current.dispatch.operationCutoffRevision, operationId: current.operationId,
        preparationToken: current.dispatch.preparationToken, projectId: current.scope.projectId,
        provider: current.adapterSnapshot.provider,
        providerAccessDispatchProofId: current.dispatch.providerAccessDispatchProofId,
        providerAccessGrantReceiptDigest: digestContainedTurnCanonicalValue(current.dispatch.grantReceipts[0] as never),
        purpose: "contained_turn_committed_dispatch_v1",
        runtimeSecurityDispatchProofId: current.dispatch.runtimeSecurityDispatchProofId,
        runtimeSecurityGrantReceiptDigest: digestContainedTurnCanonicalValue(current.dispatch.grantReceipts[1] as never),
        tenantId: current.scope.tenantId, version: 1, workspaceId: subject.workspaceId,
      }), kind: "claimed", operation: current };
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
    proveDispatchPreparationClosure: async input => {
      if (current === undefined) {return;}
      assertOwnerAuthority(input.authority, current);
      if (current.revision !== input.expectedOperationRevision ||
          current.operationCutoff.revision !== input.expectedOperationCutoffRevision ||
          preparations.size > CONTAINED_TURN_PREPARATION_CLOSURE_LIMIT) {return;}
      const binding = containedTurnPreparationClosureBinding(current, input.authority.scope);
      for (const [token, preparation] of preparations) {
        if (token !== preparation.preparationToken || preparation.operationId !== current.operationId ||
            preparation.workspaceId !== current.workspaceId ||
            preparation.preparedOperationRevision >= current.revision ||
            preparation.operationCutoffRevision >= current.operationCutoff.revision || preparation.kind !== "cleanup_closed") {
          return;
        }
      }
      return Object.freeze({ ...binding, preparationCount: preparations.size });
    },
    listDispatchPreparations: async input => {
      if (current === undefined || input.scope.tenantId !== current.scope.tenantId ||
          input.scope.projectId !== current.scope.projectId) {return [];}
      const kinds = input.kinds ?? ["active", "cleanup_pending"];
      const limit = input.limit ?? 100;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000 ||
          kinds.length === 0 || kinds.some(kind => kind !== "active" && kind !== "cleanup_pending")) {
        throw new TypeError("invalid fixture dispatch preparation recovery query");
      }
      const rows = [];
      const orderedPreparations = [...preparations.entries()].toSorted(([left], [right]) =>
        left.localeCompare(right));
      for (const [preparationToken, preparation] of orderedPreparations) {
        if (preparationToken !== preparation.preparationToken ||
            preparation.operationId !== current.operationId) {
          throw new Error("fixture preparation recovery identity fence rejected a corrupt row");
        }
        if ((preparation.kind === "active" || preparation.kind === "cleanup_pending") &&
            kinds.includes(preparation.kind)) {
          rows.push(Object.freeze({ operation: current, preparation }));
        }
        if (rows.length === limit) {break;}
      }
      return Object.freeze(rows);
    },
    prepareDispatch: async ({ authority, operation }) => {
      assertOwnerAuthority(authority, operation);
      if (operation.workspaceId === undefined) {
        throw new TypeError("fixture dispatch preparation requires workspace custody");
      }
      if (current === undefined || current.revision !== operation.revision) {
        throw new Error("fixture preparation lost its operation revision fence");
      }
      assertOwnerAuthority(authority, current);
      if (current.operationCutoff.kind !== "open" || current.admissionFence.kind !== "open" ||
          current.dispatch.kind !== "unclaimed") {
        throw new Error("fixture preparation rejected the closed operation fence");
      }
      const ordinal = preparationCount;
      preparationCount += 1;
      const preparedAttemptId = ordinal === 0 ? attemptId : identity("attempt", `one-${String(ordinal)}`);
      const preparedCustodyId = ordinal === 0 ? custodyId : identity("custody", `one-${String(ordinal)}`);
      const preparationToken = containedTurnPreparationToken({
        attemptId: preparedAttemptId, custodyId: preparedCustodyId, operationId: operation.operationId,
      });
      const preparation: ContainedTurnDispatchPreparation = {
        attemptId: preparedAttemptId, custodyId: preparedCustodyId, kind: "active", operationCutoffRevision: operation.operationCutoff.revision,
        operationId: operation.operationId, preparationToken, preparedOperationRevision: operation.revision,
        providerAccessGrantRequestId: null, runtimeSecurityGrantRequestId: null,
        workspaceId: operation.workspaceId,
      };
      preparations.set(preparationToken, preparation);
      return {
        attemptId: preparedAttemptId,
        claimProofId: proofId(`claim-${String(ordinal)}`),
        custodyId: preparedCustodyId,
        cutoffProofId: proofId(`cutoff-${String(ordinal)}`),
        executionGenerationId: ordinal === 0 ? executionGenerationId : identity("execution_generation", `one-${String(ordinal)}`),
        writerFence: ordinal === 0 ? writerFence : identity("writer_fence", `one-${String(ordinal)}`),
      };
    },
    recordDispatchPreparationCleanup: async input => {
      if (current === undefined) {throw new Error("missing test operation");}
      assertOwnerAuthority(input.authority, current);
      let preparation = preparations.get(input.permit.preparationToken);
      if (preparation === undefined) {throw new Error("missing test preparation");}
      preparation = recordContainedTurnPreparationCleanup(preparation, input);
      preparations.set(preparation.preparationToken, preparation);
      return preparation;
    },
    retireDispatchPreparation: async input => {
      if (current === undefined) {return { evidenceId: identity("evidence", "retire-missing"), kind: "indeterminate" };}
      assertOwnerAuthority(input.authority, current);
      if (current.dispatch.kind === "claimed" && current.dispatch.preparationToken === input.preparationToken) {
        return { kind: "claimed", operation: current };
      }
      let preparation = preparations.get(input.preparationToken);
      if (preparation === undefined || preparation.kind !== "active") {
        return { current, kind: "stale" };
      }
      if (preparation.operationId !== current.operationId ||
          preparation.preparationToken !== input.preparationToken ||
          preparation.workspaceId !== current.workspaceId ||
          preparation.operationCutoffRevision !== current.operationCutoff.revision ||
          preparation.preparedOperationRevision !== input.expectedOperationRevision ||
          preparation.operationCutoffRevision !== input.expectedOperationCutoffRevision) {
        return { current, kind: "stale" };
      }
      preparation = retireContainedTurnDispatchPreparation(
        preparation, "test-retirement", input.consumedGrantRequestIds,
        input.consumptionEvidenceIds,
      );
      preparations.set(preparation.preparationToken, preparation);
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
          authorityFacts: subject.runtimeSecurityExpectation, claimBeforeControlTime: 100,
          claimBindingDigest: containedTurnDispatchClaimBindingDigest(subject), consumedAtControlTime: 50,
          consumptionDigest: "runtime-security-consumption:one",
          grantRequestDigest: subject.runtimeSecurityRequest.grantRequestId.slice("grant-request:".length) as never,
          grantRequestId: subject.runtimeSecurityRequest.grantRequestId, operationId: subject.operationId,
          owner: "runtime_security", ownerEvidenceRef: "runtime-security-evidence:v1:one",
          provider: subject.provider, purpose: "contained-turn.provider-dispatch/v1",
          requestDigest: subject.runtimeSecurityRequest.requestDigest,
          scope: { ...subject.scope, scopeDigest: subject.scopeDigest },
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
              authorityFacts: subject.providerAccessExpectation, claimBeforeControlTime: 100,
              claimBindingDigest: subject.providerAccessRequest.claimBindingDigest, consumedAtControlTime: 50,
              consumptionDigest: "provider-access-consumption:one",
              grantRequestDigest: subject.providerAccessRequest.grantRequestId.slice("grant-request:".length) as never,
              grantRequestId: subject.providerAccessRequest.grantRequestId, operationId: subject.operationId,
              owner: "provider_access" as const, ownerEvidenceRef: "provider-access-evidence:v1:one",
              provider: subject.provider, purpose: "contained-turn.provider-dispatch/v1" as const,
              requestDigest: subject.providerAccessRequest.requestDigest,
              scope: { ...subject.scope, scopeDigest: subject.scopeDigest },
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
      settleConsumedGrant: async () => {
        providerSettlementCount += 1;
        return options.providerSettlementIndeterminateOnce === true && providerSettlementCount === 1
          ? { evidenceId: identity("evidence", "provider-grant-settlement-indeterminate"), kind: "indeterminate" }
          : { kind: "settled" };
      },
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
        if (operation.dispatch.kind !== "claimed" || operation.custodyId === undefined) {
          throw new TypeError("fixture execution closure requires claimed custody");
        }
        assert.equal(input.attemptId, operation.dispatch.attemptId);
        assert.equal(input.custodyId, operation.custodyId);
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
        const active = [...preparations.values()].findLast(candidate => candidate.kind === "active");
        if (active === undefined) {throw new Error("fixture custody requires an active preparation");}
        const selectedHostBootId = active.attemptId === attemptId
          ? hostBootId
          : identity("host_boot", `one-${active.attemptId}`);
        const selectedHostInstanceId = active.attemptId === attemptId
          ? hostInstanceId
          : identity("host_instance", `one-${active.attemptId}`);
        openedCustodies.push(active.custodyId);
        if (options.custodyOpenThrows === true) {throw new Error("custody failed after reserving identity");}
        return {
          custodyId: active.custodyId,
          hostBootId: selectedHostBootId,
          hostCustodyProof: {
            binding: {
              ...operationBinding(current as ContainedTurnKernelOperation),
              attemptId: active.attemptId,
              custodyId: active.custodyId,
              effectId,
            },
            kind: "host_custody",
            proofId: proofId(`host-custody-${active.attemptId}`),
          },
          hostInstanceId: selectedHostInstanceId,
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
        if (operation.dispatch.kind !== "claimed" || operation.custodyId === undefined ||
            operation.hostBootId === undefined || operation.hostInstanceId === undefined ||
            operation.workspaceId === undefined) {
          throw new TypeError("fixture containment requires exact claimed identities");
        }
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
              custodyId: operation.custodyId,
               cutoffProofId: operation.operationCutoff.kind === "closed" && "proofId" in operation.operationCutoff
                 ? operation.operationCutoff.proofId
                 : operation.admissionFence.kind === "fenced" ? operation.admissionFence.proofId : proof("cutoff"),
              executionClosureProofId: proof("execution_closure"),
              finalCursor: operation.output.chunks.length,
              hostBootId: operation.hostBootId,
              hostInstanceId: operation.hostInstanceId,
              immutableScopeDigest: operation.acceptedAuthorityVector.scopeDigest,
              outputDrainProofId: proof("output_drain"),
              physicalContainmentProofId: proof("physical_containment"),
              providerRouteRef: operation.providerAccessSnapshot.providerRouteRef,
              terminalObservationProofId: proof("provider_terminal_observation"),
               workspaceId: operation.workspaceId,
            },
            kind: "containment",
            proofId: proofId("containment"),
          },
        };
      },
      requestPhysicalContainment: async () => {
        containmentCalls.value += 1;
        const operation = current as ContainedTurnKernelOperation;
        if (operation.custodyId === undefined || operation.hostBootId === undefined ||
            operation.hostInstanceId === undefined) {
          throw new TypeError("fixture physical containment requires exact claimed identities");
        }
        return {
          kind: "contained",
          proof: { binding: { ...attemptBinding(operation), custodyId: operation.custodyId, hostBootId: operation.hostBootId, hostInstanceId: operation.hostInstanceId }, kind: "physical_containment", proofId: proofId("physical-containment") },
        };
      },
      start: async input => {
        custodyStartInputs.push(input);
        if (options.neverStart === true) {return new Promise(() => {});}
        const operation = current as ContainedTurnKernelOperation;
        if (operation.custodyId === undefined || operation.hostBootId === undefined ||
            operation.hostInstanceId === undefined) {
          throw new TypeError("fixture process start requires exact claimed identities");
        }
        const proof = { binding: { ...attemptBinding(operation), custodyId: operation.custodyId, hostBootId: operation.hostBootId, hostInstanceId: operation.hostInstanceId }, kind: "provider_process_start" as const, proofId: proofId("process-start") };
        let reportStart!: () => void;
        const observation = new Promise<import("../../../../dist/features/contained-agent-turn/application/ports/outbound/contained-turn-ports.js").ContainedTurnKernelProcessStartObservation>(resolve => {
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
        providerExecuteInputs.push(input);
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
  return {
    claimAuthorities, completionBoundaryReleases, containmentCalls, createdWorkspaces,
    custodyReleases, custodyStartInputs, current: () => current, dependencies,
    openedCustodies, providerCalls, providerExecuteInputs, workspaceQuarantines,
  };
};

export { awaitFixtureGate, createDependencies, custodyId, operationId, proofId };
