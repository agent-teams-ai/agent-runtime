import {
  containedTurnAuthorityVectorDigest,
  containedTurnCancellationFingerprint,
  containedTurnCommandFingerprint,
  containedTurnScopeDigest,
  validateContainedTurnAuthorityText,
  validateContainedTurnAuthorityShape,
  validateContainedTurnManifest,
} from "./contained-turn-authority.js";
import { containedTurnNoWorkspaceClosureFact } from "./contained-turn-closure-recovery.js";
import { parseContainedTurnCanonicalDigest } from "./contained-turn-codecs.js";
import {
  validateContainedTurnIdentity,
  type ContainedTurnEvidenceId,
} from "./contained-turn-identities.js";
import { validateContainedTurnHistory } from "./contained-turn-history.js";
import { containedTurnInvariant as invariant } from "./contained-turn-invariant.js";
import type { ContainedTurnKernelOperation } from "./contained-turn-kernel-model.js";
import { validateContainedTurnOperationShape } from "./contained-turn-operation-shape.js";
import {
  CONTAINED_TURN_LIMITS,
  isContainedTurnSchemaVersion,
  validateContainedTurnText,
} from "./contained-turn-limits.js";
import {
  containedTurnRequiredProofsSatisfied,
  requireContainedTurnProof,
  validateContainedTurnAxisProofs,
  validateContainedTurnProofBinding,
} from "./contained-turn-proof-validation.js";
import { containedTurnSatisfactionDigest } from "./contained-turn-satisfaction.js";
import { assertContainedTurnCanonicalArray, assertContainedTurnExactRecord } from "./contained-turn-record.js";
import { containedTurnOperationCutoffRevision } from "./contained-turn-output-authority.js";
import { validateContainedTurnRequiredReceiptSnapshot } from "./contained-turn-required-receipts.js";
import { validateContainedTurnOutput } from "./contained-turn-state-validation.js";

// The count exhaustively validates every disjoint identity axis and evidence source.
// oxlint-disable-next-line complexity
const validateIdentities = (operation: ContainedTurnKernelOperation): void => {
  const primary: string[] = [operation.commandId, operation.operationId, operation.effectId];
  if (operation.workspaceId !== undefined) {primary.push(operation.workspaceId);}
  if (operation.custodyId !== undefined) {primary.push(operation.custodyId);}
  if (operation.hostBootId !== undefined) {primary.push(operation.hostBootId);}
  if (operation.hostInstanceId !== undefined) {primary.push(operation.hostInstanceId);}
  if (operation.dispatch.kind === "claimed") {primary.push(operation.dispatch.attemptId);}
  if (operation.dispatch.kind === "claimed") {
    primary.push(
      operation.dispatch.executionGenerationId,
      operation.dispatch.preparationToken,
      operation.dispatch.writerFence,
    );
  }
  if (operation.cancellation.kind === "requested") {primary.push(operation.cancellation.command.cancellationCommandId);}
  for (const proof of operation.proofs) {primary.push(proof.proofId);}
  invariant(new Set(primary).size === primary.length, "identity namespaces must be textually disjoint");
  validateContainedTurnIdentity("command", operation.commandId);
  validateContainedTurnIdentity("operation", operation.operationId);
  validateContainedTurnIdentity("effect", operation.effectId);
  if (operation.workspaceId !== undefined) {validateContainedTurnIdentity("workspace", operation.workspaceId);}
  if (operation.custodyId !== undefined) {validateContainedTurnIdentity("custody", operation.custodyId);}
  if (operation.hostBootId !== undefined) {validateContainedTurnIdentity("host_boot", operation.hostBootId);}
  if (operation.hostInstanceId !== undefined) {validateContainedTurnIdentity("host_instance", operation.hostInstanceId);}
  if (operation.dispatch.kind === "claimed") {validateContainedTurnIdentity("attempt", operation.dispatch.attemptId);}
  if (operation.dispatch.kind === "claimed") {
    validateContainedTurnIdentity("execution_generation", operation.dispatch.executionGenerationId);
    validateContainedTurnIdentity("preparation", operation.dispatch.preparationToken);
    validateContainedTurnIdentity("writer_fence", operation.dispatch.writerFence);
  }
  if (operation.cancellation.kind === "requested") {
    validateContainedTurnIdentity("cancellation_command", operation.cancellation.command.cancellationCommandId);
  }
  for (const proof of operation.proofs) {validateContainedTurnIdentity("proof", proof.proofId);}
  const evidenceIds = new Set<ContainedTurnEvidenceId>();
  if (operation.providerProcessStart.kind === "unknown") {evidenceIds.add(operation.providerProcessStart.evidenceId);}
  if (operation.providerAcceptance.kind === "unknown") {evidenceIds.add(operation.providerAcceptance.evidenceId);}
  if (operation.providerExecution.kind === "unknown") {evidenceIds.add(operation.providerExecution.evidenceId);}
  if (operation.containment.kind === "uncertain") {evidenceIds.add(operation.containment.evidenceId);}
  if (operation.physicalContainment.kind === "uncertain") {evidenceIds.add(operation.physicalContainment.evidenceId);}
  if (operation.operationCutoff.kind === "closed" && operation.operationCutoff.reason === "continuity_lost") {
    evidenceIds.add(operation.operationCutoff.evidenceId);
  }
  if (operation.effect.kind === "ambiguous") {evidenceIds.add(operation.effect.evidenceId);}
  if (operation.reconciliation.kind === "required") {
    for (const evidenceId of operation.reconciliation.evidenceIds) {evidenceIds.add(evidenceId);}
  }
  if (operation.closureRecovery.kind === "required") {
    validateContainedTurnIdentity("closure_debt", operation.closureRecovery.debtId);
    validateContainedTurnIdentity("closure_request", operation.closureRecovery.requestId);
    for (const evidenceId of operation.closureRecovery.evidenceIds) {evidenceIds.add(evidenceId);}
  }
  for (const evidenceId of evidenceIds) {
    invariant(!primary.includes(evidenceId), "evidence and authority identity namespaces must be textually disjoint");
    validateContainedTurnIdentity("evidence", evidenceId);
  }
};

const validateCanonicalDigests = (operation: ContainedTurnKernelOperation): void => {
  parseContainedTurnCanonicalDigest(operation.acceptedAuthorityVectorDigest);
  parseContainedTurnCanonicalDigest(operation.commandFingerprint);
  parseContainedTurnCanonicalDigest(operation.requiredReceiptSetDigest);
  parseContainedTurnCanonicalDigest(operation.acceptedAuthorityVector.containmentPolicyDigest);
  if (operation.closureRecovery.kind === "required") {
    parseContainedTurnCanonicalDigest(operation.closureRecovery.requestDigest);
  } else if (operation.closureRecovery.kind === "proved_no_workspace") {
    parseContainedTurnCanonicalDigest(operation.closureRecovery.fact.factDigest);
  }
  parseContainedTurnCanonicalDigest(operation.acceptedAuthorityVector.providerAccessSnapshot.credentialBindingDigest);
  parseContainedTurnCanonicalDigest(operation.acceptedAuthorityVector.scopeDigest);
  parseContainedTurnCanonicalDigest(operation.acceptedAuthorityVector.securityDecisionDigest);
  if (operation.cancellation.kind === "requested") {
    parseContainedTurnCanonicalDigest(operation.cancellation.command.fingerprint);
    parseContainedTurnCanonicalDigest(operation.cancellation.command.scopeDigest);
  }
};

const validateAuthorityRevisionNamespace = (name: string, value: string, acceptedPrefixes: readonly string[]): void =>
  invariant(acceptedPrefixes.some((prefix) => value.startsWith(prefix)), `${name} must use its authority revision namespace`);

const validateAuthorityReferences = (operation: ContainedTurnKernelOperation): void => {
  const references: Array<readonly [string, string]> = [
    ["accessRef", operation.providerAccessSnapshot.accessRef],
    ["adapterRevision", operation.adapterSnapshot.adapterRevision],
    ["binaryRevision", operation.adapterSnapshot.binaryRevision],
    ["capabilityManifestRevision", operation.adapterSnapshot.capabilityManifestRevision],
    ["credentialBindingRef", operation.providerAccessSnapshot.credentialBindingRef],
    ["manifestRevision", operation.capabilityManifest.manifestRevision],
    ["operationAuthorityRevision", operation.acceptedAuthorityVector.operationAuthorityRevision],
    ["ownerAuthorityDigest", operation.providerAccessSnapshot.ownerAuthorityDigest],
    ["projectId", operation.providerAccessSnapshot.projectId],
    ["providerAccountRef", operation.providerAccessSnapshot.providerAccountRef],
    ["providerRouteRef", operation.providerAccessSnapshot.providerRouteRef],
    ["resourceScopeRevision", operation.capabilityManifest.resourceScopeRevision],
    ["securityAuthorityRevision", operation.acceptedAuthorityVector.securityAuthorityRevision],
    ["tenantId", operation.providerAccessSnapshot.tenantId],
  ];
  if (operation.artifactManifestRef !== undefined) {
    references.push(["artifactManifestRef", operation.artifactManifestRef]);
  }
  if (operation.resultRef !== undefined) {references.push(["resultRef", operation.resultRef]);}
  for (const [name, value] of references) {validateContainedTurnText(name, value, CONTAINED_TURN_LIMITS.text.identifier);}
  validateAuthorityRevisionNamespace(
    "operationAuthorityRevision",
    operation.acceptedAuthorityVector.operationAuthorityRevision,
    ["operation-authority:", "operation-revision:"],
  );
  validateAuthorityRevisionNamespace(
    "securityAuthorityRevision",
    operation.acceptedAuthorityVector.securityAuthorityRevision,
    ["security-authority:", "security-revision:"],
  );
  invariant(
    operation.acceptedAuthorityVector.operationAuthorityRevision !== operation.acceptedAuthorityVector.securityAuthorityRevision,
    "operation and security authority revisions must remain distinct",
  );
  invariant(
    Number.isSafeInteger(operation.providerAccessSnapshot.credentialGeneration) &&
      operation.providerAccessSnapshot.credentialGeneration >= 1 &&
      Number.isSafeInteger(operation.providerAccessSnapshot.revision) && operation.providerAccessSnapshot.revision >= 1,
    "Provider Access generation and revision must be positive safe integers",
  );
};

const hasAmbiguity = (operation: ContainedTurnKernelOperation): boolean =>
  operation.providerProcessStart.kind === "unknown" || operation.providerAcceptance.kind === "unknown" ||
  operation.providerExecution.kind === "unknown" || operation.containment.kind === "uncertain" ||
  operation.effect.kind === "ambiguous";

const noWorkspaceFactClosesReceipts = (operation: ContainedTurnKernelOperation): boolean => {
  if (operation.closureRecovery.kind !== "proved_no_workspace") {return false;}
  const expected = containedTurnNoWorkspaceClosureFact(operation);
  const fact = operation.closureRecovery.fact;
  if (expected === undefined || JSON.stringify(fact) !== JSON.stringify(expected) ||
      operation.artifactManifestRef !== undefined || operation.resultRef !== undefined) {
    return false;
  }
  const kinds = new Set(operation.proofs.map(proof => proof.kind));
  return [
    "acceptance", "no_dispatch", "no_start", "provider_not_started", "output_no_start_drain",
    "host_custody_no_start", "effect_no_start", "containment_not_required", "cutoff",
  ].every(kind => kinds.has(kind as never));
};

const validateTerminal = (operation: ContainedTurnKernelOperation): void => {
  if (operation.terminal.kind === "open") {return;}
  invariant(operation.reconciliation.kind === "clear", "reconciliation debt blocks terminal truth");
  invariant(operation.closureRecovery.kind !== "required", "closure recovery debt blocks terminal truth");
  invariant(!hasAmbiguity(operation), "ambiguous operation cannot become terminal");
  invariant(operation.output.fence.kind === "fenced", "terminal truth requires fenced output");
  invariant(operation.admissionFence.kind === "fenced", "terminal truth requires fenced admission");
  invariant(operation.effect.kind === "resolved", "terminal truth requires exact effect resolution");
  invariant(operation.providerExecution.kind === "closed", "terminal truth requires exact execution closure");
  if (operation.providerExecution.kind === "closed") {
    invariant(operation.providerExecution.outcome === operation.terminal.outcome, "terminal truth must match execution outcome");
  }
  invariant(operation.providerAcceptance.kind === "accepted" || operation.providerAcceptance.kind === "not_accepted", "terminal truth requires exact provider acceptance");
  if (operation.terminal.outcome === "succeeded") {
    invariant(operation.providerAcceptance.kind === "accepted", "successful terminal truth requires proved provider acceptance");
    invariant(
      operation.effect.kind === "resolved" && operation.effect.disposition === "committed",
      "successful terminal truth requires proved effect commitment",
    );
    invariant(
      operation.output.fence.kind === "fenced" && operation.output.fence.proofId !== undefined &&
        operation.proofs.some(proof => proof.kind === "output_drain" &&
          operation.output.fence.kind === "fenced" && proof.proofId === operation.output.fence.proofId),
      "successful terminal truth requires exact output-drain evidence",
    );
  }
  invariant(operation.containment.kind === "contained" || operation.containment.kind === "qualified_not_required", "terminal truth requires exact containment closure");
  invariant(
    (operation.artifactManifestRef !== undefined && operation.resultRef !== undefined) ||
      operation.closureRecovery.kind === "proved_no_workspace",
    "terminal truth requires artifact and result closure",
  );
  invariant(
    containedTurnRequiredProofsSatisfied(operation) || noWorkspaceFactClosesReceipts(operation),
    "terminal truth requires the exact frozen proof set",
  );
  const terminalObservation = operation.proofs.find(proof => proof.kind === "provider_terminal_observation");
  invariant(
    (terminalObservation?.kind === "provider_terminal_observation" && terminalObservation.binding.outcome === operation.terminal.outcome) ||
      ((operation.dispatch.kind === "prevented" || operation.providerProcessStart.kind === "proved_no_start") &&
        operation.proofs.some(proof => proof.kind === "provider_not_started")),
    "terminal truth must match the provider terminal observation",
  );
  invariant(operation.terminal.satisfactionDigest === containedTurnSatisfactionDigest(operation), "terminal satisfaction digest does not recompute");
  requireContainedTurnProof(operation, operation.terminal.terminalProofId, "terminal_truth");
};

const validateAuthorityBindings = (candidate: ContainedTurnKernelOperation): void => {
  invariant(candidate.adapterSnapshot.provider === candidate.providerAccessSnapshot.provider, "adapter and Provider Access snapshots must name the same provider");
  invariant(
    candidate.acceptedAuthorityVector.adapterSnapshot.adapterRevision === candidate.adapterSnapshot.adapterRevision &&
      candidate.acceptedAuthorityVector.adapterSnapshot.binaryRevision === candidate.adapterSnapshot.binaryRevision &&
      candidate.acceptedAuthorityVector.adapterSnapshot.capabilityManifestRevision === candidate.adapterSnapshot.capabilityManifestRevision &&
      candidate.acceptedAuthorityVector.adapterSnapshot.provider === candidate.adapterSnapshot.provider,
    "authority vector must bind the exact adapter snapshot",
  );
  invariant(
    candidate.acceptedAuthorityVector.providerAccessSnapshot.accessRef === candidate.providerAccessSnapshot.accessRef &&
      candidate.acceptedAuthorityVector.providerAccessSnapshot.credentialBindingDigest === candidate.providerAccessSnapshot.credentialBindingDigest &&
      candidate.acceptedAuthorityVector.providerAccessSnapshot.credentialBindingRef === candidate.providerAccessSnapshot.credentialBindingRef &&
      candidate.acceptedAuthorityVector.providerAccessSnapshot.credentialGeneration === candidate.providerAccessSnapshot.credentialGeneration &&
      candidate.acceptedAuthorityVector.providerAccessSnapshot.ownerAuthorityDigest === candidate.providerAccessSnapshot.ownerAuthorityDigest &&
      candidate.acceptedAuthorityVector.providerAccessSnapshot.projectId === candidate.providerAccessSnapshot.projectId &&
      candidate.acceptedAuthorityVector.providerAccessSnapshot.provider === candidate.providerAccessSnapshot.provider &&
      candidate.acceptedAuthorityVector.providerAccessSnapshot.providerAccountRef === candidate.providerAccessSnapshot.providerAccountRef &&
      candidate.acceptedAuthorityVector.providerAccessSnapshot.providerRouteRef === candidate.providerAccessSnapshot.providerRouteRef &&
      candidate.acceptedAuthorityVector.providerAccessSnapshot.revision === candidate.providerAccessSnapshot.revision &&
      candidate.acceptedAuthorityVector.providerAccessSnapshot.tenantId === candidate.providerAccessSnapshot.tenantId,
    "authority vector must bind the exact Provider Access snapshot",
  );
  invariant(candidate.acceptedAuthorityVector.scopeDigest === containedTurnScopeDigest(candidate.scope), "authority vector scope binding mismatch");
  invariant(
    candidate.providerAccessSnapshot.projectId === candidate.scope.projectId &&
      candidate.providerAccessSnapshot.tenantId === candidate.scope.tenantId,
    "Provider Access snapshot scope binding mismatch",
  );
  invariant(candidate.acceptedAuthorityVector.capabilityManifestRevision === candidate.capabilityManifest.manifestRevision, "authority vector manifest binding mismatch");
  invariant(candidate.acceptedAuthorityVectorDigest === containedTurnAuthorityVectorDigest(candidate.acceptedAuthorityVector), "accepted authority-vector digest does not recompute");
  invariant(candidate.commandFingerprint === containedTurnCommandFingerprint({ intent: candidate.intent, provider: candidate.adapterSnapshot.provider, scope: candidate.scope }), "command fingerprint does not recompute");
};

// The count is the frozen orthogonal execution-axis invariant matrix, not lifecycle branching.
// oxlint-disable-next-line complexity
const validateExecutionAxes = (candidate: ContainedTurnKernelOperation): void => {
  if (candidate.effect.kind === "resolved") {
    invariant(
      candidate.effect.disposition === "committed" || candidate.effect.disposition === "not_committed",
      "unknown effect disposition fails closed",
    );
  }
  if (candidate.providerExecution.kind === "closed") {
    invariant(
      candidate.providerExecution.outcome === "cancelled" || candidate.providerExecution.outcome === "failed" ||
        candidate.providerExecution.outcome === "succeeded",
      "unknown provider execution outcome fails closed",
    );
  }
  if (candidate.output.chunks.length > 0) {
    invariant(candidate.dispatch.kind === "claimed" && candidate.providerProcessStart.kind === "execution_started" && candidate.providerExecution.kind !== "not_started", "canonical output requires Host Custody-confirmed started execution authority");
  }
  if (candidate.dispatch.kind === "claimed") {
    requireContainedTurnProof(candidate, candidate.dispatch.claimProofId, "dispatch_claim");
    invariant(candidate.providerProcessStart.kind !== "unobserved" && (candidate.providerProcessStart.kind !== "pending" || candidate.providerProcessStart.attemptId === candidate.dispatch.attemptId), "dispatch claim must reserve exactly one pending provider start observation");
    invariant(candidate.workspaceId !== undefined && candidate.custodyId !== undefined && candidate.hostInstanceId !== undefined && candidate.hostBootId !== undefined, "dispatch requires allocated workspace and exact Host custody identities");
    invariant(candidate.admissionFence.kind === "fenced", "dispatch claim requires the exact persisted admission fence");
    invariant(
      candidate.containment.kind === "pending" || candidate.containment.kind === "uncertain" ||
        candidate.containment.kind === "contained" ||
        (candidate.providerProcessStart.kind === "proved_no_start" && candidate.containment.kind === "qualified_not_required"),
      "claimed dispatch requires attempt-bound containment state or proved process no-start",
    );
  } else {
    invariant(candidate.providerProcessStart.kind === "unobserved", "provider process start cannot be observed without a dispatch claim");
    invariant(candidate.providerExecution.kind !== "active", "provider execution cannot activate without a dispatch claim");
  }
  if (candidate.providerExecution.kind === "active") {
    invariant(candidate.providerProcessStart.kind === "execution_started" && candidate.dispatch.kind === "claimed" && candidate.providerExecution.attemptId === candidate.dispatch.attemptId, "execution_started applies only after Host Custody confirms actual process start");
  }
  if (candidate.providerProcessStart.kind === "pending") {invariant(candidate.providerExecution.kind === "not_started", "a custody reservation must never claim execution started");}
  if (candidate.providerProcessStart.kind === "proved_no_start") {
    invariant(candidate.providerExecution.kind !== "active", "proved no-start can never claim active execution");
    if (candidate.providerExecution.kind === "closed") {
      invariant(candidate.providerExecution.outcome === (candidate.cancellation.kind === "requested" ? "cancelled" : "failed"), "proved no-start has only the exact cancelled-or-failed terminal outcome");
    }
  }
  if (candidate.dispatch.kind === "unclaimed") {
    invariant(candidate.providerProcessStart.kind === "unobserved" && candidate.providerExecution.kind === "not_started" && candidate.providerAcceptance.kind === "unobserved", "unclaimed operation cannot manufacture provider truth");
    invariant(candidate.containment.kind === "not_requested" && candidate.effect.kind === "unresolved", "unclaimed operation cannot manufacture containment or effect truth");
  }
  if (candidate.dispatch.kind === "prevented") {
    requireContainedTurnProof(candidate, candidate.dispatch.noDispatchProofId, "no_dispatch");
    invariant(candidate.admissionFence.kind === "fenced" && candidate.output.fence.kind === "fenced", "dispatch prevention closes admission and output");
    invariant(candidate.providerExecution.kind === "closed" && candidate.providerAcceptance.kind === "not_accepted", "dispatch prevention requires distinct no-start and provider-not-started truth");
    invariant(candidate.containment.kind === "qualified_not_required" && candidate.effect.kind === "resolved", "dispatch prevention requires typed containment and effect non-applicability proofs");
    invariant(candidate.output.chunks.length === 0, "proved no dispatch cannot carry provider output");
    invariant(candidate.proofs.some(proof => proof.kind === "host_custody_no_start"), "dispatch prevention requires distinct Host-custody no-start proof");
  }
};

const validateCancellation = (candidate: ContainedTurnKernelOperation): void => {
  if (candidate.cancellation.kind !== "requested") {return;}
  const cancellation = candidate.cancellation;
  assertContainedTurnExactRecord("cancellation command", cancellation.command, [
    "cancellationCommandId", "fingerprint", "operationId", "scopeDigest",
  ]);
  const expectedScopeDigest = containedTurnScopeDigest(candidate.scope);
  invariant(
    cancellation.command.operationId === candidate.operationId &&
      cancellation.command.scopeDigest === expectedScopeDigest,
    "cancellation command subject binding mismatch",
  );
  invariant(
    cancellation.command.fingerprint === containedTurnCancellationFingerprint(cancellation.command),
    "cancellation fingerprint does not recompute",
  );
  requireContainedTurnProof(candidate, cancellation.proofId, "cancellation");
  invariant(candidate.admissionFence.kind === "fenced", "durable cancellation requires a persisted admission fence");
  invariant(
    candidate.operationCutoff.kind === "closed" && candidate.operationCutoff.reason === "cancellation",
    "durable cancellation requires the current monotonic operation cutoff",
  );
  if (candidate.operationCutoff.kind === "closed" && candidate.operationCutoff.reason === "cancellation") {
    const cutoffProof = requireContainedTurnProof(candidate, candidate.operationCutoff.proofId, "cutoff");
    invariant(
      cutoffProof.kind === "cutoff" &&
        cutoffProof.binding.cancellationCommandId === cancellation.command.cancellationCommandId,
      "a cancellation cutoff must bind the exact cancellation command",
    );
  }
};

const validateCutoffAndPhysicalContainment = (candidate: ContainedTurnKernelOperation): void => {
  containedTurnOperationCutoffRevision(candidate.operationCutoff.revision);
  if (candidate.operationCutoff.kind === "closed") {
    invariant(candidate.output.fence.kind === "fenced", "closed operation cutoff must close canonical output authority");
    if (candidate.operationCutoff.reason === "continuity_lost") {
      invariant(
        candidate.reconciliation.kind === "required" &&
          candidate.reconciliation.evidenceIds.includes(candidate.operationCutoff.evidenceId),
        "continuity-loss cutoff requires its exact durable reconciliation evidence",
      );
    } else {
      requireContainedTurnProof(candidate, candidate.operationCutoff.proofId, "cutoff");
    }
  }
  if (candidate.dispatch.kind === "claimed") {
    containedTurnOperationCutoffRevision(candidate.dispatch.operationCutoffRevision);
    invariant(
      candidate.operationCutoff.revision >= candidate.dispatch.operationCutoffRevision &&
        (candidate.operationCutoff.kind === "closed" ||
          candidate.operationCutoff.revision === candidate.dispatch.operationCutoffRevision),
      "dispatch must bind the current monotonic cutoff revision",
    );
  }
  switch (candidate.physicalContainment.kind) {
    case "not_requested":
      invariant(candidate.dispatch.kind !== "claimed", "claimed execution requires a physical-containment obligation");
      break;
    case "pending":
      invariant(
        candidate.dispatch.kind === "claimed" && candidate.physicalContainment.attemptId === candidate.dispatch.attemptId,
        "physical-containment obligation must bind the sole attempt",
      );
      break;
    case "contained":
      invariant(candidate.dispatch.kind === "claimed", "physical containment requires the sole attempt");
      requireContainedTurnProof(candidate, candidate.physicalContainment.proofId, "physical_containment");
      break;
    case "uncertain":
      invariant(
        candidate.dispatch.kind === "claimed" && candidate.reconciliation.kind === "required" &&
          candidate.reconciliation.evidenceIds.includes(candidate.physicalContainment.evidenceId),
        "uncertain physical containment requires exact reconciliation debt",
      );
      break;
  }
  if (candidate.containment.kind === "contained") {
    invariant(candidate.physicalContainment.kind === "contained", "composite containment requires physical containment first");
  }
  if (candidate.artifactManifestRef !== undefined) {
    invariant(
      candidate.physicalContainment.kind === "contained" || candidate.containment.kind === "qualified_not_required",
      "canonical artifacts require physical containment or proved no-start non-applicability",
    );
  }
};

// Complexity here is the explicit conjunction of orthogonal, fail-closed invariant families.
// oxlint-disable-next-line complexity
export const validateContainedTurnOperation = (
  candidate: ContainedTurnKernelOperation,
  options: Readonly<{ readonly previous?: ContainedTurnKernelOperation }> = {},
): void => {
  validateContainedTurnOperationShape(candidate);
  assertContainedTurnCanonicalArray(candidate.proofs);
  assertContainedTurnCanonicalArray(candidate.output.chunks);
  if (candidate.reconciliation.kind === "required") {
    assertContainedTurnCanonicalArray(candidate.reconciliation.evidenceIds);
  }
  if (candidate.closureRecovery.kind === "required") {
    assertContainedTurnCanonicalArray(candidate.closureRecovery.evidenceIds);
  }
  if (candidate.closureRecovery.kind === "proved_no_workspace") {
    invariant(noWorkspaceFactClosesReceipts(candidate), "no-workspace closure fact must be exact and authority-bound");
  }
  invariant(isContainedTurnSchemaVersion(candidate.schemaVersion), "unsupported contained-turn schema version");
  invariant(Number.isSafeInteger(candidate.revision) && candidate.revision >= 0, "revision must be a non-negative safe integer");
  if (candidate.revision === 0) {
    invariant(
      candidate.admissionFence.kind === "open" && candidate.cancellation.kind === "open" &&
        candidate.containment.kind === "not_requested" && candidate.dispatch.kind === "unclaimed" &&
        candidate.effect.kind === "unresolved" && candidate.output.chunks.length === 0 &&
        candidate.output.fence.kind === "open" && candidate.proofs.length === 3 &&
        candidate.operationCutoff.kind === "open" && candidate.operationCutoff.revision === 0 &&
        candidate.physicalContainment.kind === "not_requested" &&
        candidate.providerAcceptance.kind === "unobserved" && candidate.providerExecution.kind === "not_started" &&
        candidate.providerProcessStart.kind === "unobserved" && candidate.reconciliation.kind === "clear" &&
        candidate.closureRecovery.kind === "clear" &&
        candidate.terminal.kind === "open",
      "revision zero is reserved for exact command-acceptance truth",
    );
  }
  validateContainedTurnAuthorityText(candidate);
  validateContainedTurnAuthorityShape(candidate);
  validateAuthorityReferences(candidate);
  validateCanonicalDigests(candidate);
  validateContainedTurnRequiredReceiptSnapshot({
    digest: candidate.requiredReceiptSetDigest,
    set: candidate.requiredReceiptSet,
  });
  validateContainedTurnManifest(candidate.capabilityManifest, candidate.adapterSnapshot);
  invariant(candidate.capabilityManifest.supportedModes.includes(candidate.intent.mode), "unknown or missing requested capability scope fails closed");
  validateAuthorityBindings(candidate);
  invariant(candidate.proofs.length <= CONTAINED_TURN_LIMITS.collections.proofs, "proof limit exceeded");
  invariant(new Set(candidate.proofs.map(proof => proof.proofId)).size === candidate.proofs.length, "proof IDs must be unique");
  const singletonProofKinds = candidate.proofs.filter(proof => proof.kind !== "cutoff").map(proof => proof.kind);
  invariant(
    new Set(singletonProofKinds).size === singletonProofKinds.length,
    "V1 proof kinds other than monotonic cutoff receipts may be satisfied exactly once",
  );
  validateIdentities(candidate);
  candidate.proofs.forEach(proof => validateContainedTurnProofBinding(candidate, proof));
  const firstProof = candidate.proofs[0];
  invariant(firstProof !== undefined, "command acceptance requires its own exact proof");
  if (firstProof !== undefined) {requireContainedTurnProof(candidate, firstProof.proofId, "acceptance");}
  validateContainedTurnAxisProofs(candidate);
  validateContainedTurnOutput(candidate);
  validateExecutionAxes(candidate);
  validateCutoffAndPhysicalContainment(candidate);
  if (hasAmbiguity(candidate)) {
    invariant(candidate.reconciliation.kind === "required" && candidate.reconciliation.evidenceIds.length > 0, "ambiguity requires durable reconciliation debt");
    invariant(candidate.output.fence.kind === "fenced", "ambiguity immediately fences canonical output");
  }
  validateCancellation(candidate);
  validateTerminal(candidate);
  if (options.previous !== undefined) {
    if (options.previous.closureRecovery.kind === "proved_no_workspace") {
      invariant(
        candidate.closureRecovery.kind === "proved_no_workspace" &&
          JSON.stringify(candidate.closureRecovery.fact) === JSON.stringify(options.previous.closureRecovery.fact),
        "proved no-workspace closure cannot reopen or change",
      );
    }
    validateContainedTurnHistory(candidate, options.previous, invariant);
  }
};
