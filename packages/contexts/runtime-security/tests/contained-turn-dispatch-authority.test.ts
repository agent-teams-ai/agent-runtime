/* oxlint-disable eslint/max-lines -- adversarial contract probes intentionally share one harness. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import * as publicApi from "../dist/index.js";

import {
  createContainedTurnDispatchAuthorityFeature,
  createInMemoryDispatchConsumptionRepository,
  createNodeSha256DispatchDigest,
} from "../dist/composition.js";
import type {
  DispatchAuthorityHead,
  DispatchConsumptionRepository,
} from "../dist/composition.js";
import type {
  ConsumeForDispatchInput,
  DispatchAuthorityScope,
} from "../dist/index.js";

const scope: DispatchAuthorityScope = Object.freeze({
  tenantId: "tenant-a",
  projectId: "project-a",
  scopeDigest: "scope-digest-a",
});

const authority = (
  overrides: Partial<DispatchAuthorityHead> = {},
): DispatchAuthorityHead => ({
  decision: "accepted",
  purpose: "contained-turn.provider-dispatch/v1",
  operationId: "operation-a",
  scope,
  authorityRevision: "authority-revision-7",
  acceptedAuthorityDigest: "accepted-authority-digest-a",
  authorityHeadDigest: "authority-head-digest-a",
  constraintsDigest: "constraints-digest-a",
  containmentPolicyDigest: "containment-policy-digest-a",
  requestDigest: "request-digest-a",
  providerId: "provider-a",
  authorityGeneration: "generation-a",
  providerBindingDigest: "provider-binding-digest-a",
  claimBindingDigest: "claim-binding-digest-a",
  claimBeforeControlTime: 200,
  revoked: false,
  ownerEvidenceRef: "runtime-security-evidence:v1:opaque-a",
  ...overrides,
});

const input = (
  overrides: Partial<ConsumeForDispatchInput> = {},
): ConsumeForDispatchInput => ({
  purpose: "contained-turn.provider-dispatch/v1",
  operationId: "operation-a",
  scope,
  grantRequestId: "grant-request-a",
  requestDigest: "request-digest-a",
  providerId: "provider-a",
  authorityGeneration: "generation-a",
  providerBindingDigest: "provider-binding-digest-a",
  claimBindingDigest: "claim-binding-digest-a",
  acceptedAuthorityDigest: "accepted-authority-digest-a",
  expectedAuthorityHeadDigest: "authority-head-digest-a",
  expectedAuthorityRevision: "authority-revision-7",
  expectedConstraintsDigest: "constraints-digest-a",
  expectedContainmentPolicyDigest: "containment-policy-digest-a",
  ...overrides,
});

const harness = (head: DispatchAuthorityHead = authority()) => {
  let controlTime = 100;
  const repository = createInMemoryDispatchConsumptionRepository([head]);
  const feature = createContainedTurnDispatchAuthorityFeature({
    repository,
    clock: { now: () => controlTime },
    digest: createNodeSha256DispatchDigest(),
  });
  return {
    authority: feature.dispatchAuthorityV1,
    repository,
    setControlTime: (value: number) => {
      controlTime = value;
    },
  };
};

const assertDeepFrozen = (value: unknown): void => {
  if (typeof value !== "object" || value === null) {return;}
  assert.equal(Object.isFrozen(value), true);
  for (const nested of Object.values(value)) {assertDeepFrozen(nested);}
};

test("exact replay returns the original bytes and digest reuse conflicts", async () => {
  const fixture = harness();
  const first = await fixture.authority.consumeForDispatch(input());
  assert.equal(first.status, "consumed");
  const originalBytes = JSON.stringify(first);

  fixture.setControlTime(500);
  await fixture.repository.revokeAuthority(scope, "provider-a", "generation-a", "operation-a");
  const replay = await fixture.authority.consumeForDispatch(input());
  assert.equal(JSON.stringify(replay), originalBytes);
  assert.deepEqual(replay, first);

  const conflict = await fixture.authority.consumeForDispatch(
    input({ requestDigest: "request-digest-conflict" }),
  );
  assert.deepEqual(conflict, {
    status: "conflict",
    reason: "grant_request_digest_conflict",
  });
  const disguisedConflict = await fixture.authority.consumeForDispatch(
    input({ expectedAuthorityRevision: "authority-revision-disguised" }),
  );
  assert.deepEqual(disguisedConflict, {
    status: "conflict",
    reason: "grant_request_digest_conflict",
  });
  const crossScopeReplay = await fixture.authority.consumeForDispatch(
    input({ scope: { ...scope, tenantId: "tenant-b" } }),
  );
  assert.deepEqual(crossScopeReplay, { status: "not_found" });
});

test("stale authority revision is terminal prevented evidence", async () => {
  const fixture = harness();
  const result = await fixture.authority.consumeForDispatch(
    input({ expectedAuthorityRevision: "authority-revision-6" }),
  );
  assert.equal(result.status, "prevented");
  if (result.status === "prevented") {
    assert.equal(result.evidence.reason, "authority_revision_stale");
    assert.ok(Object.isFrozen(result.evidence));
  }
  assert.equal(
    (await fixture.repository.inspectConsumption(scope, "provider-a", "generation-a", "operation-a")),
    undefined,
  );
});

test("constraints drift fails closed without a consumption", async () => {
  const fixture = harness();
  const result = await fixture.authority.consumeForDispatch(
    input({ expectedConstraintsDigest: "constraints-digest-old" }),
  );
  assert.equal(result.status, "prevented");
  if (result.status === "prevented") {assert.equal(result.evidence.reason, "constraints_drift");}
});

test("containment-policy drift fails closed without a consumption", async () => {
  const fixture = harness();
  const result = await fixture.authority.consumeForDispatch(
    input({ expectedContainmentPolicyDigest: "containment-policy-digest-old" }),
  );
  assert.equal(result.status, "prevented");
  if (result.status === "prevented") {
    assert.equal(result.evidence.reason, "containment_policy_drift");
  }
});

test("revocation before consume prevents dispatch", async () => {
  const fixture = harness(authority({ revoked: true }));
  const result = await fixture.authority.consumeForDispatch(input());
  assert.equal(result.status, "prevented");
  if (result.status === "prevented") {assert.equal(result.evidence.reason, "revoked");}
});

test("revocation after consume cannot rewrite the consumed outcome", async () => {
  const fixture = harness();
  const consumed = await fixture.authority.consumeForDispatch(input());
  assert.equal(consumed.status, "consumed");
  await fixture.repository.revokeAuthority(scope, "provider-a", "generation-a", "operation-a");
  assert.deepEqual(await fixture.authority.consumeForDispatch(input()), consumed);
});

test("owner-derived claim deadline is fixed and expiry is fail closed", async () => {
  const fixture = harness();
  fixture.setControlTime(200);
  const expired = await fixture.authority.consumeForDispatch(input());
  assert.equal(expired.status, "prevented");
  if (expired.status === "prevented") {assert.equal(expired.evidence.reason, "expired");}

  const fresh = harness(authority({ operationId: "operation-b", claimBeforeControlTime: 201 }));
  const consumed = await fresh.authority.consumeForDispatch(
    input({ operationId: "operation-b", grantRequestId: "grant-request-b" }),
  );
  assert.equal(consumed.status, "consumed");
  if (consumed.status === "consumed") {assert.equal(consumed.receipt.claimBeforeControlTime, 201);}
});

test("two concurrent consumers linearize to one immutable receipt", async () => {
  const fixture = harness();
  const outcomes = await Promise.all([
    fixture.authority.consumeForDispatch(input({ grantRequestId: "consumer-a" })),
    fixture.authority.consumeForDispatch(input({ grantRequestId: "consumer-b" })),
  ]);
  assert.deepEqual(outcomes.map(outcome => outcome.status).toSorted(), ["consumed", "prevented"]);
  const prevented = outcomes.find(outcome => outcome.status === "prevented");
  if (prevented?.status === "prevented") {
    assert.equal(prevented.evidence.reason, "already_consumed");
  }
});

test("observe recovers a consumed receipt after lost acknowledgement", async () => {
  const fixture = harness();
  const consumed = await fixture.authority.consumeForDispatch(input());
  assert.equal(consumed.status, "consumed");
  const observed = await fixture.authority.observeDispatchConsumption({
    ...input(),
  });
  assert.equal(observed.status, "consumed");
  if (observed.status === "consumed" && consumed.status === "consumed") {
    assert.deepEqual(observed.receipt, consumed.receipt);
    assert.equal(observed.lifecycleState, "consumed_pending");
  }
});

test("maps application persistence records to detached V1 boundary DTOs", async () => {
  const fixture = harness();
  const consumed = await fixture.authority.consumeForDispatch(input());
  assert.equal(consumed.status, "consumed");
  if (consumed.status !== "consumed") {return;}
  const persisted = await fixture.repository.inspectConsumption(
    scope, "provider-a", "generation-a", "operation-a");
  assert.notEqual(persisted, undefined);
  assert.notStrictEqual(persisted?.receipt, consumed.receipt);
  assert.deepEqual(persisted?.receipt, consumed.receipt);
  assert.equal(Object.isFrozen(consumed.receipt), true);
  assert.equal(Object.isFrozen(consumed.receipt.scope), true);
});

test("settlement is idempotent and conflicting request reuse is typed", async () => {
  const fixture = harness();
  const consumed = await fixture.authority.consumeForDispatch(input());
  assert.equal(consumed.status, "consumed");
  if (consumed.status !== "consumed") {return;}
  const settlementInput = {
    scope,
    providerId: "provider-a",
    authorityGeneration: "generation-a",
    operationId: "operation-a",
    grantRequestId: "grant-request-a",
    settlementRequestId: "settlement-a",
    consumptionDigest: consumed.receipt.consumptionDigest,
    disposition: "claim_committed" as const,
  };
  const first = await fixture.authority.settleDispatchConsumption(settlementInput);
  const replay = await fixture.authority.settleDispatchConsumption(settlementInput);
  assert.deepEqual(replay, first);
  const conflict = await fixture.authority.settleDispatchConsumption({
    ...settlementInput,
    disposition: "abandoned_without_claim",
  });
  assert.deepEqual(conflict, {
    status: "conflict",
    reason: "settlement_request_digest_conflict",
  });
});

test("settlement never reopens or makes authority reusable", async () => {
  const fixture = harness();
  const consumed = await fixture.authority.consumeForDispatch(input());
  assert.equal(consumed.status, "consumed");
  if (consumed.status !== "consumed") {return;}
  await fixture.authority.settleDispatchConsumption({
    scope, providerId: "provider-a", authorityGeneration: "generation-a",
    operationId: "operation-a", grantRequestId: "grant-request-a",
    settlementRequestId: "settlement-abandon",
    consumptionDigest: consumed.receipt.consumptionDigest,
    disposition: "abandoned_without_claim",
  });
  const reuse = await fixture.authority.consumeForDispatch(
    input({ grantRequestId: "grant-request-reuse" }),
  );
  assert.equal(reuse.status, "prevented");
  if (reuse.status === "prevented") {assert.equal(reuse.evidence.reason, "already_consumed");}
  const resettle = await fixture.authority.settleDispatchConsumption({
    scope, providerId: "provider-a", authorityGeneration: "generation-a",
    operationId: "operation-a", grantRequestId: "grant-request-a",
    settlementRequestId: "settlement-reopen",
    consumptionDigest: consumed.receipt.consumptionDigest,
    disposition: "claim_committed",
  });
  assert.deepEqual(resettle, {
    status: "conflict",
    reason: "consumption_already_settled",
  });
});

test("not found and owner unavailability never create a grant", async () => {
  const fixture = harness();
  const absent = await fixture.authority.consumeForDispatch(
    input({ operationId: "missing-operation", grantRequestId: "missing-request" }),
  );
  assert.deepEqual(absent, { status: "not_found" });
  fixture.repository.setAvailable(false);
  const unavailable = await fixture.authority.consumeForDispatch(
    input({ grantRequestId: "unavailable-request" }),
  );
  assert.deepEqual(unavailable, {
    status: "indeterminate",
    reason: "owner_unavailable",
  });
});

test("request, claim binding, accepted head, and scope substitutions fail closed", async () => {
  const cases = [
    [input({ providerBindingDigest: "wrong-provider" }), "provider_binding_mismatch"],
    [input({ claimBindingDigest: "wrong-claim" }), "claim_binding_mismatch"],
    [input({ requestDigest: "wrong-request", grantRequestId: "wrong-request-id" }), "request_digest_mismatch"],
    [input({ expectedAuthorityHeadDigest: "wrong-head", grantRequestId: "wrong-head-id" }), "accepted_authority_changed"],
  ] as const;
  for (const [candidate, reason] of cases) {
    const fixture = harness();
    const result = await fixture.authority.consumeForDispatch(candidate);
    assert.equal(result.status, "prevented");
    if (result.status === "prevented") {assert.equal(result.evidence.reason, reason);}
  }
  const fixture = harness();
  const wrongScope = await fixture.authority.consumeForDispatch(input({
    scope: { ...scope, tenantId: "tenant-b" },
  }));
  assert.deepEqual(wrongScope, { status: "not_found" });
});

test("snapshots caller-owned request data before entering the owner transaction", async () => {
  const fixture = harness();
  const candidate = input({ scope: { ...scope } });
  const pending = fixture.authority.consumeForDispatch(candidate);
  (candidate as { expectedAuthorityRevision: string }).expectedAuthorityRevision = "mutated";
  (candidate.scope as { tenantId: string }).tenantId = "tenant-mutated";
  const result = await pending;
  assert.equal(result.status, "consumed");
  if (result.status === "consumed") {
    assert.equal(result.receipt.authorityRevision, "authority-revision-7");
    assert.equal(result.receipt.scope.tenantId, "tenant-a");
  }
});

test("authority ingress rejects malformed persisted facts before storage", async () => {
  const missing = { ...authority() } as Partial<DispatchAuthorityHead>;
  delete missing.revoked;
  const accessor = { ...authority() };
  Object.defineProperty(accessor, "revoked", { get: () => false, enumerable: true });
  const malformed = [
    missing,
    { ...authority(), revoked: null },
    { ...authority(), revoked: 0 },
    { ...authority(), revoked: "false" },
    accessor,
    new Proxy(authority(), {
      getOwnPropertyDescriptor(target, property) {
        if (property === "revoked") {return { get: () => false, enumerable: true, configurable: true };}
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
    }),
  ];
  for (const candidate of malformed) {
    const head = candidate as unknown as DispatchAuthorityHead;
    assert.throws(() => createInMemoryDispatchConsumptionRepository([head]), TypeError);
  }
});

test("persisted authority heads are captured once from plain own data", async () => {
  const sha256 = createNodeSha256DispatchDigest();
  const mutable = authority();
  let digestCalls = 0;
  const repository: DispatchConsumptionRepository = {
    async consumeAtomically(_key, decide) {
      return decide({ authority: mutable }).outcome;
    },
    async observe() {return;},
    async settleAtomically() {return { status: "invalid_request" };},
  };
  const feature = createContainedTurnDispatchAuthorityFeature({
    repository,
    clock: { now: () => 100 },
    digest: { digestCanonical(value) {
      digestCalls += 1;
      if (digestCalls === 2) {
        (mutable as { acceptedAuthorityDigest: string }).acceptedAuthorityDigest =
          "receipt-forgery";
      }
      return sha256.digestCanonical(value);
    } },
  });
  const consumed = await feature.dispatchAuthorityV1.consumeForDispatch(input());
  assert.equal(consumed.status, "consumed");
  if (consumed.status === "consumed") {
    assert.equal(consumed.receipt.acceptedAuthorityDigest, "accepted-authority-digest-a");
  }

  let accessorReads = 0;
  const accessor = { ...authority() };
  Object.defineProperty(accessor, "acceptedAuthorityDigest", {
    enumerable: true,
    get() {accessorReads += 1; return "accepted-authority-digest-a";},
  });
  let proxyDescriptorReads = 0;
  const proxy = new Proxy(authority(), {
    getOwnPropertyDescriptor(target, property) {
      proxyDescriptorReads += 1;
      return Reflect.getOwnPropertyDescriptor(target, property);
    },
  });
  const inherited = Object.create(authority()) as DispatchAuthorityHead;
  for (const malformed of [accessor, inherited]) {
    const failingRepository: DispatchConsumptionRepository = {
      async consumeAtomically(_key, decide) {
        return decide({ authority: malformed }).outcome;
      },
      async observe() {return;},
      async settleAtomically() {return { status: "invalid_request" };},
    };
    const failingFeature = createContainedTurnDispatchAuthorityFeature({
      repository: failingRepository,
      clock: { now: () => 100 },
      digest: sha256,
    });
    const result = await failingFeature.dispatchAuthorityV1.consumeForDispatch(input());
    assert.deepEqual(result, { status: "indeterminate", reason: "owner_unavailable" });
  }
  assert.equal(accessorReads, 0);
  const proxyRepository: DispatchConsumptionRepository = {
    async consumeAtomically(_key, decide) {return decide({ authority: proxy }).outcome;},
    async observe() {return;},
    async settleAtomically() {return { status: "invalid_request" };},
  };
  const proxyResult = await createContainedTurnDispatchAuthorityFeature({
    repository: proxyRepository, clock: { now: () => 100 }, digest: sha256,
  }).dispatchAuthorityV1.consumeForDispatch(input());
  assert.deepEqual(proxyResult, { status: "indeterminate", reason: "owner_unavailable" });
  assert.equal(proxyDescriptorReads, 0);
});

test("observation rejects same-scope grant and nested receipt substitution", async () => {
  const base = createInMemoryDispatchConsumptionRepository([
    authority(),
    authority({
      operationId: "operation-b",
      requestDigest: "request-digest-b",
      claimBindingDigest: "claim-binding-digest-b",
    }),
  ]);
  const direct = createContainedTurnDispatchAuthorityFeature({
    repository: base,
    clock: { now: () => 100 },
    digest: createNodeSha256DispatchDigest(),
  });
  await direct.dispatchAuthorityV1.consumeForDispatch(input());
  await direct.dispatchAuthorityV1.consumeForDispatch(input({
    operationId: "operation-b",
    grantRequestId: "grant-request-b",
    requestDigest: "request-digest-b",
    claimBindingDigest: "claim-binding-digest-b",
  }));
  const recordA = await base.observe({ scope, providerId: "provider-a",
    authorityGeneration: "generation-a", operationId: "operation-a",
    grantRequestId: "grant-request-a" });
  const recordB = await base.observe({ scope, providerId: "provider-a",
    authorityGeneration: "generation-a", operationId: "operation-b",
    grantRequestId: "grant-request-b" });
  assert.notEqual(recordA, undefined);
  assert.notEqual(recordB, undefined);

  const substitutedGrant: DispatchConsumptionRepository = {
    consumeAtomically: base.consumeAtomically,
    async observe() {return recordB;},
    settleAtomically: base.settleAtomically,
  };
  const grantFeature = createContainedTurnDispatchAuthorityFeature({
    repository: substitutedGrant,
    clock: { now: () => 100 },
    digest: createNodeSha256DispatchDigest(),
  });
  assert.deepEqual(await grantFeature.dispatchAuthorityV1.observeDispatchConsumption({
    ...input(),
  }), { status: "not_found" });

  const substitutedReceipt: DispatchConsumptionRepository = {
    consumeAtomically: base.consumeAtomically,
    async observe() {
      if (recordA === undefined || recordB === undefined) {return;}
      return { ...recordA, consumption: recordB.consumption };
    },
    settleAtomically: base.settleAtomically,
  };
  const receiptFeature = createContainedTurnDispatchAuthorityFeature({
    repository: substitutedReceipt,
    clock: { now: () => 100 },
    digest: createNodeSha256DispatchDigest(),
  });
  assert.deepEqual(await receiptFeature.dispatchAuthorityV1.observeDispatchConsumption({
    ...input(),
  }), { status: "indeterminate", reason: "owner_unavailable" });
});

test("invalid settlement facts are rejected before digesting or persistence", async () => {
  let digestCalls = 0;
  const repository = createInMemoryDispatchConsumptionRepository([authority()]);
  const feature = createContainedTurnDispatchAuthorityFeature({
    repository,
    clock: { now: () => 100 },
    digest: { digestCanonical(value) {
      digestCalls += 1;
      return createNodeSha256DispatchDigest().digestCanonical(value);
    } },
  });
  const consumed = await feature.dispatchAuthorityV1.consumeForDispatch(input());
  assert.equal(consumed.status, "consumed");
  if (consumed.status !== "consumed") {return;}
  const callsAfterConsume = digestCalls;
  const candidates: unknown[] = [
    { consumptionDigest: consumed.receipt.consumptionDigest, disposition: "claim_committed" },
    { settlementRequestId: null, consumptionDigest: consumed.receipt.consumptionDigest,
      disposition: "claim_committed" },
    { settlementRequestId: 7, consumptionDigest: consumed.receipt.consumptionDigest,
      disposition: "claim_committed" },
    { settlementRequestId: "settle", consumptionDigest: "", disposition: "claim_committed" },
    { settlementRequestId: "settle", consumptionDigest: consumed.receipt.consumptionDigest,
      disposition: "consumed_pending" },
    Object.defineProperty({
      consumptionDigest: consumed.receipt.consumptionDigest,
      disposition: "claim_committed",
    }, "settlementRequestId", { get: () => "settle", enumerable: true }),
  ];
  for (const candidate of candidates) {
    const result = await feature.dispatchAuthorityV1.settleDispatchConsumption(
      candidate as Parameters<typeof feature.dispatchAuthorityV1.settleDispatchConsumption>[0],
    );
    assert.deepEqual(result, { status: "invalid_request" });
  }
  assert.equal(digestCalls, callsAfterConsume);
  assert.equal(
    (await repository.inspectConsumption(scope, "provider-a", "generation-a",
      "operation-a"))?.lifecycleState,
    "consumed_pending",
  );
});

test("composition snapshots dependency methods against later caller mutation", async () => {
  const repository = createInMemoryDispatchConsumptionRepository([authority()]);
  const clock = { now: () => 100 };
  const digest = createNodeSha256DispatchDigest();
  const dependencies = { repository, clock, digest };
  const feature = createContainedTurnDispatchAuthorityFeature(dependencies);
  dependencies.clock.now = () => 500;
  dependencies.digest.digestCanonical = () => { throw new Error("mutated digest"); };
  dependencies.repository.consumeAtomically = async () => {
    throw new Error("mutated repository");
  };
  const result = await feature.dispatchAuthorityV1.consumeForDispatch(input());
  assert.equal(result.status, "consumed");
});

test("composition rejects accessors and proxies without invoking traps", async () => {
  const repository = createInMemoryDispatchConsumptionRepository([authority()]);
  let reads = 0;
  const accessorClock = Object.defineProperty({}, "now", {
    enumerable: true,
    get() {reads += 1; return () => 100;},
  });
  assert.throws(() => createContainedTurnDispatchAuthorityFeature({
    repository, clock: accessorClock as { now(): number }, digest: createNodeSha256DispatchDigest(),
  }), TypeError);
  assert.equal(reads, 0);
  let traps = 0;
  const proxied = new Proxy({
    repository, clock: { now: () => 100 }, digest: createNodeSha256DispatchDigest(),
  }, { getOwnPropertyDescriptor() {traps += 1; throw new Error("trap");} }) as never;
  assert.throws(() => createContainedTurnDispatchAuthorityFeature(proxied), TypeError);
  assert.equal(traps, 0);
});

test("authority ingress snapshots once, rejects unknowns, and never freezes caller sources", async () => {
  const source = authority({ scope: { ...scope } });
  const sourceScope = source.scope;
  const repository = createInMemoryDispatchConsumptionRepository([source]);
  assert.equal(Object.isFrozen(source), false);
  assert.equal(Object.isFrozen(sourceScope), false);
  const replacement = authority({ authorityRevision: "authority-revision-8" });
  await repository.replaceAuthority(replacement);
  assert.equal(Object.isFrozen(replacement), false);
  assert.rejects(() => repository.replaceAuthority(
    new Proxy(authority(), {}) as DispatchAuthorityHead), TypeError);
  assert.throws(() => createInMemoryDispatchConsumptionRepository([
    { ...authority(), diagnostics: "unknown" } as unknown as DispatchAuthorityHead,
  ]), TypeError);
  const scopeAccessor = { tenantId: "tenant-a", projectId: "project-a" };
  Object.defineProperty(scopeAccessor, "scopeDigest", {
    enumerable: true, get: () => "scope-digest-a",
  });
  assert.throws(() => createInMemoryDispatchConsumptionRepository([
    authority({ scope: scopeAccessor as DispatchAuthorityScope }),
  ]), TypeError);
  assert.throws(() => createInMemoryDispatchConsumptionRepository([
    authority({ scope: [] as unknown as DispatchAuthorityScope }),
  ]), TypeError);
});

test("same scope digest is isolated across tenant and project before observation", async () => {
  const otherScope = Object.freeze({
    tenantId: "tenant-b", projectId: "project-b", scopeDigest: scope.scopeDigest,
  });
  const repository = createInMemoryDispatchConsumptionRepository([
    authority(), authority({ scope: otherScope }),
  ]);
  const feature = createContainedTurnDispatchAuthorityFeature({
    repository, clock: { now: () => 100 }, digest: createNodeSha256DispatchDigest(),
  });
  const first = await feature.dispatchAuthorityV1.consumeForDispatch(input());
  const second = await feature.dispatchAuthorityV1.consumeForDispatch(input({ scope: otherScope }));
  assert.equal(first.status, "consumed");
  assert.equal(second.status, "consumed");
  const observed = await feature.dispatchAuthorityV1.observeDispatchConsumption(
    input({ scope: otherScope }),
  );
  assert.equal(observed.status, "consumed");
  if (observed.status === "consumed") {assert.equal(observed.receipt.scope.tenantId, "tenant-b");}
});

test("consume and settlement recover after commit acknowledgement loss", async () => {
  const base = createInMemoryDispatchConsumptionRepository([authority()]);
  let consumeThrows = true;
  let settlementThrows = true;
  const repository: DispatchConsumptionRepository = {
    async consumeAtomically(key, decide) {
      const committed = await base.consumeAtomically(key, decide);
      if (consumeThrows) {consumeThrows = false; throw new Error("lost consume acknowledgement");}
      return committed;
    },
    observe: base.observe,
    async settleAtomically(key, decide) {
      const committed = await base.settleAtomically(key, decide);
      if (settlementThrows) {settlementThrows = false; throw new Error("lost settlement acknowledgement");}
      return committed;
    },
  };
  const feature = createContainedTurnDispatchAuthorityFeature({
    repository, clock: { now: () => 100 }, digest: createNodeSha256DispatchDigest(),
  }).dispatchAuthorityV1;
  assert.deepEqual(await feature.consumeForDispatch(input()), {
    status: "indeterminate", reason: "owner_unavailable",
  });
  const recovered = await feature.observeDispatchConsumption(input());
  assert.equal(recovered.status, "consumed");
  const retried = await feature.consumeForDispatch(input());
  assert.equal(retried.status, "consumed");
  if (retried.status !== "consumed") {return;}
  const settlement = {
    scope, providerId: "provider-a", authorityGeneration: "generation-a",
    operationId: "operation-a", grantRequestId: "grant-request-a",
    settlementRequestId: "settlement-recovery",
    consumptionDigest: retried.receipt.consumptionDigest, disposition: "claim_committed" as const,
  };
  assert.deepEqual(await feature.settleDispatchConsumption(settlement), {
    status: "indeterminate", reason: "owner_unavailable",
  });
  const staleObservation = await feature.observeDispatchConsumption(input());
  assert.equal(staleObservation.status, "consumed");
  if (staleObservation.status === "consumed") {
    assert.equal(staleObservation.lifecycleState, "claim_committed");
  }
  assert.equal((await feature.settleDispatchConsumption(settlement)).status, "settled");
});

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
