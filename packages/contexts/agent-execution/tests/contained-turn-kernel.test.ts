import assert from "node:assert/strict";
import test from "node:test";

import { type ContainedTurnProviderAccessSnapshot } from "../dist/features/contained-agent-turn/domain/contained-turn-authority.js";
import { digestContainedTurnCanonicalValue } from "../dist/features/contained-agent-turn/domain/contained-turn-codecs.js";
import {
  createContainedTurnOperation,
  mutateContainedTurnOperation,
  validateContainedTurnOperation,
} from "../dist/features/contained-agent-turn/domain/contained-turn-kernel.js";
import { CONTAINED_TURN_LIMITS } from "../dist/features/contained-agent-turn/domain/contained-turn-limits.js";
import {
  containedTurnIdentity,
  CONTAINED_TURN_IDENTITY_PREFIXES,
} from "../dist/features/contained-agent-turn/domain/contained-turn-identities.js";
import {
  CONTAINED_TURN_PROOF_KINDS,
  type ContainedTurnProof,
  type ContainedTurnProofKind,
} from "../dist/features/contained-agent-turn/domain/contained-turn-proofs.js";
import {
  CONTAINED_TURN_DEPENDENCY_NAMES,
  validateContainedTurnKernelDependencies,
  type ContainedTurnKernelOperationStore,
} from "../dist/features/contained-agent-turn/application/ports/outbound/contained-turn-ports.js";
import {
  acceptanceProof,
  adapterSnapshot,
  attemptId,
  attemptBinding,
  authorityVector,
  commandFingerprint,
  commandId,
  commonBinding,
  createActiveOperation,
  createOperation,
  createReservedOperation,
  custodyId,
  dependencyNamesAreExhaustive,
  effectId,
  expectInvariant,
  hostBootId,
  hostInstanceId,
  intent,
  manifest,
  operationId,
  proofId,
  providerAccessAcceptanceProof,
  providerAccessSnapshot,
  runtimeSecurityAcceptanceProof,
  scope,
  workspaceId,
} from "./contained-turn-kernel-fixtures.ts";

type SameUnion<Left, Right> =
  [Exclude<Left, Right>, Exclude<Right, Left>] extends [never, never] ? true : false;

const proofKindsAreExhaustive: SameUnion<
  ContainedTurnProofKind,
  (typeof CONTAINED_TURN_PROOF_KINDS)[number]
> = true;

test("freezes the exact seven consumer-owned dependencies and separate provider authorities", () => {
  assert.equal(dependencyNamesAreExhaustive, true);
  assert.deepEqual(CONTAINED_TURN_DEPENDENCY_NAMES, [
    "operationStore", "security", "providerAccess", "workspace", "artifacts", "custody", "provider",
  ]);
  assert.deepEqual(Object.keys(adapterSnapshot).toSorted(), [
    "adapterRevision", "binaryRevision", "capabilityManifestRevision", "provider",
  ]);
  assert.deepEqual(Object.keys(providerAccessSnapshot).toSorted(), [
    "accessRef", "credentialBindingDigest", "credentialBindingRef", "credentialGeneration", "projectId",
    "provider", "providerAccountRef", "providerRouteRef", "revision", "tenantId",
  ]);
  assert.equal(Object.keys(providerAccessSnapshot).some(key => /path|secret|token|password/iu.test(key)), false);
  expectInvariant(
    () => validateContainedTurnKernelDependencies({ extraAuthority: {} } as unknown as Parameters<typeof validateContainedTurnKernelDependencies>[0]),
    /exact closed record/u,
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

test("strict codecs reject collision-shaped values and accepted inputs are deeply detached", () => {
  expectInvariant(
    () => digestContainedTurnCanonicalValue({ value: undefined } as never),
    /undefined/u,
  );
  expectInvariant(() => digestContainedTurnCanonicalValue(new Date() as never), /ordinary object prototype/u);
  expectInvariant(() => digestContainedTurnCanonicalValue("\ud800"), /lone surrogates/u);
  expectInvariant(() => digestContainedTurnCanonicalValue(-0), /collision-free/u);
  const sparseValue: unknown[] = [];
  sparseValue.length = 1;
  expectInvariant(() => digestContainedTurnCanonicalValue(sparseValue as never), /dense/u);
  expectInvariant(() => containedTurnIdentity("operation", "operation:"), /non-empty suffix/u);
  const mutableIntent = { mode: "analysis" as const, prompt: "detached" };
  const operation = createOperation({ intent: mutableIntent });
  mutableIntent.prompt = "mutated outside";
  assert.equal(operation.intent.prompt, "detached");
  assert.equal(Object.isFrozen(operation), true);
  assert.equal(Object.isFrozen(operation.intent), true);
  const symbolInput = Object.assign({
    acceptanceProof,
    acceptedAuthorityVector: authorityVector,
    adapterSnapshot,
    capabilityManifest: manifest,
    commandId,
    effectId,
    intent,
    operationId,
    providerAccessAcceptanceProof,
    providerAccessSnapshot,
    runtimeSecurityAcceptanceProof,
    schemaVersion: 1 as const,
    scope,
  }, { [Symbol("hidden")]: true });
  expectInvariant(() => createContainedTurnOperation(symbolInput), /symbol keys/u);
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
  const missingProviderAccessProofId = proofId("proof:missing-provider-access-dispatch");
  const missingRuntimeSecurityProofId = proofId("proof:missing-runtime-security-dispatch");
  const claimProof: ContainedTurnProof = {
    binding: {
      ...attemptBinding,
      providerAccessDispatchProofId: missingProviderAccessProofId,
      runtimeSecurityDispatchProofId: missingRuntimeSecurityProofId,
    },
    kind: "dispatch_claim",
    proofId: proofId("proof:claim"),
  };
  const claimed = {
    ...operation,
    dispatch: {
      attemptId,
      claimProofId: claimProof.proofId,
      kind: "claimed" as const,
      providerAccessDispatchProofId: missingProviderAccessProofId,
      runtimeSecurityDispatchProofId: missingRuntimeSecurityProofId,
    },
    proofs: [...operation.proofs, claimProof],
    revision: operation.revision + 1,
  };
  expectInvariant(() => validateContainedTurnOperation(claimed), /dispatch requires allocated|pending provider start observation|requires its own exact proof/u);
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
  const closedNoStart = mutateContainedTurnOperation(provedNoStart, {
    containmentProof: {
      binding: { ...commonBinding, effectId },
      kind: "containment_not_required",
      proofId: proofId("proof:process-no-containment"),
    },
    effectProof: {
      binding: { ...commonBinding, disposition: "not_committed", effectId },
      kind: "effect_no_start",
      proofId: proofId("proof:process-no-effect"),
    },
    executionProof: {
      binding: { ...commonBinding, effectId },
      kind: "no_start",
      proofId: proofId("proof:process-no-execution"),
    },
    kind: "close_process_no_start",
    outputProof: {
      binding: { ...commonBinding, finalCursor: 0 },
      kind: "output_no_start_drain",
      proofId: proofId("proof:process-no-output"),
    },
    providerProof: {
      binding: { ...commonBinding, effectId },
      kind: "provider_not_started",
      proofId: proofId("proof:process-provider-not-started"),
    },
  });
  assert.deepEqual(closedNoStart.providerExecution, {
    kind: "closed",
    outcome: "failed",
    proofId: proofId("proof:process-no-execution"),
  });
  assert.deepEqual(closedNoStart.output.fence, {
    finalCursor: 0,
    kind: "fenced",
    proofId: proofId("proof:process-no-output"),
  });
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

test("dispatch prevention atomically records distinct no-start authorities", () => {
  const operation = mutateContainedTurnOperation(createOperation(), { kind: "bind_workspace", workspaceId });
  const prevented = mutateContainedTurnOperation(operation, {
    containmentProof: { binding: { ...commonBinding, effectId }, kind: "containment_not_required", proofId: proofId("proof:no-containment") },
    cutoffProof: { binding: commonBinding, kind: "cutoff", proofId: proofId("proof:prevented-cutoff") },
    effectProof: { binding: { ...commonBinding, disposition: "not_committed", effectId }, kind: "effect_no_start", proofId: proofId("proof:no-effect") },
    executionProof: { binding: { ...commonBinding, effectId }, kind: "no_start", proofId: proofId("proof:no-start") },
    hostCustodyProof: { binding: { ...commonBinding, effectId }, kind: "host_custody_no_start", proofId: proofId("proof:no-custody") },
    kind: "prevent_dispatch",
    noDispatchProof: { binding: { ...commonBinding, effectId }, kind: "no_dispatch", proofId: proofId("proof:no-dispatch") },
    outputProof: { binding: { ...commonBinding, finalCursor: 0 }, kind: "output_no_start_drain", proofId: proofId("proof:no-output") },
    providerProof: { binding: { ...commonBinding, effectId }, kind: "provider_not_started", proofId: proofId("proof:provider-not-started") },
  });
  assert.equal(prevented.dispatch.kind, "prevented");
  assert.equal(prevented.providerAcceptance.kind, "not_accepted");
  assert.equal(prevented.providerExecution.kind, "closed");
  assert.equal(new Set(prevented.proofs.map(proof => proof.kind)).size, prevented.proofs.length);
});

test("enforces proof exhaustiveness, unique kinds and IDs, exact bindings, and substitution fences", () => {
  assert.equal(proofKindsAreExhaustive, true);
  assert.deepEqual(CONTAINED_TURN_PROOF_KINDS, [
    "acceptance", "artifact_manifest_seal", "cancellation", "containment", "containment_not_required", "cutoff",
    "dispatch_claim", "effect_no_start", "effect_resolution", "execution_closure", "host_custody", "host_custody_no_start",
    "no_dispatch", "no_start", "output_drain", "output_no_start_drain", "provider_acceptance", "provider_not_started",
    "provider_process_no_start", "provider_process_start", "provider_access_acceptance", "provider_access_dispatch",
    "provider_terminal_observation", "result_publication", "runtime_security_acceptance", "runtime_security_dispatch",
    "terminal_truth", "workspace_closure",
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
  expectInvariant(() => validateContainedTurnOperation({ ...operation, proofs: [wrongSubject, ...operation.proofs.slice(1)] }), /operation binding mismatch/u);
  const leakedProof = {
    ...acceptanceProof,
    binding: { ...acceptanceProof.binding, rawSecret: "must-not-persist" },
  } as unknown as ContainedTurnProof;
  expectInvariant(
    () => validateContainedTurnOperation({ ...operation, proofs: [leakedProof, ...operation.proofs.slice(1)] }),
    /proof binding must be an exact closed record/u,
  );
  const wrongProviderAccessAcceptance = {
    ...providerAccessAcceptanceProof,
    binding: {
      ...providerAccessAcceptanceProof.binding,
      snapshotDigest: digestContainedTurnCanonicalValue({ snapshot: "substituted" }),
    },
  };
  expectInvariant(
    () => validateContainedTurnOperation({
      ...operation,
      proofs: [operation.proofs[0] as ContainedTurnProof, wrongProviderAccessAcceptance, operation.proofs[2] as ContainedTurnProof],
    }),
    /acceptance proof snapshot binding mismatch/u,
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
