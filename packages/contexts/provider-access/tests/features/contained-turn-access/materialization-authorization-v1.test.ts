import assert from "node:assert/strict";
import test from "node:test";

import type {
  AuthorizeCredentialMaterializationInput, ObserveCredentialMaterializationAuthorizationInput,
} from "../../../dist/index.js";
import {
  createCredentialMaterializationRequestDigest, createInMemoryContainedTurnDispatchConsumptionV1,
} from "../../../dist/composition.js";
import { createContainedTurnCredentialMaterializationAuthorizationV1 } from
  "../../../dist/features/contained-turn-access/composition/materialization-authorization-v1-factory.js";
import { createSha256DispatchConsumptionDigest } from
  "../../../dist/features/contained-turn-access/adapters/outbound/sha256-dispatch-consumption-digest.js";
import type {
  MaterializationAuthorizationBinding, MaterializationAuthorizationRepository,
} from "../../../dist/features/contained-turn-access/application/ports/outbound/materialization-authorization-repository.js";
import type { AuthorizationRecord } from
  "../../../dist/features/contained-turn-access/domain/materialization-authorization.js";
import { seed } from "./dispatch-consumption-test-fixture.ts";

const unsignedRequest = (overrides: Partial<Omit<AuthorizeCredentialMaterializationInput, "requestDigest">> = {}) => ({
  accessRef: "access:1", authorizationRequestId: "authorization-request:1", availability: "available" as const,
  bindingRevision: 1, credentialBindingDigest: "credential:digest:1", credentialBindingRef: seed().credentialBindingRef,
  credentialGeneration: 1, projectId: "project:1", provider: "codex" as const, providerAccountRef: "account:1",
  providerRouteRef: "route:1", purpose: "contained-turn.credential-materialization-authorization/v1" as const,
  revocation: "active" as const, schemaVersion: 1 as const, scopeDigest: "scope:digest:1", tenantId: "tenant:1",
  ...overrides,
});
const requestFor = async (
  overrides: Partial<Omit<AuthorizeCredentialMaterializationInput, "requestDigest">> = {},
): Promise<AuthorizeCredentialMaterializationInput> => {
  const unsigned = unsignedRequest(overrides);
  return Object.freeze({...unsigned, requestDigest: await createCredentialMaterializationRequestDigest(unsigned)});
};
const observationFor = (request: AuthorizeCredentialMaterializationInput): ObserveCredentialMaterializationAuthorizationInput => ({
  authorizationRequestId: request.authorizationRequestId, projectId: request.projectId, provider: request.provider,
  requestDigest: request.requestDigest, scopeDigest: request.scopeDigest, tenantId: request.tenantId,
});
const harnessFor = () => createInMemoryContainedTurnDispatchConsumptionV1({bindings: [seed()], initialControlTime: 100});

test("authorization is one-shot under concurrency and exact replay only observes", async () => {
  const harness = harnessFor();
  const request = await requestFor();
  const outcomes = await Promise.all(Array.from({length: 40}, () => harness.materialization.authorize(request)));
  assert.equal(outcomes.filter(outcome => outcome.kind === "authorized").length, 1);
  assert.equal(outcomes.filter(outcome => outcome.kind === "observed").length, 39);
  const authorized = outcomes.find(outcome => outcome.kind === "authorized");
  assert.ok(authorized?.kind === "authorized");
  if (authorized?.kind !== "authorized") {return;}
  assert.ok(Object.isFrozen(authorized));
  assert.ok(Object.isFrozen(authorized.receipt));
  assert.deepEqual(Object.keys(authorized.receipt).toSorted(), [
    "accessRef", "authorizationRequestId", "availability", "bindingRevision", "credentialBindingDigest",
    "credentialBindingRef", "credentialGeneration", "decision", "projectId", "provider", "providerAccountRef",
    "providerRouteRef", "purpose", "rejectionReason", "requestDigest", "revocation", "schemaVersion", "scopeDigest", "tenantId",
  ]);
  assert.equal(authorized.receipt.decision, "authorized");
  assert.equal(authorized.receipt.rejectionReason, null);
  assert.equal(/operation|effect|attempt|execution|host|custody|install|cleanup|quarantine|reconcil/iu.test(
    Object.keys(authorized.receipt).join(" "),
  ), false);
});

test("same-owner request identity conflicts for every changed closed payload field", async () => {
  const changes = [
    ["accessRef", "access:2"], ["availability", "unavailable"], ["bindingRevision", 2],
    ["credentialBindingDigest", "credential:digest:2"], ["credentialBindingRef", "credential:ref:2"],
    ["credentialGeneration", 2], ["providerAccountRef", "account:2"], ["providerRouteRef", "route:2"],
    ["revocation", "revoked"],
  ] as const;
  for (const [field, value] of changes) {
    const harness = harnessFor();
    const original = await requestFor();
    assert.equal((await harness.materialization.authorize(original)).kind, "authorized");
    const changed = await requestFor({[field]: value});
    assert.deepEqual(await harness.materialization.authorize(changed), {
      kind: "conflict", reason: "authorization_request_digest_conflict",
    }, field);
  }
  const harness = harnessFor();
  const original = await requestFor();
  assert.equal((await harness.materialization.authorize(original)).kind, "authorized");
  assert.deepEqual(await harness.materialization.authorize({...original, requestDigest: "sha256:forged"}), {
    kind: "conflict", reason: "authorization_request_digest_conflict",
  });
});

test("missing and foreign request identities are publicly indistinguishable", async () => {
  const harness = harnessFor();
  const request = await requestFor();
  assert.equal((await harness.materialization.authorize(request)).kind, "authorized");
  const absent = await harness.materialization.observe({...observationFor(request), authorizationRequestId: "authorization-request:absent"});
  for (const change of [
    {tenantId: "tenant:foreign"}, {projectId: "project:foreign"}, {scopeDigest: "scope:foreign"},
    {provider: "claude" as const},
  ]) {
    const foreignObservation = {...observationFor(request), ...change};
    assert.deepEqual(await harness.materialization.observe(foreignObservation), absent);
    const foreignRequest = await requestFor({...change, requestDigest: undefined} as never);
    assert.deepEqual(await harness.materialization.authorize(foreignRequest), {kind: "indeterminate"});
  }
  assert.deepEqual(absent, {kind: "indeterminate"});
  assert.equal((await harness.materialization.observe(observationFor(request))).kind, "observed");
});

test("a foreign attempt cannot consume or replace canonical owner authority", async () => {
  const harness = harnessFor();
  const canonical = await requestFor();
  const foreign = await requestFor({projectId: "project:foreign"});
  assert.equal((await harness.materialization.authorize(canonical)).kind, "authorized");
  assert.deepEqual(await harness.materialization.authorize(foreign), {kind: "indeterminate"});
  assert.equal((await harness.materialization.observe(observationFor(canonical))).kind, "observed");
});

test("every Provider Access binding drift produces a final rejection ledger entry", async () => {
  const cases = [
    [{accessRef: "access:2"}, "access_changed"], [{providerAccountRef: "account:2"}, "account_changed"],
    [{providerRouteRef: "route:2"}, "route_changed"], [{bindingRevision: 2}, "binding_revision_changed"],
    [{credentialBindingDigest: "credential:digest:2"}, "credential_binding_changed"],
    [{credentialBindingRef: "credential:ref:2"}, "credential_binding_changed"],
    [{credentialGeneration: 2}, "credential_generation_changed"],
    [{availability: "unavailable" as const}, "availability_changed"], [{revocation: "revoked" as const}, "revoked"],
  ] as const;
  for (const [change, reason] of cases) {
    const harness = harnessFor();
    await harness.control.replaceBindingHead(seed(change));
    const outcome = await harness.materialization.authorize(await requestFor());
    assert.equal(outcome.kind, "rejected", reason);
    if (outcome.kind === "rejected") {
      assert.equal(outcome.reason, reason); assert.equal(outcome.receipt.decision, "rejected");
      assert.equal(outcome.receipt.rejectionReason, reason);
    }
  }
});

test("inputs are exact, bounded and return typed invalid or unsupported outcomes", async () => {
  const harness = harnessFor();
  const request = await requestFor();
  for (const input of [
    {...request, path: "/tmp/provider-home"}, {...request, accessRef: new String("access:1")},
    {...request, credentialBindingRef: "x".repeat(513)}, {...request, requestDigest: "sha256:forged"},
  ]) {
    assert.deepEqual(await harness.materialization.authorize(input as never), {kind: "invalid", reason: "invalid_request"});
  }
  const accessor = {...request} as Record<string, unknown>;
  Object.defineProperty(accessor, "accessRef", {enumerable: true, get: () => "access:1"});
  assert.deepEqual(await harness.materialization.authorize(accessor as never), {kind: "invalid", reason: "invalid_request"});
  assert.deepEqual(await harness.materialization.authorize({...request, provider: "unknown"} as never), {
    kind: "unsupported", reason: "unsupported_provider",
  });
  assert.deepEqual(await harness.materialization.authorize({...request, schemaVersion: 2} as never), {
    kind: "unsupported", reason: "unsupported_version",
  });
  assert.deepEqual(await harness.materialization.observe({...observationFor(request), provider: "unknown"} as never), {
    kind: "unsupported", reason: "unsupported_provider",
  });
});

const binding: MaterializationAuthorizationBinding = Object.freeze({
  accessRef: "access:1", availability: "available", bindingRevision: 1, credentialBindingDigest: "credential:digest:1",
  credentialBindingRef: seed().credentialBindingRef, credentialGeneration: 1, projectId: "project:1", provider: "codex",
  providerAccountRef: "account:1", providerRouteRef: "route:1", revocation: "active", scopeDigest: "scope:digest:1", tenantId: "tenant:1",
});
const repositoryFixture = (currentBinding = binding) => {
  let saved: AuthorizationRecord | undefined;
  const repository: MaterializationAuthorizationRepository = {
    async observeAuthorizationRequest() {return saved;},
    async transact(_selector, work) {
      return work(Object.freeze({
        async findAuthorizationRequest() {return saved;}, async findBinding() {return currentBinding;},
        async saveAuthorization(record: AuthorizationRecord) {saved = record;},
      }));
    },
  };
  return {repository, saved: () => saved};
};

test("composition rejects dependency bags, accessors, proxies and hidden authority", () => {
  const digest = createSha256DispatchConsumptionDigest();
  const {repository} = repositoryFixture();
  const invalid: unknown[] = [
    {digest, repository, extra: true},
    new Proxy({digest, repository}, {}),
    {digest: {...digest, extra: () => null}, repository},
    {digest, repository: {...repository, extra: () => null}},
  ];
  const accessor = {repository} as Record<string, unknown>;
  Object.defineProperty(accessor, "digest", {enumerable: true, get: () => digest});
  invalid.push(accessor);
  for (const dependencies of invalid) {
    assert.throws(() => createContainedTurnCredentialMaterializationAuthorizationV1(dependencies as never), TypeError);
  }
});

test("composition captures methods once and public DTOs are detached fresh frozen projections", async () => {
  const digest = {...createSha256DispatchConsumptionDigest()};
  const fixture = repositoryFixture();
  const api = createContainedTurnCredentialMaterializationAuthorizationV1({digest, repository: fixture.repository});
  const originalDigest = digest.digest;
  const originalTransact = fixture.repository.transact;
  digest.digest = (() => {throw new Error("replacement digest called");}) as never;
  fixture.repository.transact = (() => {throw new Error("replacement repository called");}) as never;
  const request = await requestFor();
  const outcome = await api.authorize(request);
  assert.equal(outcome.kind, "authorized");
  if (outcome.kind !== "authorized") {return;}
  assert.notEqual(outcome.receipt, fixture.saved());
  assert.ok(Object.isFrozen(outcome.receipt));
  const observed = await api.observe(observationFor(request));
  assert.equal(observed.kind, "observed");
  if (observed.kind === "observed") {
    assert.notEqual(observed.receipt, outcome.receipt);
    assert.notEqual(observed.receipt, fixture.saved());
    assert.ok(Object.isFrozen(observed.receipt));
  }
  digest.digest = originalDigest;
  fixture.repository.transact = originalTransact;
});

test("inbound input is snapped before asynchronous work and proxy DTOs fail closed", async () => {
  const harness = harnessFor();
  const request = {...await requestFor()};
  const pending = harness.materialization.authorize(request);
  request.accessRef = "access:mutated";
  assert.equal((await pending).kind, "authorized");
  const proxy = new Proxy(await requestFor({authorizationRequestId: "authorization-request:proxy"}), {});
  assert.deepEqual(await harness.materialization.authorize(proxy), {kind: "invalid", reason: "invalid_request"});
});

test("a substituted binding from another owner cannot authorize or write a receipt", async () => {
  for (const change of [
    {tenantId: "tenant:foreign"}, {projectId: "project:foreign"}, {scopeDigest: "scope:foreign"},
    {provider: "claude" as const},
  ]) {
    const fixture = repositoryFixture({...binding, ...change});
    const api = createContainedTurnCredentialMaterializationAuthorizationV1({
      digest: createSha256DispatchConsumptionDigest(), repository: fixture.repository,
    });
    assert.deepEqual(await api.authorize(await requestFor()), {kind: "indeterminate"});
    assert.equal(fixture.saved(), undefined);
  }
});

test("a retained transaction callback cannot run after the repository returns or rejects", async () => {
  for (const throws of [false, true]) {
    let replay: (() => Promise<unknown>) | undefined;
    let writes = 0;
    const repository: MaterializationAuthorizationRepository = {
      async observeAuthorizationRequest() {return;},
      async transact(_selector, work) {
        replay = () => work({
          async findAuthorizationRequest() {return;},
          async findBinding() {return binding;},
          async saveAuthorization() {writes += 1;},
        });
        if (throws) {throw new Error("repository failure");}
        return undefined as never;
      },
    };
    const api = createContainedTurnCredentialMaterializationAuthorizationV1({
      digest: createSha256DispatchConsumptionDigest(), repository,
    });
    assert.deepEqual(await api.authorize(await requestFor()), {kind: "indeterminate"});
    assert.ok(replay);
    await assert.rejects(replay(), TypeError);
    await assert.rejects(replay(), TypeError);
    assert.equal(writes, 0);
  }
});
