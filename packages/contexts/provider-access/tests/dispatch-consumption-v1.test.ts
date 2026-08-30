import assert from "node:assert/strict";
import test from "node:test";

import type { ConsumeForDispatchInput } from "../dist/index.js";
import {
  createDispatchConsumptionRequestDigests,
  createInMemoryContainedTurnDispatchConsumptionV1,
  type InMemoryDispatchBindingSeed,
} from "../dist/composition.js";
import { createContainedTurnDispatchConsumptionV1 } from "../dist/features/contained-turn-access/composition/dispatch-consumption-v1-factory.js";
import { createSha256DispatchConsumptionDigest } from "../dist/features/contained-turn-access/adapters/outbound/sha256-dispatch-consumption-digest.js";

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

test("atomically consumes the exact binding head and returns the closed V1 receipt", async () => {
  const harness = createInMemoryContainedTurnDispatchConsumptionV1({ bindings: [seed()], initialControlTime: 100 });
  assert.deepEqual(Object.keys(harness.access).toSorted(), [
    "consumeForDispatch", "observeDispatchConsumption", "settleDispatchConsumption",
  ]);
  const outcome = await harness.access.consumeForDispatch(await inputFor());
  assert.equal(outcome.kind, "consumed");
  if (outcome.kind !== "consumed") return;
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
  harness.control.replaceBindingHead(seed({ authorityHeadDigest: "authority:head:2", revocation: "revoked" }));
  harness.control.advanceControlTime(500);
  const replay = await harness.access.consumeForDispatch(input);
  assert.equal(JSON.stringify(replay), JSON.stringify(first));
});

test("grant request ID reuse with another digest is a typed conflict", async () => {
  const harness = createInMemoryContainedTurnDispatchConsumptionV1({ bindings: [seed()], initialControlTime: 100 });
  const input = await inputFor();
  assert.equal((await harness.access.consumeForDispatch(input)).kind, "consumed");
  assert.deepEqual(await harness.access.consumeForDispatch({ ...input, requestDigest: "sha256:different" }), {
    kind: "conflict", reason: "grant_request_digest_conflict",
  });
});

test("scope drift and provider drift never fall back to another binding", async () => {
  const harness = createInMemoryContainedTurnDispatchConsumptionV1({ bindings: [seed()], initialControlTime: 100 });
  const wrongScope = await inputFor(seed(), {
    scope: { projectId: "project:other", scopeDigest: "scope:digest:1", tenantId: "tenant:1" },
  });
  const outcome = await harness.access.consumeForDispatch(wrongScope);
  assert.equal(outcome.kind, "prevented");
  if (outcome.kind === "prevented") assert.equal(outcome.prevention.reason, "scope_mismatch");
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
    if (outcome.kind === "prevented") assert.equal(outcome.prevention.reason, reason);
  }
  const providerDrift = createInMemoryContainedTurnDispatchConsumptionV1({ bindings: [seed({ provider: "claude" })], initialControlTime: 100 });
  assert.equal((await providerDrift.access.consumeForDispatch(await inputFor())).kind, "not_found");
});

test("revocation, availability, expiry, request digest, and claim binding prevent dispatch", async () => {
  const cases: readonly [InMemoryDispatchBindingSeed, number, Partial<ConsumeForDispatchInput>, string][] = [
    [seed({ revocation: "revoked" }), 100, {}, "revoked"], [seed({ availability: "unavailable" }), 100, {}, "unavailable"],
    [seed(), 200, {}, "expired"], [seed(), 100, { requestDigest: "sha256:bad" }, "request_digest_mismatch"],
    [seed(), 100, { claimBindingDigest: "sha256:bad" }, "claim_binding_mismatch"],
  ];
  for (const [head, now, override, reason] of cases) {
    const harness = createInMemoryContainedTurnDispatchConsumptionV1({ bindings: [head], initialControlTime: now });
    const outcome = await harness.access.consumeForDispatch({ ...await inputFor(), ...override });
    assert.equal(outcome.kind, "prevented");
    if (outcome.kind === "prevented") assert.equal(outcome.prevention.reason, reason);
  }
  const replayHarness = createInMemoryContainedTurnDispatchConsumptionV1({ bindings: [seed({ revocation: "revoked" })], initialControlTime: 100 });
  const replayInput = await inputFor();
  const prevention = await replayHarness.access.consumeForDispatch(replayInput);
  replayHarness.control.replaceBindingHead(seed({ revocation: "active" }));
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

test("observation recovers a consumption after acknowledgement loss", async () => {
  const harness = createInMemoryContainedTurnDispatchConsumptionV1({ bindings: [seed()], initialControlTime: 100 });
  const input = await inputFor();
  const consumed = await harness.access.consumeForDispatch(input);
  const observed = await harness.access.observeDispatchConsumption({
    grantRequestId: input.grantRequestId, requestDigest: input.requestDigest, scope: input.scope,
  });
  assert.equal(JSON.stringify(observed), JSON.stringify(consumed));
  assert.deepEqual(await harness.access.observeDispatchConsumption({
    grantRequestId: input.grantRequestId, requestDigest: "sha256:other", scope: input.scope,
  }), { kind: "conflict", reason: "grant_request_digest_conflict" });
  assert.deepEqual(await harness.access.observeDispatchConsumption({
    grantRequestId: input.grantRequestId, requestDigest: input.requestDigest,
    scope: { ...input.scope, projectId: "project:other" },
  }), { kind: "not_found" });
});

test("owner unavailability is indeterminate and never grants dispatch", async () => {
  const access = createContainedTurnDispatchConsumptionV1({
    clock: { now: () => 100 }, digest: createSha256DispatchConsumptionDigest(),
    repository: {
      async observeGrantRequest() { throw new Error("owner unavailable"); },
      async transact() { throw new Error("owner unavailable"); },
    },
  });
  assert.deepEqual(await access.consumeForDispatch(await inputFor()), { kind: "indeterminate" });
  const input = await inputFor();
  assert.deepEqual(await access.observeDispatchConsumption({
    grantRequestId: input.grantRequestId, requestDigest: input.requestDigest, scope: input.scope,
  }), { kind: "indeterminate" });
});

test("settlement replays exactly, conflicts on reuse, and cannot reopen consumed access", async () => {
  const harness = createInMemoryContainedTurnDispatchConsumptionV1({ bindings: [seed()], initialControlTime: 100 });
  const consumed = await harness.access.consumeForDispatch(await inputFor());
  assert.equal(consumed.kind, "consumed");
  if (consumed.kind !== "consumed") return;
  const settlement = { consumptionDigest: consumed.receipt.consumptionDigest, disposition: "abandoned_without_claim" as const, settlementRequestId: "settlement:1" };
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
  harness.control.replaceBindingHead(seed({ bindingRevision: 2, bindingDigest: "binding:digest:2" }));
  const again = await harness.access.consumeForDispatch(await inputFor(seed({ bindingRevision: 2, bindingDigest: "binding:digest:2" }), {
    grantRequestId: "grant-request:2", operationId: "operation:2",
  }));
  assert.equal(again.kind, "prevented");
  if (again.kind === "prevented") assert.equal(again.prevention.reason, "already_consumed");
});

test("claim-committed settlement is terminal audit evidence", async () => {
  const harness = createInMemoryContainedTurnDispatchConsumptionV1({ bindings: [seed()], initialControlTime: 100 });
  const consumed = await harness.access.consumeForDispatch(await inputFor());
  assert.equal(consumed.kind, "consumed");
  if (consumed.kind !== "consumed") return;
  assert.equal((await harness.access.settleDispatchConsumption({
    consumptionDigest: consumed.receipt.consumptionDigest, disposition: "claim_committed", settlementRequestId: "settlement:claim",
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
