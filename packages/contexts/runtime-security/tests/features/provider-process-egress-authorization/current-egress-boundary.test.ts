import assert from "node:assert/strict";
import { test } from "node:test";
import { createCurrentEgressOwner } from
  "../../../dist/features/provider-process-egress-authorization/composition/current-egress-owner.js";
import { approve, changed, current, deferred, digest, fixture, resolveInput, scope } from
  "./current-egress-owner.fixture.ts";

test("construction is inert and snapshots data and callback identities once", async t => {
  const { input, state } = fixture();
  const dependencies = { ...input, readRsHead: async () => state.head,
    readPaEndorsement: async () => state.pa };
  const owner = createCurrentEgressOwner(dependencies); t.after(() => owner.dispose());
  assert.equal(state.clockReads, 0); assert.deepEqual(state.calls, []);
  dependencies.readRsHead = async () => {throw new Error("replacement must not be called");};
  dependencies.readPaEndorsement = async () => {throw new Error("replacement must not be called");};
  Object.assign(input.rule.limits, { responseBytes: 1 });
  Object.assign(input.rule.route.origin, { hostname: "mutated.example.com" });
  Object.assign(input.operation.scope, { operationId: "mutated" });
  Object.assign(input.approval, { bindingDigest: digest("mutated") });
  const authority = await current(owner);
  assert.equal(authority.policy.limits.responseBytes, 8192);
  assert.equal(authority.policy.origin.hostname, "api.example.com");
  assert.equal(Object.isFrozen(authority.providerAccess), true);
});

test("a request is captured before waiting for a borrowed read", async t => {
  const { input, state } = fixture(); const gate = deferred<typeof state.head>(); let reads = 0;
  const owner = createCurrentEgressOwner({ ...input,
    readRsHead: async () => ++reads === 1 ? gate.promise : Promise.resolve(state.head) }); t.after(() => owner.dispose());
  const raw = resolveInput(); const originalDigest = raw.request.body.digest;
  const pending = owner.resolvePolicy(raw);
  raw.request.body.digest = digest("mutation-after-call"); raw.authorizationRequestId = "changed";
  raw.request.requestTarget.byteLength = 100;
  gate.resolve(state.head);
  const outcome = await pending; assert.equal(outcome.status, "current");
  assert.notEqual(raw.request.body.digest, originalDigest);
  if (outcome.status !== "current") {throw new Error("Expected authorized fixture result");}
  assert.equal((await owner.readCurrent({ scope: scope(), authorityRef: outcome.authority.authorityRef })).status, "current");
});

test("proxy/accessor/symbol/prototype boundaries are rejected without evaluating them", async t => {
  const { input } = fixture(); let traps = 0;
  const handler = { get() {traps += 1; throw new Error("get trap");},
    ownKeys() {traps += 1; throw new Error("keys trap");},
    getPrototypeOf() {traps += 1; throw new Error("prototype trap");} };
  assert.throws(() => createCurrentEgressOwner(new Proxy(input, handler)), TypeError);
  assert.throws(() => createCurrentEgressOwner({ ...input, rule: new Proxy(input.rule, handler) }), TypeError);
  assert.throws(() => createCurrentEgressOwner({ ...input, readRsHead: new Proxy(input.readRsHead, {
    apply() {traps += 1; throw new Error("apply trap");} }) }), TypeError);
  const accessor = { ...input };
  Object.defineProperty(accessor, "readRsHead", { get() {traps += 1; return input.readRsHead;} });
  assert.throws(() => createCurrentEgressOwner(accessor), TypeError);
  const owner = createCurrentEgressOwner(input); t.after(() => owner.dispose());
  for (const raw of [new Proxy(resolveInput(), handler),
    { ...resolveInput(), request: new Proxy(resolveInput().request, handler) },
    Object.assign(Object.create({ inherited: true }), resolveInput()),
    { ...resolveInput(), [Symbol("extra")]: true }]) {
    assert.equal((await owner.resolvePolicy(raw)).status, "denied");
  }
  const requestGetter = resolveInput();
  Object.defineProperty(requestGetter.request.body, "digest", { get() {traps += 1; return digest("get");} });
  assert.equal((await owner.resolvePolicy(requestGetter)).status, "denied");
  const hidden = resolveInput(); Object.defineProperty(hidden, "scope", { enumerable: false });
  assert.equal((await owner.resolvePolicy(hidden)).status, "denied");
  const getter = resolveInput(); Object.defineProperty(getter, "scope", { get() {traps += 1; return scope();} });
  assert.equal((await owner.resolvePolicy(getter)).status, "denied");
  assert.equal(traps, 0);
});

test("malformed current projections and hostile thenables close without retries or property execution", async t => {
  let traps = 0;
  for (const bad of [null, {}, { headVersion: "07", authority: null },
    { headVersion: "1", authority: null, extra: true }]) {
    const { input } = fixture(); let reads = 0;
    const owner = createCurrentEgressOwner({ ...input,
      readRsHead: (async () => {reads += 1; return Promise.resolve(bad);}) as never });
    t.after(() => owner.dispose());
    assert.notEqual((await owner.resolvePolicy(resolveInput())).status, "current");
    assert.equal((await owner.resolvePolicy(resolveInput())).status, "denied"); assert.equal(reads, 1);
  }
  const { input, state } = fixture();
  const accessor = structuredClone(state.head);
  Object.defineProperty(accessor.authority, "constraintsDigest", { get() {traps += 1; return digest("getter");} });
  const owner = createCurrentEgressOwner({ ...input, readRsHead: async () => accessor }); t.after(() => owner.dispose());
  assert.notEqual((await owner.resolvePolicy(resolveInput())).status, "current");
  // oxlint-disable-next-line unicorn/no-thenable -- Deliberate hostile getter must never be assimilated.
  const thenable = Object.defineProperty({}, "then", { get() {traps += 1; throw new Error("then getter");} });
  assert.throws(() => createCurrentEgressOwner({ ...input, readRsHead: (() => thenable) as never }), TypeError);
  for (const value of [new Proxy(Promise.resolve(state.head), { get() {traps += 1; throw new Error("trap");} }),
    Object.defineProperty(Promise.resolve(state.head), "constructor", { get() {traps += 1; return Promise;} }),
    // oxlint-disable-next-line unicorn/no-thenable -- Deliberate hostile promise getter must remain unread.
    Object.defineProperty(Promise.resolve(state.head), "then", { get() {traps += 1; throw new Error("then");} })]) {
    assert.throws(() => createCurrentEgressOwner({ ...input, readRsHead: () => value }), TypeError);
  }
  assert.equal(traps, 0);
});

test("malformed PA current data and credential arrays fail closed", async t => {
  const { input, state } = fixture();
  for (const [path, value] of [["available", "yes"], ["bindingRevision", -1], ["bindingRevision", 1.5],
    ["routeAuthorityDigest", "not-a-digest"], ["credentialGeneration", "bad/ref"],
    ["route.credentialSlots", Array(17).fill("authorization")]] as [string, unknown][]) {
    const owner = createCurrentEgressOwner({ ...input, readPaEndorsement: async () => changed(state.pa, path, value) });
    t.after(() => owner.dispose()); assert.notEqual((await owner.resolvePolicy(resolveInput())).status, "current");
  }
  const owner = createCurrentEgressOwner(input); t.after(() => owner.dispose());
  for (const fields of [Array.from({length: 257}, () => ({})), Array(2),
    [resolveInput().request.headers.credentialFields[0], resolveInput().request.headers.credentialFields[0]]]) {
    const raw = changed(resolveInput(), "request.headers.credentialFields", fields);
    assert.equal((await owner.resolvePolicy(raw)).status, "denied");
  }
});

for (const stage of [1, 2, 3]) {
  test(`dispose invalidates a late callback at RS/PA/RS stage ${stage}`, async () => {
    const { input, state } = fixture(); const gate = deferred<unknown>(); const entered = deferred<void>(); let calls = 0;
    const observe = (value: unknown): Promise<unknown> => {
      calls += 1;
      if (calls === stage) {entered.resolve(); return gate.promise;}
      return Promise.resolve(value);
    };
    const owner = createCurrentEgressOwner({ ...input,
      readRsHead: async () => observe(state.head) as Promise<typeof state.head>,
      readPaEndorsement: async () => observe(state.pa) as Promise<typeof state.pa> });
    const pending = owner.resolvePolicy(resolveInput()); await entered.promise;
    owner.dispose(); owner.dispose();
    assert.notEqual((await pending).status, "current");
    if (stage === 2) {gate.resolve(state.pa);} else {gate.reject(new Error("late borrowed failure"));}
    assert.equal((await owner.resolvePolicy(resolveInput())).status, "denied");
    assert.equal(calls, stage);
  });
}

test("a timed-out callback settles locally and a late rejection cannot authorize or retry", async t => {
  const { input } = fixture(); const gate = deferred<never>(); let reads = 0;
  const owner = createCurrentEgressOwner({ ...input, timing: { ...input.timing, readTimeoutMilliseconds: 10 },
    readRsHead: async () => {reads += 1; return gate.promise;} }); t.after(() => owner.dispose());
  const start = performance.now();
  const result = await owner.resolvePolicy(resolveInput());
  assert.equal(result.status, "indeterminate"); assert.ok(performance.now() - start < 1000);
  gate.reject(new Error("late failure"));
  assert.equal((await owner.resolvePolicy(resolveInput())).status, "denied"); assert.equal(reads, 1);
});

test("a callback completing beyond its monotonic read deadline is rejected even before timer delivery", async () => {
  const { input, state } = fixture();
  const owner = createCurrentEgressOwner({ ...input, readRsHead: async () => {state.now += 101; return state.head;} });
  assert.notEqual((await owner.resolvePolicy(resolveInput())).status, "current");
  assert.equal((await owner.resolvePolicy(resolveInput())).status, "denied");
});

test("context TTL expires; operation deadlines and clock faults are irreversible", async t => {
  const { input, state } = fixture(); const owner = createCurrentEgressOwner(input); t.after(() => owner.dispose());
  const before = await current(owner); state.now = 1100;
  assert.equal((await owner.readCurrent({ scope: scope(), authorityRef: before.authorityRef })).status, "denied");
  const after = await current(owner); assert.notEqual(after.authorityRef, before.authorityRef);
  for (const mode of ["operation", "regression", "NaN", "throws"]) {
    const f = fixture();
    const acceptedDispatch = f.input.acceptedDispatch;
    f.state.head = structuredClone(acceptedDispatch) as typeof f.state.head;
    let throws = false;
    const bounded = createCurrentEgressOwner(approve({ ...f.input, acceptedDispatch,
      timing: { ...f.input.timing, operationDeadlineMonotonic: mode === "operation" ? 150 : 10100 },
      monotonicNow: () => { if (throws) {throw new Error("clock fault");} return f.state.now; } }));
    t.after(() => bounded.dispose()); const authority = await current(bounded);
    f.state.now = mode === "regression" ? 99 : mode === "NaN" ? NaN : 150; throws = mode === "throws";
    assert.equal((await bounded.readCurrent({ scope: scope(), authorityRef: authority.authorityRef })).status, "denied");
    f.state.now = 100; throws = false;
    assert.equal((await bounded.resolvePolicy(resolveInput())).status, "denied");
  }
});

test("both private readers reject raw promise suppliers before invocation", () => {
  const {input} = fixture(); let calls = 0; let getters = 0;
  const raw = () => {
    calls += 1;
    // oxlint-disable-next-line unicorn/no-thenable -- Regression supplier must never be invoked.
    return Object.defineProperty(Promise.reject(new Error("unhandled if invoked")), "then", {
      get() {getters += 1; throw new Error("must not be read");},
    });
  };
  const generator = async function* () {calls += 1; yield null;};
  const revoked = Proxy.revocable(input.readRsHead, {}); revoked.revoke();
  for (const key of ["readRsHead", "readPaEndorsement"]) {
    for (const value of [raw, generator, input.readRsHead.bind({}), revoked.proxy]) {
      assert.throws(() => createCurrentEgressOwner({...input, [key]: value}), TypeError);
    }
  }
  assert.equal(calls, 0); assert.equal(getters, 0);
});

test("trusted async readers handle immediate rejections at either owner", async t => {
  for (const key of ["readRsHead", "readPaEndorsement"]) {
    const {input} = fixture(); let calls = 0;
    const owner = createCurrentEgressOwner({...input, [key]: async () => {
      calls += 1; throw new Error("synthetic immediate owner rejection");
    }}); t.after(() => owner.dispose());
    assert.equal((await owner.resolvePolicy(resolveInput())).status, "indeterminate");
    await new Promise<void>(resolve => {setImmediate(resolve);});
    assert.equal((await owner.resolvePolicy(resolveInput())).status, "denied");
    assert.equal(calls, 1);
  }
});
