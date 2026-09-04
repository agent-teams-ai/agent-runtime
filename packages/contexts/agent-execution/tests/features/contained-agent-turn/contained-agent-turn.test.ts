import assert from "node:assert/strict";
import test from "node:test";

import type { ContainedTurnKernelDependencies } from "../../../dist/features/contained-agent-turn/application/ports/outbound/contained-turn-ports.js";
import { recoverContainedTurnDispatchPreparations } from "../../../dist/features/contained-agent-turn/application/contained-turn-preparation-recovery.js";
import { createContainedTurnFeature } from "../../../dist/features/contained-agent-turn/composition/feature-module-factory.js";
import {
  awaitFixtureGate,
  createDependencies,
  custodyId,
  operationId,
  proofId,
} from "../../features/contained-agent-turn/support/contained-agent-turn-fixture.ts";

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

test("Host Custody receives only intent mode while the provider receives the full accepted intent", async () => {
  const { custodyStartInputs, dependencies, providerExecuteInputs } = createDependencies();
  const intent = Object.freeze({ mode: "analysis" as const, prompt: "private provider prompt payload" });
  const result = await createContainedTurnFeature(dependencies).submit.execute({
    commandId: "command:one",
    expectedProvider: "codex",
    intent,
    scope: { projectId: "project:one", tenantId: "tenant:one" },
  });
  assert.equal(result.status, "observed");
  assert.equal(custodyStartInputs.length, 1);
  assert.equal(custodyStartInputs[0]?.intentMode, intent.mode);
  assert.equal("intent" in (custodyStartInputs[0] ?? {}), false);
  assert.equal("prompt" in (custodyStartInputs[0] ?? {}), false);
  assert.equal(providerExecuteInputs.length, 1);
  assert.deepEqual(providerExecuteInputs[0]?.intent, intent);
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
  let accepted: import("../../../dist/features/contained-agent-turn/index.js").ContainedTurnOperationRef | undefined;
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
    cancellation = await feature.cancel.execute(accepted as import("../../../dist/features/contained-agent-turn/index.js").ContainedTurnOperationRef);
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

test("abort after durable acceptance leaves owner state unchanged while explicit cancellation keeps its identity", async () => {
  let releaseProvider!: () => void;
  const providerGate = new Promise<void>(resolve => {releaseProvider = resolve;});
  let providerStarted!: () => void;
  const started = new Promise<void>(resolve => {providerStarted = resolve;});
  const controller = new AbortController();
  const { containmentCalls, current, dependencies, providerCalls } = createDependencies({ providerGate, providerStarted });
  const feature = createContainedTurnFeature(dependencies);
  const submission = feature.submit.execute({
    commandId: "command:one",
    expectedProvider: "codex",
    intent: { mode: "analysis", prompt: "inspect disposable state" },
    scope: { projectId: "project:one", tenantId: "tenant:one" },
  }, { signal: controller.signal });
  await awaitFixtureGate(started, submission);
  while (current()?.providerExecution.kind !== "active") {
    await new Promise<void>(resolve => {setImmediate(resolve);});
  }
  const beforeAbort = current();
  assert.ok(beforeAbort !== undefined);
  try {
    controller.abort();
    await new Promise<void>(resolve => {setImmediate(resolve);});
    assert.equal(current(), beforeAbort);
    assert.equal(beforeAbort.cancellation.kind, "open");
    assert.equal(beforeAbort.operationCutoff.kind, "open");
    assert.equal(beforeAbort.output.fence.kind, "open");
    assert.equal(beforeAbort.providerExecution.kind, "active");
    assert.equal(containmentCalls.value, 0);
    assert.equal(providerCalls.value, 1);

    const cancellation = await feature.cancel.execute({ operationId, scope: beforeAbort.scope });
    assert.equal(cancellation.status, "observed");
    const afterCancellation = current();
    assert.ok(afterCancellation !== undefined);
    assert.equal(afterCancellation.cancellation.kind, "requested");
    if (afterCancellation.cancellation.kind === "requested") {
      assert.equal(
        afterCancellation.cancellation.command.cancellationCommandId,
        "cancellation-command:one",
      );
    }
    assert.equal(afterCancellation.operationCutoff.kind, "closed");
    assert.ok(afterCancellation.revision > beforeAbort.revision);
    assert.equal(containmentCalls.value, 1);
    assert.equal(providerCalls.value, 1);
  } finally {releaseProvider();}
  const completed = await submission;
  assert.equal(completed.status, "observed");
  if (completed.status === "observed") {assert.equal(completed.turn.status, "reconcile_required");}
});
test("potential command acceptance enters Host lifecycle custody without dispatch", async () => {
  const { createdWorkspaces, dependencies, providerCalls } = createDependencies({
    potentialAcceptance: true,
  });
  let acceptedOperationId: string | undefined;
  const outcome = await createContainedTurnFeature(dependencies).submit.execute({
    commandId: "command:one",
    expectedProvider: "codex",
    intent: { mode: "analysis", prompt: "inspect potential durable acceptance" },
    scope: { projectId: "project:one", tenantId: "tenant:one" },
  }, { onAccepted: operation => {acceptedOperationId = operation.operationId;} });

  assert.equal(outcome.status, "observed");
  if (outcome.status === "observed") {
    assert.equal(outcome.turn.operationId, acceptedOperationId);
    assert.equal(outcome.turn.status, "reconcile_required");
  }
  assert.equal(createdWorkspaces.length, 0);
  assert.equal(providerCalls.value, 0);
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

test("indeterminate dispatch claim retires preparation into durable debt without provider retry", async () => {
  const { current, dependencies, providerCalls } = createDependencies({
    claimIndeterminate: true,
    providerSettlementIndeterminateOnce: true,
  });
  const outcome = await createContainedTurnFeature(dependencies).submit.execute({
    commandId: "command:one",
    expectedProvider: "codex",
    intent: { mode: "analysis", prompt: "lose the dispatch claim outcome" },
    scope: { projectId: "project:one", tenantId: "tenant:one" },
  });
  assert.equal(outcome.status, "observed");
  if (outcome.status === "observed") {assert.equal(outcome.turn.status, "reconcile_required");}
  assert.equal(providerCalls.value, 0);
  assert.equal(current()?.dispatch.kind, "unclaimed");
  assert.equal(current()?.reconciliation.kind, "required");
  assert.equal(current()?.terminal.kind, "open");
  const scope = { projectId: "project:one", tenantId: "tenant:one" };
  const pending = await dependencies.operationStore.listDispatchPreparations?.({ scope });
  assert.equal(pending?.length, 1);
  assert.equal(pending?.[0]?.preparation.kind, "cleanup_pending");
  assert.deepEqual(await recoverContainedTurnDispatchPreparations(dependencies, scope), {
    discovered: 1,
    retired: 0,
  });
  assert.equal((await dependencies.operationStore.listDispatchPreparations?.({ scope }))?.length, 0);
});

test("cancellation racing the first workspace creation reaches proved-no-start terminal closure", async () => {
  let releaseWorkspace!: () => void;
  const workspaceGate = new Promise<void>(resolve => {releaseWorkspace = resolve;});
  let workspaceStarted!: () => void;
  const started = new Promise<void>(resolve => {workspaceStarted = resolve;});
  let accepted: import("../../../dist/features/contained-agent-turn/index.js").ContainedTurnOperationRef | undefined;
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
    const cancellation = await feature.cancel.execute(accepted as import("../../../dist/features/contained-agent-turn/index.js").ContainedTurnOperationRef);
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
