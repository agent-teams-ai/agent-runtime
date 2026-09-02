import assert from "node:assert/strict";
import test from "node:test";

import {
  createContainedTurnProviderAccessPort,
  ProviderAccessRouteCOwnerError,
  type OuterContainedTurnProviderAccess,
} from "@agent-teams/agent-execution/composition";
import {
  createDispatchConsumptionRequestDigests,
  createInMemoryContainedTurnDispatchConsumptionV1,
  createStaticContainedTurnProviderAccessFeature,
} from "@agent-teams/provider-access/composition";
import { createContainedTurnFeatureFromProviderAccess } from "../dist/composition.js";
import { digestContainedTurnCanonicalValue } from "../../../contexts/agent-execution/dist/features/contained-agent-turn/domain/contained-turn-codecs.js";
import {
  completeContainedTurnDispatchGrantSubject,
  containedTurnGrantSettlementRequestId,
} from "../../../contexts/agent-execution/dist/features/contained-agent-turn/domain/contained-turn-dispatch-authority.js";
import { containedTurnIdentity } from "../../../contexts/agent-execution/dist/features/contained-agent-turn/domain/contained-turn-identities.js";

const scope = Object.freeze({ projectId: "project:kernel", tenantId: "tenant:kernel" });
const record = Object.freeze({
  accessRef: "access:one", availability: "available" as const,
  credentialBindingDigest: "owner-issued-opaque-digest", credentialBindingRef: "credential-binding:one",
  credentialGeneration: 7, projectId: scope.projectId, provider: "codex" as const,
  providerAccountRef: "provider-account:one", providerRouteRef: "provider-route:one",
  revision: 11, revocation: "active" as const, tenantId: scope.tenantId,
});

const sealedOwner = (owner: OuterContainedTurnProviderAccess): OuterContainedTurnProviderAccess => Object.seal({
  dispatchConsumptionV1: Object.seal({ ...owner.dispatchConsumptionV1 }),
  resolve: Object.seal({ ...owner.resolve }),
  revalidate: Object.seal({ ...owner.revalidate }),
});

const unusedDispatch = Object.freeze({
  async consumeForDispatch() { return Object.freeze({ kind: "not_found" as const }); },
  async observeDispatchConsumption() { return Object.freeze({ kind: "not_found" as const }); },
  async settleDispatchConsumption() { return Object.freeze({ kind: "not_found" as const }); },
});

const staticOwner = (): OuterContainedTurnProviderAccess => {
  const feature = createStaticContainedTurnProviderAccessFeature([{ ...record, kind: "binding" as const }]);
  return Object.freeze({ dispatchConsumptionV1: unusedDispatch, resolve: feature.resolve, revalidate: feature.revalidate });
};

const ownerWithShadowedResolveBind = (bindDescriptor: PropertyDescriptor): OuterContainedTurnProviderAccess => {
  const valid = staticOwner();
  const execute = async (input: Parameters<OuterContainedTurnProviderAccess["resolve"]["execute"]>[0]) =>
    valid.resolve.execute(input);
  Object.defineProperty(execute, "bind", { configurable: false, enumerable: false, ...bindDescriptor });
  Object.freeze(execute);
  return Object.freeze({ ...valid, resolve: Object.freeze({ execute }) });
};

test("real Route C owner resolves, revalidates, observes ambiguous consumption, and settles", async () => {
  const feature = createStaticContainedTurnProviderAccessFeature([{ ...record, kind: "binding" as const }]);
  const acceptedAuthorityDigest = "accepted-authority:one";
  const authorityHeadDigest = "authority-head:one";
  const bindingDigest = "binding-digest:one";
  const scopeDigest = digestContainedTurnCanonicalValue({ scope });
  const harness = createInMemoryContainedTurnDispatchConsumptionV1({
    bindings: [Object.freeze({
      acceptedAuthorityDigest, accessRef: record.accessRef, authorityHeadDigest, bindingDigest,
      bindingRevision: record.revision, claimBeforeControlTime: 100,
      credentialBindingDigest: record.credentialBindingDigest, credentialBindingRef: record.credentialBindingRef,
      credentialGeneration: record.credentialGeneration, expiresAtControlTime: 100,
      opaqueOwnerEvidenceRef: "owner-evidence:one", projectId: scope.projectId, provider: record.provider,
      providerAccountRef: record.providerAccountRef, providerRouteRef: record.providerRouteRef,
      scopeDigest, tenantId: scope.tenantId,
    })],
    initialControlTime: 50,
  });
  let hideFirstConsumption = true;
  const owner = Object.freeze({
    dispatchConsumptionV1: Object.freeze({
      async consumeForDispatch(input: Parameters<OuterContainedTurnProviderAccess["dispatchConsumptionV1"]["consumeForDispatch"]>[0]) {
        const outcome = await harness.access.consumeForDispatch(input);
        if (hideFirstConsumption) { hideFirstConsumption = false; return Object.freeze({ kind: "indeterminate" as const }); }
        return outcome;
      },
      observeDispatchConsumption: harness.access.observeDispatchConsumption.bind(harness.access),
      settleDispatchConsumption: harness.access.settleDispatchConsumption.bind(harness.access),
    }),
    resolve: feature.resolve,
    revalidate: feature.revalidate,
  }) satisfies OuterContainedTurnProviderAccess;
  const port = createContainedTurnProviderAccessPort(owner);
  const accepted = await port.resolveForAcceptance({
    intent: { mode: "analysis", prompt: "Inspect the disposable workspace." }, provider: "codex", scope,
  });
  assert.equal(accepted.kind, "resolved");
  if (accepted.kind !== "resolved") { return; }
  assert.equal((await port.revalidateForDispatch({
    acceptedSnapshot: accepted.snapshot, operationId: "operation:unchanged", scope,
  })).kind, "current");

  const operationId = containedTurnIdentity("operation", "operation:route-c-integration");
  const dispatchBinding = {
    acceptedAuthorityDigest, accessRef: record.accessRef, authorityHeadDigest, bindingDigest,
    bindingRevision: record.revision, credentialBindingDigest: record.credentialBindingDigest,
    credentialBindingRef: record.credentialBindingRef, credentialGeneration: record.credentialGeneration,
    providerAccountRef: record.providerAccountRef, providerRouteRef: record.providerRouteRef,
  };
  const subject = completeContainedTurnDispatchGrantSubject({
    attemptId: containedTurnIdentity("attempt", "attempt:route-c-integration"),
    custodyId: containedTurnIdentity("custody", "custody:route-c-integration"),
    effectId: containedTurnIdentity("effect", "effect:route-c-integration"),
    executionGenerationId: containedTurnIdentity("execution_generation", "execution-generation:route-c-integration"),
    hostBootId: containedTurnIdentity("host_boot", "host-boot:route-c-integration"),
    hostInstanceId: containedTurnIdentity("host_instance", "host-instance:route-c-integration"),
    operationCutoffRevision: 0, operationId,
    preparationToken: containedTurnIdentity("preparation", "preparation:route-c-integration"),
    provider: "codex", providerAccessExpectation: dispatchBinding,
    purpose: "contained_turn_provider_start_v1",
    runtimeSecurityExpectation: {
      acceptedAuthorityDigest: "security-accepted:one", authorityGeneration: "security-generation:one",
      authorityHeadDigest: "security-head:one", authorityRevision: "security-revision:one",
      constraintsDigest: "constraints:one", containmentPolicyDigest: "containment:one",
      providerBindingDigest: "provider-binding:one", providerId: "codex",
    },
    scope, scopeDigest, workspaceId: containedTurnIdentity("workspace", "workspace:route-c-integration"),
  });
  const digests = await createDispatchConsumptionRequestDigests({
    binding: dispatchBinding, grantRequestId: subject.providerAccessRequest.grantRequestId,
    operationId, provider: "codex", purpose: "contained-turn.provider-dispatch/v1",
    scope: { ...scope, scopeDigest },
  });
  assert.equal(subject.providerAccessRequest.claimBindingDigest, digests.claimBindingDigest);
  assert.equal(subject.providerAccessRequest.requestDigest, digests.requestDigest);
  const consumed = await port.consumeForDispatch({ grantRequestId: subject.providerAccessRequest.grantRequestId, subject });
  assert.equal(consumed.kind, "consumed");
  if (consumed.kind !== "consumed") { return; }
  const settlement = await port.settleConsumedGrant({
    disposition: "claim_committed", receipt: consumed.receipt,
    settlementRequestId: containedTurnGrantSettlementRequestId(consumed.receipt, "claim_committed"),
  });
  assert.equal(settlement.kind, "settled");
  assert.equal(harness.control.observeOwnerState({ provider: "codex", scopeDigest }), "claim_committed");
});

test("real Route C revalidation fails closed on drift, revocation, and scope mismatch", async () => {
  let currentRecord: Omit<typeof record, "revocation"> & { revocation: "active" | "revoked" } = record;
  const currentFeature = () => createStaticContainedTurnProviderAccessFeature([
    { ...currentRecord, kind: "binding" as const },
  ]);
  const owner = Object.freeze({
    dispatchConsumptionV1: unusedDispatch,
    resolve: Object.freeze({ async execute(input: Parameters<OuterContainedTurnProviderAccess["resolve"]["execute"]>[0]) {
      return currentFeature().resolve.execute(input);
    } }),
    revalidate: Object.freeze({ async execute(input: Parameters<OuterContainedTurnProviderAccess["revalidate"]["execute"]>[0]) {
      return currentFeature().revalidate.execute(input);
    } }),
  });
  const port = createContainedTurnProviderAccessPort(owner);
  const accepted = await port.resolveForAcceptance({
    intent: { mode: "analysis", prompt: "Inspect the disposable workspace." }, provider: "codex", scope,
  });
  assert.equal(accepted.kind, "resolved");
  if (accepted.kind !== "resolved") { return; }

  currentRecord = { ...record, providerRouteRef: "provider-route:drifted" };
  assert.notEqual((await port.revalidateForDispatch({
    acceptedSnapshot: accepted.snapshot, operationId: "operation:drift", scope,
  })).kind, "current");
  currentRecord = { ...record, revocation: "revoked" };
  assert.notEqual((await port.revalidateForDispatch({
    acceptedSnapshot: accepted.snapshot, operationId: "operation:revoked", scope,
  })).kind, "current");
  currentRecord = record;
  assert.notEqual((await port.revalidateForDispatch({
    acceptedSnapshot: accepted.snapshot, operationId: "operation:scope-mismatch",
    scope: { projectId: "project:other", tenantId: scope.tenantId },
  })).kind, "current");
});

test("Route C construction rejects descriptor, prototype, authority, method, and mutable-shape violations", () => {
  const valid = staticOwner();
  const cases: ReadonlyArray<readonly [unknown, string]> = [
    [Object.freeze({ resolve: valid.resolve, revalidate: valid.revalidate }), "invalid_shape"],
    [Object.freeze({ ...valid, credentialAuthority: Object.freeze({}) }), "invalid_shape"],
    [{ ...valid }, "mutable_shape"],
    [Object.freeze({ ...valid, dispatchConsumptionV1: Object.freeze({
      consumeForDispatch: valid.dispatchConsumptionV1.consumeForDispatch,
      observeDispatchConsumption: valid.dispatchConsumptionV1.observeDispatchConsumption,
    }) }), "invalid_shape"],
    [Object.freeze({ ...valid, dispatchConsumptionV1: Object.freeze({
      observeDispatchConsumption: valid.dispatchConsumptionV1.observeDispatchConsumption,
      settleDispatchConsumption: valid.dispatchConsumptionV1.settleDispatchConsumption,
    }) }), "invalid_shape"],
    [Object.freeze({ ...valid, dispatchConsumptionV1: Object.freeze({
      consumeForDispatch: valid.dispatchConsumptionV1.consumeForDispatch,
      settleDispatchConsumption: valid.dispatchConsumptionV1.settleDispatchConsumption,
    }) }), "invalid_shape"],
    [Object.freeze({ ...valid, dispatchConsumptionV1: Object.freeze({
      consumeForDispatch: valid.dispatchConsumptionV1.consumeForDispatch,
      observeDispatchConsumption: valid.dispatchConsumptionV1.observeDispatchConsumption,
      settleDispatchConsumption: "not a method",
    }) }), "invalid_method"],
    [Object.preventExtensions(Object.defineProperties({}, {
      dispatchConsumptionV1: { enumerable: true, get: () => valid.dispatchConsumptionV1 },
      resolve: { configurable: false, enumerable: true, value: valid.resolve },
      revalidate: { configurable: false, enumerable: true, value: valid.revalidate },
    })), "accessor_backed"],
    [Object.freeze(Object.assign(Object.create({ hiddenAuthority: true }), valid)), "invalid_prototype"],
  ];
  for (const [candidate, diagnostic] of cases) {
    assert.throws(
      () => createContainedTurnProviderAccessPort(candidate as OuterContainedTurnProviderAccess),
      (error: unknown) => error instanceof ProviderAccessRouteCOwnerError &&
        error.code === "ERR_PROVIDER_ACCESS_ROUTE_C_OWNER" && error.diagnostic === diagnostic,
    );
  }
});

test("Route C captures sealed owner methods once and ignores later value mutation", async () => {
  let originalDispatchCalls = 0;
  const base = staticOwner();
  const original = Object.freeze({ ...base, dispatchConsumptionV1: Object.freeze({
    ...base.dispatchConsumptionV1,
    async consumeForDispatch() { originalDispatchCalls += 1; return Object.freeze({ kind: "not_found" as const }); },
  }) });
  const mutable = sealedOwner(original);
  const port = createContainedTurnProviderAccessPort(mutable);
  mutable.resolve.execute = async () => { throw new Error("mutated authority must not run"); };
  (mutable as unknown as { revalidate: OuterContainedTurnProviderAccess["revalidate"] }).revalidate =
    Object.seal({ async execute() { throw new Error("replacement authority must not run"); } });
  mutable.dispatchConsumptionV1.consumeForDispatch = async () => { throw new Error("mutated dispatch must not run"); };
  const accepted = await port.resolveForAcceptance({
    intent: { mode: "analysis", prompt: "Inspect." }, provider: "codex", scope,
  });
  assert.equal(accepted.kind, "resolved");
  if (accepted.kind === "resolved") {
    assert.equal((await port.revalidateForDispatch({
      acceptedSnapshot: accepted.snapshot, operationId: "operation:snapshot", scope,
    })).kind, "current");
  }
  const snapshotScopeDigest = digestContainedTurnCanonicalValue({ scope });
  const subject = completeContainedTurnDispatchGrantSubject({
    attemptId: containedTurnIdentity("attempt", "attempt:route-c-snapshot"),
    custodyId: containedTurnIdentity("custody", "custody:route-c-snapshot"),
    effectId: containedTurnIdentity("effect", "effect:route-c-snapshot"),
    executionGenerationId: containedTurnIdentity("execution_generation", "execution-generation:route-c-snapshot"),
    hostBootId: containedTurnIdentity("host_boot", "host-boot:route-c-snapshot"),
    hostInstanceId: containedTurnIdentity("host_instance", "host-instance:route-c-snapshot"),
    operationCutoffRevision: 0, operationId: containedTurnIdentity("operation", "operation:route-c-snapshot"),
    preparationToken: containedTurnIdentity("preparation", "preparation:route-c-snapshot"),
    provider: "codex",
    providerAccessExpectation: {
      acceptedAuthorityDigest: "accepted:snapshot", accessRef: record.accessRef,
      authorityHeadDigest: "head:snapshot", bindingDigest: "binding:snapshot", bindingRevision: record.revision,
      credentialBindingDigest: record.credentialBindingDigest, credentialBindingRef: record.credentialBindingRef,
      credentialGeneration: record.credentialGeneration, providerAccountRef: record.providerAccountRef,
      providerRouteRef: record.providerRouteRef,
    },
    purpose: "contained_turn_provider_start_v1",
    runtimeSecurityExpectation: {
      acceptedAuthorityDigest: "security-accepted:snapshot", authorityGeneration: "security-generation:snapshot",
      authorityHeadDigest: "security-head:snapshot", authorityRevision: "security-revision:snapshot",
      constraintsDigest: "constraints:snapshot", containmentPolicyDigest: "containment:snapshot",
      providerBindingDigest: "provider-binding:snapshot", providerId: "codex",
    },
    scope, scopeDigest: snapshotScopeDigest,
    workspaceId: containedTurnIdentity("workspace", "workspace:route-c-snapshot"),
  });
  assert.equal((await port.consumeForDispatch({
    grantRequestId: subject.providerAccessRequest.grantRequestId, subject,
  })).kind, "indeterminate");
  assert.equal(originalDispatchCalls, 1);
});

test("frozen Route C owners reject shadowed bind without leaking attacker failures or publishing", () => {
  const secretObject = Object.freeze({ authority: "route-c-object-secret" });
  const secretError = Object.assign(new Error("route-c-error-secret", { cause: secretObject }), {
    authority: "route-c-error-custom-secret",
  });
  const mutableDelegate = Object.assign(() => undefined, { authority: "mutable-delegate" });
  let returnedDelegateCalls = 0;
  let returnedNonFunctionCalls = 0;
  let thrownObjectCalls = 0;
  let thrownErrorCalls = 0;
  let getterCalls = 0;
  const cases = [
    {
      bindDescriptor: { value() { returnedDelegateCalls += 1; return mutableDelegate; }, writable: false },
      calls: () => returnedDelegateCalls,
    },
    {
      bindDescriptor: { value() { returnedNonFunctionCalls += 1; return "not-callable"; }, writable: false },
      calls: () => returnedNonFunctionCalls,
    },
    {
      bindDescriptor: { value() {
        thrownObjectCalls += 1;
        // oxlint-disable-next-line no-throw-literal -- the boundary must contain arbitrary attacker-thrown values.
        throw secretObject;
      }, writable: false },
      calls: () => thrownObjectCalls,
    },
    {
      bindDescriptor: { value() { thrownErrorCalls += 1; throw secretError; }, writable: false },
      calls: () => thrownErrorCalls,
    },
    {
      bindDescriptor: { get() { getterCalls += 1; throw secretError; } },
      calls: () => getterCalls,
    },
  ] satisfies ReadonlyArray<{ bindDescriptor: PropertyDescriptor; calls(): number }>;

  for (const { bindDescriptor, calls } of cases) {
    const owner = ownerWithShadowedResolveBind(bindDescriptor);
    let downstreamReads = 0;
    const dependencies = Object.defineProperties({}, {
      providerAccess: { enumerable: true, value: owner },
      operationStore: { get() { downstreamReads += 1; } },
      security: { get() { downstreamReads += 1; } },
      workspace: { get() { downstreamReads += 1; } },
      artifacts: { get() { downstreamReads += 1; } },
      custody: { get() { downstreamReads += 1; } },
      provider: { get() { downstreamReads += 1; } },
    });
    let published: unknown;
    let rejection: unknown;
    assert.throws(() => {
      published = createContainedTurnFeatureFromProviderAccess(dependencies as never);
    }, (error: unknown) => {
      rejection = error;
      return error instanceof ProviderAccessRouteCOwnerError &&
        error.code === "ERR_PROVIDER_ACCESS_ROUTE_C_OWNER" && error.diagnostic === "invalid_method";
    });
    assert.ok(rejection instanceof ProviderAccessRouteCOwnerError);
    assert.equal(rejection.message, "Provider Access Route C owner rejected: invalid_method");
    assert.deepEqual(
      Object.getOwnPropertyNames(rejection).filter(key => key !== "stack").toSorted(),
      ["code", "diagnostic", "message", "name"],
    );
    assert.equal("cause" in rejection, false);
    assert.notEqual(rejection, secretObject);
    assert.notEqual(rejection, secretError);
    assert.doesNotMatch(`${rejection.name}:${rejection.message}:${JSON.stringify(rejection)}`, /secret|mutable-delegate/);
    assert.equal(calls(), 0);
    assert.equal(downstreamReads, 0);
    assert.equal(published, undefined);
  }
});

test("missing dispatch fails before seven-port factory reads or handle publication", () => {
  const valid = staticOwner();
  const missingDispatch = Object.freeze({ resolve: valid.resolve, revalidate: valid.revalidate });
  let downstreamReads = 0;
  const dependencies = Object.defineProperties({}, {
    providerAccess: { enumerable: true, value: missingDispatch },
    operationStore: { get() { downstreamReads += 1; } },
    security: { get() { downstreamReads += 1; } },
    workspace: { get() { downstreamReads += 1; } },
    artifacts: { get() { downstreamReads += 1; } },
    custody: { get() { downstreamReads += 1; } },
    provider: { get() { downstreamReads += 1; } },
  });
  let published: unknown;
  assert.throws(() => {
    published = createContainedTurnFeatureFromProviderAccess(dependencies as never);
  }, (error: unknown) => error instanceof ProviderAccessRouteCOwnerError && error.diagnostic === "invalid_shape");
  assert.equal(downstreamReads, 0);
  assert.equal(published, undefined);
});
