import * as safetyFixture from "./staged-ingress-safety-fixture.mjs";
void safetyFixture;
import assert from "node:assert/strict";
import { test } from "node:test";
import * as sessions from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/egress/host-http-egress-session.js";
import { issueHostHttpIngressAuthorization } from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/egress/host-http-ingress-authorization.js";
import { verifyPrivateLaunchPaths } from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/host-custody-launch.js";
import { bytes, chunks, createEgressFixture, SECRET_MARKER } from "./http-egress-test-fixture.ts";
import type { EgressFixture, FixtureOptions } from "./http-egress-test-fixture.ts";

const prepare = sessions.prepareAuthenticatedHostHttpEgressSession;
const denied = /inbound_authentication_denied/;
const rejected = /Host HTTP staged session rejected/;
const wire = (token: string) => "POST /invoke HTTP/1.1\r\nHost: broker.invalid\r\n"
  + `Content-Type: application/json\r\nContent-Length: 2\r\nAuthorization: Bearer ${token}\r\n\r\n{}`;
const operation = (f: EgressFixture, token: string) => ({...f.operation,
  connection: {...f.operation.connection, request: chunks([wire(token)])}});
const noEffects = (f: EgressFixture) => assert.deepEqual(f.observations.order, []);
const noAuthority = (f: EgressFixture) => {
  assert.equal(f.observations.materializationInputs.length, 0);
  assert.equal(f.observations.provisionalInputs.length, 0);
  assert.equal(f.observations.renders, 0);
  assert.equal(f.observations.opens, 0);
};
const noTokenIn = (token: string, values: unknown) => {
  assert.equal(JSON.stringify(values).includes(token), false, "local token must not escape native input");
};

test("real issuer uses native Host hex format and authenticates that exact value", async () => {
  const ingress = issueHostHttpIngressAuthorization();
  try {
    const token = ingress.nativeBearerToken();
    assert.equal(/^[a-f0-9]{64}$/.test(token), true, "native token must encode 32 bytes as lowercase hex");
    const body = bytes("{}");
    const request = {method: "POST", path: "/invoke", body, wireBytes: 123,
      headers: [{name: "authorization", value: `Bearer ${token}`}]};
    const authenticated = ingress.authenticate(request);
    assert.equal(authenticated.body, body);
    assert.deepEqual(authenticated.headers, []);
    assert.equal(authenticated.wireBytes, 123);
    // Exercise the existing Host validator without touching disk: the deliberately
    // invalid root must be rejected only AFTER the real environment check passes.
    const stats = {isDirectory: () => true, isSymbolicLink: () => false, mode: 0o40700n,
      uid: typeof process.getuid === "function" ? BigInt(process.getuid()) : undefined};
    const plan = {provider: "codex", environment: {AR_PRIVATE_BROKER_CAPABILITY: token}, privateRootPath: "invalid"};
    await assert.rejects(verifyPrivateLaunchPaths(plan as never, "/synthetic-workspace", stats as never),
      /private root is not the operation-scoped workspace sibling/);
    for (const invalid of ["A".repeat(64), "g".repeat(64), "a".repeat(43)]) {
      await assert.rejects(verifyPrivateLaunchPaths({...plan,
        environment: {AR_PRIVATE_BROKER_CAPABILITY: invalid}} as never, "/synthetic-workspace", stats as never),
      /local broker capability is malformed/);
    }
  } finally {ingress.close();}
});

test("early issuance needs only identity; later binding retains the same native token", async t => {
  const f = createEgressFixture();
  const staged = prepare(f.ports.identity); t.after(staged.close);
  const token = staged.nativeBearerToken();
  assert.deepEqual(Object.keys(staged).toSorted(), ["bind", "close", "nativeBearerToken"]);
  assert.equal(Object.isFrozen(staged), true);
  noEffects(f);
  // Journal and authenticated container/session dependencies arrive later.
  const dependencies = await Promise.resolve({...f.ports, identity: {...f.ports.identity}});
  const session = staged.bind(dependencies);
  noEffects(f);
  assert.equal(session.nativeBearerToken() === token, true);
  const receipt = await session.execute(operation(f, token));
  assert.equal(receipt.outcome, "completed");
  assert.equal(receipt.inboundRequestBytes, bytes(wire(token)).byteLength);
  noTokenIn(token, [staged, session, receipt, f.observations.materializationInputs,
    f.observations.provisionalInputs, f.observations.finalAuthorizationInputs]);
  const upstream = new TextDecoder().decode(f.observations.dispatchedRequests[0]);
  assert.equal(upstream.includes(token), false);
  assert.equal(upstream.includes(SECRET_MARKER), true);
  session.close(); assert.throws(staged.nativeBearerToken, denied);
});

test("identity is snapshotted at issuance and binding without copying the opaque session object", async t => {
  const f = createEgressFixture(); let traps = 0;
  const opaque = new Proxy({}, {get() {traps += 1; throw new Error("opaque identity inspected");},
    ownKeys() {traps += 1; throw new Error("opaque identity inspected");}});
  const identity = {...f.ports.identity, liveProcessSessionIdentity: opaque};
  const captured = {...identity}; const staged = prepare(identity); t.after(staged.close);
  identity.operationId = "mutated-after-issuance";
  const dependencies = {...f.ports, identity: {...captured}};
  const session = staged.bind(dependencies);
  dependencies.identity.operationId = "mutated-after-binding";
  assert.equal((await session.execute(operation(f, staged.nativeBearerToken()))).outcome, "completed");
  assert.equal(traps, 0);
});

for (const field of ["operationId", "attemptId", "custodyId", "hostBootId", "liveProcessSessionIdentity"] as const) {
  test(`binding rejects substituted ${field} and permanently revokes the retained ingress`, () => {
    const f = createEgressFixture(); const staged = prepare(f.ports.identity);
    const token = staged.nativeBearerToken();
    const changed = {...f.ports.identity, [field]: field === "liveProcessSessionIdentity" ? {} : `other-${field}`};
    assert.throws(() => staged.bind({...f.ports, identity: changed}), error => {
      assert.match(String(error), rejected); noTokenIn(token, String(error)); return true;
    });
    assert.throws(staged.nativeBearerToken, denied);
    assert.throws(() => staged.bind(f.ports), rejected); noEffects(f);
  });
}

test("issuance and binding reject accessors, proxies and malformed identity without invoking traps", () => {
  const f = createEgressFixture(); let calls = 0;
  const trap = () => {calls += 1; throw new Error("identity trap");};
  const accessor = {...f.ports.identity}; Object.defineProperty(accessor, "operationId", {get: trap});
  const proxy = new Proxy(f.ports.identity, {get: trap, getPrototypeOf: trap, ownKeys: trap});
  const invalid = [accessor, proxy, {...f.ports.identity, operationId: ""},
    {...f.ports.identity, attemptId: "x".repeat(513)}, {...f.ports.identity, hostBootId: "line\nbreak"},
    {...f.ports.identity, custodyId: null}, {...f.ports.identity, liveProcessSessionIdentity: null},
    {...f.ports.identity, extra: "unowned"}, Object.create(f.ports.identity)];
  for (const identity of invalid) {
    assert.throws(() => prepare(identity as never), rejected);
    const staged = prepare(f.ports.identity);
    assert.throws(() => staged.bind({...f.ports, identity} as never), rejected);
    assert.throws(staged.nativeBearerToken, denied);
  }
  for (const dependencies of [new Proxy(f.ports, {get: trap, ownKeys: trap, getPrototypeOf: trap}),
    Object.defineProperty({...f.ports}, "identity", {get: trap}),
    Object.defineProperty({...f.ports}, "journal", {get: trap})]) {
    const staged = prepare(f.ports.identity);
    assert.throws(() => staged.bind(dependencies), rejected);
    assert.throws(staged.nativeBearerToken, denied);
  }
  assert.equal(calls, 0); noEffects(f);
});

test("close before bind rejects without inspecting dependencies", () => {
  const f = createEgressFixture(); const staged = prepare(f.ports.identity);
  staged.close(); staged.close();
  assert.throws(staged.nativeBearerToken, denied);
  let calls = 0;
  assert.throws(() => staged.bind(new Proxy(f.ports, {get() {calls += 1; throw new Error("read");}})), rejected);
  assert.throws(() => staged.bind(f.ports), rejected);
  assert.equal(calls, 0); noEffects(f);
});

test("duplicate binding retires both the existing guard and token without opening another session", async () => {
  const f = createEgressFixture(); const staged = prepare(f.ports.identity);
  const token = staged.nativeBearerToken(); const session = staged.bind(f.ports);
  assert.throws(() => staged.bind(f.ports), rejected);
  assert.throws(staged.nativeBearerToken, denied); assert.throws(session.nativeBearerToken, denied);
  const receipt = await session.execute(operation(f, token));
  assert.notEqual(receipt.outcome, "completed"); noAuthority(f);
});

test("cloned, inherited, proxied, detached and substituted handles cannot bind", () => {
  const f = createEgressFixture();
  type Staged = ReturnType<typeof prepare>;
  for (const clone of [(value: Staged) => ({...value}), (value: Staged) => Object.create(value),
    (value: Staged) => new Proxy(value, {}), () => {}]) {
    const staged = prepare(f.ports.identity);
    assert.throws(() => Reflect.apply(staged.bind, clone(staged), [f.ports]), rejected);
    assert.throws(staged.nativeBearerToken, denied);
    assert.throws(() => staged.bind(f.ports), rejected);
  }
  const left = prepare(f.ports.identity); const right = prepare(f.ports.identity);
  try {
    assert.throws(() => Reflect.apply(left.bind, right, [f.ports]), rejected);
    assert.throws(left.nativeBearerToken, denied);
    assert.equal(typeof right.nativeBearerToken(), "string");
  } finally {left.close(); right.close();}
  noEffects(f);
});

test("wrong bearer is denied before fresh IDs and all authority calls", async () => {
  const f = createEgressFixture(); let ids = 0;
  const staged = prepare(f.ports.identity); const session = staged.bind({...f.ports,
    ids: {fresh() {ids += 1; return f.ports.ids.fresh();}}});
  const token = staged.nativeBearerToken();
  const foreign = issueHostHttpIngressAuthorization();
  try {
    const receipt = await session.execute(operation(f, foreign.nativeBearerToken()));
    assert.equal(receipt.anomalyCode, "inbound_authentication_denied");
    assert.equal(receipt.firstByteState, "not_sent"); assert.equal(ids, 0); noAuthority(f);
    assert.throws(staged.nativeBearerToken, denied); noTokenIn(token, receipt);
    assert.throws(() => staged.bind(f.ports), rejected);
  } finally {foreign.close(); staged.close();}
});

for (const [name, options] of Object.entries({
  "PA denial": {paReceiptChange: {decision: "rejected"}},
  "inbound close uncertainty": {inboundClosure: "unknown"},
  "upstream close uncertainty": {upstreamClosure: "unknown"},
  "evidence uncertainty": {evidence: "unknown"},
  "write acknowledgement loss": {dispatch: {status: "failed", acceptedRequestBytes: "unknown", acknowledgement: "lost"}},
} satisfies Record<string, FixtureOptions>)) {
  test(`${name} permanently revokes staged authorization and session admission`, async () => {
    const f = createEgressFixture(options); const staged = prepare(f.ports.identity);
    const token = staged.nativeBearerToken(); const session = staged.bind(f.ports);
    try {
      const receipt = await session.execute(operation(f, token));
      assert.notEqual(receipt.outcome, "completed");
      assert.throws(staged.nativeBearerToken, denied); assert.throws(session.nativeBearerToken, denied);
      const counts = [f.observations.materializationInputs.length, f.observations.opens, f.observations.dispatches];
      assert.notEqual((await session.execute(operation(f, token))).outcome, "completed");
      assert.deepEqual([f.observations.materializationInputs.length, f.observations.opens, f.observations.dispatches], counts);
      noTokenIn(token, f.observations.receipts);
    } finally {staged.close();}
  });
}

test("staged close while request reading retains existing authentication-before-PA behavior", async () => {
  const f = createEgressFixture(); const staged = prepare(f.ports.identity);
  const session = staged.bind(f.ports); const request = wire(staged.nativeBearerToken());
  const receipt = await session.execute({...f.operation, connection: {...f.operation.connection,
    request: (async function* () {staged.close(); yield bytes(request);})()}});
  assert.equal(receipt.anomalyCode, "inbound_authentication_denied"); noAuthority(f);
  assert.throws(session.nativeBearerToken, denied);
});

test("invalid execution closes both staged and ordinary sessions", async () => {
  const f = createEgressFixture(); const staged = prepare(f.ports.identity);
  const session = staged.bind(f.ports);
  await assert.rejects(session.execute({} as never)); assert.throws(staged.nativeBearerToken, denied);
  const ordinary = sessions.openAuthenticatedHostHttpEgressSession(f.ports);
  await assert.rejects(ordinary.execute({} as never)); assert.throws(ordinary.nativeBearerToken, denied);
  noEffects(f);
});

test("ordinary open still exposes detached methods and allows successive fully closed requests", async t => {
  const f = createEgressFixture();
  const session = sessions.openAuthenticatedHostHttpEgressSession({...f.ports,
    materializer: {render: async () => [{name: "authorization", valueBytes: bytes(`Bearer ${SECRET_MARKER}`)}]}});
  t.after(session.close);
  assert.deepEqual(Object.keys(session).toSorted(), ["close", "execute", "nativeBearerToken"]);
  const {nativeBearerToken, execute, close} = session;
  const token = nativeBearerToken();
  assert.equal((await execute(operation(f, token))).outcome, "completed");
  assert.equal((await execute(operation(f, token))).outcome, "completed");
  close(); assert.throws(nativeBearerToken, denied);
  noTokenIn(token, f.observations.receipts);
});
