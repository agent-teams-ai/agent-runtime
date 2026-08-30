import assert from "node:assert/strict";
import test from "node:test";

import type { ConsumeForDispatchInput, DispatchConsumptionReceipt, SettleDispatchConsumptionInput } from "../dist/index.js";
import {
  createDispatchConsumptionRequestDigests,
  createInMemoryContainedTurnDispatchConsumptionV1,
  type InMemoryDispatchBindingSeed,
} from "../dist/composition.js";
import { createContainedTurnDispatchConsumptionV1 } from "../dist/features/contained-turn-access/composition/dispatch-consumption-v1-factory.js";
import { createSha256DispatchConsumptionDigest } from "../dist/features/contained-turn-access/adapters/outbound/sha256-dispatch-consumption-digest.js";
import { createInMemoryDispatchConsumptionRepository } from "../dist/features/contained-turn-access/adapters/outbound/in-memory-dispatch-consumption-repository.js";
import type {
  DispatchConsumptionRepository, DispatchConsumptionTransaction, DispatchConsumptionTransactionSelector,
} from "../dist/features/contained-turn-access/application/ports/outbound/dispatch-consumption-repository.js";
import { claimBindingDigestPayload, requestDigestPayload } from "../dist/features/contained-turn-access/domain/dispatch-consumption.js";

const seed = (overrides: Partial<InMemoryDispatchBindingSeed> = {}): InMemoryDispatchBindingSeed => ({
  acceptedAuthorityDigest: "authority:accepted:1", accessRef: "access:1", authorityHeadDigest: "authority:head:1",
  bindingDigest: "binding:digest:1", bindingRevision: 1, claimBeforeControlTime: 200,
  expiresAtControlTime: 300,
  credentialBindingDigest: "credential:digest:1", credentialBindingRef: "credential:binding:1",
  credentialGeneration: 1, opaqueOwnerEvidenceRef: "owner:evidence:1", projectId: "project:1",
  provider: "codex", providerAccountRef: "account:1", providerRouteRef: "route:1",
  scopeDigest: "scope:digest:1", tenantId: "tenant:1", ...overrides,
});

const unsignedInput = (head = seed(), overrides: Partial<Omit<ConsumeForDispatchInput, "claimBindingDigest" | "requestDigest">> = {}) => ({
  binding: {
    acceptedAuthorityDigest: head.acceptedAuthorityDigest, accessRef: head.accessRef,
    authorityHeadDigest: head.authorityHeadDigest, bindingDigest: head.bindingDigest,
    bindingRevision: head.bindingRevision, credentialBindingDigest: head.credentialBindingDigest,
    credentialBindingRef: head.credentialBindingRef, credentialGeneration: head.credentialGeneration,
    providerAccountRef: head.providerAccountRef, providerRouteRef: head.providerRouteRef,
  },
  grantRequestId: "grant-request:1", operationId: "operation:1", provider: head.provider,
  purpose: "contained-turn.provider-dispatch/v1" as const,
  scope: { projectId: head.projectId, scopeDigest: head.scopeDigest, tenantId: head.tenantId },
  ...overrides,
});

const inputFor = async (head = seed(), overrides: Parameters<typeof unsignedInput>[1] = {}): Promise<ConsumeForDispatchInput> => {
  const unsigned = unsignedInput(head, overrides);
  return { ...unsigned, ...await createDispatchConsumptionRequestDigests(unsigned) };
};

const repositoryHarness = () => createInMemoryDispatchConsumptionRepository([{
  ...seed(), availability: "available", revocation: "active",
}], 100);
const settlementFor = (receipt: DispatchConsumptionReceipt,
  overrides: Partial<SettleDispatchConsumptionInput> = {}): SettleDispatchConsumptionInput => ({
  consumptionDigest: receipt.consumptionDigest, disposition: "abandoned_without_claim" as const,
  expectedBinding: {
    acceptedAuthorityDigest: receipt.acceptedAuthorityDigest, accessRef: receipt.accessRef,
    authorityHeadDigest: receipt.authorityHeadDigestAtConsumption, bindingDigest: receipt.bindingDigest,
    bindingRevision: receipt.bindingRevision, credentialBindingDigest: receipt.credentialBindingDigest,
    credentialBindingRef: receipt.credentialBindingRef, credentialGeneration: receipt.credentialGeneration,
    providerAccountRef: receipt.providerAccountRef, providerRouteRef: receipt.providerRouteRef,
  },
  operationId: receipt.operationId, provider: receipt.provider, scope: receipt.scope,
  settlementRequestId: "settlement:1", ...overrides,
});

const transactionBarrier = (base: DispatchConsumptionRepository) => {
  let entered!: () => void;
  let release!: () => void;
  const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
  const releasePromise = new Promise<void>(resolve => { release = resolve; });
  const repository: DispatchConsumptionRepository = {
    observeGrantRequest: input => base.observeGrantRequest(input),
    transact<T>(selector: DispatchConsumptionTransactionSelector, work: (transaction: DispatchConsumptionTransaction) => Promise<T>) {
      return base.transact(selector, async transaction => { entered(); await releasePromise; return work(transaction); });
    },
  };
  return { entered: enteredPromise, release, repository };
};

test("atomically consumes the exact binding head and returns the closed V1 receipt", async () => {
  const harness = createInMemoryContainedTurnDispatchConsumptionV1({ bindings: [seed()], initialControlTime: 100 });
  assert.deepEqual(Object.keys(harness.access).toSorted(), [
    "consumeForDispatch", "observeDispatchConsumption", "settleDispatchConsumption",
  ]);
  const outcome = await harness.access.consumeForDispatch(await inputFor());
  assert.equal(outcome.kind, "consumed");
  if (outcome.kind !== "consumed") {return;}
  assert.equal(outcome.receipt.claimBeforeControlTime, 200);
  assert.equal(outcome.receipt.consumedAtControlTime, 100);
  assert.equal(outcome.receipt.authorityHeadDigestAtConsumption, "authority:head:1");
  assert.match(outcome.receipt.consumptionDigest, /^sha256:[a-f0-9]{64}$/u);
  assert.ok(Object.isFrozen(outcome.receipt));
  assert.ok(Object.isFrozen(outcome.receipt.scope));
  assert.equal(harness.control.observeOwnerState({ provider: "codex", scopeDigest: "scope:digest:1" }), "consumed_pending");
});

test("exact replay is byte-for-byte stable after owner revocation and expiry", async () => {
  const harness = createInMemoryContainedTurnDispatchConsumptionV1({ bindings: [seed()], initialControlTime: 100 });
  const input = await inputFor();
  const first = await harness.access.consumeForDispatch(input);
  await harness.control.replaceBindingHead(seed({ authorityHeadDigest: "authority:head:2", revocation: "revoked" }));
  await harness.control.advanceControlTime(500);
  const replay = await harness.access.consumeForDispatch(input);
  assert.equal(JSON.stringify(replay), JSON.stringify(first));
});

test("caller digest mismatch opens no transaction and a corrected retry succeeds", async () => {
  const base = repositoryHarness();
  let transactionCount = 0;
  const repository: DispatchConsumptionRepository = {
    observeGrantRequest: input => base.repository.observeGrantRequest(input),
    transact(selector, work) { transactionCount += 1; return base.repository.transact(selector, work); },
  };
  const access = createContainedTurnDispatchConsumptionV1({ digest: createSha256DispatchConsumptionDigest(), repository });
  const input = await inputFor();
  assert.deepEqual(await access.consumeForDispatch({ ...input, requestDigest: "sha256:different" }), {
    kind: "invalid", reason: "invalid_request",
  });
  assert.equal(transactionCount, 0);
  assert.equal((await access.consumeForDispatch(input)).kind, "consumed");
  assert.equal(transactionCount, 1);
});

test("grant journals are namespaced by complete scope, provider, and request ID", async () => {
  const other = seed({ projectId: "project:2", tenantId: "tenant:2" });
  const harness = createInMemoryContainedTurnDispatchConsumptionV1({ bindings: [seed(), other], initialControlTime: 100 });
  const [first, second] = await Promise.all([
    inputFor(), inputFor(other, { operationId: "operation:2" }),
  ]);
  const outcomes = await Promise.all([harness.access.consumeForDispatch(first), harness.access.consumeForDispatch(second)]);
  assert.deepEqual(outcomes.map(outcome => outcome.kind), ["consumed", "consumed"]);
  if (outcomes[0]?.kind !== "consumed" || outcomes[1]?.kind !== "consumed") {return;}
  const settlements = await Promise.all([
    harness.access.settleDispatchConsumption(settlementFor(outcomes[0].receipt, { settlementRequestId: "settlement:shared" })),
    harness.access.settleDispatchConsumption(settlementFor(outcomes[1].receipt, { settlementRequestId: "settlement:shared" })),
  ]);
  assert.deepEqual(settlements.map(outcome => outcome.kind), ["settled", "settled"]);
  assert.equal((await harness.access.observeDispatchConsumption({
    grantRequestId: second.grantRequestId, provider: second.provider, requestDigest: second.requestDigest, scope: second.scope,
  })).kind, "consumed");
  assert.equal((await harness.access.observeDispatchConsumption({
    grantRequestId: first.grantRequestId, provider: first.provider, requestDigest: first.requestDigest,
    scope: { ...first.scope, tenantId: "tenant:missing" },
  })).kind, "not_found");
});

test("claim binding digest covers every safe route and full trusted scope field", async () => {
  const original = await inputFor();
  const changes: ConsumeForDispatchInput[] = [
    { ...original, grantRequestId: "grant-request:2" }, { ...original, operationId: "operation:2" },
    { ...original, provider: "claude" },
    { ...original, purpose: "other-purpose" as never },
    { ...original, scope: { ...original.scope, tenantId: "tenant:2" } },
    { ...original, scope: { ...original.scope, projectId: "project:2" } },
    { ...original, scope: { ...original.scope, scopeDigest: "scope:digest:2" } },
    { ...original, binding: { ...original.binding, accessRef: "access:2" } },
    { ...original, binding: { ...original.binding, acceptedAuthorityDigest: "authority:accepted:2" } },
    { ...original, binding: { ...original.binding, authorityHeadDigest: "authority:head:2" } },
    { ...original, binding: { ...original.binding, bindingDigest: "binding:digest:2" } },
    { ...original, binding: { ...original.binding, bindingRevision: 2 } },
    { ...original, binding: { ...original.binding, providerAccountRef: "account:2" } },
    { ...original, binding: { ...original.binding, providerRouteRef: "route:2" } },
    { ...original, binding: { ...original.binding, credentialGeneration: 2 } },
    { ...original, binding: { ...original.binding, credentialBindingRef: "credential:binding:2" } },
    { ...original, binding: { ...original.binding, credentialBindingDigest: "credential:digest:2" } },
  ];
  const digest = createSha256DispatchConsumptionDigest();
  const expected = await digest.digest(claimBindingDigestPayload(original));
  for (const changed of changes) {
    assert.notEqual(await digest.digest(claimBindingDigestPayload(changed)), expected);
  }
});

test("composition validates Pure DI once and retains bound method snapshots", async () => {
  const base = repositoryHarness();
  const repository = {
    observeGrantRequest: base.repository.observeGrantRequest,
    transact: base.repository.transact,
  };
  const digest = { digest: createSha256DispatchConsumptionDigest().digest };
  const access = createContainedTurnDispatchConsumptionV1({ digest, repository });
  repository.transact = async () => { throw new Error("mutated after composition"); };
  digest.digest = async () => { throw new Error("mutated after composition"); };
  assert.equal((await access.consumeForDispatch(await inputFor())).kind, "consumed");

  const valid = { digest: createSha256DispatchConsumptionDigest(), repository: base.repository };
  const accessor = {} as Record<string, unknown>;
  Object.defineProperty(accessor, "digest", { enumerable: true, get: () => valid.digest });
  Object.defineProperty(accessor, "repository", { enumerable: true, value: valid.repository });
  for (const invalidDependencies of [
    new Proxy(valid, {}), accessor, { digest: valid.digest }, { ...valid, unknown: true },
    { ...valid, repository: new Proxy(valid.repository, {}) },
    { ...valid, digest: { ...valid.digest, unknown() { return Promise.resolve("bad"); } } },
  ]) {
    assert.throws(() => createContainedTurnDispatchConsumptionV1(invalidDependencies as never), TypeError);
  }
});

test("server-derived replay identity rejects changed semantics with a reused claimed digest", async () => {
  const harness = createInMemoryContainedTurnDispatchConsumptionV1({ bindings: [seed()], initialControlTime: 100 });
  const input = await inputFor();
  assert.equal((await harness.access.consumeForDispatch(input)).kind, "consumed");
  for (const changedUnsigned of [
    { ...unsignedInput(), operationId: "operation:changed" },
    { ...unsignedInput(), binding: { ...input.binding, providerRouteRef: "route:changed" } },
  ]) {
    const changed = { ...changedUnsigned, ...await createDispatchConsumptionRequestDigests(changedUnsigned) };
    assert.deepEqual(await harness.access.consumeForDispatch(changed), {
      kind: "conflict", reason: "grant_request_digest_conflict",
    });
  }
  const otherProvider = await inputFor(seed({ provider: "claude" }));
  assert.equal((await harness.access.consumeForDispatch(otherProvider)).kind, "not_found");
});

test("public dispatch inputs reject aggregate tricks and snapshot mutable callers", async () => {
  const harness = createInMemoryContainedTurnDispatchConsumptionV1({ bindings: [seed()], initialControlTime: 100 });
  const mutable = structuredClone(await inputFor()) as ConsumeForDispatchInput & {
    binding: { providerRouteRef: string }; scope: { projectId: string };
  };
  const pending = harness.access.consumeForDispatch(mutable);
  mutable.binding.providerRouteRef = "route:mutated";
  mutable.scope.projectId = "project:mutated";
  const outcome = await pending;
  assert.equal(outcome.kind, "consumed");
  if (outcome.kind === "consumed") {
    assert.equal(outcome.receipt.providerRouteRef, "route:1");
    assert.equal(outcome.receipt.scope.projectId, "project:1");
    assert.ok(Object.isFrozen(outcome.receipt.scope));
  }

  const valid = await inputFor(seed(), { grantRequestId: "grant-request:invalid" });
  const accessor = { ...valid } as Record<string, unknown>;
  Object.defineProperty(accessor, "operationId", { enumerable: true, get: () => "operation:trap" });
  for (const malformed of [
    new Proxy(valid, {}), accessor, { ...valid, scope: [valid.scope] },
    { ...valid, operationId: "../operation" }, { ...valid, operationId: "bad\u0001control" },
    { ...valid, secret: "forbidden-extra-field" },
  ]) {
    assert.deepEqual(await harness.access.consumeForDispatch(malformed as ConsumeForDispatchInput), {
      kind: "invalid", reason: "invalid_request",
    });
  }
});

test("observation, settlement, deadline, and numeric fields validate as bounded primitives", async () => {
  const harness = createInMemoryContainedTurnDispatchConsumptionV1({ bindings: [seed()], initialControlTime: 100 });
  assert.deepEqual(await harness.access.observeDispatchConsumption({
    grantRequestId: "grant-request:missing", provider: "codex", requestDigest: "sha256:missing",
    scope: { projectId: new String("project:1") as unknown as string, scopeDigest: "scope:digest:1", tenantId: "tenant:1" },
  }), { kind: "invalid", reason: "invalid_request" });
  const consumed = await harness.access.consumeForDispatch(await inputFor());
  assert.equal(consumed.kind, "consumed");
  if (consumed.kind !== "consumed") {return;}
  assert.deepEqual(await harness.access.settleDispatchConsumption({
    ...settlementFor(consumed.receipt),
    disposition: new String("claim_committed") as unknown as "claim_committed", settlementRequestId: "settlement:invalid",
  }), { kind: "invalid", reason: "invalid_request" });
  assert.throws(() => createInMemoryContainedTurnDispatchConsumptionV1({
    bindings: [seed({ bindingRevision: new Number(1) as unknown as number })], initialControlTime: 100,
  }), TypeError);
  assert.throws(() => createInMemoryContainedTurnDispatchConsumptionV1({
    bindings: [seed({ claimBeforeControlTime: 301, expiresAtControlTime: 300 })], initialControlTime: 100,
  }), TypeError);
});

test("scope drift and provider drift never fall back to another binding", async () => {
  const harness = createInMemoryContainedTurnDispatchConsumptionV1({ bindings: [seed()], initialControlTime: 100 });
  const wrongScope = await inputFor(seed(), {
    scope: { projectId: "project:other", scopeDigest: "scope:digest:1", tenantId: "tenant:1" },
  });
  const outcome = await harness.access.consumeForDispatch(wrongScope);
  assert.equal(outcome.kind, "not_found");
  const missing = await inputFor(seed(), {
    grantRequestId: "grant-request:2", scope: { projectId: "project:1", scopeDigest: "scope:other", tenantId: "tenant:1" },
  });
  assert.equal((await harness.access.consumeForDispatch(missing)).kind, "not_found");
});

test("provider, account, route, revision, binding, generation, and authority drift fail closed", async () => {
  const cases: readonly [Partial<InMemoryDispatchBindingSeed>, string][] = [
    [{ providerAccountRef: "account:2" }, "account_changed"],
    [{ providerRouteRef: "route:2" }, "route_changed"], [{ bindingRevision: 2 }, "revision_changed"],
    [{ bindingDigest: "binding:digest:2" }, "binding_changed"], [{ credentialGeneration: 2 }, "credential_rotated"],
    [{ credentialBindingDigest: "credential:digest:2" }, "credential_changed"],
    [{ acceptedAuthorityDigest: "authority:accepted:2" }, "accepted_authority_changed"],
    [{ authorityHeadDigest: "authority:head:2" }, "authority_head_changed"],
  ];
  for (const [drift, reason] of cases) {
    const harness = createInMemoryContainedTurnDispatchConsumptionV1({ bindings: [seed(drift)], initialControlTime: 100 });
    const outcome = await harness.access.consumeForDispatch(await inputFor());
    assert.equal(outcome.kind, "prevented");
    if (outcome.kind === "prevented") {assert.equal(outcome.prevention.reason, reason);}
  }
  const providerDrift = createInMemoryContainedTurnDispatchConsumptionV1({ bindings: [seed({ provider: "claude" })], initialControlTime: 100 });
  assert.equal((await providerDrift.access.consumeForDispatch(await inputFor())).kind, "not_found");
});

test("revocation, availability, expiry, request digest, and claim binding prevent dispatch", async () => {
  const cases: readonly [InMemoryDispatchBindingSeed, number, Partial<ConsumeForDispatchInput>, string][] = [
    [seed({ revocation: "revoked" }), 100, {}, "revoked"], [seed({ availability: "unavailable" }), 100, {}, "unavailable"],
    [seed(), 200, {}, "expired"],
  ];
  for (const [head, now, override, reason] of cases) {
    const harness = createInMemoryContainedTurnDispatchConsumptionV1({ bindings: [head], initialControlTime: now });
    const outcome = await harness.access.consumeForDispatch({ ...await inputFor(), ...override });
    assert.equal(outcome.kind, "prevented");
    if (outcome.kind === "prevented") {assert.equal(outcome.prevention.reason, reason);}
  }
  assert.deepEqual(await createInMemoryContainedTurnDispatchConsumptionV1({ bindings: [seed()], initialControlTime: 100 })
    .access.consumeForDispatch({ ...await inputFor(), requestDigest: "sha256:bad" }), { kind: "invalid", reason: "invalid_request" });
  const badClaim = { ...await inputFor(), claimBindingDigest: "sha256:bad" };
  const { requestDigest: _requestDigest, ...semantic } = badClaim;
  const matchingRequestDigest = await createSha256DispatchConsumptionDigest().digest(requestDigestPayload(semantic));
  const claimOutcome = await createInMemoryContainedTurnDispatchConsumptionV1({ bindings: [seed()], initialControlTime: 100 })
    .access.consumeForDispatch({ ...badClaim, requestDigest: matchingRequestDigest });
  assert.equal(claimOutcome.kind, "prevented");
  if (claimOutcome.kind === "prevented") {assert.equal(claimOutcome.prevention.reason, "claim_binding_mismatch");}
  const replayHarness = createInMemoryContainedTurnDispatchConsumptionV1({ bindings: [seed({ revocation: "revoked" })], initialControlTime: 100 });
  const replayInput = await inputFor();
  const prevention = await replayHarness.access.consumeForDispatch(replayInput);
  await replayHarness.control.replaceBindingHead(seed({ revocation: "active" }));
  assert.equal(JSON.stringify(await replayHarness.access.consumeForDispatch(replayInput)), JSON.stringify(prevention));
});

test("two concurrent consumers produce exactly one immutable consumption", async () => {
  const harness = createInMemoryContainedTurnDispatchConsumptionV1({ bindings: [seed()], initialControlTime: 100 });
  const [firstInput, secondInput] = await Promise.all([
    inputFor(), inputFor(seed(), { grantRequestId: "grant-request:2", operationId: "operation:2" }),
  ]);
  const outcomes = await Promise.all([
    harness.access.consumeForDispatch(firstInput), harness.access.consumeForDispatch(secondInput),
  ]);
  assert.deepEqual(outcomes.map(outcome => outcome.kind).toSorted(), ["consumed", "prevented"]);
  const prevention = outcomes.find(outcome => outcome.kind === "prevented");
  assert.equal(prevention?.kind === "prevented" ? prevention.prevention.reason : undefined, "already_consumed");
});

test("consume and revocation serialize in both barrier-controlled orders", async () => {
  const consumeFirst = repositoryHarness();
  const barrier = transactionBarrier(consumeFirst.repository);
  const access = createContainedTurnDispatchConsumptionV1({ digest: createSha256DispatchConsumptionDigest(), repository: barrier.repository });
  const consumption = access.consumeForDispatch(await inputFor());
  await barrier.entered;
  const revocation = consumeFirst.control.replaceBindingHead({ ...seed(), availability: "available", revocation: "revoked" });
  barrier.release();
  assert.equal((await consumption).kind, "consumed");
  await revocation;

  const revokeFirst = repositoryHarness();
  await revokeFirst.control.replaceBindingHead({ ...seed(), availability: "available", revocation: "revoked" });
  const revokedAccess = createContainedTurnDispatchConsumptionV1({ digest: createSha256DispatchConsumptionDigest(), repository: revokeFirst.repository });
  const outcome = await revokedAccess.consumeForDispatch(await inputFor());
  assert.equal(outcome.kind, "prevented");
  if (outcome.kind === "prevented") {assert.equal(outcome.prevention.reason, "revoked");}
});

test("consume and head replacement serialize in both barrier-controlled orders", async () => {
  const consumeFirst = repositoryHarness();
  const barrier = transactionBarrier(consumeFirst.repository);
  const access = createContainedTurnDispatchConsumptionV1({ digest: createSha256DispatchConsumptionDigest(), repository: barrier.repository });
  const consumption = access.consumeForDispatch(await inputFor());
  await barrier.entered;
  const replacement = consumeFirst.control.replaceBindingHead({ ...seed({ authorityHeadDigest: "authority:head:2" }), availability: "available", revocation: "active" });
  barrier.release();
  assert.equal((await consumption).kind, "consumed");
  await replacement;

  const replaceFirst = repositoryHarness();
  await replaceFirst.control.replaceBindingHead({ ...seed({ authorityHeadDigest: "authority:head:2" }), availability: "available", revocation: "active" });
  const changedAccess = createContainedTurnDispatchConsumptionV1({ digest: createSha256DispatchConsumptionDigest(), repository: replaceFirst.repository });
  const outcome = await changedAccess.consumeForDispatch(await inputFor());
  assert.equal(outcome.kind, "prevented");
  if (outcome.kind === "prevented") {assert.equal(outcome.prevention.reason, "authority_head_changed");}
});

test("consume and exact expiry boundary serialize in both barrier-controlled orders", async () => {
  const consumeFirst = repositoryHarness();
  const barrier = transactionBarrier(consumeFirst.repository);
  const access = createContainedTurnDispatchConsumptionV1({ digest: createSha256DispatchConsumptionDigest(), repository: barrier.repository });
  const consumption = access.consumeForDispatch(await inputFor());
  await barrier.entered;
  const expiry = consumeFirst.control.advanceControlTime(200);
  barrier.release();
  assert.equal((await consumption).kind, "consumed");
  await expiry;

  const expiryFirst = repositoryHarness();
  await expiryFirst.control.advanceControlTime(200);
  const expiredAccess = createContainedTurnDispatchConsumptionV1({ digest: createSha256DispatchConsumptionDigest(), repository: expiryFirst.repository });
  const outcome = await expiredAccess.consumeForDispatch(await inputFor());
  assert.equal(outcome.kind, "prevented");
  if (outcome.kind === "prevented") {assert.equal(outcome.prevention.reason, "expired");}
});

test("observation recovers a consumption after acknowledgement loss", async () => {
  const harness = createInMemoryContainedTurnDispatchConsumptionV1({ bindings: [seed()], initialControlTime: 100 });
  const input = await inputFor();
  const consumed = await harness.access.consumeForDispatch(input);
  const observed = await harness.access.observeDispatchConsumption({
    grantRequestId: input.grantRequestId, provider: input.provider, requestDigest: input.requestDigest, scope: input.scope,
  });
  assert.equal(JSON.stringify(observed), JSON.stringify(consumed));
  assert.deepEqual(await harness.access.observeDispatchConsumption({
    grantRequestId: input.grantRequestId, provider: input.provider, requestDigest: "sha256:other", scope: input.scope,
  }), { kind: "conflict", reason: "grant_request_digest_conflict" });
  assert.deepEqual(await harness.access.observeDispatchConsumption({
    grantRequestId: input.grantRequestId, provider: input.provider, requestDigest: input.requestDigest,
    scope: { ...input.scope, projectId: "project:other" },
  }), { kind: "not_found" });
});

test("observation cannot see an uncommitted journal and sees it immediately after commit", async () => {
  const base = repositoryHarness();
  let workFinished!: () => void;
  let allowCommit!: () => void;
  const workFinishedPromise = new Promise<void>(resolve => { workFinished = resolve; });
  const allowCommitPromise = new Promise<void>(resolve => { allowCommit = resolve; });
  const repository: DispatchConsumptionRepository = {
    observeGrantRequest: input => base.repository.observeGrantRequest(input),
    transact: (selector, work) => base.repository.transact(selector, async transaction => {
      const result = await work(transaction); workFinished(); await allowCommitPromise; return result;
    }),
  };
  const access = createContainedTurnDispatchConsumptionV1({ digest: createSha256DispatchConsumptionDigest(), repository });
  const input = await inputFor();
  const consumption = access.consumeForDispatch(input);
  await workFinishedPromise;
  let observationResolved = false;
  const observation = access.observeDispatchConsumption({
    grantRequestId: input.grantRequestId, provider: input.provider, requestDigest: input.requestDigest, scope: input.scope,
  }).then(value => { observationResolved = true; return value; });
  await new Promise<void>(resolve => { setImmediate(resolve); });
  assert.equal(observationResolved, false);
  allowCommit();
  assert.equal((await consumption).kind, "consumed");
  assert.equal((await observation).kind, "consumed");
});

test("transaction rollback leaves no journal or consumption and permits exact retry", async () => {
  const base = repositoryHarness();
  let fail = true;
  const repository: DispatchConsumptionRepository = {
    observeGrantRequest: input => base.repository.observeGrantRequest(input),
    transact: (selector, work) => base.repository.transact(selector, async transaction => {
      const result = await work(transaction);
      if (fail) {fail = false; throw new Error("rollback before commit");}
      return result;
    }),
  };
  const access = createContainedTurnDispatchConsumptionV1({ digest: createSha256DispatchConsumptionDigest(), repository });
  const input = await inputFor();
  assert.deepEqual(await access.consumeForDispatch(input), { kind: "indeterminate" });
  assert.equal((await access.observeDispatchConsumption({
    grantRequestId: input.grantRequestId, provider: input.provider, requestDigest: input.requestDigest, scope: input.scope,
  })).kind, "not_found");
  assert.equal((await access.consumeForDispatch(input)).kind, "consumed");
});

test("lost acknowledgement remains observable as the one immutable journal result", async () => {
  const base = repositoryHarness();
  const repository: DispatchConsumptionRepository = {
    observeGrantRequest: input => base.repository.observeGrantRequest(input),
    async transact<T>(selector: DispatchConsumptionTransactionSelector, work: (transaction: DispatchConsumptionTransaction) => Promise<T>) {
      await base.repository.transact(selector, work);
      throw new Error("acknowledgement lost after commit");
    },
  };
  const access = createContainedTurnDispatchConsumptionV1({ digest: createSha256DispatchConsumptionDigest(), repository });
  const input = await inputFor();
  assert.deepEqual(await access.consumeForDispatch(input), { kind: "indeterminate" });
  const observed = await access.observeDispatchConsumption({
    grantRequestId: input.grantRequestId, provider: input.provider, requestDigest: input.requestDigest, scope: input.scope,
  });
  assert.equal(observed.kind, "consumed");
  if (observed.kind === "consumed") {
    assert.ok(Object.isFrozen(observed.receipt));
    assert.equal(base.control.observeOwnerState({ provider: "codex", scopeDigest: "scope:digest:1" }), "consumed_pending");
  }
});

test("owner unavailability is indeterminate and never grants dispatch", async () => {
  const access = createContainedTurnDispatchConsumptionV1({
    digest: createSha256DispatchConsumptionDigest(),
    repository: {
      async observeGrantRequest() { throw new Error("owner unavailable"); },
      async transact() { throw new Error("owner unavailable"); },
    },
  });
  assert.deepEqual(await access.consumeForDispatch(await inputFor()), { kind: "indeterminate" });
  const input = await inputFor();
  assert.deepEqual(await access.observeDispatchConsumption({
    grantRequestId: input.grantRequestId, provider: input.provider, requestDigest: input.requestDigest, scope: input.scope,
  }), { kind: "indeterminate" });
});

test("settlement replays exactly, conflicts on reuse, and a replacement is independent", async () => {
  const harness = createInMemoryContainedTurnDispatchConsumptionV1({ bindings: [seed()], initialControlTime: 100 });
  const consumed = await harness.access.consumeForDispatch(await inputFor());
  assert.equal(consumed.kind, "consumed");
  if (consumed.kind !== "consumed") {return;}
  const settlement = settlementFor(consumed.receipt);
  const first = await harness.access.settleDispatchConsumption(settlement);
  const replay = await harness.access.settleDispatchConsumption(settlement);
  assert.equal(JSON.stringify(replay), JSON.stringify(first));
  assert.equal(harness.control.observeOwnerState({ provider: "codex", scopeDigest: "scope:digest:1" }), "abandoned_without_claim");
  assert.deepEqual(await harness.access.settleDispatchConsumption({ ...settlement, disposition: "claim_committed" }), {
    kind: "conflict", reason: "settlement_request_conflict",
  });
  assert.deepEqual(await harness.access.settleDispatchConsumption({ ...settlement, settlementRequestId: "settlement:2" }), {
    kind: "conflict", reason: "settlement_request_conflict",
  });
  assert.deepEqual(await harness.access.settleDispatchConsumption({
    ...settlement, expectedBinding: { ...settlement.expectedBinding, credentialGeneration: 2 },
  }), { kind: "conflict", reason: "settlement_request_conflict" });
  await harness.control.replaceBindingHead(seed({ bindingRevision: 2, bindingDigest: "binding:digest:2" }));
  const again = await harness.access.consumeForDispatch(await inputFor(seed({ bindingRevision: 2, bindingDigest: "binding:digest:2" }), {
    grantRequestId: "grant-request:2", operationId: "operation:2",
  }));
  assert.equal(again.kind, "consumed");
});

test("two settlement winners serialize to one immutable outcome", async () => {
  const harness = createInMemoryContainedTurnDispatchConsumptionV1({ bindings: [seed()], initialControlTime: 100 });
  const consumed = await harness.access.consumeForDispatch(await inputFor());
  assert.equal(consumed.kind, "consumed");
  if (consumed.kind !== "consumed") {return;}
  const outcomes = await Promise.all([
    harness.access.settleDispatchConsumption(settlementFor(consumed.receipt, { settlementRequestId: "settlement:a" })),
    harness.access.settleDispatchConsumption(settlementFor(consumed.receipt, {
      disposition: "claim_committed", settlementRequestId: "settlement:b",
    })),
  ]);
  assert.deepEqual(outcomes.map(outcome => outcome.kind).toSorted(), ["conflict", "settled"]);
});

test("settlement commit-then-throw remains indeterminate until exact replay", async () => {
  const base = repositoryHarness();
  const baseAccess = createContainedTurnDispatchConsumptionV1({ digest: createSha256DispatchConsumptionDigest(), repository: base.repository });
  const consumed = await baseAccess.consumeForDispatch(await inputFor());
  assert.equal(consumed.kind, "consumed");
  if (consumed.kind !== "consumed") {return;}
  const repository: DispatchConsumptionRepository = {
    observeGrantRequest: input => base.repository.observeGrantRequest(input),
    async transact(selector, work) {
      await base.repository.transact(selector, work);
      throw new Error("settlement acknowledgement lost after commit");
    },
  };
  const uncertainAccess = createContainedTurnDispatchConsumptionV1({ digest: createSha256DispatchConsumptionDigest(), repository });
  const settlement = settlementFor(consumed.receipt);
  assert.deepEqual(await uncertainAccess.settleDispatchConsumption(settlement), { kind: "indeterminate" });
  assert.equal((await baseAccess.settleDispatchConsumption(settlement)).kind, "settled");
});

test("settlement and binding replacement serialize without stale overwrite", async () => {
  const first = repositoryHarness();
  const initialAccess = createContainedTurnDispatchConsumptionV1({ digest: createSha256DispatchConsumptionDigest(), repository: first.repository });
  const consumed = await initialAccess.consumeForDispatch(await inputFor());
  assert.equal(consumed.kind, "consumed");
  if (consumed.kind !== "consumed") {return;}
  const barrier = transactionBarrier(first.repository);
  const settlementAccess = createContainedTurnDispatchConsumptionV1({ digest: createSha256DispatchConsumptionDigest(), repository: barrier.repository });
  const settlement = settlementAccess.settleDispatchConsumption(settlementFor(consumed.receipt));
  await barrier.entered;
  const replacement = first.control.replaceBindingHead({
    ...seed({ authorityHeadDigest: "authority:head:2", bindingDigest: "binding:digest:2", bindingRevision: 2 }),
    availability: "available", revocation: "active",
  });
  barrier.release();
  assert.equal((await settlement).kind, "settled");
  await replacement;
  assert.equal(first.control.observeOwnerState({ provider: "codex", scopeDigest: "scope:digest:1" }), "absent");

  const second = repositoryHarness();
  const secondAccess = createContainedTurnDispatchConsumptionV1({ digest: createSha256DispatchConsumptionDigest(), repository: second.repository });
  const secondConsumed = await secondAccess.consumeForDispatch(await inputFor());
  assert.equal(secondConsumed.kind, "consumed");
  if (secondConsumed.kind !== "consumed") {return;}
  await second.control.replaceBindingHead({
    ...seed({ authorityHeadDigest: "authority:head:2", bindingDigest: "binding:digest:2", bindingRevision: 2 }),
    availability: "available", revocation: "active",
  });
  assert.equal((await secondAccess.settleDispatchConsumption(settlementFor(secondConsumed.receipt))).kind, "conflict");
  assert.equal(second.control.observeOwnerState({ provider: "codex", scopeDigest: "scope:digest:1" }), "absent");
});

test("claim-committed settlement is terminal audit evidence", async () => {
  const harness = createInMemoryContainedTurnDispatchConsumptionV1({ bindings: [seed()], initialControlTime: 100 });
  const consumed = await harness.access.consumeForDispatch(await inputFor());
  assert.equal(consumed.kind, "consumed");
  if (consumed.kind !== "consumed") {return;}
  assert.equal((await harness.access.settleDispatchConsumption({
    ...settlementFor(consumed.receipt), disposition: "claim_committed", settlementRequestId: "settlement:claim",
  })).kind, "settled");
  assert.equal(harness.control.observeOwnerState({ provider: "codex", scopeDigest: "scope:digest:1" }), "claim_committed");
});

test("Route C contract contains no secret, raw path, home, environment, SDK, Agent Execution, or Module Kit fields", async () => {
  const input = await inputFor();
  const text = JSON.stringify(input).toLowerCase();
  for (const token of ["secret", "path", "home", "environment", "sdk", "appserver", "acp", "agentexecution", "modulekit"]) {
    assert.equal(text.includes(token), false);
  }
});
