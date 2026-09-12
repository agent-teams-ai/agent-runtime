import assert from "node:assert/strict";
import test from "node:test";

import type { ContainedTurnKernelDependencies } from "../../../dist/features/contained-agent-turn/application/ports/outbound/contained-turn-ports.js";
import { createContainedTurnFeature } from "../../../dist/features/contained-agent-turn/composition/feature-module-factory.js";
import { createContainedTurnPreparationScopeDependencies } from "../../../dist/features/contained-agent-turn/composition/preparation-scope-anti-corruption.js";
import type { ContainedTurnKernelOperation } from "../../../dist/features/contained-agent-turn/domain/contained-turn-kernel-model.js";
import { createOperation } from "../../contained-turn-kernel-fixtures.ts";
import { createDependencies, operationId } from "./support/contained-agent-turn-fixture.ts";

const input = {
  commandId: "command:one", expectedProvider: "codex",
  intent: { mode: "analysis" as const, prompt: "inspect acceptance snapshot" },
  scope: { projectId: "project:one", tenantId: "tenant:one" },
};
const potential = (candidateOperation: ContainedTurnKernelOperation) => ({
  candidateOperation, evidenceId: "evidence:potential-acceptance", kind: "potential_acceptance",
});

const submission = (respond: (candidate: ContainedTurnKernelOperation) => unknown) => {
  const fixture = createDependencies();
  let acceptanceCalls = 0;
  let acceptedCallbacks = 0;
  const feature = createContainedTurnFeature({
    ...fixture.dependencies,
    operationStore: {
      ...fixture.dependencies.operationStore,
      accept: ((candidate: ContainedTurnKernelOperation) => {
        acceptanceCalls += 1;
        return respond(candidate);
      }) as ContainedTurnKernelDependencies["operationStore"]["accept"],
    },
  });
  return {
    execute: () => feature.submit.execute(input, { onAccepted: () => {acceptedCallbacks += 1;} }),
    assertNoDispatch: () => {
      assert.equal(acceptanceCalls, 1);
      assert.equal(acceptedCallbacks, 0);
      assert.equal(fixture.current(), undefined);
      assert.equal(fixture.providerCalls.value, 0);
      assert.equal(fixture.createdWorkspaces.length, 0);
      assert.equal(fixture.openedCustodies.length, 0);
    },
  };
};

for (const field of ["operationId", "commandId"] as const) {
  test(`acceptance snapshot rejects first-read/second-read ${field} substitution`, async () => {
    let reads = 0;
    const run = submission(async candidate => {
      const hostile = { ...candidate };
      Object.defineProperty(hostile, field, {
        enumerable: true,
        get: () => ++reads === 1 ? candidate[field] : `${field === "operationId" ? "operation" : "command"}:foreign`,
      });
      return potential(hostile);
    });
    const result = await run.execute().catch((error: unknown) => error);
    run.assertNoDispatch();
    assert.ok(result instanceof TypeError, `expected rejection, received ${JSON.stringify(result)}`);
    assert.equal(reads, 0, "validation must not invoke the identity accessor");
  });
}

test("acceptance snapshot rejects accessors and proxies without executing hostile code", async () => {
  let traps = 0;
  const trap = (): never => {traps += 1; throw new Error("hostile trap must not run");};
  const proxy = <Value extends object>(value: Value): Value => new Proxy(value, {
    get: trap, getOwnPropertyDescriptor: trap, getPrototypeOf: trap, ownKeys: trap,
  });
  const accessor = <Value extends object>(value: Value, field: string): Value =>
    Object.defineProperty(value, field, { enumerable: true, get: trap });
  const cases: Array<(candidate: ContainedTurnKernelOperation) => unknown> = [
    candidate => accessor(potential(candidate), "kind"),
    candidate => accessor(potential(candidate), "candidateOperation"),
    candidate => accessor(potential(candidate), "evidenceId"),
    candidate => potential({ ...candidate, scope: accessor({ ...candidate.scope }, "tenantId") }),
    candidate => potential(proxy({ ...candidate })),
    candidate => potential({ ...candidate, scope: proxy({ ...candidate.scope }) }),
    candidate => potential({ ...candidate, proofs: proxy([...candidate.proofs]) }),
    candidate => potential(Object.setPrototypeOf({ ...candidate }, proxy({}))),
    candidate => ({ kind: "accepted", operation: proxy({ ...candidate }) }),
    candidate => ({ kind: "replayed", operation: accessor({ ...candidate }, "operationId") }),
    candidate => {
      const revoked = Proxy.revocable(candidate, {});
      revoked.revoke();
      return potential(revoked.proxy);
    },
  ];
  for (const [index, respond] of cases.entries()) {
    const run = submission(async candidate => respond(candidate));
    await assert.rejects(run.execute(), TypeError, `hostile acceptance case ${index}`);
    run.assertNoDispatch();
  }
  // Invalid synchronous results must be rejected before await can assimilate them.
  for (const respond of [
    (candidate: ContainedTurnKernelOperation) => proxy(potential(candidate)),
    () => proxy(Promise.resolve({ kind: "not_found" })),
    () => accessor({}, "then"),
  ]) {
    const run = submission(respond);
    await assert.rejects(run.execute(), TypeError);
    run.assertNoDispatch();
  }
  assert.equal(traps, 0);
});

test("acceptance snapshot rejects unknown, malformed, oversized and aliased values", async () => {
  const cases: Array<(candidate: ContainedTurnKernelOperation) => unknown> = [
    () => null,
    () => ({ kind: "unknown" }),
    candidate => ({ ...potential(candidate), extra: "private owner data" }),
    candidate => ({ ...potential(candidate), candidateOperation: { ...candidate, extra: true } }),
    candidate => ({ ...potential(candidate), [Symbol("extra")]: true }),
    candidate => Object.defineProperty(potential(candidate), "extra", { value: true }),
    candidate => ({ ...potential(candidate), candidateOperation: { ...candidate, revision: Number.NaN } }),
    candidate => ({ ...potential(candidate), candidateOperation: { ...candidate, operationId: "operation:foreign" } }),
    candidate => ({ ...potential(candidate), candidateOperation: { ...candidate, commandId: "command:foreign" } }),
    candidate => ({ ...potential(candidate), candidateOperation: { ...candidate, intent: { ...candidate.intent, prompt: "x".repeat(65_537) } } }),
    candidate => ({ ...potential(candidate), candidateOperation: { ...candidate, proofs: Array.from({ length: 65 }, () => structuredClone(candidate.proofs[0])) } }),
    candidate => ({ ...potential(candidate), candidateOperation: { ...candidate, proofs: Array(20_000) } }),
    candidate => ({ ...potential(candidate), candidateOperation: { ...candidate, proofs: Array.from({ length: 16_385 }, () => ({})) } }),
    candidate => ({ ...potential(candidate), extra: Object.fromEntries(Array.from({ length: 16_385 }, (_, index) => [index, null])) }),
    candidate => ({ ...potential(candidate), extra: Array.from({ length: 33 }).reduce(value => ({ value }), {} as object) }),
    candidate => {
      const cyclic = { ...potential(candidate), cycle: {} };
      cyclic.cycle = cyclic;
      return cyclic;
    },
    candidate => ({ ...potential(candidate), candidateOperation: {
      ...candidate, acceptedAuthorityVector: { ...candidate.acceptedAuthorityVector, adapterSnapshot: candidate.adapterSnapshot },
    } }),
  ];
  for (const evidenceId of [undefined, null, {}, "", "operation:foreign", "evidence:\ninvalid", `evidence:${"x".repeat(512)}`]) {
    cases.push(candidate => ({ ...potential(candidate), evidenceId }));
  }
  for (const kind of ["accepted", "replayed", "fingerprint_conflict", "not_found"]) {
    cases.push(candidate => ({ kind, operation: candidate, extra: "must reject before projection" }));
  }
  for (const [index, respond] of cases.entries()) {
    const run = submission(async candidate => respond(candidate));
    await assert.rejects(run.execute(), TypeError, `malformed acceptance case ${index}`);
    run.assertNoDispatch();
  }
  const foreign = submission(async candidate => potential({ ...candidate, effectId: "effect:foreign" as never }));
  assert.deepEqual(await foreign.execute(), { status: "denied" });
  foreign.assertNoDispatch();
});

test("acceptance response is detached from retained owner mutation", async () => {
  for (const kind of ["accepted", "replayed", "potential_acceptance"] as const) {
    const fixture = createDependencies();
    const candidate = createOperation();
    const ownerOperation = structuredClone(candidate);
    const owner = kind === "potential_acceptance"
      ? { kind, candidateOperation: ownerOperation, evidenceId: "evidence:potential-acceptance" }
      : { kind, operation: ownerOperation };
    const dependencies = createContainedTurnPreparationScopeDependencies({
      ...fixture.dependencies,
      operationStore: { ...fixture.dependencies.operationStore, accept: async () => owner as never },
    });
    const snapshot = await dependencies.operationStore.accept(candidate, {
      commandId: candidate.commandId, effectId: candidate.effectId,
      operationId: candidate.operationId, scope: candidate.scope,
    });
    const expected = structuredClone(snapshot);
    ownerOperation.operationId = "operation:foreign" as never;
    ownerOperation.commandId = "command:foreign" as never;
    ownerOperation.scope.tenantId = "tenant:foreign";
    assert.deepEqual(snapshot, expected);
    const operation = snapshot.kind === "potential_acceptance" ? snapshot.candidateOperation
      : snapshot.kind === "accepted" || snapshot.kind === "replayed" ? snapshot.operation : undefined;
    assert.ok(operation);
    assert.notStrictEqual(operation, ownerOperation);
    assert.equal(Object.isFrozen(snapshot), true);
    assert.equal(Object.isFrozen(operation), true);
    assert.equal(Object.isFrozen(operation.scope), true);
    assert.equal(fixture.providerCalls.value, 0);
  }
  const run = submission(async candidate => potential(structuredClone(candidate)));
  assert.deepEqual(await run.execute(), {
    candidateOperationId: operationId, commandId: input.commandId,
    evidenceId: "evidence:potential-acceptance", status: "potential_acceptance",
  });
  run.assertNoDispatch();
});

test("malformed confirmed acceptance cannot dispatch an actually persisted candidate", async () => {
  const fixture = createDependencies();
  let acceptanceCalls = 0;
  let acceptedCallbacks = 0;
  const feature = createContainedTurnFeature({
    ...fixture.dependencies,
    operationStore: {
      ...fixture.dependencies.operationStore,
      accept: async (candidate, authority) => {
        acceptanceCalls += 1;
        const accepted = await fixture.dependencies.operationStore.accept(candidate, authority);
        return { ...accepted, extra: "untrusted owner data" };
      },
    },
  });
  await assert.rejects(feature.submit.execute(input, { onAccepted: () => {acceptedCallbacks += 1;} }), TypeError);
  const observed = await feature.observe.execute({ operationId, scope: input.scope });
  assert.equal(observed.status, "observed");
  if (observed.status === "observed") {assert.equal(observed.turn.status, "accepted");}
  assert.equal(fixture.current()?.reconciliation.kind, "clear");
  assert.equal(acceptanceCalls, 1);
  assert.equal(acceptedCallbacks, 0);
  assert.equal(fixture.providerCalls.value, 0);
  assert.equal(fixture.createdWorkspaces.length, 0);
  assert.equal(fixture.openedCustodies.length, 0);
});
