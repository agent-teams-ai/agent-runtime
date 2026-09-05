import assert from "node:assert/strict";
import {test} from "node:test";
import type {AuthorizeCredentialMaterializationInput, CredentialMaterializationAuthorizationV1} from "@agent-teams/provider-access";
import {createCredentialMaterializationRequestDigest, createInMemoryContainedTurnDispatchConsumptionV1,
  type InMemoryDispatchBindingSeed} from "@agent-teams/provider-access/composition";
import {createContainedTurnHttpProviderAccessAuthorization, type ContainedTurnHttpProviderAccessOwner} from "../dist/composition/contained-turn-http-provider-access.js";

const seed: InMemoryDispatchBindingSeed = Object.freeze({acceptedAuthorityDigest: "accepted:1", accessRef: "access:1",
  authorityHeadDigest: "authority:1", bindingDigest: "binding:1", bindingRevision: 2, claimBeforeControlTime: 1000,
  credentialBindingDigest: "pa:original-digest", credentialBindingRef: "credential:1", credentialGeneration: 3,
  expiresAtControlTime: 1000, opaqueOwnerEvidenceRef: "evidence:1", projectId: "project:1", provider: "codex",
  providerAccountRef: "account:1", providerRouteRef: "route:1", scopeDigest: "scope:1", tenantId: "tenant:1"});
const unsigned = (overrides: Partial<AuthorizeCredentialMaterializationInput> = {}) => ({accessRef: seed.accessRef,
  authorizationRequestId: "authorization:1", availability: "available" as const, bindingRevision: seed.bindingRevision,
  credentialBindingDigest: seed.credentialBindingDigest, credentialBindingRef: seed.credentialBindingRef,
  credentialGeneration: seed.credentialGeneration, projectId: seed.projectId, provider: seed.provider,
  providerAccountRef: seed.providerAccountRef, providerRouteRef: seed.providerRouteRef,
  purpose: "contained-turn.credential-materialization-authorization/v1" as const, revocation: "active" as const,
  schemaVersion: 1 as const, scopeDigest: seed.scopeDigest, tenantId: seed.tenantId, ...overrides});
const request = async (overrides: Partial<AuthorizeCredentialMaterializationInput> = {}) => {
  const input = unsigned(overrides);
  return {...input, requestDigest: await createCredentialMaterializationRequestDigest(input)};
};
const selector = (input: AuthorizeCredentialMaterializationInput) => ({authorizationRequestId: input.authorizationRequestId,
  projectId: input.projectId, provider: input.provider, requestDigest: input.requestDigest, scopeDigest: input.scopeDigest, tenantId: input.tenantId});
const fixture = () => {
  const harness = createInMemoryContainedTurnDispatchConsumptionV1({bindings: [seed], initialControlTime: 10});
  const owner = {authorization: harness.materialization, createRequestDigest: createCredentialMaterializationRequestDigest};
  return {harness, owner, adapter: createContainedTurnHttpProviderAccessAuthorization(owner)};
};

test("composes the PA application and preserves one-shot authorization under concurrency", async () => {
  const {adapter} = fixture(); const input = await request();
  assert.equal(await adapter.createRequestDigest(unsigned()), input.requestDigest);
  const outcomes = await Promise.all(Array.from({length: 20}, () => adapter.authorize(input)));
  assert.equal(outcomes.filter(value => value.kind === "authorized").length, 1);
  assert.equal(outcomes.filter(value => value.kind === "observed").length, 19);
  const observed = await adapter.observe(selector(input));
  assert.equal(observed.kind, "observed");
  if (observed.kind !== "observed") {throw new Error("missing receipt");}
  assert.equal(observed.receipt.credentialBindingDigest, "pa:original-digest");
  assert.ok(Object.isFrozen(observed)); assert.ok(Object.isFrozen(observed.receipt));
});

test("reobserves current PA authority and does not reuse a receipt after revocation", async () => {
  const {adapter, harness} = fixture(); const input = await request();
  assert.equal((await adapter.authorize(input)).kind, "authorized");
  await harness.control.replaceBindingHead({...seed, revocation: "revoked"});
  for (const value of [await adapter.authorize(input), await adapter.observe(selector(input))]) {
    assert.equal(value.kind, "rejected");
    if (value.kind !== "rejected") {throw new Error("missing rejection");}
    assert.equal(value.receipt.decision, "authorized"); assert.equal(value.receipt.rejectionReason, null);
  }
});

test("keeps PA and normalized AE digests distinct and preserves owner-scoped absence", async () => {
  const {adapter} = fixture();
  const wrongDigest = await request({credentialBindingDigest: "ae:normalized-different-digest"});
  const denied = await adapter.authorize(wrongDigest);
  assert.equal(denied.kind, "rejected");
  if (denied.kind !== "rejected") {throw new Error("missing rejection");}
  assert.equal(denied.receipt.rejectionReason, "credential_binding_changed");
  const input = await request({authorizationRequestId: "authorization:2"});
  assert.equal((await adapter.authorize(input)).kind, "authorized");
  for (const change of [{tenantId: "tenant:other"}, {projectId: "project:other"}, {scopeDigest: "scope:other"}, {provider: "claude" as const}]) {
    assert.deepEqual(await adapter.observe({...selector(input), ...change}), {kind: "indeterminate"});
  }
});

test("maps conflicts, invalid and unsupported decisions without creating fresh authority", async () => {
  const {adapter} = fixture(); const input = await request();
  await adapter.authorize(input);
  assert.deepEqual(await adapter.authorize(await request({credentialGeneration: 4})), {kind: "conflict"});
  assert.deepEqual(await adapter.authorize({...input, authorizationRequestId: "new", requestDigest: "invalid"}), {kind: "invalid"});
  assert.deepEqual(await adapter.authorize({...input, schemaVersion: 2} as never), {kind: "unsupported"});
});

test("captures owner capabilities once without calling them during construction", async () => {
  const f = fixture(); let authorizations = 0; let observations = 0; let digests = 0;
  const owner = {authorization: {
    async authorize(input: AuthorizeCredentialMaterializationInput) {authorizations++; return f.owner.authorization.authorize(input);},
    async observe(input: Parameters<CredentialMaterializationAuthorizationV1["observe"]>[0]) {observations++; return f.owner.authorization.observe(input);},
  }, async createRequestDigest(input: Parameters<typeof createCredentialMaterializationRequestDigest>[0]) {digests++; return createCredentialMaterializationRequestDigest(input);}};
  const adapter = createContainedTurnHttpProviderAccessAuthorization(owner);
  assert.deepEqual([authorizations, observations, digests], [0, 0, 0]);
  owner.authorization.authorize = async () => {throw new Error("replacement");};
  owner.authorization.observe = async () => {throw new Error("replacement");};
  owner.createRequestDigest = async () => {throw new Error("replacement");};
  const input = {...unsigned(), requestDigest: await adapter.createRequestDigest(unsigned())};
  assert.equal((await adapter.authorize(input)).kind, "authorized");
  assert.equal((await adapter.observe(selector(input))).kind, "observed");
  assert.deepEqual([authorizations, observations, digests], [1, 1, 1]);
});

test("rejects proxy, accessor, inherited, symbol and extra owner capabilities without effects", () => {
  const {owner} = fixture(); let effects = 0;
  const effect = () => {effects++; throw new Error("must not execute");};
  const cases: unknown[] = [null, Object.create(owner), {...owner, extra: true}, {...owner, [Symbol("extra")]: true},
    new Proxy(owner, {get: effect, ownKeys: effect, getPrototypeOf: effect}),
    Object.defineProperty({...owner}, "authorization", {get: effect}),
    {...owner, authorization: Object.defineProperty({}, "authorize", {get: effect, enumerable: true})},
    {...owner, authorization: {...owner.authorization, authorize: new Proxy(owner.authorization.authorize, {apply: effect})}},
    {...owner, createRequestDigest: owner.createRequestDigest.bind(null)}];
  for (const value of cases) {assert.throws(() => createContainedTurnHttpProviderAccessAuthorization(value as ContainedTurnHttpProviderAccessOwner), /Invalid HTTP Provider Access owner/u);}
  assert.equal(effects, 0);
});

test("malformed inputs cannot invoke the PA owner or digest capability", async () => {
  let calls = 0;
  const adapter = createContainedTurnHttpProviderAccessAuthorization({authorization: {
    async authorize() {calls++; return {kind: "indeterminate"};}, async observe() {calls++; return {kind: "indeterminate"};},
  }, async createRequestDigest() {calls++; return "unused";}});
  let traps = 0; const input = await request();
  const bad = new Proxy(input, {ownKeys() {traps++; return Reflect.ownKeys(input);}});
  assert.deepEqual(await adapter.authorize(bad), {kind: "indeterminate"});
  assert.deepEqual(await adapter.observe({...selector(input), extra: "unexpected"} as never), {kind: "indeterminate"});
  await assert.rejects(adapter.createRequestDigest({...unsigned(), nested: {value: "unknown"}} as never), /digest unavailable/u);
  assert.equal(calls, 0); assert.equal(traps, 0);
});

test("rejects non-async capabilities before they can create rejected foreign Promises", () => {
  let calls = 0; let hooks = 0;
  class ForeignPromise<T> extends Promise<T> {}
  const producers = [
    () => Promise.reject(new Error("owner diagnostic")),
    // oxlint-disable-next-line unicorn/no-thenable -- Invalid owner must be rejected before this Promise or hook is created.
    () => Object.defineProperty(Promise.reject(new Error("owner diagnostic")), "then", {
      get() {hooks++; throw new Error("owner then hook");},
    }),
    () => Object.defineProperty(Promise.reject(new Error("owner diagnostic")), "constructor", {
      get() {hooks++; throw new Error("owner constructor hook");},
    }),
    () => ForeignPromise.reject(new Error("owner diagnostic")),
  ];
  for (const produce of producers) {
    const invalid = () => {calls++; return produce();};
    for (const capability of ["authorize", "observe", "createRequestDigest"] as const) {
      const {owner} = fixture();
      const candidate = capability === "createRequestDigest" ? {...owner, createRequestDigest: invalid} :
        {...owner, authorization: {...owner.authorization, [capability]: invalid}};
      assert.throws(() => createContainedTurnHttpProviderAccessAuthorization(candidate), /Invalid HTTP Provider Access owner/u);
    }
  }
  assert.equal(calls, 0); assert.equal(hooks, 0);
});

test("rejects async generators and forged async tags without executing capabilities", () => {
  let calls = 0;
  // Async generators also satisfy node:util types.isAsyncFunction, but return iterators.
  async function* generator() {calls++; yield "unused";}
  const forged = Object.assign(() => {calls++; return Promise.resolve("unused");}, {[Symbol.toStringTag]: "AsyncFunction"});
  for (const invalid of [generator, forged]) {
    const {owner} = fixture();
    assert.throws(() => createContainedTurnHttpProviderAccessAuthorization({...owner, createRequestDigest: invalid as never}), /Invalid HTTP Provider Access owner/u);
  }
  assert.equal(calls, 0);
});

test("detaches receipts and sanitizes thrown, malformed and contradictory owner results", async () => {
  const input = await request(); const valid = {...input, decision: "authorized" as const, rejectionReason: null};
  let result: unknown = {kind: "authorized", receipt: valid}; let effects = 0;
  const adapter = createContainedTurnHttpProviderAccessAuthorization({authorization: {
    async authorize() {return result as never;}, async observe() {return result as never;},
  }, createRequestDigest: createCredentialMaterializationRequestDigest});
  const retained = await adapter.authorize(input); assert.equal(retained.kind, "authorized");
  if (retained.kind !== "authorized") {throw new Error("missing authorized receipt");}
  valid.credentialBindingDigest = "later-mutation";
  assert.equal(retained.receipt.credentialBindingDigest, input.credentialBindingDigest);
  const effect = () => {effects++; throw new Error("secret-owner-diagnostic");};
  const cases = [null, {kind: "authorized", receipt: {...valid, extra: true}},
    {kind: "authorized", receipt: {...valid, decision: "rejected", rejectionReason: "revoked"}},
    {kind: "rejected", reason: "invented", receipt: valid},
    {kind: "observed", receipt: {...valid, credentialGeneration: NaN}},
    {kind: "unsupported", reason: "made_up"}, {kind: "indeterminate", extra: "secret"},
    new Proxy({}, {ownKeys: effect, get(_target, key) {if (key === "then") {return;} return effect();}}),
    Object.defineProperty({kind: "authorized"}, "receipt", {get: effect, enumerable: true})];
  for (result of cases) {assert.deepEqual(await adapter.authorize(input), {kind: "indeterminate"});}
  result = {kind: "authorized", receipt: valid};
  assert.deepEqual(await adapter.observe(selector(input)), {kind: "indeterminate"});
  assert.equal(effects, 0);
  const throwing = createContainedTurnHttpProviderAccessAuthorization({authorization: {
    async authorize() {throw new Error("secret-owner-diagnostic");}, async observe() {throw new Error("secret-owner-diagnostic");},
  }, async createRequestDigest() {throw new Error("secret-owner-diagnostic");}});
  assert.deepEqual(await throwing.authorize(input), {kind: "indeterminate"});
  assert.deepEqual(await throwing.observe(selector(input)), {kind: "indeterminate"});
  await assert.rejects(throwing.createRequestDigest(unsigned()), /^TypeError: HTTP Provider Access request digest unavailable$/u);
});
