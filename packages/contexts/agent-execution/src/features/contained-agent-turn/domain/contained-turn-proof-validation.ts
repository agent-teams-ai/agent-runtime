import { containedTurnProviderAccessSnapshotDigest } from "./contained-turn-authority.js";
import type { ContainedTurnAttemptId, ContainedTurnProofId } from "./contained-turn-identities.js";
import { containedTurnInvariant as invariant } from "./contained-turn-invariant.js";
import type { ContainedTurnKernelOperation } from "./contained-turn-kernel-model.js";
import { assertContainedTurnExactRecord } from "./contained-turn-record.js";
import { parseContainedTurnCanonicalDigest } from "./contained-turn-codecs.js";
import {
  type ContainedTurnProof,
  type ContainedTurnProofKind,
} from "./contained-turn-proofs.js";
import { containedTurnRequiredReceiptsSatisfied } from "./contained-turn-required-receipts.js";

const OPERATION_BINDING_KEYS = ["authorityVectorDigest", "operationId"] as const;
const ATTEMPT_BINDING_KEYS = [...OPERATION_BINDING_KEYS, "attemptId", "effectId"] as const;

const assertExactKeys = (name: string, value: object, expected: readonly string[]): void => {
  assertContainedTurnExactRecord(name, value, expected);
};

// Exhaustive by proof kind so no proof can smuggle unbound authority fields.
// oxlint-disable-next-line complexity
const validateProofShape = (proof: ContainedTurnProof): void => {
  assertExactKeys(`${proof.kind} proof`, proof, ["binding", "kind", "proofId"]);
  const exactBinding = (keys: readonly string[]): void => assertExactKeys(`${proof.kind} proof binding`, proof.binding, keys);
  switch (proof.kind) {
    case "acceptance":
      exactBinding([...OPERATION_BINDING_KEYS, "commandFingerprint", "commandId"]);
      break;
    case "artifact_manifest_seal":
      exactBinding([...OPERATION_BINDING_KEYS, "artifactManifestRef", "workspaceId"]);
      break;
    case "cancellation":
      exactBinding([...OPERATION_BINDING_KEYS, "cancellationCommandId", "cancellationFingerprint"]);
      break;
    case "containment":
      exactBinding([
        ...ATTEMPT_BINDING_KEYS, "adapterRevision", "artifactManifestSealProofId", "binaryRevision",
        "capabilityManifestRevision", "containmentPolicyDigest", "credentialBindingDigest", "custodyId",
        "cutoffProofId", "executionClosureProofId", "finalCursor", "hostBootId", "hostInstanceId",
        "immutableScopeDigest", "outputDrainProofId",
        ...(proof.binding.physicalContainmentProofId === undefined ? [] : ["physicalContainmentProofId"]),
        "providerRouteRef", "terminalObservationProofId", "workspaceId",
      ]);
      break;
    case "cutoff":
      exactBinding(proof.binding.cancellationCommandId === undefined
        ? OPERATION_BINDING_KEYS
        : [...OPERATION_BINDING_KEYS, "cancellationCommandId"]);
      break;
    case "dispatch_claim":
      exactBinding([...ATTEMPT_BINDING_KEYS, "providerAccessDispatchProofId", "runtimeSecurityDispatchProofId"]);
      break;
    case "provider_access_acceptance":
      exactBinding([...OPERATION_BINDING_KEYS, "resolutionDigest", "snapshotDigest"]);
      break;
    case "provider_access_dispatch":
      exactBinding([...OPERATION_BINDING_KEYS, "acceptedSnapshotDigest", "resolutionDigest"]);
      break;
    case "runtime_security_acceptance":
      exactBinding([...OPERATION_BINDING_KEYS, "securityAuthorityRevision", "securityDecisionDigest"]);
      break;
    case "runtime_security_dispatch":
      exactBinding([...OPERATION_BINDING_KEYS, "acceptedSecurityDecisionDigest", "currentSecurityDecisionDigest", "securityAuthorityRevision"]);
      break;
    case "effect_resolution":
    case "provider_acceptance":
      exactBinding([...ATTEMPT_BINDING_KEYS, "disposition"]);
      break;
    case "effect_no_start":
      exactBinding([...OPERATION_BINDING_KEYS, "disposition", "effectId"]);
      break;
    case "execution_closure":
    case "provider_terminal_observation":
      exactBinding([...ATTEMPT_BINDING_KEYS, "outcome"]);
      break;
    case "host_custody":
      exactBinding([...ATTEMPT_BINDING_KEYS, "custodyId"]);
      break;
    case "output_drain":
      exactBinding([...ATTEMPT_BINDING_KEYS, "finalCursor"]);
      break;
    case "output_no_start_drain":
      exactBinding([...OPERATION_BINDING_KEYS, "finalCursor"]);
      break;
    case "provider_process_no_start":
    case "provider_process_start":
      exactBinding([...ATTEMPT_BINDING_KEYS, "custodyId", "hostBootId", "hostInstanceId"]);
      break;
    case "physical_containment":
      exactBinding([...ATTEMPT_BINDING_KEYS, "custodyId", "hostBootId", "hostInstanceId"]);
      break;
    case "result_publication":
      exactBinding([...OPERATION_BINDING_KEYS, "resultRef"]);
      break;
    case "terminal_truth":
      exactBinding([
        ...OPERATION_BINDING_KEYS, "requiredReceiptSetDigest", "requiredReceiptSetVersion",
        "satisfactionDigest", "terminalOutcome",
      ]);
      break;
    case "workspace_closure":
      exactBinding([...OPERATION_BINDING_KEYS, "workspaceId"]);
      break;
    case "containment_not_required":
    case "host_custody_no_start":
    case "no_dispatch":
    case "no_start":
    case "provider_not_started":
      exactBinding([...OPERATION_BINDING_KEYS, "effectId"]);
      break;
    default: {
      const exhaustiveProofKind: never = proof;
      throw new TypeError(`unknown proof kind fails closed: ${String(exhaustiveProofKind)}`);
    }
  }
};

const proofById = (
  operation: ContainedTurnKernelOperation,
  proofId: ContainedTurnProofId,
): ContainedTurnProof | undefined => operation.proofs.find(proof => proof.proofId === proofId);

export const requireContainedTurnProof = (
  operation: ContainedTurnKernelOperation,
  proofId: ContainedTurnProofId,
  kind: ContainedTurnProofKind,
): ContainedTurnProof => {
  const proof = proofById(operation, proofId);
  invariant(proof?.kind === kind, `${kind} requires its own exact proof kind and ID`);
  return proof as ContainedTurnProof;
};

const attemptId = (operation: ContainedTurnKernelOperation): ContainedTurnAttemptId | undefined =>
  operation.dispatch.kind === "claimed" ? operation.dispatch.attemptId : undefined;

// The count is the exhaustive closed proof union; every case validates distinct subject bindings.
// oxlint-disable-next-line complexity, max-lines-per-function
export const validateContainedTurnProofBinding = (
  operation: ContainedTurnKernelOperation,
  proof: ContainedTurnProof,
): void => {
  validateProofShape(proof);
  invariant(proof.binding.operationId === operation.operationId, `${proof.kind} proof operation binding mismatch`);
  invariant(
    proof.binding.authorityVectorDigest === operation.acceptedAuthorityVectorDigest,
    `${proof.kind} proof authority-vector binding mismatch`,
  );
  const currentAttemptId = attemptId(operation);
  if ("attemptId" in proof.binding) {
    invariant(currentAttemptId !== undefined && proof.binding.attemptId === currentAttemptId, `${proof.kind} proof attempt binding mismatch`);
    invariant(proof.binding.effectId === operation.effectId, `${proof.kind} proof effect binding mismatch`);
  }
  switch (proof.kind) {
    case "acceptance":
      invariant(proof.binding.commandId === operation.commandId, "acceptance proof command binding mismatch");
      invariant(proof.binding.commandFingerprint === operation.commandFingerprint, "acceptance proof fingerprint mismatch");
      break;
    case "artifact_manifest_seal":
      invariant(proof.binding.artifactManifestRef === operation.artifactManifestRef, "artifact proof manifest binding mismatch");
      invariant(proof.binding.workspaceId === operation.workspaceId, "artifact proof workspace binding mismatch");
      break;
    case "cancellation":
      invariant(operation.cancellation.kind === "requested", "cancellation proof requires a cancellation command");
      if (operation.cancellation.kind === "requested") {
        invariant(proof.binding.cancellationCommandId === operation.cancellation.command.cancellationCommandId, "cancellation proof command binding mismatch");
        invariant(proof.binding.cancellationFingerprint === operation.cancellation.command.fingerprint, "cancellation proof fingerprint mismatch");
      }
      break;
    case "containment":
      invariant(proof.binding.adapterRevision === operation.adapterSnapshot.adapterRevision, "containment proof adapter binding mismatch");
      invariant(proof.binding.binaryRevision === operation.adapterSnapshot.binaryRevision, "containment proof binary binding mismatch");
      invariant(proof.binding.capabilityManifestRevision === operation.capabilityManifest.manifestRevision, "containment proof manifest binding mismatch");
      invariant(proof.binding.containmentPolicyDigest === operation.acceptedAuthorityVector.containmentPolicyDigest, "containment proof policy binding mismatch");
      invariant(proof.binding.credentialBindingDigest === operation.providerAccessSnapshot.credentialBindingDigest, "containment proof credential binding mismatch");
      invariant(proof.binding.custodyId === operation.custodyId, "containment proof custody binding mismatch");
      invariant(
        proof.binding.cutoffProofId === (operation.operationCutoff.kind === "closed" &&
          "proofId" in operation.operationCutoff
          ? operation.operationCutoff.proofId
          : operation.admissionFence.kind === "fenced" ? operation.admissionFence.proofId : undefined),
        "containment proof must attest the exact current operation cutoff",
      );
      invariant(proof.binding.workspaceId === operation.workspaceId, "containment proof workspace binding mismatch");
      invariant(proof.binding.finalCursor === operation.output.chunks.length, "containment proof output cursor mismatch");
      invariant(proof.binding.hostBootId === operation.hostBootId, "containment proof host boot binding mismatch");
      invariant(proof.binding.hostInstanceId === operation.hostInstanceId, "containment proof host instance binding mismatch");
      invariant(proof.binding.immutableScopeDigest === operation.acceptedAuthorityVector.scopeDigest, "containment proof scope binding mismatch");
      invariant(proof.binding.providerRouteRef === operation.providerAccessSnapshot.providerRouteRef, "containment proof route binding mismatch");
      invariant(
        operation.physicalContainment.kind === "contained" &&
          proof.binding.physicalContainmentProofId === operation.physicalContainment.proofId,
        "containment proof must bind the exact earlier physical-containment proof",
      );
      requireContainedTurnProof(operation, proof.binding.artifactManifestSealProofId, "artifact_manifest_seal");
      requireContainedTurnProof(operation, proof.binding.executionClosureProofId, "execution_closure");
      requireContainedTurnProof(operation, proof.binding.outputDrainProofId, "output_drain");
      requireContainedTurnProof(operation, proof.binding.terminalObservationProofId, "provider_terminal_observation");
      break;
    case "cutoff":
      if (operation.cancellation.kind === "requested" && proof.binding.cancellationCommandId !== undefined) {
        invariant(proof.binding.cancellationCommandId === operation.cancellation.command.cancellationCommandId, "cutoff proof cancellation binding mismatch");
      } else {invariant(proof.binding.cancellationCommandId === undefined, "non-cancellation cutoff proof cannot bind a cancellation command");}
      break;
    case "effect_resolution":
      invariant(operation.effect.kind === "resolved" && proof.binding.disposition === operation.effect.disposition, "effect proof disposition mismatch");
      break;
    case "effect_no_start":
      invariant(operation.effect.kind === "resolved" && operation.effect.disposition === "not_committed", "no-start effect proof disposition mismatch");
      invariant(proof.binding.effectId === operation.effectId, "no-start effect proof binding mismatch");
      break;
    case "host_custody":
      invariant(proof.binding.custodyId === operation.custodyId, "host-custody proof identity mismatch");
      break;
    case "output_drain":
    case "output_no_start_drain":
      invariant(proof.binding.finalCursor === operation.output.chunks.length, `${proof.kind} final cursor mismatch`);
      break;
    case "provider_process_no_start":
    case "provider_process_start":
      invariant(proof.binding.custodyId === operation.custodyId, `${proof.kind} proof custody binding mismatch`);
      invariant(proof.binding.hostBootId === operation.hostBootId, `${proof.kind} proof Host boot binding mismatch`);
      invariant(proof.binding.hostInstanceId === operation.hostInstanceId, `${proof.kind} proof Host instance binding mismatch`);
      break;
    case "physical_containment":
      invariant(operation.dispatch.kind === "claimed", "physical containment requires the sole claimed attempt");
      invariant(proof.binding.custodyId === operation.custodyId, "physical containment custody binding mismatch");
      invariant(proof.binding.hostBootId === operation.hostBootId, "physical containment Host boot binding mismatch");
      invariant(proof.binding.hostInstanceId === operation.hostInstanceId, "physical containment Host instance binding mismatch");
      break;
    case "result_publication":
      invariant(proof.binding.resultRef === operation.resultRef, "result proof binding mismatch");
      break;
    case "provider_acceptance":
      invariant(
        (operation.providerAcceptance.kind === "accepted" || operation.providerAcceptance.kind === "not_accepted") &&
          proof.binding.disposition === operation.providerAcceptance.kind,
        "provider-acceptance proof disposition mismatch",
      );
      break;
    case "provider_access_acceptance":
      invariant(
        proof.binding.snapshotDigest === containedTurnProviderAccessSnapshotDigest(operation.providerAccessSnapshot),
        "Provider Access acceptance proof snapshot binding mismatch",
      );
      parseContainedTurnCanonicalDigest(proof.binding.resolutionDigest);
      break;
    case "provider_access_dispatch":
      invariant(
        proof.binding.acceptedSnapshotDigest === containedTurnProviderAccessSnapshotDigest(operation.providerAccessSnapshot),
        "Provider Access dispatch proof accepted-snapshot binding mismatch",
      );
      parseContainedTurnCanonicalDigest(proof.binding.resolutionDigest);
      break;
    case "runtime_security_acceptance":
      invariant(
        proof.binding.securityAuthorityRevision === operation.acceptedAuthorityVector.securityAuthorityRevision &&
          proof.binding.securityDecisionDigest === operation.acceptedAuthorityVector.securityDecisionDigest,
        "Runtime Security acceptance proof binding mismatch",
      );
      break;
    case "runtime_security_dispatch":
      invariant(
        proof.binding.securityAuthorityRevision === operation.acceptedAuthorityVector.securityAuthorityRevision &&
          proof.binding.acceptedSecurityDecisionDigest === operation.acceptedAuthorityVector.securityDecisionDigest,
        "Runtime Security dispatch proof accepted-decision binding mismatch",
      );
      parseContainedTurnCanonicalDigest(proof.binding.currentSecurityDecisionDigest);
      break;
    case "terminal_truth":
      invariant(operation.terminal.kind === "final", "terminal proof requires final terminal truth");
      if (operation.terminal.kind === "final") {
        invariant(proof.binding.terminalOutcome === operation.terminal.outcome, "terminal proof outcome mismatch");
        invariant(proof.binding.satisfactionDigest === operation.terminal.satisfactionDigest, "terminal proof satisfaction mismatch");
        invariant(proof.binding.requiredReceiptSetDigest === operation.requiredReceiptSetDigest, "terminal proof receipt-set digest mismatch");
        invariant(proof.binding.requiredReceiptSetVersion === operation.requiredReceiptSet.setVersion, "terminal proof receipt-set version mismatch");
      }
      break;
    case "workspace_closure":
      invariant(proof.binding.workspaceId === operation.workspaceId, "workspace proof binding mismatch");
      break;
    case "dispatch_claim":
      invariant(operation.dispatch.kind === "claimed", "dispatch proof requires claimed dispatch");
      if (operation.dispatch.kind === "claimed") {
        invariant(
          proof.binding.providerAccessDispatchProofId === operation.dispatch.providerAccessDispatchProofId &&
            proof.binding.runtimeSecurityDispatchProofId === operation.dispatch.runtimeSecurityDispatchProofId,
          "dispatch claim must bind the exact current authority evidence",
        );
        requireContainedTurnProof(operation, proof.binding.providerAccessDispatchProofId, "provider_access_dispatch");
        requireContainedTurnProof(operation, proof.binding.runtimeSecurityDispatchProofId, "runtime_security_dispatch");
      }
      invariant(proof.binding.effectId === operation.effectId, `${proof.kind} proof effect binding mismatch`);
      break;
    case "containment_not_required":
    case "host_custody_no_start":
    case "no_dispatch":
    case "no_start":
    case "provider_not_started":
      invariant(proof.binding.effectId === operation.effectId, `${proof.kind} proof effect binding mismatch`);
      break;
    case "provider_terminal_observation":
    case "execution_closure":
      invariant(
        operation.providerExecution.kind === "closed" && proof.binding.outcome === operation.providerExecution.outcome,
        `${proof.kind} outcome mismatch`,
      );
      break;
  }
};

export const containedTurnRequiredProofsSatisfied = (operation: ContainedTurnKernelOperation): boolean => {
  return containedTurnRequiredReceiptsSatisfied(
    { digest: operation.requiredReceiptSetDigest, set: operation.requiredReceiptSet },
    operation.proofs,
  );
};

// The branches are the closed set of independently evidenced execution axes.
// oxlint-disable-next-line complexity
export const validateContainedTurnAxisProofs = (operation: ContainedTurnKernelOperation): void => {
  invariant(operation.proofs.some(proof => proof.kind === "provider_access_acceptance"), "Provider Access acceptance requires its own proof");
  invariant(operation.proofs.some(proof => proof.kind === "runtime_security_acceptance"), "Runtime Security acceptance requires its own proof");
  if (operation.admissionFence.kind === "fenced") {requireContainedTurnProof(operation, operation.admissionFence.proofId, "cutoff");}
  if (operation.providerProcessStart.kind === "execution_started") {
    requireContainedTurnProof(operation, operation.providerProcessStart.proofId, "provider_process_start");
  }
  if (operation.dispatch.kind === "claimed") {
    requireContainedTurnProof(operation, operation.dispatch.providerAccessDispatchProofId, "provider_access_dispatch");
    requireContainedTurnProof(operation, operation.dispatch.runtimeSecurityDispatchProofId, "runtime_security_dispatch");
  }
  if (operation.providerProcessStart.kind === "proved_no_start") {
    requireContainedTurnProof(operation, operation.providerProcessStart.proofId, "provider_process_no_start");
  }
  if (operation.providerExecution.kind === "closed") {
    const proof = proofById(operation, operation.providerExecution.proofId);
    invariant(
      proof?.kind === (operation.dispatch.kind === "prevented" || operation.providerProcessStart.kind === "proved_no_start"
        ? "no_start" : "execution_closure"),
      "execution closure requires the dispatch-applicable exact proof",
    );
  }
  if (operation.providerAcceptance.kind === "accepted" || operation.providerAcceptance.kind === "not_accepted") {
    const proof = proofById(operation, operation.providerAcceptance.proofId);
    invariant(
      proof?.kind === (operation.dispatch.kind === "prevented" || operation.providerProcessStart.kind === "proved_no_start"
        ? "provider_not_started" : "provider_acceptance"),
      "provider acceptance requires the dispatch-applicable exact proof",
    );
  }
  if (operation.containment.kind === "contained") {requireContainedTurnProof(operation, operation.containment.proofId, "containment");}
  if (operation.physicalContainment.kind === "contained") {
    requireContainedTurnProof(operation, operation.physicalContainment.proofId, "physical_containment");
  }
  if (operation.containment.kind === "qualified_not_required") {
    invariant(
      operation.dispatch.kind === "prevented" || operation.providerProcessStart.kind === "proved_no_start",
      "containment non-applicability requires proved no dispatch or proved no process start",
    );
    requireContainedTurnProof(operation, operation.containment.proofId, "containment_not_required");
  }
  if (operation.effect.kind === "resolved") {
    const proof = proofById(operation, operation.effect.proofId);
    invariant(
      proof?.kind === (operation.dispatch.kind === "prevented" || operation.providerProcessStart.kind === "proved_no_start"
        ? "effect_no_start" : "effect_resolution"),
      "effect resolution requires the dispatch-applicable exact proof",
    );
  }
};
