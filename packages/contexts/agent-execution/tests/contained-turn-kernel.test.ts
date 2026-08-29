import assert from "node:assert/strict";
import test from "node:test";

import {
  containedTurnAuthorityVectorDigest,
  containedTurnCancellationFingerprint,
  containedTurnCommandFingerprint,
  containedTurnScopeDigest,
  CONTAINED_TURN_REQUIRED_PROOF_KINDS,
  type ContainedTurnAuthorityVector,
  type ContainedTurnCancellationCommand,
  type ContainedTurnCapabilityManifest,
  type ContainedTurnProviderAccessSnapshot,
  type ContainedTurnProviderAdapterSnapshot,
} from "../src/features/contained-agent-turn/domain/contained-turn-authority.js";
import {
  digestContainedTurnCanonicalValue,
  type ContainedTurnCanonicalDigest,
} from "../src/features/contained-agent-turn/domain/contained-turn-codecs.js";
import {
  containedTurnSatisfactionDigest,
  createContainedTurnOperation,
  mutateContainedTurnOperation,
  validateContainedTurnOperation,
  type ContainedTurnKernelOperation,
} from "../src/features/contained-agent-turn/domain/contained-turn-kernel.js";
import { CONTAINED_TURN_LIMITS } from "../src/features/contained-agent-turn/domain/contained-turn-limits.js";
import {
  containedTurnIdentity,
  CONTAINED_TURN_IDENTITY_PREFIXES,
} from "../src/features/contained-agent-turn/domain/contained-turn-identities.js";
import {
  CONTAINED_TURN_PROOF_KINDS,
  type ContainedTurnProof,
  type ContainedTurnProofKind,
} from "../src/features/contained-agent-turn/domain/contained-turn-proofs.js";
import {
  CONTAINED_TURN_DEPENDENCY_NAMES,
  validateContainedTurnKernelDependencies,
  type ContainedTurnKernelDependencies,
  type ContainedTurnKernelOperationStore,
} from "../src/features/contained-agent-turn/application/ports/outbound/contained-turn-ports.js";

type SameUnion<Left, Right> =
  [Exclude<Left, Right>, Exclude<Right, Left>] extends [never, never] ? true : false;

const dependencyNamesAreExhaustive: SameUnion<
  keyof ContainedTurnKernelDependencies,
  (typeof CONTAINED_TURN_DEPENDENCY_NAMES)[number]
> = true;
const proofKindsAreExhaustive: SameUnion<
  ContainedTurnProofKind,
  (typeof CONTAINED_TURN_PROOF_KINDS)[number]
> = true;

const scope = Object.freeze({ projectId: "project:kernel", tenantId: "tenant:kernel" });
const intent = Object.freeze({ mode: "analysis" as const, prompt: "Inspect the disposable workspace." });
const adapterSnapshot: ContainedTurnProviderAdapterSnapshot = Object.freeze({
  adapterRevision: "adapter:codex:1",
  binaryRevision: "binary:codex:1",
  capabilityManifestRevision: "manifest:codex:1",
  provider: "codex",
});
const providerAccessSnapshot: ContainedTurnProviderAccessSnapshot = Object.freeze({
  accessRef: "access:1",
  accessRevision: "access-revision:1",
  accountRef: "account:1",
  accountRevision: "account-revision:1",
  credentialBindingDigest: digestContainedTurnCanonicalValue({ binding: "opaque:1" }),
  credentialBindingGeneration: "credential-generation:1",
  credentialBindingRef: "credential-binding:1",
  credentialBindingRevision: "credential-revision:1",
  provider: "codex",
  providerRouteRef: "provider-route:1",
  providerRouteRevision: "route-revision:1",
});
const manifest: ContainedTurnCapabilityManifest = Object.freeze({
  effectCardinality: "one_coarse_effect_per_operation",
  effectClass: "contained_unmediated_effect",
  manifestRevision: adapterSnapshot.capabilityManifestRevision,
  manifestVersion: 1,
  provider: "codex",
  providerAttemptCardinality: "at_most_one",
  requiredProofKinds: CONTAINED_TURN_REQUIRED_PROOF_KINDS,
  resourceScopeRevision: "contained-workspace-network-credential:1",
  supportedModes: Object.freeze(["analysis", "workspace-write"] as const),
  unknownCapabilityPolicy: "fail_closed",
});
const authorityVector: ContainedTurnAuthorityVector = Object.freeze({
  adapterSnapshot,
  capabilityManifestRevision: manifest.manifestRevision,
  containmentPolicyDigest: digestContainedTurnCanonicalValue({ policy: "contained-turn-v1" }),
  operationAuthorityRevision: "operation-authority:1",
  providerAccessSnapshot,
  scopeDigest: containedTurnScopeDigest(scope),
  securityAuthorityRevision: "security-authority:1",
  securityDecisionDigest: digestContainedTurnCanonicalValue({ decision: "allowed" }),
});

const operationId = containedTurnIdentity("operation", "operation:1");
const commandId = containedTurnIdentity("command", "command:1");
const effectId = containedTurnIdentity("effect", "effect:1");
const attemptId = containedTurnIdentity("attempt", "attempt:1");
const custodyId = containedTurnIdentity("custody", "custody:1");
const hostBootId = containedTurnIdentity("host_boot", "host-boot:1");
const hostInstanceId = containedTurnIdentity("host_instance", "host-instance:1");
const workspaceId = containedTurnIdentity("workspace", "workspace:1");
const proofId = (value: string) => containedTurnIdentity("proof", value);
const authorityDigest = containedTurnAuthorityVectorDigest(authorityVector);
const commandFingerprint = containedTurnCommandFingerprint({ intent, provider: "codex", scope });

const acceptanceProof = Object.freeze({
  binding: Object.freeze({
    authorityVectorDigest: authorityDigest,
    commandFingerprint,
    commandId,
    operationId,
  }),
  kind: "acceptance" as const,
  proofId: proofId("proof:acceptance"),
});

const createOperation = (overrides: Partial<Parameters<typeof createContainedTurnOperation>[0]> = {}): ContainedTurnKernelOperation => {
  const selectedIntent = overrides.intent ?? intent;
  const selectedCommandId = overrides.commandId ?? commandId;
  const selectedOperationId = overrides.operationId ?? operationId;
  const selectedScope = overrides.scope ?? scope;
  const selectedAdapter = overrides.adapterSnapshot ?? adapterSnapshot;
  const selectedVector = overrides.acceptedAuthorityVector ?? authorityVector;
  const selectedFingerprint = containedTurnCommandFingerprint({
    intent: selectedIntent,
    provider: selectedAdapter.provider,
    scope: selectedScope,
  });
  const selectedAcceptance = overrides.acceptanceProof ?? {
    binding: {
      authorityVectorDigest: containedTurnAuthorityVectorDigest(selectedVector),
      commandFingerprint: selectedFingerprint,
      commandId: selectedCommandId,
      operationId: selectedOperationId,
    },
    kind: "acceptance" as const,
    proofId: proofId("proof:acceptance"),
  };
  return createContainedTurnOperation({
    acceptanceProof: selectedAcceptance,
    acceptedAuthorityVector: authorityVector,
    adapterSnapshot,
    capabilityManifest: manifest,
    commandId,
    effectId,
    intent,
    operationId,
    providerAccessSnapshot,
    schemaVersion: 2,
    scope,
    ...overrides,
  });
};

const commonBinding = Object.freeze({ authorityVectorDigest: authorityDigest, operationId });
const attemptBinding = Object.freeze({ ...commonBinding, attemptId, effectId });

const createReservedOperation = (): ContainedTurnKernelOperation => {
  const operation = createOperation();
  const claimProof: ContainedTurnProof = { binding: attemptBinding, kind: "dispatch_claim", proofId: proofId("proof:claim") };
  const cutoffProof: ContainedTurnProof = { binding: commonBinding, kind: "cutoff", proofId: proofId("proof:cutoff") };
  const reserved: ContainedTurnKernelOperation = {
    ...operation,
    admissionFence: { kind: "fenced", proofId: cutoffProof.proofId },
    containment: { attemptId, kind: "pending" },
    custodyId,
    dispatch: { attemptId, claimProofId: claimProof.proofId, kind: "claimed" },
    proofs: [...operation.proofs, claimProof, cutoffProof],
    hostBootId,
    hostInstanceId,
    providerProcessStart: { attemptId, kind: "pending" },
    revision: operation.revision + 1,
    workspaceId,
  };
  validateContainedTurnOperation(reserved);
  return reserved;
};

const createActiveOperation = (): ContainedTurnKernelOperation => {
  const operation = createReservedOperation();
  const startProof: ContainedTurnProof = {
    binding: { ...attemptBinding, custodyId, hostBootId, hostInstanceId },
    kind: "provider_process_start",
    proofId: proofId("proof:process-start"),
  };
  const active = mutateContainedTurnOperation(operation, { kind: "record_process_start", proof: startProof });
  validateContainedTurnOperation(active);
  return active;
};

const expectInvariant = (action: () => unknown, pattern: RegExp): void => assert.throws(action, pattern);

test("freezes the exact seven consumer-owned dependencies and separate provider authorities", () => {
  assert.equal(dependencyNamesAreExhaustive, true);
  assert.deepEqual(CONTAINED_TURN_DEPENDENCY_NAMES, [
    "operationStore", "security", "providerAccess", "workspace", "artifacts", "custody", "provider",
  ]);
  assert.deepEqual(Object.keys(adapterSnapshot).toSorted(), [
    "adapterRevision", "binaryRevision", "capabilityManifestRevision", "provider",
  ]);
  assert.deepEqual(Object.keys(providerAccessSnapshot).toSorted(), [
    "accessRef", "accessRevision", "accountRef", "accountRevision", "credentialBindingDigest",
    "credentialBindingGeneration", "credentialBindingRef", "credentialBindingRevision", "provider",
    "providerRouteRef", "providerRouteRevision",
  ]);
  assert.equal(Object.keys(providerAccessSnapshot).some(key => /path|secret|token|password/iu.test(key)), false);
  expectInvariant(
    () => validateContainedTurnKernelDependencies({ extraAuthority: {} } as unknown as Parameters<typeof validateContainedTurnKernelDependencies>[0]),
    /exact closed seven dependencies/u,
  );
  const leakedSnapshot = {
    ...providerAccessSnapshot,
    rawSecret: "must-never-enter-authority-state",
  } as unknown as ContainedTurnProviderAccessSnapshot;
  expectInvariant(
    () => createOperation({
      acceptedAuthorityVector: { ...authorityVector, providerAccessSnapshot: leakedSnapshot },
      providerAccessSnapshot: leakedSnapshot,
    }),
    /Provider Access snapshot must be an exact closed record/u,
  );
});

test("freezes the accepted PostgreSQL command replay and semantic-conflict invariant", async () => {
  const acceptedByCommand = new Map<string, ContainedTurnKernelOperation>();
  const accept: ContainedTurnKernelOperationStore["accept"] = async candidate => {
    const accepted = acceptedByCommand.get(candidate.commandId);
    if (accepted === undefined) {
      acceptedByCommand.set(candidate.commandId, candidate);
      return { kind: "accepted", operation: candidate };
    }
    return accepted.commandFingerprint === candidate.commandFingerprint
      ? { kind: "replayed", operation: accepted }
      : { kind: "fingerprint_conflict" };
  };
  const accepted = createOperation();
  assert.equal((await accept(accepted)).kind, "accepted");
  const replayCandidate = createOperation({
    effectId: containedTurnIdentity("effect", "effect:replay"),
    operationId: containedTurnIdentity("operation", "operation:replay"),
  });
  assert.equal((await accept(replayCandidate)).kind, "replayed");
  const conflict = createOperation({
    effectId: containedTurnIdentity("effect", "effect:conflict"),
    intent: { mode: "analysis", prompt: "Semantically different command." },
    operationId: containedTurnIdentity("operation", "operation:conflict"),
  });
  assert.equal((await accept(conflict)).kind, "fingerprint_conflict");
  assert.strictEqual(acceptedByCommand.get(commandId), accepted);
});

test("freezes canonical SHA-256 codecs and rejects impossible recomputed-digest states", () => {
  assert.equal(
    digestContainedTurnCanonicalValue({ a: 1, b: 2 }),
    digestContainedTurnCanonicalValue({ b: 2, a: 1 }),
  );
  assert.equal(
    digestContainedTurnCanonicalValue({ a: 1, b: 2 }),
    "sha256:43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777",
  );
  const operation = createOperation();
  const corrupted = {
    ...operation,
    acceptedAuthorityVectorDigest: digestContainedTurnCanonicalValue({ impossible: true }),
  };
  expectInvariant(() => validateContainedTurnOperation(corrupted), /authority-vector digest does not recompute/u);
  const wrongFingerprint = { ...operation, commandFingerprint: digestContainedTurnCanonicalValue({ wrong: true }) as unknown as typeof commandFingerprint };
  expectInvariant(() => validateContainedTurnOperation(wrongFingerprint), /command fingerprint does not recompute/u);
});

test("uses one V1/V2 byte authority with ASCII identifiers and exact one-byte-over rejection", () => {
  assert.deepEqual(CONTAINED_TURN_LIMITS.acceptedSchemaVersions, [1, 2]);
  const maximumPrompt = "p".repeat(CONTAINED_TURN_LIMITS.text.prompt.maximumBytes);
  assert.doesNotThrow(() => createOperation({ intent: { mode: "analysis", prompt: maximumPrompt } }));
  expectInvariant(
    () => createOperation({ intent: { mode: "analysis", prompt: `${maximumPrompt}p` } }),
    /65536 utf8 bytes/u,
  );
  expectInvariant(() => createOperation({ commandId: containedTurnIdentity("command", "command:non-ascii-é") }), /ascii bytes/u);
  expectInvariant(
    () => createOperation({
      commandId: containedTurnIdentity(
        "command",
        `command:${"c".repeat(CONTAINED_TURN_LIMITS.text.commandId.maximumBytes - "command:".length + 1)}`,
      ),
    }),
    /256 ascii bytes/u,
  );
  const active = createActiveOperation();
  expectInvariant(
    () => mutateContainedTurnOperation(active, {
      kind: "append_output",
      output: {
        cursor: 0,
        kind: "assistant",
        text: "o".repeat(CONTAINED_TURN_LIMITS.text.outputChunk.maximumBytes + 1),
      },
    }),
    /2000000 utf8 bytes/u,
  );
  const oneByteOverTotal = {
    ...active,
    output: {
      chunks: [
        { cursor: 0, kind: "assistant" as const, text: "a".repeat(1_000_000) },
        { cursor: 1, kind: "assistant" as const, text: "b".repeat(1_000_001) },
      ],
      fence: { kind: "open" as const },
    },
  };
  expectInvariant(() => validateContainedTurnOperation(oneByteOverTotal), /output total byte limit/u);
});

test("fails closed on missing, unknown, duplicated, or unsupported capability scope", () => {
  const operation = createOperation();
  const missing = { ...operation, capabilityManifest: { ...manifest, supportedModes: [] } } as ContainedTurnKernelOperation;
  expectInvariant(() => validateContainedTurnOperation(missing), /capability manifest/u);
  const duplicate = { ...operation, capabilityManifest: { ...manifest, supportedModes: ["analysis", "analysis"] } } as ContainedTurnKernelOperation;
  expectInvariant(() => validateContainedTurnOperation(duplicate), /capability manifest/u);
  const unknown = { ...operation, capabilityManifest: { ...manifest, supportedModes: ["unknown"] } } as unknown as ContainedTurnKernelOperation;
  expectInvariant(() => validateContainedTurnOperation(unknown), /unknown capability scope|capability manifest/u);
  const extra = {
    ...operation,
    capabilityManifest: { ...manifest, speculativeCapability: true },
  } as unknown as ContainedTurnKernelOperation;
  expectInvariant(() => validateContainedTurnOperation(extra), /capability manifest must be an exact closed record/u);
});

test("enforces disjoint immutable identities and one-attempt claim coupling", () => {
  assert.equal(
    new Set(Object.values(CONTAINED_TURN_IDENTITY_PREFIXES)).size,
    Object.keys(CONTAINED_TURN_IDENTITY_PREFIXES).length,
  );
  expectInvariant(
    () => createOperation({ effectId: containedTurnIdentity("effect", operationId) }),
    /disjoint namespace prefix|identity namespaces/u,
  );
  const operation = createOperation();
  const claimProof: ContainedTurnProof = { binding: attemptBinding, kind: "dispatch_claim", proofId: proofId("proof:claim") };
  const claimed = {
    ...operation,
    dispatch: { attemptId, claimProofId: claimProof.proofId, kind: "claimed" as const },
    proofs: [...operation.proofs, claimProof],
    revision: operation.revision + 1,
  };
  expectInvariant(() => validateContainedTurnOperation(claimed), /dispatch requires allocated|pending provider start observation/u);
  const mutableIdentity = { ...operation, operationId: containedTurnIdentity("operation", "operation:changed"), revision: 1 };
  expectInvariant(() => validateContainedTurnOperation(mutableIdentity, { previous: operation }), /binding mismatch|immutable/u);
});

test("separates custody reservation from confirmed start and fails closed on unknown start", () => {
  const reserved = createReservedOperation();
  assert.deepEqual(reserved.providerProcessStart, { attemptId, kind: "pending" });
  assert.deepEqual(reserved.providerExecution, { kind: "not_started" });
  expectInvariant(
    () => validateContainedTurnOperation({ ...reserved, providerExecution: { attemptId, kind: "active" } }),
    /only after Host Custody confirms actual process start/u,
  );

  const noStartProof: ContainedTurnProof = {
    binding: { ...attemptBinding, custodyId, hostBootId, hostInstanceId },
    kind: "provider_process_no_start",
    proofId: proofId("proof:process-no-start"),
  };
  const provedNoStart = mutateContainedTurnOperation(reserved, {
    kind: "record_process_no_start",
    proof: noStartProof,
  });
  assert.doesNotThrow(() => validateContainedTurnOperation(provedNoStart));
  expectInvariant(
    () => validateContainedTurnOperation({ ...provedNoStart, providerExecution: { attemptId, kind: "active" } }),
    /proved no-start can never claim active execution|only after Host Custody/u,
  );

  const evidenceId = containedTurnIdentity("evidence", "evidence:start-unknown");
  const unknown = mutateContainedTurnOperation(reserved, {
    evidenceId,
    kind: "record_process_start_unknown",
  });
  assert.deepEqual(unknown.providerProcessStart, { evidenceId, kind: "unknown" });
  assert.deepEqual(unknown.reconciliation, { evidenceIds: [evidenceId], kind: "required" });
  assert.deepEqual(unknown.output.fence, { finalCursor: 0, kind: "fenced" });
  expectInvariant(
    () => mutateContainedTurnOperation(unknown, { kind: "record_process_start", proof: {
      binding: { ...attemptBinding, custodyId, hostBootId, hostInstanceId },
      kind: "provider_process_start",
      proofId: proofId("proof:late-process-start"),
    } }),
    /one pending custody reservation/u,
  );
});

test("enforces proof exhaustiveness, unique kinds and IDs, exact bindings, and substitution fences", () => {
  assert.equal(proofKindsAreExhaustive, true);
  assert.deepEqual(CONTAINED_TURN_PROOF_KINDS, [
    "acceptance", "artifact_manifest_seal", "cancellation", "containment", "containment_not_required", "cutoff",
    "dispatch_claim", "effect_no_start", "effect_resolution", "execution_closure", "host_custody", "host_custody_no_start",
    "no_dispatch", "no_start", "output_drain", "output_no_start_drain", "provider_acceptance", "provider_not_started",
    "provider_process_no_start", "provider_process_start", "provider_terminal_observation",
    "result_publication", "terminal_truth", "workspace_closure",
  ]);
  const operation = createOperation();
  const duplicateKind = { ...acceptanceProof, proofId: proofId("proof:acceptance:second") };
  expectInvariant(
    () => validateContainedTurnOperation({
      ...operation,
      proofs: [...operation.proofs, duplicateKind],
      revision: operation.revision + 1,
    }),
    /proof kinds/u,
  );
  const wrongSubject = {
    ...acceptanceProof,
    binding: { ...acceptanceProof.binding, operationId: containedTurnIdentity("operation", "operation:other") },
  };
  expectInvariant(() => validateContainedTurnOperation({ ...operation, proofs: [wrongSubject] }), /operation binding mismatch/u);
  const leakedProof = {
    ...acceptanceProof,
    binding: { ...acceptanceProof.binding, rawSecret: "must-not-persist" },
  } as unknown as ContainedTurnProof;
  expectInvariant(
    () => validateContainedTurnOperation({ ...operation, proofs: [leakedProof] }),
    /proof binding must be an exact closed record/u,
  );
  const substituted = {
    ...operation,
    containment: { kind: "contained" as const, proofId: acceptanceProof.proofId },
    revision: operation.revision + 1,
  };
  expectInvariant(() => validateContainedTurnOperation(substituted), /containment requires its own exact proof/u);

  const active = createActiveOperation();
  const noStartProof: ContainedTurnProof = {
    binding: { ...commonBinding, effectId },
    kind: "no_start",
    proofId: proofId("proof:no-start-substitution"),
  };
  expectInvariant(
    () => validateContainedTurnOperation({
      ...active,
      proofs: [...active.proofs, noStartProof],
      providerExecution: { kind: "closed", outcome: "failed", proofId: noStartProof.proofId },
    }),
    /dispatch-applicable exact proof/u,
  );
  const noStartDrainProof: ContainedTurnProof = {
    binding: { ...commonBinding, finalCursor: 0 },
    kind: "output_no_start_drain",
    proofId: proofId("proof:no-start-drain-substitution"),
  };
  expectInvariant(
    () => validateContainedTurnOperation({
      ...active,
      output: { chunks: [], fence: { finalCursor: 0, kind: "fenced", proofId: noStartDrainProof.proofId } },
      proofs: [...active.proofs, noStartDrainProof],
    }),
    /output_drain requires its own exact proof/u,
  );
});

test("enforces contiguous output, exact final cursor, append-only history, and no reopen", () => {
  const operation = createActiveOperation();
  const withOutput = mutateContainedTurnOperation(operation, {
    kind: "append_output",
    output: { cursor: 0, kind: "assistant", text: "one" },
  });
  expectInvariant(
    () => mutateContainedTurnOperation(withOutput, { kind: "append_output", output: { cursor: 2, kind: "assistant", text: "gap" } }),
    /contiguous/u,
  );
  const fenced = { ...withOutput, output: { chunks: withOutput.output.chunks, fence: { finalCursor: 2, kind: "fenced" as const } } };
  expectInvariant(() => validateContainedTurnOperation(fenced), /final cursor/u);
  const rewritten = {
    ...withOutput,
    output: { chunks: [{ cursor: 0, kind: "assistant" as const, text: "rewritten" }], fence: withOutput.output.fence },
    revision: withOutput.revision + 1,
  };
  expectInvariant(() => validateContainedTurnOperation(rewritten, { previous: withOutput }), /cannot be rewritten/u);
});

test("ambiguity atomically fences output, records debt, and rejects later canonical output", () => {
  const operation = mutateContainedTurnOperation(createActiveOperation(), {
    kind: "append_output",
    output: { cursor: 0, kind: "progress", text: "before ambiguity" },
  });
  const ambiguityEvidenceId = containedTurnIdentity("evidence", "evidence:ambiguous");
  const ambiguous = mutateContainedTurnOperation(operation, { evidenceId: ambiguityEvidenceId, kind: "record_ambiguity" });
  assert.deepEqual(ambiguous.output.fence, { finalCursor: 1, kind: "fenced" });
  assert.deepEqual(ambiguous.reconciliation, { evidenceIds: [ambiguityEvidenceId], kind: "required" });
  expectInvariant(
    () => mutateContainedTurnOperation(ambiguous, { kind: "append_output", output: { cursor: 1, kind: "assistant", text: "late" } }),
    /cannot append after its fence|final cursor/u,
  );
  const clearedDebt = { ...ambiguous, reconciliation: { kind: "clear" as const }, revision: ambiguous.revision + 1 };
  expectInvariant(() => validateContainedTurnOperation(clearedDebt, { previous: ambiguous }), /reconciliation debt|cannot be cleared/u);
});

test("cancellation replay is keyed by exact command identity and canonical fingerprint", () => {
  const operation = createOperation();
  const cancellationCommandId = containedTurnIdentity("cancellation_command", "cancellation-command:1");
  const cancellationCommand: ContainedTurnCancellationCommand = {
    cancellationCommandId,
    fingerprint: containedTurnCancellationFingerprint({ cancellationCommandId, operationId, scopeDigest: containedTurnScopeDigest(scope) }),
    operationId,
    scopeDigest: containedTurnScopeDigest(scope),
  };
  const cancellationProof = {
    binding: { ...commonBinding, cancellationCommandId, cancellationFingerprint: cancellationCommand.fingerprint },
    kind: "cancellation" as const,
    proofId: proofId("proof:cancellation"),
  };
  const cutoffProof = {
    binding: { ...commonBinding, cancellationCommandId },
    kind: "cutoff" as const,
    proofId: proofId("proof:cutoff"),
  };
  const requested = mutateContainedTurnOperation(operation, {
    command: cancellationCommand, cutoffProof, kind: "request_cancellation", proof: cancellationProof,
  });
  assert.equal(requested.cancellation.kind, "requested");
  const replayed = mutateContainedTurnOperation(requested, {
    command: cancellationCommand, cutoffProof, kind: "request_cancellation", proof: cancellationProof,
  });
  assert.strictEqual(replayed, requested);
  const otherId = containedTurnIdentity("cancellation_command", "cancellation-command:2");
  const other = {
    ...cancellationCommand,
    cancellationCommandId: otherId,
    fingerprint: containedTurnCancellationFingerprint({ cancellationCommandId: otherId, operationId, scopeDigest: containedTurnScopeDigest(scope) }),
  };
  expectInvariant(
    () => mutateContainedTurnOperation(requested, { command: other, cutoffProof, kind: "request_cancellation", proof: cancellationProof }),
    /exact command/u,
  );

  const active = createActiveOperation();
  const activeCutoff = active.proofs.find(
    (proof): proof is Extract<ContainedTurnProof, { readonly kind: "cutoff" }> => proof.kind === "cutoff",
  );
  assert.notEqual(activeCutoff, undefined);
  if (activeCutoff !== undefined) {
    const activeCancellationProof: Extract<ContainedTurnProof, { readonly kind: "cancellation" }> = {
      binding: { ...commonBinding, cancellationCommandId, cancellationFingerprint: cancellationCommand.fingerprint },
      kind: "cancellation",
      proofId: proofId("proof:active-cancellation"),
    };
    const activeCancellation = mutateContainedTurnOperation(active, {
      command: cancellationCommand,
      cutoffProof: activeCutoff,
      kind: "request_cancellation",
      proof: activeCancellationProof,
    });
    assert.deepEqual(activeCancellation.admissionFence, active.admissionFence);
    assert.equal(activeCancellation.proofs.filter(proof => proof.kind === "cutoff").length, 1);
  }
});

const buildTerminalCandidate = (): ContainedTurnKernelOperation => {
  const operation = createOperation();
  const proofs: readonly ContainedTurnProof[] = [
    acceptanceProof,
    { binding: attemptBinding, kind: "dispatch_claim", proofId: proofId("proof:claim") },
    {
      binding: { ...attemptBinding, custodyId, hostBootId, hostInstanceId },
      kind: "provider_process_start",
      proofId: proofId("proof:process-start"),
    },
    { binding: { ...attemptBinding, outcome: "succeeded" }, kind: "execution_closure", proofId: proofId("proof:execution") },
    { binding: { ...attemptBinding, disposition: "accepted" }, kind: "provider_acceptance", proofId: proofId("proof:provider-acceptance") },
    { binding: { ...attemptBinding, outcome: "succeeded" }, kind: "provider_terminal_observation", proofId: proofId("proof:provider-terminal") },
    { binding: { ...attemptBinding, finalCursor: 1 }, kind: "output_drain", proofId: proofId("proof:output-drain") },
    { binding: { ...attemptBinding, custodyId }, kind: "host_custody", proofId: proofId("proof:custody") },
    { binding: { ...commonBinding, workspaceId }, kind: "workspace_closure", proofId: proofId("proof:workspace") },
    { binding: { ...commonBinding, artifactManifestRef: "artifact-manifest:1", workspaceId }, kind: "artifact_manifest_seal", proofId: proofId("proof:artifact") },
    { binding: { ...attemptBinding, disposition: "committed" }, kind: "effect_resolution", proofId: proofId("proof:effect") },
    {
      binding: {
        ...attemptBinding,
        adapterRevision: adapterSnapshot.adapterRevision,
        artifactManifestSealProofId: proofId("proof:artifact"),
        binaryRevision: adapterSnapshot.binaryRevision,
        capabilityManifestRevision: manifest.manifestRevision,
        containmentPolicyDigest: authorityVector.containmentPolicyDigest,
        credentialBindingDigest: providerAccessSnapshot.credentialBindingDigest,
        custodyId,
        cutoffProofId: proofId("proof:cutoff"),
        executionClosureProofId: proofId("proof:execution"),
        finalCursor: 1,
        hostBootId,
        hostInstanceId,
        immutableScopeDigest: authorityVector.scopeDigest,
        outputDrainProofId: proofId("proof:output-drain"),
        providerRouteRef: providerAccessSnapshot.providerRouteRef,
        terminalObservationProofId: proofId("proof:provider-terminal"),
        workspaceId,
      },
      kind: "containment",
      proofId: proofId("proof:containment"),
    },
    { binding: { ...commonBinding, resultRef: "result:1" }, kind: "result_publication", proofId: proofId("proof:result") },
    { binding: commonBinding, kind: "cutoff", proofId: proofId("proof:cutoff") },
  ];
  const preTerminal: ContainedTurnKernelOperation = {
    ...operation,
    admissionFence: { kind: "fenced", proofId: proofId("proof:cutoff") },
    artifactManifestRef: "artifact-manifest:1",
    containment: { kind: "contained", proofId: proofId("proof:containment") },
    custodyId,
    dispatch: { attemptId, claimProofId: proofId("proof:claim"), kind: "claimed" },
    effect: { disposition: "committed", kind: "resolved", proofId: proofId("proof:effect") },
    hostBootId,
    hostInstanceId,
    output: { chunks: [{ cursor: 0, kind: "assistant", text: "done" }], fence: { finalCursor: 1, kind: "fenced", proofId: proofId("proof:output-drain") } },
    proofs,
    providerAcceptance: { kind: "accepted", proofId: proofId("proof:provider-acceptance") },
    providerExecution: { kind: "closed", outcome: "succeeded", proofId: proofId("proof:execution") },
    providerProcessStart: { kind: "execution_started", proofId: proofId("proof:process-start") },
    resultRef: "result:1",
    revision: operation.revision + 1,
    workspaceId,
  };
  const satisfactionDigest = containedTurnSatisfactionDigest(preTerminal);
  const terminalProof: ContainedTurnProof = {
    binding: { ...commonBinding, satisfactionDigest, terminalOutcome: "succeeded" },
    kind: "terminal_truth",
    proofId: proofId("proof:terminal"),
  };
  return {
    ...preTerminal,
    proofs: [...proofs, terminalProof],
    terminal: { kind: "final", outcome: "succeeded", satisfactionDigest, terminalProofId: terminalProof.proofId },
  };
};

test("accepts exact terminal proof closure and rejects false terminal truth or proof substitution", () => {
  const terminal = buildTerminalCandidate();
  assert.doesNotThrow(() => validateContainedTurnOperation(terminal));
  const impossibleDigest = {
    ...terminal,
    terminal: { ...terminal.terminal, satisfactionDigest: digestContainedTurnCanonicalValue({ false: "closure" }) as ContainedTurnCanonicalDigest },
  } as ContainedTurnKernelOperation;
  expectInvariant(() => validateContainedTurnOperation(impossibleDigest), /satisfaction digest|satisfaction mismatch/u);
  const containmentSubstitution = {
    ...terminal,
    containment: { kind: "contained" as const, proofId: proofId("proof:acceptance") },
  };
  expectInvariant(() => validateContainedTurnOperation(containmentSubstitution), /containment requires its own exact proof/u);
  const falseClosure = { ...terminal, resultRef: undefined } as unknown as ContainedTurnKernelOperation;
  expectInvariant(
    () => validateContainedTurnOperation(falseClosure),
    /exact closed record|result proof binding|artifact and result closure/u,
  );
});
