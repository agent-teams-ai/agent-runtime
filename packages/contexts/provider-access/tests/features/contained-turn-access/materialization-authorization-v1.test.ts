import assert from "node:assert/strict";
import test from "node:test";

import type {
  AuthorizeCredentialMaterializationInput, ObserveCredentialMaterializationInput,
} from "../../../dist/index.js";
import {
  createCredentialMaterializationRequestDigest, createInMemoryContainedTurnDispatchConsumptionV1,
} from "../../../dist/composition.js";
import { createContainedTurnCredentialMaterializationAuthorizationV1 } from
  "../../../dist/features/contained-turn-access/composition/materialization-authorization-v1-factory.js";
import { createSha256DispatchConsumptionDigest } from
  "../../../dist/features/contained-turn-access/adapters/outbound/sha256-dispatch-consumption-digest.js";
import { createInMemoryDispatchConsumptionRepository } from
  "../../../dist/features/contained-turn-access/adapters/outbound/in-memory-dispatch-consumption-repository.js";
import type { MaterializationAuthorizationRepository } from
  "../../../dist/features/contained-turn-access/application/ports/outbound/materialization-authorization-repository.js";
import { inputFor, seed, settlementFor } from "./dispatch-consumption-test-fixture.ts";

const observationFor = (request: AuthorizeCredentialMaterializationInput): ObserveCredentialMaterializationInput => ({
  materializationRequestId: request.materializationRequestId, projectId: request.projectId, provider: request.provider,
  requestDigest: request.requestDigest, scopeDigest: request.scopeDigest, tenantId: request.tenantId,
});

const requestFor = async (
  consumptionDigest: string, overrides: Partial<Omit<AuthorizeCredentialMaterializationInput, "requestDigest">> = {},
): Promise<AuthorizeCredentialMaterializationInput> => {
  const unsigned = {
    accessRef: "access:1", attemptId: "attempt:1", availability: "available" as const, bindingRevision: 1,
    credentialBindingDigest: "credential:digest:1", credentialGeneration: 1, custodyId: "custody:1",
    executionGenerationId: "execution-generation:1", hostBootId: "host-boot:1", hostInstanceId: "host-instance:1",
    materializationRequestId: "materialization-request:1", operationId: "operation:1", projectId: "project:1",
    provider: "codex" as const, providerAccountRef: "account:1", providerRouteRef: "route:1",
    purpose: "contained-turn.credential-materialization/v1" as const, revocation: "active" as const, schemaVersion: 1 as const,
    scopeDigest: "scope:digest:1", settledConsumptionDigest: consumptionDigest, tenantId: "tenant:1", ...overrides,
  };
  return { ...unsigned, requestDigest: await createCredentialMaterializationRequestDigest(unsigned) };
};

const settledHarness = async (disposition: "abandoned_without_claim" | "claim_committed" = "claim_committed") => {
  const harness = createInMemoryContainedTurnDispatchConsumptionV1({ bindings: [seed()], initialControlTime: 100 });
  const consumed = await harness.access.consumeForDispatch(await inputFor());
  assert.equal(consumed.kind, "consumed");
  if (consumed.kind !== "consumed") {throw new Error("fixture did not consume");}
  const settlement = await harness.access.settleDispatchConsumption({
    ...settlementFor(consumed.receipt), disposition, settlementRequestId: `settlement:${disposition}`,
  });
  assert.equal(settlement.kind, "settled");
  return { consumption: consumed.receipt, harness, request: await requestFor(consumed.receipt.consumptionDigest) };
};

test("claims once under concurrency; exact and conflicting replay never create authority", async () => {
  const { harness, request } = await settledHarness();
  const changedScope = await requestFor(request.settledConsumptionDigest, { scopeDigest: "scope:digest:2" });
  const outcomes = await Promise.all([
    ...Array.from({ length: 20 }, () => harness.materialization.authorize(request)),
    ...Array.from({ length: 20 }, () => harness.materialization.authorize(changedScope)),
  ]);
  assert.equal(outcomes.filter(outcome => outcome.kind === "claimed").length, 1);
  assert.equal(outcomes.filter(outcome => outcome.kind === "observed").length, 19);
  assert.equal(outcomes.filter(outcome => outcome.kind === "conflict").length, 20);
  const first = outcomes.find(outcome => outcome.kind === "claimed");
  assert.ok(first?.kind === "claimed");
  if (first?.kind !== "claimed") {return;}
  assert.equal(first.receipt.state, "claimed");
  assert.ok(Object.isFrozen(first.receipt));
  assert.deepEqual(Object.keys(first.receipt).toSorted(), [
    "accessRef", "attemptId", "availability", "bindingRevision", "credentialBindingDigest", "credentialGeneration", "custodyId",
    "executionGenerationId", "hostBootId", "hostInstanceId", "materializationRequestId", "observedAtControlTime", "operationId",
    "projectId", "provider", "providerAccountRef", "providerRouteRef", "purpose", "receiptDigest", "requestDigest", "revocation",
    "schemaVersion", "scopeDigest", "settledConsumptionDigest", "state", "stateRevision", "tenantId",
  ]);
  assert.equal(/secret|token|path|env|home|socket|endpoint|credentialBindingRef/iu.test(Object.keys(first.receipt).join(" ")), false);

  const changed = await requestFor(request.settledConsumptionDigest, { hostBootId: "host-boot:2" });
  assert.deepEqual(await harness.materialization.authorize(changed), {
    kind: "conflict", reason: "materialization_request_digest_conflict",
  });
  const anotherId = await requestFor(request.settledConsumptionDigest, { materializationRequestId: "materialization-request:2" });
  const reused = await harness.materialization.authorize(anotherId);
  assert.equal(reused.kind, "rejected");
  if (reused.kind === "rejected") {assert.equal(reused.reason, "already_used_by_another_request");}
});

test("one settled consumption has one claim winner across different concurrent request identities", async () => {
  const { harness, request } = await settledHarness();
  const other = await requestFor(request.settledConsumptionDigest, { materializationRequestId: "materialization-request:2" });
  const outcomes = await Promise.all([
    ...Array.from({ length: 10 }, () => harness.materialization.authorize(request)),
    ...Array.from({ length: 10 }, () => harness.materialization.authorize(other)),
  ]);
  assert.equal(outcomes.filter(outcome => outcome.kind === "claimed").length, 1);
  assert.equal(outcomes.filter(outcome => outcome.kind === "observed").length, 18);
  assert.equal(outcomes.filter(outcome => outcome.kind === "rejected").length, 1);
});

test("observation does not disclose a globally unique request across owner scopes", async () => {
  const { harness, request } = await settledHarness();
  assert.equal((await harness.materialization.authorize(request)).kind, "claimed");
  const foreignScopes = [
    { projectId: "project:foreign" }, { provider: "claude" as const },
    { scopeDigest: "scope:foreign" }, { tenantId: "tenant:foreign" },
  ];
  for (const foreignScope of foreignScopes) {
    const foreign = { ...observationFor(request), ...foreignScope };
    assert.deepEqual(await harness.materialization.observe(foreign), { kind: "not_found" });
    assert.deepEqual(await harness.materialization.transition({ ...foreign, transition: "materialized" }), { kind: "indeterminate" });
  }
  assert.equal((await harness.materialization.observe(observationFor(request))).kind, "observed");
});

test("a foreign owner scope cannot consume the settled-consumption claim in its canonical scope", async () => {
  const { harness, request } = await settledHarness();
  const foreign = await requestFor(request.settledConsumptionDigest, {
    materializationRequestId: "materialization-request:foreign", projectId: "project:foreign",
  });
  const foreignOutcome = await harness.materialization.authorize(foreign);
  assert.equal(foreignOutcome.kind, "rejected");
  if (foreignOutcome.kind === "rejected") {assert.equal(foreignOutcome.reason, "scope_mismatch");}
  assert.equal((await harness.materialization.authorize(request)).kind, "claimed");
});

test("all request identity bindings participate in the exact digest", async () => {
  const fields = [
    ["accessRef", "access:2"], ["attemptId", "attempt:2"], ["operationId", "operation:2"],
    ["executionGenerationId", "execution-generation:2"],
    ["custodyId", "custody:2"], ["hostInstanceId", "host-instance:2"], ["hostBootId", "host-boot:2"],
    ["tenantId", "tenant:2"], ["projectId", "project:2"], ["scopeDigest", "scope:digest:2"], ["provider", "claude"],
    ["providerAccountRef", "account:2"], ["providerRouteRef", "route:2"], ["settledConsumptionDigest", "consumption:digest:2"],
    ["credentialBindingDigest", "credential:digest:2"], ["credentialGeneration", 2], ["bindingRevision", 2],
  ] as const;
  for (const [field, value] of fields) {
    const { harness, request } = await settledHarness();
    assert.equal((await harness.materialization.authorize(request)).kind, "claimed");
    const changed = await requestFor(request.settledConsumptionDigest, { [field]: value });
    assert.deepEqual(await harness.materialization.authorize(changed), {
      kind: "conflict", reason: "materialization_request_digest_conflict",
    }, field);
  }
  const { harness, request } = await settledHarness();
  assert.equal((await harness.materialization.authorize(request)).kind, "claimed");
  assert.deepEqual(await harness.materialization.authorize({ ...request, scopeDigest: "scope:digest:2" }), {
    kind: "conflict", reason: "materialization_request_digest_conflict",
  });
  assert.deepEqual(await harness.materialization.authorize({ ...request, requestDigest: "sha256:forged" }), {
    kind: "conflict", reason: "materialization_request_digest_conflict",
  });
});

test("non-claim settlement and every canonical-head drift fail closed after settlement", async () => {
  const abandoned = await settledHarness("abandoned_without_claim");
  const abandonedOutcome = await abandoned.harness.materialization.authorize(abandoned.request);
  assert.equal(abandonedOutcome.kind, "rejected");
  if (abandonedOutcome.kind === "rejected") {assert.equal(abandonedOutcome.reason, "consumption_not_claim_committed");}

  const cases = [
    [{ accessRef: "access:2" }, "access_changed"], [{ providerAccountRef: "account:2" }, "account_changed"],
    [{ providerRouteRef: "route:2" }, "route_changed"], [{ credentialBindingDigest: "credential:digest:2" }, "credential_changed"],
    [{ credentialGeneration: 2 }, "credential_rotated"], [{ bindingRevision: 2 }, "binding_revision_changed"],
    [{ bindingDigest: "binding:digest:2" }, "binding_changed"], [{ authorityHeadDigest: "authority:head:2" }, "binding_changed"],
    [{ availability: "unavailable" as const }, "availability_changed"], [{ revocation: "revoked" as const }, "revoked"],
  ] as const;
  for (const [change, expected] of cases) {
    const { harness, request } = await settledHarness();
    await harness.control.replaceBindingHead(seed(change));
    const outcome = await harness.materialization.authorize(request);
    assert.equal(outcome.kind, "rejected", expected);
    if (outcome.kind === "rejected") {assert.equal(outcome.reason, expected);}
  }
  const expired = await settledHarness();
  await expired.harness.control.advanceControlTime(300);
  const expiredOutcome = await expired.harness.materialization.authorize(expired.request);
  assert.equal(expiredOutcome.kind, "rejected");
  if (expiredOutcome.kind === "rejected") {assert.equal(expiredOutcome.receipt.state, "expired");}
});

test("provider and scope substitution fail closed against the settled consumption", async () => {
  const providerCase = await settledHarness();
  await providerCase.harness.control.replaceBindingHead(seed({ provider: "claude" }));
  const providerRequest = await requestFor(providerCase.request.settledConsumptionDigest, { provider: "claude" });
  const providerOutcome = await providerCase.harness.materialization.authorize(providerRequest);
  assert.equal(providerOutcome.kind, "rejected");
  if (providerOutcome.kind === "rejected") {assert.equal(providerOutcome.reason, "provider_mismatch");}

  const scopeCase = await settledHarness();
  const scopeRequest = await requestFor(scopeCase.request.settledConsumptionDigest, { projectId: "project:2" });
  const scopeOutcome = await scopeCase.harness.materialization.authorize(scopeRequest);
  assert.equal(scopeOutcome.kind, "rejected");
  if (scopeOutcome.kind === "rejected") {assert.equal(scopeOutcome.reason, "scope_mismatch");}
});

test("lifecycle is at-most-once, cleanup is terminal, and cleanup failure quarantines", async () => {
  for (const cleanupOutcome of ["destroyed", "quarantined"] as const) {
    const { harness, request } = await settledHarness();
    assert.equal((await harness.materialization.authorize(request)).kind, "claimed");
    const selector = observationFor(request);
    const installing = { ...selector, transition: "installation_may_have_begun" as const };
    assert.equal((await harness.materialization.transition(installing)).kind, "transitioned");
    assert.equal((await harness.materialization.transition(installing)).kind, "observed");
    assert.equal((await harness.materialization.transition({ ...selector, transition: "materialized" })).kind, "transitioned");
    assert.equal((await harness.materialization.transition({ ...selector, transition: "cleanup_pending" })).kind, "transitioned");
    const cleanup = { ...selector, outcome: cleanupOutcome };
    const first = await harness.materialization.acknowledgeCleanup(cleanup);
    const replay = await harness.materialization.acknowledgeCleanup(cleanup);
    assert.equal(first.kind, "transitioned");
    assert.equal(replay.kind, "observed");
    if (replay.kind === "observed") {assert.equal(replay.receipt.state, cleanupOutcome);}
    assert.equal((await harness.materialization.transition(installing)).kind, "observed");
    const opposite = cleanupOutcome === "destroyed" ? "quarantined" : "destroyed";
    assert.equal((await harness.materialization.acknowledgeCleanup({ ...selector, outcome: opposite })).kind, "conflict");
  }
});

test("lost acknowledgement reconciles only by observation and never creates another installing transition", async () => {
  const head = { ...seed(), availability: "available" as const, revocation: "active" as const };
  const base = createInMemoryDispatchConsumptionRepository([head], 100);
  const digest = createSha256DispatchConsumptionDigest();
  // Seed the shared repository through its dispatch surface.
  const sharedDispatch = (await import("../../../dist/features/contained-turn-access/composition/dispatch-consumption-v1-factory.js"))
    .createContainedTurnDispatchConsumptionV1({ digest, repository: base.repository });
  const sharedConsumed = await sharedDispatch.consumeForDispatch(await inputFor());
  assert.equal(sharedConsumed.kind, "consumed");
  if (sharedConsumed.kind !== "consumed") {return;}
  await sharedDispatch.settleDispatchConsumption({
    ...settlementFor(sharedConsumed.receipt), disposition: "claim_committed", settlementRequestId: "settlement:lost-ack",
  });
  const request = await requestFor(sharedConsumed.receipt.consumptionDigest);
  const stable = createContainedTurnCredentialMaterializationAuthorizationV1({ digest, repository: base.materializationRepository });
  assert.equal((await stable.authorize(request)).kind, "claimed");
  let lose = true;
  const uncertainRepository: MaterializationAuthorizationRepository = {
    observeMaterializationRequest: selector => base.materializationRepository.observeMaterializationRequest(selector),
    async transact(selector, work) {
      const result = await base.materializationRepository.transact(selector, work);
      if (lose) {lose = false; throw new Error("acknowledgement lost after commit");}
      return result;
    },
  };
  const uncertain = createContainedTurnCredentialMaterializationAuthorizationV1({ digest, repository: uncertainRepository });
  const transition = { ...observationFor(request), transition: "installation_may_have_begun" as const };
  assert.deepEqual(await uncertain.transition(transition), { kind: "indeterminate" });
  const observed = await stable.observe(observationFor(request));
  assert.equal(observed.kind, "observed");
  if (observed.kind === "observed") {assert.equal(observed.receipt.state, "installing");}
  assert.equal((await stable.transition(transition)).kind, "observed");
  assert.equal((await stable.transition({ ...observationFor(request), transition: "reconcile_required" })).kind, "transitioned");
});

test("contract validation rejects extra, accessor, boxed, oversized, and forged-digest inputs", async () => {
  const { harness, request } = await settledHarness();
  const invalid = [
    { ...request, path: "/tmp/provider-home" },
    { ...request, hostBootId: new String("host-boot:1") },
    { ...request, custodyId: "x".repeat(513) },
    { ...request, requestDigest: "sha256:forged" },
  ];
  const accessor = { ...request } as Record<string, unknown>;
  Object.defineProperty(accessor, "hostBootId", { enumerable: true, get: () => "host-boot:1" });
  invalid.push(accessor as never);
  for (const value of invalid) {
    assert.deepEqual(await harness.materialization.authorize(value as never), { kind: "invalid", reason: "invalid_request" });
  }
  assert.deepEqual(await harness.materialization.observe({ ...observationFor(request), env: "secret" } as never), { kind: "indeterminate" });
});
