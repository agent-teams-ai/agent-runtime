import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import * as publicApi from "../dist/index.js";

import {
  createContainedTurnDispatchAuthorityFeature,
  createInMemoryDispatchConsumptionRepository,
  createNodeSha256DispatchDigest,
} from "../dist/composition.js";
import type { DispatchConsumptionRepository } from "../dist/composition.js";

import {
  assertDeepFrozen,
  authority,
  harness,
  input,
  scope,
} from "./contained-turn-dispatch-authority.fixtures.ts";

test("DTO serializers reject unknown diagnostics and do not freeze sources", async () => {
  const base = harness();
  const seed = await base.authority.consumeForDispatch(input());
  assert.equal(seed.status, "consumed");
  if (seed.status !== "consumed") {return;}
  const sourceScope = { ...seed.receipt.scope };
  const sourceReceipt = {
    ...seed.receipt,
    scope: sourceScope,
    diagnostics: { secret: "must-not-cross-boundary" },
  };
  const sourceResult = {
    status: "consumed" as const,
    receipt: sourceReceipt,
    diagnostics: { internal: true },
  };
  const repository: DispatchConsumptionRepository = {
    async consumeAtomically() {return sourceResult;},
    async observe() {return;},
    async settleAtomically() {return { status: "not_found" };},
  };
  const result = await createContainedTurnDispatchAuthorityFeature({
    repository, clock: { now: () => 100 }, digest: createNodeSha256DispatchDigest(),
  }).dispatchAuthorityV1.consumeForDispatch(input());
  assert.deepEqual(result, { status: "indeterminate", reason: "owner_unavailable" });
  assert.equal(Object.isFrozen(sourceResult), false);
  assert.equal(Object.isFrozen(sourceReceipt), false);
  assert.equal(Object.isFrozen(sourceScope), false);
});

test("invalid adapter settlement cannot create an arbitrary or reopened lifecycle", async () => {
  const repository = createInMemoryDispatchConsumptionRepository([authority()]);
  const feature = createContainedTurnDispatchAuthorityFeature({
    repository,
    clock: { now: () => 100 },
    digest: createNodeSha256DispatchDigest(),
  });
  const consumed = await feature.dispatchAuthorityV1.consumeForDispatch(input());
  assert.equal(consumed.status, "consumed");
  if (consumed.status !== "consumed") {return;}
  const malformedDecision = {
    outcome: { status: "settled", receipt: {
      contractVersion: "contained-turn-dispatch-settlement/v1",
      settlementRequestId: "malformed",
      consumptionDigest: consumed.receipt.consumptionDigest,
      disposition: "claim_committed",
      settledAtControlTime: 101,
    } },
    persistSettlement: {
      contractVersion: "contained-turn-dispatch-settlement/v1",
      settlementRequestId: "malformed",
      consumptionDigest: consumed.receipt.consumptionDigest,
      disposition: "abandoned_without_claim",
      settledAtControlTime: 101,
    },
  } as never;
  const malformedResult = await repository.settleAtomically(
    { scope, providerId: "provider-a", authorityGeneration: "generation-a",
      operationId: "operation-a", grantRequestId: "grant-request-a",
      settlementRequestId: "malformed", consumptionDigest: consumed.receipt.consumptionDigest },
    () => malformedDecision,
  );
  assert.deepEqual(malformedResult, { status: "invalid_request" });
  assert.equal(
    (await repository.inspectConsumption(scope, "provider-a", "generation-a",
      "operation-a"))?.lifecycleState,
    "consumed_pending",
  );
});

test("every observation result branch is deeply frozen", async () => {
  const preventedFixture = harness();
  await preventedFixture.authority.consumeForDispatch(
    input({ expectedAuthorityRevision: "authority-revision-stale" }),
  );
  const prevented = await preventedFixture.authority.observeDispatchConsumption({
    ...input(),
  });
  const notFound = await preventedFixture.authority.observeDispatchConsumption({
    ...input({ grantRequestId: "missing-grant", requestDigest: "missing-request" }),
  });
  const conflict = await preventedFixture.authority.observeDispatchConsumption({
    ...input({ requestDigest: "different-request" }),
  });
  const unavailableRepository: DispatchConsumptionRepository = {
    async consumeAtomically() {return { status: "indeterminate", reason: "owner_unavailable" };},
    async observe() {throw new Error("owner unavailable");},
    async settleAtomically() {return { status: "indeterminate", reason: "owner_unavailable" };},
  };
  const unavailable = createContainedTurnDispatchAuthorityFeature({
    repository: unavailableRepository,
    clock: { now: () => 100 },
    digest: createNodeSha256DispatchDigest(),
  });
  const indeterminate = await unavailable.dispatchAuthorityV1.observeDispatchConsumption({
    ...input(),
  });
  for (const result of [prevented, notFound, conflict, indeterminate]) {
    assertDeepFrozen(result);
  }
});

test("concurrent settlements have one winner and cannot reopen consumption", async () => {
  const fixture = harness();
  const consumed = await fixture.authority.consumeForDispatch(input());
  assert.equal(consumed.status, "consumed");
  if (consumed.status !== "consumed") {return;}
  const outcomes = await Promise.all([
    fixture.authority.settleDispatchConsumption({
      scope, providerId: "provider-a", authorityGeneration: "generation-a",
      operationId: "operation-a", grantRequestId: "grant-request-a",
      settlementRequestId: "settlement-one",
      consumptionDigest: consumed.receipt.consumptionDigest,
      disposition: "claim_committed",
    }),
    fixture.authority.settleDispatchConsumption({
      scope, providerId: "provider-a", authorityGeneration: "generation-a",
      operationId: "operation-a", grantRequestId: "grant-request-a",
      settlementRequestId: "settlement-two",
      consumptionDigest: consumed.receipt.consumptionDigest,
      disposition: "abandoned_without_claim",
    }),
  ]);
  assert.deepEqual(outcomes.map(outcome => outcome.status).toSorted(), ["conflict", "settled"]);
});

test("provider identity and authority generation are exact independent selectors", async () => {
  const fixture = harness();
  assert.deepEqual(await fixture.authority.consumeForDispatch(input({ providerId: "provider-b" })),
    { status: "not_found" });
  assert.deepEqual(await fixture.authority.consumeForDispatch(
    input({ authorityGeneration: "generation-b" })), { status: "not_found" });
  const consumed = await fixture.authority.consumeForDispatch(input());
  assert.equal(consumed.status, "consumed");
  if (consumed.status !== "consumed") {return;}
  assert.equal(consumed.receipt.providerId, "provider-a");
  assert.equal(consumed.receipt.authorityGeneration, "generation-a");
  assert.deepEqual(await fixture.authority.observeDispatchConsumption(
    input({ authorityGeneration: "generation-b" })), { status: "not_found" });
  assert.deepEqual(await fixture.authority.settleDispatchConsumption({
    scope, providerId: "provider-b", authorityGeneration: "generation-a",
    operationId: "operation-a", grantRequestId: "grant-request-a",
    settlementRequestId: "wrong-provider", consumptionDigest: consumed.receipt.consumptionDigest,
    disposition: "claim_committed",
  }), { status: "not_found" });
});

test("hostile receipt fields and consumption digests fail closed without source freezing", async () => {
  const seeded = harness();
  const result = await seeded.authority.consumeForDispatch(input());
  assert.equal(result.status, "consumed");
  if (result.status !== "consumed") {return;}
  for (const receipt of [
    { ...result.receipt, consumptionDigest: "sha256:forged" },
    { ...result.receipt, ownerEvidenceRef: "runtime-security-evidence:v1:../../host" },
    { ...result.receipt, hostile: true },
  ]) {
    const source = { status: "consumed" as const, receipt };
    const repository: DispatchConsumptionRepository = {
      async consumeAtomically() {return source as never;},
      async observe() {return;},
      async settleAtomically() {return { status: "not_found" };},
    };
    const outcome = await createContainedTurnDispatchAuthorityFeature({
      repository, clock: { now: () => 100 }, digest: createNodeSha256DispatchDigest(),
    }).dispatchAuthorityV1.consumeForDispatch(input());
    assert.deepEqual(outcome, { status: "indeterminate", reason: "owner_unavailable" });
    assert.equal(Object.isFrozen(source), false);
    assert.equal(Object.isFrozen(receipt), false);
  }
});

test("in-memory selectors snapshot before their queued owner transaction", async () => {
  const repository = createInMemoryDispatchConsumptionRepository([authority()]);
  const originalScope = { ...scope };
  const key = { scope: originalScope, providerId: "provider-a", authorityGeneration: "generation-a",
    operationId: "operation-a", grantRequestId: "snapshot-request" };
  const notFound = Object.freeze({ status: "not_found" } as const);
  const pendingConsume = repository.consumeAtomically(key, () => ({
    outcome: notFound,
    persistRequest: { requestDigest: "snapshot-digest", requestFingerprint: "snapshot-fingerprint",
      outcome: notFound },
  }));
  originalScope.tenantId = "mutated-tenant";
  key.providerId = "mutated-provider";
  await pendingConsume;
  const observed = await repository.observe({ scope, providerId: "provider-a",
    authorityGeneration: "generation-a", operationId: "operation-a",
    grantRequestId: "snapshot-request" });
  assert.equal(observed?.requestDigest, "snapshot-digest");

  const revokeScope = { ...scope };
  const pendingRevoke = repository.revokeAuthority(
    revokeScope, "provider-a", "generation-a", "operation-a");
  revokeScope.projectId = "mutated-project";
  await pendingRevoke;
  const feature = createContainedTurnDispatchAuthorityFeature({ repository,
    clock: { now: () => 100 }, digest: createNodeSha256DispatchDigest() });
  const revoked = await feature.dispatchAuthorityV1.consumeForDispatch(
    input({ grantRequestId: "after-revoke" }));
  assert.equal(revoked.status, "prevented");
  if (revoked.status === "prevented") {assert.equal(revoked.evidence.reason, "revoked");}
});

test("exact composition rejects unknown keys and never invokes dependency getters", () => {
  const repository = createInMemoryDispatchConsumptionRepository([authority()]);
  assert.throws(() => createContainedTurnDispatchAuthorityFeature({
    repository, clock: { now: () => 100 }, digest: createNodeSha256DispatchDigest(),
    hostile: true,
  } as never), TypeError);
  let reads = 0;
  const dependencies = { repository, clock: { now: () => 100 } } as Record<string, unknown>;
  Object.defineProperty(dependencies, "digest", {
    enumerable: true, get() {reads += 1; return createNodeSha256DispatchDigest();},
  });
  assert.throws(() => createContainedTurnDispatchAuthorityFeature(dependencies as never), TypeError);
  assert.equal(reads, 0);
});

test("composition rejects a caller proxy before reflection", () => {
  const repository = createInMemoryDispatchConsumptionRepository([authority()]);
  let descriptorReads = 0;
  const dependencies = new Proxy({ repository, clock: { now: () => 100 },
    digest: createNodeSha256DispatchDigest() }, {
    getOwnPropertyDescriptor(target, property) {
      descriptorReads += 1;
      return Reflect.getOwnPropertyDescriptor(target, property);
    },
  });
  assert.throws(() => createContainedTurnDispatchAuthorityFeature(dependencies), TypeError);
  assert.equal(descriptorReads, 0);
});

test("corrupt consumed replay snapshots fail closed across every request identity", async () => {
  const base = harness();
  assert.equal((await base.authority.consumeForDispatch(input())).status, "consumed");
  const observed = await base.repository.observe({ scope, providerId: "provider-a",
    authorityGeneration: "generation-a", operationId: "operation-a",
    grantRequestId: "grant-request-a" });
  assert.notEqual(observed, undefined);
  if (observed === undefined || observed.consumption === undefined) {return;}
  const prior = {
    scope: observed.scope, providerId: observed.providerId,
    authorityGeneration: observed.authorityGeneration, operationId: observed.operationId,
    grantRequestId: observed.grantRequestId, requestDigest: observed.requestDigest,
    requestFingerprint: observed.requestFingerprint, outcome: observed.outcome,
  };
  const corruptions = [
    { ...prior, scope: { ...scope, tenantId: "tenant-cross" } },
    { ...prior, scope: { ...scope, projectId: "project-cross" } },
    { ...prior, providerId: "provider-cross" },
    { ...prior, authorityGeneration: "generation-cross" },
    { ...prior, operationId: "operation-cross" },
    { ...prior, grantRequestId: "grant-cross" },
  ];
  for (const priorRequest of corruptions) {
    const repository: DispatchConsumptionRepository = {
      async consumeAtomically(_key, decide) {
        return decide({ priorRequest, consumption: observed.consumption }).outcome;
      },
      async observe() {return;},
      async settleAtomically() {return { status: "not_found" };},
    };
    const candidate = createContainedTurnDispatchAuthorityFeature({ repository,
      clock: { now: () => 100 }, digest: createNodeSha256DispatchDigest() });
    assert.deepEqual(await candidate.dispatchAuthorityV1.consumeForDispatch(input()),
      { status: "indeterminate", reason: "owner_unavailable" });
  }
});

test("settlement binds scope, generation, consumption, and replay identities", async () => {
  const base = harness();
  const consumed = await base.authority.consumeForDispatch(input());
  assert.equal(consumed.status, "consumed");
  if (consumed.status !== "consumed") {return;}
  const observed = await base.repository.observe({ scope, providerId: "provider-a",
    authorityGeneration: "generation-a", operationId: "operation-a",
    grantRequestId: "grant-request-a" });
  assert.notEqual(observed?.consumption, undefined);
  if (observed?.consumption === undefined) {return;}
  const repository: DispatchConsumptionRepository = {
    async consumeAtomically() {return { status: "not_found" };},
    async observe() {return;},
    async settleAtomically(_key, decide) {
      return decide({ consumption: observed.consumption }).result;
    },
  };
  const feature = createContainedTurnDispatchAuthorityFeature({ repository,
    clock: { now: () => 101 }, digest: createNodeSha256DispatchDigest() }).dispatchAuthorityV1;
  for (const changed of [
    { scope: { ...scope, tenantId: "tenant-cross" } },
    { authorityGeneration: "generation-cross" },
    { providerId: "provider-cross" },
    { grantRequestId: "grant-cross" },
  ]) {
    assert.deepEqual(await feature.settleDispatchConsumption({
      scope, providerId: "provider-a", authorityGeneration: "generation-a",
      operationId: "operation-a", grantRequestId: "grant-request-a",
      settlementRequestId: "settlement-corrupt",
      consumptionDigest: consumed.receipt.consumptionDigest,
      disposition: "claim_committed", ...changed,
    }), { status: "indeterminate", reason: "owner_unavailable" });
  }

  const settled = await base.authority.settleDispatchConsumption({
    scope, providerId: "provider-a", authorityGeneration: "generation-a",
    operationId: "operation-a", grantRequestId: "grant-request-a",
    settlementRequestId: "settlement-replay",
    consumptionDigest: consumed.receipt.consumptionDigest, disposition: "claim_committed",
  });
  assert.equal(settled.status, "settled");
  if (settled.status !== "settled") {return;}
  const replayRepository: DispatchConsumptionRepository = {
    async consumeAtomically() {return { status: "not_found" };},
    async observe() {return;},
    async settleAtomically(_key, decide) {return decide({ priorRequest: {
      scope, providerId: "provider-a", authorityGeneration: "generation-a",
      operationId: "operation-a", grantRequestId: "grant-request-a",
      settlementRequestId: "settlement-replay",
      consumptionDigest: consumed.receipt.consumptionDigest,
      settlementDigest: "sha256:valid-but-wrong-request", outcome: settled,
    } }).result;},
  };
  const replayFeature = createContainedTurnDispatchAuthorityFeature({ repository: replayRepository,
    clock: { now: () => 102 }, digest: createNodeSha256DispatchDigest() }).dispatchAuthorityV1;
  assert.deepEqual(await replayFeature.settleDispatchConsumption({
    scope: { ...scope, tenantId: "tenant-cross" }, providerId: "provider-a",
    authorityGeneration: "generation-a", operationId: "operation-a",
    grantRequestId: "grant-request-a", settlementRequestId: "settlement-replay",
    consumptionDigest: consumed.receipt.consumptionDigest, disposition: "claim_committed",
  }), { status: "indeterminate", reason: "owner_unavailable" });
});

test("observation rejects settlement provider and generation substitution", async () => {
  const base = harness();
  const consumed = await base.authority.consumeForDispatch(input());
  assert.equal(consumed.status, "consumed");
  if (consumed.status !== "consumed") {return;}
  await base.authority.settleDispatchConsumption({ scope, providerId: "provider-a",
    authorityGeneration: "generation-a", operationId: "operation-a",
    grantRequestId: "grant-request-a", settlementRequestId: "settled-observation",
    consumptionDigest: consumed.receipt.consumptionDigest, disposition: "claim_committed" });
  const observed = await base.repository.observe({ scope, providerId: "provider-a",
    authorityGeneration: "generation-a", operationId: "operation-a",
    grantRequestId: "grant-request-a" });
  assert.notEqual(observed?.consumption?.settlement, undefined);
  if (observed?.consumption?.settlement === undefined) {return;}
  for (const replacement of [
    { providerId: "provider-cross" }, { authorityGeneration: "generation-cross" },
  ]) {
    const forged = { ...observed, consumption: { ...observed.consumption,
      settlement: { ...observed.consumption.settlement, ...replacement } } };
    const repository: DispatchConsumptionRepository = {
      async consumeAtomically() {return { status: "not_found" };},
      async observe() {return forged;},
      async settleAtomically() {return { status: "not_found" };},
    };
    const feature = createContainedTurnDispatchAuthorityFeature({ repository,
      clock: { now: () => 100 }, digest: createNodeSha256DispatchDigest() });
    assert.deepEqual(await feature.dispatchAuthorityV1.observeDispatchConsumption(input()),
      { status: "indeterminate", reason: "owner_unavailable" });
  }
});

test("public and owner proxies fail closed with zero traps", async () => {
  const fixture = harness();
  let publicTraps = 0;
  const publicProxy = new Proxy(input(), {
    getOwnPropertyDescriptor() {publicTraps += 1; throw new Error("public trap");},
  });
  assert.deepEqual(await fixture.authority.consumeForDispatch(publicProxy),
    { status: "indeterminate", reason: "owner_unavailable" });
  assert.equal(publicTraps, 0);

  let scopeTraps = 0;
  const scopeProxy = new Proxy({ ...scope }, {
    getOwnPropertyDescriptor() {scopeTraps += 1; throw new Error("scope trap");},
  });
  assert.deepEqual(await fixture.authority.consumeForDispatch(input({ scope: scopeProxy })),
    { status: "indeterminate", reason: "owner_unavailable" });
  assert.equal(scopeTraps, 0);

  let snapshotTraps = 0;
  const snapshotProxy = new Proxy({ authority: authority() }, {
    getOwnPropertyDescriptor() {snapshotTraps += 1; throw new Error("snapshot trap");},
  });
  const repository: DispatchConsumptionRepository = {
    async consumeAtomically(_key, decide) {return decide(snapshotProxy as never).outcome;},
    async observe() {return;}, async settleAtomically() {return { status: "not_found" };},
  };
  const feature = createContainedTurnDispatchAuthorityFeature({ repository,
    clock: { now: () => 100 }, digest: createNodeSha256DispatchDigest() });
  assert.deepEqual(await feature.dispatchAuthorityV1.consumeForDispatch(input()),
    { status: "indeterminate", reason: "owner_unavailable" });
  assert.equal(snapshotTraps, 0);

  let nestedTraps = 0;
  const nestedProxy = new Proxy({ ...scope }, {
    getOwnPropertyDescriptor() {nestedTraps += 1; throw new Error("nested trap");},
  });
  const nestedRepository: DispatchConsumptionRepository = {
    async consumeAtomically(_key, decide) {
      return decide({ authority: authority({ scope: nestedProxy }) }).outcome;
    },
    async observe() {return;}, async settleAtomically() {return { status: "not_found" };},
  };
  const nestedFeature = createContainedTurnDispatchAuthorityFeature({
    repository: nestedRepository, clock: { now: () => 100 },
    digest: createNodeSha256DispatchDigest(),
  });
  assert.deepEqual(await nestedFeature.dispatchAuthorityV1.consumeForDispatch(input()),
    { status: "indeterminate", reason: "owner_unavailable" });
  assert.equal(nestedTraps, 0);
});

test("consume decision crossing the owner boundary is exact detached and alias-free", async () => {
  const sourceAuthority = authority({ scope: { ...scope } });
  let captured: unknown;
  const repository: DispatchConsumptionRepository = {
    async consumeAtomically(_key, decide) {
      const decision = decide({ authority: sourceAuthority });
      captured = decision;
      (sourceAuthority as { acceptedAuthorityDigest: string }).acceptedAuthorityDigest = "mutated";
      return decision.outcome;
    },
    async observe() {return;}, async settleAtomically() {return { status: "not_found" };},
  };
  const result = await createContainedTurnDispatchAuthorityFeature({ repository,
    clock: { now: () => 100 }, digest: createNodeSha256DispatchDigest(),
  }).dispatchAuthorityV1.consumeForDispatch(input());
  assert.equal(result.status, "consumed");
  const decision = captured as { outcome: { receipt: { scope: object } };
    persistConsumption: { receipt: { scope: object } }; persistRequest: { outcome: object } };
  assert.deepEqual(Object.keys(decision).toSorted(),
    ["outcome", "persistConsumption", "persistRequest"]);
  assertDeepFrozen(decision);
  assert.notStrictEqual(decision.outcome, decision.persistRequest.outcome);
  assert.notStrictEqual(decision.outcome.receipt, decision.persistConsumption.receipt);
  assert.notStrictEqual(decision.outcome.receipt.scope,
    decision.persistConsumption.receipt.scope);
  if (result.status === "consumed") {
    assert.equal(result.receipt.acceptedAuthorityDigest, "accepted-authority-digest-a");
  }
});

test("owner accessors and nested unknown callback facts fail closed without reads", async () => {
  let reads = 0;
  const accessorSnapshot = Object.defineProperty({}, "authority", {
    enumerable: true, get() {reads += 1; return authority();},
  });
  const accessorRepository: DispatchConsumptionRepository = {
    async consumeAtomically(_key, decide) {return decide(accessorSnapshot as never).outcome;},
    async observe() {return;}, async settleAtomically() {return { status: "not_found" };},
  };
  const accessorFeature = createContainedTurnDispatchAuthorityFeature({
    repository: accessorRepository, clock: { now: () => 100 },
    digest: createNodeSha256DispatchDigest(),
  });
  assert.deepEqual(await accessorFeature.dispatchAuthorityV1.consumeForDispatch(input()),
    { status: "indeterminate", reason: "owner_unavailable" });
  assert.equal(reads, 0);

  const seeded = harness();
  await seeded.authority.consumeForDispatch(input());
  const observed = await seeded.repository.observe({ scope, providerId: "provider-a",
    authorityGeneration: "generation-a", operationId: "operation-a",
    grantRequestId: "grant-request-a" });
  assert.notEqual(observed?.consumption, undefined);
  const unknownRepository: DispatchConsumptionRepository = {
    async consumeAtomically() {return { status: "not_found" };},
    async observe() {return observed === undefined ? undefined : { ...observed,
      consumption: observed.consumption === undefined ? undefined : {
        ...observed.consumption,
        receipt: { ...observed.consumption.receipt, nestedUnknown: { secret: true } },
      } };},
    async settleAtomically() {return { status: "not_found" };},
  };
  const unknownFeature = createContainedTurnDispatchAuthorityFeature({
    repository: unknownRepository, clock: { now: () => 100 },
    digest: createNodeSha256DispatchDigest(),
  });
  assert.deepEqual(await unknownFeature.dispatchAuthorityV1.observeDispatchConsumption(input()),
    { status: "indeterminate", reason: "owner_unavailable" });
});

test("package root exposes only supported V1 consumer contracts", async () => {
  assert.deepEqual(Object.keys(publicApi), ["CONTAINED_TURN_PROVIDER_DISPATCH_PURPOSE"]);
  const declarations = await readFile(new URL("../dist/index.d.ts", import.meta.url), "utf8");
  assert.match(declarations, /ContainedTurnDispatchAuthorityV1/);
  for (const internalName of [
    "DispatchAuthorityHead",
    "DispatchConsumptionRepository",
    "DispatchControlClock",
    "DispatchDigest",
    "PersistedConsumption",
  ]) {
    assert.doesNotMatch(declarations, new RegExp(`\\b${internalName}\\b`));
  }
});
