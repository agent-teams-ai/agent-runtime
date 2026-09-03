import assert from "node:assert/strict";
import test from "node:test";

import type {
  ContainedTurnKernelArtifactPort,
  ContainedTurnKernelCustodyPort,
  ContainedTurnKernelDelegatedStart,
  ContainedTurnKernelProviderObservation,
} from "../../../dist/features/contained-agent-turn/application/ports/outbound/contained-turn-ports.js";
import {
  containedTurnCancellationFingerprint,
  containedTurnScopeDigest,
  type ContainedTurnCancellationCommand,
} from "../../../dist/features/contained-agent-turn/domain/contained-turn-authority.js";
import {
  digestContainedTurnCanonicalValue,
  type ContainedTurnCanonicalDigest,
} from "../../../dist/features/contained-agent-turn/domain/contained-turn-codecs.js";
import {
  appendContainedTurnOutputForOwnerStore,
  containedTurnSatisfactionDigest,
  mutateContainedTurnOperation,
  validateContainedTurnOperation,
  type ContainedTurnKernelOperation,
} from "../../../dist/features/contained-agent-turn/domain/contained-turn-kernel.js";
import { containedTurnIdentity } from "../../../dist/features/contained-agent-turn/domain/contained-turn-identities.js";
import {
  classifyContainedTurnOutputAppend,
  containedTurnOutputWriteAuthority,
  type ContainedTurnOutputWriteAuthority,
} from "../../../dist/features/contained-agent-turn/domain/contained-turn-output-authority.js";
import { type ContainedTurnProof } from "../../../dist/features/contained-agent-turn/domain/contained-turn-proofs.js";
import {
  adapterSnapshot,
  attemptId,
  attemptBinding,
  authorityVector,
  commonBinding,
  createActiveOperation,
  createOperation,
  createReservedOperation,
  custodyId,
  executionGenerationId,
  expectInvariant,
  hostBootId,
  hostInstanceId,
  intent,
  manifest,
  operationId,
  proofId,
  providerAccessSnapshot,
  scope,
  workspaceId,
  writerFence,
} from "../../contained-turn-kernel-fixtures.ts";

test("enforces contiguous output, exact final cursor, append-only history, and no reopen", () => {
  const operation = createActiveOperation();
  const withOutput = appendContainedTurnOutputForOwnerStore(
    operation,
    { cursor: 0, kind: "assistant", text: "one" },
  );
  expectInvariant(
    () => appendContainedTurnOutputForOwnerStore(
      withOutput,
      { cursor: 2, kind: "assistant", text: "gap" },
    ),
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
  const operation = appendContainedTurnOutputForOwnerStore(
    createActiveOperation(),
    { cursor: 0, kind: "progress", text: "before ambiguity" },
  );
  const oldListenerAuthority = containedTurnOutputWriteAuthority(operation);
  const ambiguityEvidenceId = containedTurnIdentity("evidence", "evidence:ambiguous");
  const ambiguous = mutateContainedTurnOperation(operation, { evidenceId: ambiguityEvidenceId, kind: "record_ambiguity" });
  assert.deepEqual(ambiguous.output.fence, { finalCursor: 1, kind: "fenced" });
  assert.deepEqual(ambiguous.reconciliation, { evidenceIds: [ambiguityEvidenceId], kind: "required" });
  assert.deepEqual(ambiguous.operationCutoff, {
    evidenceId: ambiguityEvidenceId,
    kind: "closed",
    reason: "continuity_lost",
    revision: 1,
  });
  assert.equal(classifyContainedTurnOutputAppend({
    authority: oldListenerAuthority,
    current: ambiguous,
    expectedCursor: 1,
    expectedRevision: ambiguous.revision,
    operationId,
    scope,
  }), "stale");
  expectInvariant(
    () => appendContainedTurnOutputForOwnerStore(
      ambiguous,
      { cursor: 1, kind: "assistant", text: "late" },
    ),
    /current active execution authority|cannot append after its fence|final cursor/u,
  );
  const clearedDebt = { ...ambiguous, reconciliation: { kind: "clear" as const }, revision: ambiguous.revision + 1 };
  expectInvariant(
    () => validateContainedTurnOperation(clearedDebt, { previous: ambiguous }),
    /durable reconciliation evidence|reconciliation debt|cannot be cleared/u,
  );
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
  assert.deepEqual(requested.operationCutoff, {
    kind: "closed",
    proofId: cutoffProof.proofId,
    reason: "cancellation",
    revision: 1,
  });
  assert.deepEqual(requested.output.fence, { finalCursor: 0, kind: "fenced" });
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
  const oldListenerAuthority = containedTurnOutputWriteAuthority(active);
  const dispatchCutoff = active.proofs.find(
    (proof): proof is Extract<ContainedTurnProof, { readonly kind: "cutoff" }> => proof.kind === "cutoff",
  );
  assert.notEqual(dispatchCutoff, undefined);
  const activeCancellationProof: Extract<ContainedTurnProof, { readonly kind: "cancellation" }> = {
    binding: { ...commonBinding, cancellationCommandId, cancellationFingerprint: cancellationCommand.fingerprint },
    kind: "cancellation",
    proofId: proofId("proof:active-cancellation"),
  };
  const activeCancellationCutoff: Extract<ContainedTurnProof, { readonly kind: "cutoff" }> = {
    binding: { ...commonBinding, cancellationCommandId },
    kind: "cutoff",
    proofId: proofId("proof:active-cancellation-cutoff"),
  };
  const activeCancellation = mutateContainedTurnOperation(active, {
    command: cancellationCommand,
    cutoffProof: activeCancellationCutoff,
    kind: "request_cancellation",
    proof: activeCancellationProof,
  });
  assert.deepEqual(activeCancellation.admissionFence, active.admissionFence);
  assert.deepEqual(activeCancellation.operationCutoff, {
    kind: "closed",
    proofId: activeCancellationCutoff.proofId,
    reason: "cancellation",
    revision: 1,
  });
  assert.equal(activeCancellation.proofs.filter(proof => proof.kind === "cutoff").length, 2);
  assert.strictEqual(mutateContainedTurnOperation(activeCancellation, {
    command: cancellationCommand,
    cutoffProof: activeCancellationCutoff,
    kind: "request_cancellation",
    proof: activeCancellationProof,
  }), activeCancellation);
  assert.equal(classifyContainedTurnOutputAppend({
    authority: oldListenerAuthority,
    current: activeCancellation,
    expectedCursor: 0,
    expectedRevision: activeCancellation.revision,
    operationId,
    scope,
  }), "stale");
  if (dispatchCutoff !== undefined) {
    expectInvariant(
      () => mutateContainedTurnOperation(active, {
        command: cancellationCommand,
        cutoffProof: dispatchCutoff,
        kind: "request_cancellation",
        proof: activeCancellationProof,
      }),
      /fresh cutoff proof/u,
    );
  }
});

test("output authority rejects wrong scope and every stale private writer binding at the current revision", () => {
  const operation = createActiveOperation();
  const authority = containedTurnOutputWriteAuthority(operation);
  assert.equal(classifyContainedTurnOutputAppend({
    authority,
    current: operation,
    expectedCursor: operation.output.chunks.length,
    expectedRevision: operation.revision,
    operationId,
    scope,
  }), "current");
  for (const wrongScope of [
    { projectId: "project:foreign", tenantId: scope.tenantId },
    { projectId: scope.projectId, tenantId: "tenant:foreign" },
  ]) {
    assert.equal(classifyContainedTurnOutputAppend({
      authority,
      current: operation,
      expectedCursor: 0,
      expectedRevision: operation.revision,
      operationId,
      scope: wrongScope,
    }), "not_found");
  }

  const staleAuthorities: readonly ContainedTurnOutputWriteAuthority[] = [
    { ...authority, executionGenerationId: containedTurnIdentity("execution_generation", "execution-generation:stale") },
    { ...authority, writerFence: containedTurnIdentity("writer_fence", "writer-fence:stale") },
    { ...authority, custodyId: containedTurnIdentity("custody", "custody:stale") },
    { ...authority, hostBootId: containedTurnIdentity("host_boot", "host-boot:stale") },
    { ...authority, hostInstanceId: containedTurnIdentity("host_instance", "host-instance:stale") },
    { ...authority, adapterRevision: "adapter:codex:stale" },
  ];
  for (const staleAuthority of staleAuthorities) {
    assert.equal(classifyContainedTurnOutputAppend({
      authority: staleAuthority,
      current: operation,
      expectedCursor: operation.output.chunks.length,
      expectedRevision: operation.revision,
      operationId,
      scope,
    }), "stale");
  }

  const advanced = appendContainedTurnOutputForOwnerStore(
    operation,
    { cursor: 0, kind: "assistant", text: "advance aggregate revision" },
  );
  assert.equal(classifyContainedTurnOutputAppend({
    authority,
    current: advanced,
    expectedCursor: 1,
    expectedRevision: advanced.revision,
    operationId,
    scope,
  }), "current");
  for (const staleAuthority of staleAuthorities) {
    assert.equal(classifyContainedTurnOutputAppend({
      authority: staleAuthority,
      current: advanced,
      expectedCursor: 1,
      expectedRevision: advanced.revision,
      operationId,
      scope,
    }), "stale");
  }
});

test("correct and misrouted output writers race without foreign existence disclosure", async () => {
  let current = createActiveOperation();
  const authority = containedTurnOutputWriteAuthority(current);
  const expectedRevision = current.revision;
  const append = async (trustedScope: typeof scope, text: string) => {
    await Promise.resolve();
    const predicate = classifyContainedTurnOutputAppend({
      authority,
      current,
      expectedCursor: 0,
      expectedRevision,
      operationId,
      scope: trustedScope,
    });
    if (predicate === "not_found") {return { kind: "not_found" as const };}
    if (predicate === "stale") {return { kind: "stale" as const };}
    current = appendContainedTurnOutputForOwnerStore(
      current,
      { cursor: 0, kind: "assistant", text },
    );
    return { kind: "applied" as const };
  };

  const [correct, misrouted] = await Promise.all([
    append(scope, "canonical"),
    append({ projectId: "project:misrouted", tenantId: scope.tenantId }, "foreign"),
  ]);
  assert.deepEqual(correct, { kind: "applied" });
  assert.deepEqual(misrouted, { kind: "not_found" });
  assert.deepEqual(current.output.chunks, [{ cursor: 0, kind: "assistant", text: "canonical" }]);
});

test("operation cutoff linearizes against output and fences an old listener after restart", () => {
  const operation = createActiveOperation();
  const authority = containedTurnOutputWriteAuthority(operation);
  const evidenceId = containedTurnIdentity("evidence", "evidence:cutoff-output-race");

  const outputFirst = appendContainedTurnOutputForOwnerStore(
    operation,
    { cursor: 0, kind: "assistant", text: "won before cutoff" },
  );
  const cutoffAfterOutput = mutateContainedTurnOperation(outputFirst, {
    evidenceId,
    kind: "record_ambiguity",
  });
  assert.deepEqual(cutoffAfterOutput.output.fence, { finalCursor: 1, kind: "fenced" });

  const cutoffFirst = mutateContainedTurnOperation(operation, {
    evidenceId,
    kind: "record_ambiguity",
  });
  const restarted = JSON.parse(JSON.stringify(cutoffFirst)) as ContainedTurnKernelOperation;
  assert.doesNotThrow(() => validateContainedTurnOperation(restarted));
  assert.equal(classifyContainedTurnOutputAppend({
    authority,
    current: restarted,
    expectedCursor: 0,
    expectedRevision: restarted.revision,
    operationId,
    scope,
  }), "stale");
  expectInvariant(
    () => appendContainedTurnOutputForOwnerStore(
      restarted,
      { cursor: 0, kind: "assistant", text: "old listener" },
    ),
    /current active execution authority/u,
  );
});

test("the sole V1 dispatch rejects a second claimant or successor generation", () => {
  const claimed = createReservedOperation();
  assert.equal(claimed.dispatch.kind, "claimed");
  if (claimed.dispatch.kind !== "claimed") {return;}
  const proof = <Kind extends ContainedTurnProof["kind"]>(kind: Kind): Extract<ContainedTurnProof, { kind: Kind }> => {
    const selected = claimed.proofs.find(candidate => candidate.kind === kind);
    assert.notEqual(selected, undefined);
    return selected as Extract<ContainedTurnProof, { kind: Kind }>;
  };
  expectInvariant(
    () => mutateContainedTurnOperation(claimed, {
      attemptId: claimed.dispatch.attemptId,
      consumedGrantReceipts: claimed.dispatch.grantReceipts,
      claimProof: proof("dispatch_claim"),
      custodyId,
      cutoffProof: proof("cutoff"),
      executionGenerationId: containedTurnIdentity("execution_generation", "execution-generation:successor"),
      hostBootId,
      hostCustodyProof: proof("host_custody"),
      hostInstanceId,
      kind: "claim_dispatch",
      preparationToken: claimed.dispatch.preparationToken,
      providerAccessDispatchProof: proof("provider_access_dispatch"),
      runtimeSecurityDispatchProof: proof("runtime_security_dispatch"),
      writerFence: containedTurnIdentity("writer_fence", "writer-fence:successor"),
    }),
    /one uncancelled, cutoff-current, workspace-bound operation/u,
  );
  assert.equal(claimed.dispatch.executionGenerationId, executionGenerationId);
  assert.equal(claimed.dispatch.writerFence, writerFence);
});

const buildClosedExecution = (): ContainedTurnKernelOperation => {
  let operation = appendContainedTurnOutputForOwnerStore(
    createActiveOperation(),
    { cursor: 0, kind: "assistant", text: "done" },
  );
  operation = mutateContainedTurnOperation(operation, {
    kind: "record_provider_acceptance",
    proof: { binding: { ...attemptBinding, disposition: "accepted" }, kind: "provider_acceptance", proofId: proofId("proof:provider-acceptance") },
  });
  operation = mutateContainedTurnOperation(operation, {
    executionProof: { binding: { ...attemptBinding, outcome: "succeeded" }, kind: "execution_closure", proofId: proofId("proof:execution") },
    kind: "close_provider_execution",
    terminalObservationProof: { binding: { ...attemptBinding, outcome: "succeeded" }, kind: "provider_terminal_observation", proofId: proofId("proof:provider-terminal") },
  });
  operation = mutateContainedTurnOperation(operation, {
    kind: "drain_output",
    proof: { binding: { ...attemptBinding, finalCursor: 1 }, kind: "output_drain", proofId: proofId("proof:output-drain") },
  });
  operation = mutateContainedTurnOperation(operation, {
    kind: "resolve_effect",
    proof: { binding: { ...attemptBinding, disposition: "committed" }, kind: "effect_resolution", proofId: proofId("proof:effect") },
  });
  return operation;
};

const physicalContainmentProof: Extract<ContainedTurnProof, { kind: "physical_containment" }> = {
  binding: { ...attemptBinding, custodyId, hostBootId, hostInstanceId },
  kind: "physical_containment",
  proofId: proofId("proof:physical-containment"),
};

const artifactProof: Extract<ContainedTurnProof, { kind: "artifact_manifest_seal" }> = {
  binding: { ...commonBinding, artifactManifestRef: "artifact-manifest:1", workspaceId },
  kind: "artifact_manifest_seal",
  proofId: proofId("proof:artifact"),
};

test("Host Custody owns delegated start while the provider supplies only its private creator", async () => {
  type StartObservation = Awaited<ContainedTurnKernelDelegatedStart["observation"]>;
  const events: string[] = [];
  const startProof: Extract<ContainedTurnProof, { kind: "provider_process_start" }> = {
    binding: { ...attemptBinding, custodyId, hostBootId, hostInstanceId },
    kind: "provider_process_start",
    proofId: proofId("proof:delegated-start"),
  };
  const providerExecution = async (
    start: ContainedTurnKernelDelegatedStart,
  ): Promise<ContainedTurnKernelProviderObservation> => {
    events.push("provider:sdk-entered");
    const providerPrivateProcess = start.createProcess(() => {
      events.push("provider:actual-creator");
      return Object.freeze({ providerPrivateRef: "private-child:1" });
    });
    assert.equal(providerPrivateProcess.providerPrivateRef, "private-child:1");
    assert.throws(
      () => start.createProcess(() => Object.freeze({ providerPrivateRef: "private-child:2" })),
      /exactly once/u,
    );
    const observation = await start.observation;
    assert.equal(observation.kind, "execution_started");
    events.push("provider:observed-host-proof");
    return {
      evidenceId: containedTurnIdentity("evidence", "evidence:provider-terminal-ambiguous"),
      kind: "indeterminate",
    };
  };
  const hostStart: ContainedTurnKernelCustodyPort["start"] = async input => {
    assert.deepEqual(input.intent, intent);
    assert.equal(input.workspaceId, workspaceId);
    assert.equal(Object.keys(input).some(key => /cwd|path/iu.test(key)), false);
    events.push("host:delegated-start");
    let resolveObservation: ((observation: StartObservation) => void) | undefined;
    const observation = new Promise<StartObservation>(resolve => {resolveObservation = resolve;});
    let createInvoked = false;
    const start: ContainedTurnKernelDelegatedStart = {
      createProcess<Process>(createProcess: () => Process): Process {
        if (createInvoked) {throw new TypeError("provider process creator runs exactly once");}
        createInvoked = true;
        events.push("host:before-provider-creator");
        const process = createProcess();
        events.push("host:after-provider-creator");
        if (resolveObservation === undefined) {
          throw new Error("delegated-start observation resolver was not installed");
        }
        resolveObservation({ kind: "execution_started", proof: startProof });
        return process;
      },
      observation,
    };
    const execution = input.execute(start);
    const startOutcome = await observation;
    return startOutcome.kind === "execution_started"
      ? { execution, kind: "execution_started", proof: startOutcome.proof }
      : startOutcome;
  };

  const started = await hostStart({ attemptId, custodyId, execute: providerExecution, intent, operationId, workspaceId });
  assert.equal(started.kind, "execution_started");
  if (started.kind !== "execution_started") {return;}
  assert.equal((await started.execution).kind, "indeterminate");
  assert.deepEqual(events, [
    "host:delegated-start",
    "provider:sdk-entered",
    "host:before-provider-creator",
    "provider:actual-creator",
    "host:after-provider-creator",
    "provider:observed-host-proof",
  ]);
});

const buildTerminalCandidate = (): ContainedTurnKernelOperation => {
  let operation = buildClosedExecution();
  operation = mutateContainedTurnOperation(operation, {
    kind: "record_physical_containment",
    proof: physicalContainmentProof,
  });
  operation = mutateContainedTurnOperation(operation, {
    artifactManifestRef: "artifact-manifest:1",
    kind: "seal_artifact",
    proof: artifactProof,
  });
  operation = mutateContainedTurnOperation(operation, {
    kind: "publish_result",
    proof: { binding: { ...commonBinding, resultRef: "result:1" }, kind: "result_publication", proofId: proofId("proof:result") },
    resultRef: "result:1",
  });
  operation = mutateContainedTurnOperation(operation, {
    kind: "close_workspace",
    proof: { binding: { ...commonBinding, workspaceId }, kind: "workspace_closure", proofId: proofId("proof:workspace") },
  });
  operation = mutateContainedTurnOperation(operation, {
    kind: "record_containment",
    proof: {
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
        physicalContainmentProofId: physicalContainmentProof.proofId,
        providerRouteRef: providerAccessSnapshot.providerRouteRef,
        terminalObservationProofId: proofId("proof:provider-terminal"),
        workspaceId,
      },
      kind: "containment",
      proofId: proofId("proof:containment"),
    },
  });
  const satisfactionDigest = containedTurnSatisfactionDigest(operation);
  const terminalProof: ContainedTurnProof = {
    binding: {
      ...commonBinding,
      requiredReceiptSetDigest: operation.requiredReceiptSetDigest,
      requiredReceiptSetVersion: operation.requiredReceiptSet.setVersion,
      satisfactionDigest,
      terminalOutcome: "succeeded",
    },
    kind: "terminal_truth",
    proofId: proofId("proof:terminal"),
  };
  return mutateContainedTurnOperation(operation, {
    kind: "finalize",
    proof: terminalProof as Extract<ContainedTurnProof, { kind: "terminal_truth" }>,
  });
};

test("post-claim cancellation containment rejects the stale dispatch cutoff and accepts the exact current cutoff", () => {
  let operation = buildClosedExecution();
  const commandId = containedTurnIdentity("cancellation_command", "cancellation-command:containment-cutoff");
  const commandSubject = {
    cancellationCommandId: commandId,
    operationId,
    scopeDigest: containedTurnScopeDigest(scope),
  };
  const command = { ...commandSubject, fingerprint: containedTurnCancellationFingerprint(commandSubject) };
  const cancellationCutoff: Extract<ContainedTurnProof, { kind: "cutoff" }> = {
    binding: { ...commonBinding, cancellationCommandId: commandId },
    kind: "cutoff",
    proofId: proofId("proof:cancellation-containment-cutoff"),
  };
  operation = mutateContainedTurnOperation(operation, {
    command,
    cutoffProof: cancellationCutoff,
    kind: "request_cancellation",
    proof: {
      binding: { ...commonBinding, cancellationCommandId: commandId, cancellationFingerprint: command.fingerprint },
      kind: "cancellation",
      proofId: proofId("proof:cancellation-containment"),
    },
  });
  operation = mutateContainedTurnOperation(operation, { kind: "record_physical_containment", proof: physicalContainmentProof });
  operation = mutateContainedTurnOperation(operation, {
    artifactManifestRef: "artifact-manifest:1", kind: "seal_artifact", proof: artifactProof,
  });
  operation = mutateContainedTurnOperation(operation, {
    kind: "publish_result",
    proof: { binding: { ...commonBinding, resultRef: "result:cancellation" }, kind: "result_publication", proofId: proofId("proof:result:cancellation") },
    resultRef: "result:cancellation",
  });
  operation = mutateContainedTurnOperation(operation, {
    kind: "close_workspace",
    proof: { binding: { ...commonBinding, workspaceId }, kind: "workspace_closure", proofId: proofId("proof:workspace:cancellation") },
  });
  const containmentProof = (cutoffProofId: ReturnType<typeof proofId>): Extract<ContainedTurnProof, { kind: "containment" }> => ({
    binding: {
      ...attemptBinding,
      adapterRevision: adapterSnapshot.adapterRevision,
      artifactManifestSealProofId: artifactProof.proofId,
      binaryRevision: adapterSnapshot.binaryRevision,
      capabilityManifestRevision: manifest.manifestRevision,
      containmentPolicyDigest: authorityVector.containmentPolicyDigest,
      credentialBindingDigest: providerAccessSnapshot.credentialBindingDigest,
      custodyId,
      cutoffProofId,
      executionClosureProofId: proofId("proof:execution"),
      finalCursor: 1,
      hostBootId,
      hostInstanceId,
      immutableScopeDigest: authorityVector.scopeDigest,
      outputDrainProofId: proofId("proof:output-drain"),
      physicalContainmentProofId: physicalContainmentProof.proofId,
      providerRouteRef: providerAccessSnapshot.providerRouteRef,
      terminalObservationProofId: proofId("proof:provider-terminal"),
      workspaceId,
    },
    kind: "containment",
    proofId: proofId(`proof:containment:${cutoffProofId}`),
  });
  expectInvariant(
    () => mutateContainedTurnOperation(operation, {
      kind: "record_containment", proof: containmentProof(proofId("proof:cutoff")),
    }),
    /exact current operation cutoff/u,
  );
  const contained = mutateContainedTurnOperation(operation, {
    kind: "record_containment", proof: containmentProof(cancellationCutoff.proofId),
  });
  assert.equal(contained.containment.kind, "contained");
});

test("physical containment precedes canonical artifacts and exact composite containment", async () => {
  const closed = buildClosedExecution();
  const events: string[] = [];
  const requestPhysicalContainment: ContainedTurnKernelCustodyPort["requestPhysicalContainment"] = async input => {
    assert.deepEqual(input, { attemptId, custodyId, operationId });
    events.push("custody:physical-containment");
    return { kind: "contained", proof: physicalContainmentProof };
  };
  const sealArtifacts: ContainedTurnKernelArtifactPort["seal"] = async input => {
    assert.equal(input.workspaceId, workspaceId);
    events.push("artifacts:seal");
    return {
      artifactProof,
      kind: "sealed",
      resultProof: {
        binding: { ...commonBinding, resultRef: "result:fake-ordering" },
        kind: "result_publication",
        proofId: proofId("proof:result:fake-ordering"),
      },
    };
  };
  expectInvariant(
    () => mutateContainedTurnOperation(closed, {
      artifactManifestRef: "artifact-manifest:1",
      kind: "seal_artifact",
      proof: artifactProof,
    }),
    /physical-containment barrier/u,
  );
  const earlyComposite: Extract<ContainedTurnProof, { kind: "containment" }> = {
    binding: {
      ...attemptBinding,
      adapterRevision: adapterSnapshot.adapterRevision,
      artifactManifestSealProofId: artifactProof.proofId,
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
      physicalContainmentProofId: physicalContainmentProof.proofId,
      providerRouteRef: providerAccessSnapshot.providerRouteRef,
      terminalObservationProofId: proofId("proof:provider-terminal"),
      workspaceId,
    },
    kind: "containment",
    proofId: proofId("proof:containment"),
  };
  expectInvariant(
    () => mutateContainedTurnOperation(closed, { kind: "record_containment", proof: earlyComposite }),
    /earlier exact physical-containment barrier/u,
  );

  const physical = await requestPhysicalContainment({ attemptId, custodyId, operationId });
  assert.equal(physical.kind, "contained");
  if (physical.kind !== "contained") {return;}
  const physicallyContained = mutateContainedTurnOperation(closed, {
    kind: "record_physical_containment",
    proof: physical.proof,
  });
  assert.deepEqual(physicallyContained.physicalContainment, {
    kind: "contained",
    proofId: physicalContainmentProof.proofId,
  });
  const artifacts = await sealArtifacts({ operationId, output: physicallyContained.output.chunks, workspaceId });
  assert.equal(artifacts.kind, "sealed");
  if (artifacts.kind !== "sealed") {return;}
  const sealed = mutateContainedTurnOperation(physicallyContained, {
    artifactManifestRef: artifacts.artifactProof.binding.artifactManifestRef,
    kind: "seal_artifact",
    proof: artifacts.artifactProof,
  });
  assert.deepEqual(events, ["custody:physical-containment", "artifacts:seal"]);
  const wrongPhysicalBinding = {
    ...earlyComposite,
    binding: {
      ...earlyComposite.binding,
      physicalContainmentProofId: proofId("proof:physical-containment:other"),
    },
  };
  expectInvariant(
    () => mutateContainedTurnOperation(sealed, { kind: "record_containment", proof: wrongPhysicalBinding }),
    /earlier exact physical-containment barrier/u,
  );
});

test("indeterminate physical containment closes cutoff and remains reconcile-required", () => {
  const operation = createActiveOperation();
  const oldListenerAuthority = containedTurnOutputWriteAuthority(operation);
  const evidenceId = containedTurnIdentity("evidence", "evidence:physical-containment-unknown");
  const uncertain = mutateContainedTurnOperation(operation, {
    evidenceId,
    kind: "record_physical_containment_unknown",
  });
  assert.deepEqual(uncertain.physicalContainment, { evidenceId, kind: "uncertain" });
  assert.deepEqual(uncertain.containment, { evidenceId, kind: "uncertain" });
  assert.deepEqual(uncertain.reconciliation, { evidenceIds: [evidenceId], kind: "required" });
  assert.deepEqual(uncertain.operationCutoff, {
    evidenceId,
    kind: "closed",
    reason: "continuity_lost",
    revision: 1,
  });
  assert.equal(classifyContainedTurnOutputAppend({
    authority: oldListenerAuthority,
    current: uncertain,
    expectedCursor: 0,
    expectedRevision: uncertain.revision,
    operationId,
    scope,
  }), "stale");
  expectInvariant(
    () => mutateContainedTurnOperation(uncertain, {
      artifactManifestRef: "artifact-manifest:1",
      kind: "seal_artifact",
      proof: artifactProof,
    }),
    /physical-containment barrier/u,
  );
});

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
