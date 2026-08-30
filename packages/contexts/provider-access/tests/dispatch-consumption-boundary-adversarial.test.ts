import assert from "node:assert/strict";
import test from "node:test";

import type { ConsumeForDispatchInput } from "../dist/index.js";
import { createDispatchConsumptionRequestDigests, createInMemoryContainedTurnDispatchConsumptionV1 } from "../dist/composition.js";
import { createInMemoryDispatchConsumptionRepository } from "../dist/features/contained-turn-access/adapters/outbound/in-memory-dispatch-consumption-repository.js";
import { createSha256DispatchConsumptionDigest } from "../dist/features/contained-turn-access/adapters/outbound/sha256-dispatch-consumption-digest.js";
import type { DispatchConsumptionRepository } from "../dist/features/contained-turn-access/application/ports/outbound/dispatch-consumption-repository.js";
import { createContainedTurnDispatchConsumptionV1 } from "../dist/features/contained-turn-access/composition/dispatch-consumption-v1-factory.js";

const seed = () => ({
  acceptedAuthorityDigest: "authority:accepted:1", accessRef: "access:1", authorityHeadDigest: "authority:head:1",
  availability: "available" as const, bindingDigest: "binding:digest:1", bindingRevision: 1, claimBeforeControlTime: 200,
  credentialBindingDigest: "credential:digest:1", credentialBindingRef: "credential:binding:1", credentialGeneration: 1,
  expiresAtControlTime: 300, opaqueOwnerEvidenceRef: "owner:evidence:1", projectId: "project:1", provider: "codex" as const,
  providerAccountRef: "account:1", providerRouteRef: "route:1", revocation: "active" as const,
  scopeDigest: "scope:digest:1", tenantId: "tenant:1",
});

const inputFor = async (): Promise<ConsumeForDispatchInput> => {
  const head = seed();
  const unsigned = {
    binding: {
      acceptedAuthorityDigest: head.acceptedAuthorityDigest, accessRef: head.accessRef,
      authorityHeadDigest: head.authorityHeadDigest, bindingDigest: head.bindingDigest, bindingRevision: head.bindingRevision,
      credentialBindingDigest: head.credentialBindingDigest, credentialBindingRef: head.credentialBindingRef,
      credentialGeneration: head.credentialGeneration, providerAccountRef: head.providerAccountRef, providerRouteRef: head.providerRouteRef,
    },
    grantRequestId: "grant-request:proxy", operationId: "operation:1", provider: head.provider,
    purpose: "contained-turn.provider-dispatch/v1" as const,
    scope: { projectId: head.projectId, scopeDigest: head.scopeDigest, tenantId: head.tenantId },
  };
  return { ...unsigned, ...await createDispatchConsumptionRequestDigests(unsigned) };
};

const armedHandler = (onTrap: () => void): ProxyHandler<object> => ({
  get() { onTrap(); throw new Error("proxy get trap"); },
  getOwnPropertyDescriptor() { onTrap(); throw new Error("proxy descriptor trap"); },
  getPrototypeOf() { onTrap(); throw new Error("proxy prototype trap"); },
  ownKeys() { onTrap(); throw new Error("proxy keys trap"); },
});

test("public dispatch inputs reject top-level and nested proxies without invoking traps", async () => {
  const harness = createInMemoryContainedTurnDispatchConsumptionV1({ bindings: [seed()], initialControlTime: 100 });
  const valid = await inputFor();
  let traps = 0;
  const handler = armedHandler(() => { traps += 1; });
  for (const value of [
    new Proxy(valid, handler),
    { ...valid, binding: new Proxy(valid.binding, handler) },
    { ...valid, scope: new Proxy(valid.scope, handler) },
  ]) {
    assert.deepEqual(await harness.access.consumeForDispatch(value as ConsumeForDispatchInput), {
      kind: "invalid", reason: "invalid_request",
    });
  }
  assert.equal(traps, 0);
});

test("repository outcomes reject top-level and nested proxies without invoking traps", async () => {
  const base = createInMemoryDispatchConsumptionRepository([seed()], 100);
  const input = await inputFor();
  const initial = createContainedTurnDispatchConsumptionV1({ digest: createSha256DispatchConsumptionDigest(), repository: base.repository });
  assert.equal((await initial.consumeForDispatch(input)).kind, "consumed");
  const stored = await base.repository.observeGrantRequest(input);
  assert.ok(stored !== undefined);
  if (stored === undefined) { return; }
  let traps = 0;
  const handler = armedHandler(() => { traps += 1; });
  for (const value of [
    new Proxy(structuredClone(stored), handler),
    { ...structuredClone(stored), outcome: new Proxy(structuredClone(stored.outcome), handler) },
  ]) {
    const observationRepository: DispatchConsumptionRepository = {
      observeGrantRequest: (() => value) as never, transact: base.repository.transact,
    };
    assert.deepEqual(await createContainedTurnDispatchConsumptionV1({
      digest: createSha256DispatchConsumptionDigest(), repository: observationRepository,
    }).observeDispatchConsumption({
      grantRequestId: input.grantRequestId, provider: input.provider, requestDigest: input.requestDigest, scope: input.scope,
    }), { kind: "indeterminate" });
    const transactionRepository: DispatchConsumptionRepository = {
      observeGrantRequest: base.repository.observeGrantRequest,
      transact: (selector, work) => base.repository.transact(selector, transaction => work({
        controlTime: transaction.controlTime, findBindingHead: transaction.findBindingHead,
        findConsumption: transaction.findConsumption, findGrantRequest: (() => value) as never,
        findSettlement: transaction.findSettlement, findSettlementByConsumption: transaction.findSettlementByConsumption,
        isBindingConsumed: transaction.isBindingConsumed, markBindingConsumed: transaction.markBindingConsumed,
        saveGrantRequest: transaction.saveGrantRequest, saveSettlement: transaction.saveSettlement,
      })),
    };
    assert.deepEqual(await createContainedTurnDispatchConsumptionV1({
      digest: createSha256DispatchConsumptionDigest(), repository: transactionRepository,
    }).consumeForDispatch(input), { kind: "indeterminate" });
  }
  assert.equal(traps, 0);
});
