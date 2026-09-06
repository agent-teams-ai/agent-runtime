import "./staged-ingress-safety-fixture.mjs";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { after, mock, test } from "node:test";
import { guards, bindings, duringConstruction } from "./staged-ingress-construction-fixture.ts";
import { bytes, chunks, createEgressFixture } from "./http-egress-test-fixture.ts";

// Observe real entropy and comparisons, never log their content or replace the
// authentication algorithm. These mocks precede import of the session owner.
const entropy: Buffer[] = [];
const originalHex: string[] = [];
const retainedTokens: Uint8Array[] = [];
const comparisons: Uint8Array[][] = [];
const randomBytes = crypto.randomBytes;
const timingSafeEqual = crypto.timingSafeEqual;
const encode = TextEncoder.prototype.encode;
mock.method(crypto, "randomBytes", (size: number) => {
  const value = randomBytes(size); entropy.push(value); originalHex.push(value.toString("hex")); return value;
});
mock.method(crypto, "timingSafeEqual", (presented: Uint8Array, retained: Uint8Array) => {
  comparisons.push([presented, retained]); return timingSafeEqual(presented, retained);
});
mock.method(TextEncoder.prototype, "encode", function (this: TextEncoder, input?: string) {
  const value = Reflect.apply(encode, this, [input]);
  if (input !== undefined && input === originalHex.at(-1)) {retainedTokens.push(value);}
  return value;
});
syncBuiltinESMExports();
after(() => {mock.restoreAll(); syncBuiltinESMExports();});

const sessions = await import("../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/egress/host-http-egress-session.js");
const entropyOnImport = entropy.length;
const zeroed = (value: Uint8Array | undefined) => {
  assert.ok(value); assert.equal(value.every(byte => byte === 0), true, "owned byte buffer must be cleared");
};
const request = (token: string) => chunks(["POST /invoke HTTP/1.1\r\nHost: broker.invalid\r\n"
  + `Content-Type: application/json\r\nContent-Length: 2\r\nAuthorization: Bearer ${token}\r\n\r\n{}`]);

test("import is inert; preparation allocates entropy once; binding preserves exact owner identity", async () => {
  assert.equal(entropyOnImport, 0);
  const f = createEgressFixture(); const before = entropy.length; const beforeGuards = guards.length;
  const staged = sessions.prepareAuthenticatedHostHttpEgressSession(f.ports.identity);
  const token = staged.nativeBearerToken();
  assert.equal(entropy.length, before + 1); assert.equal(guards.length, beforeGuards);
  assert.equal(entropy[before]?.byteLength, 32); zeroed(entropy[before]);
  assert.equal(token === originalHex[before], true, "issuer must directly encode the original entropy");
  const retained = retainedTokens.at(-1);
  const session = staged.bind(f.ports);
  assert.equal(entropy.length, before + 1); assert.equal(guards.length, beforeGuards + 1);
  assert.equal(bindings.at(-1)?.identity.liveProcessSessionIdentity, f.ports.identity.liveProcessSessionIdentity);
  assert.equal(bindings.at(-1)?.guard, guards.at(-1));
  const receipt = await session.execute({...f.operation, connection: {...f.operation.connection, request: request(token)}});
  assert.equal(receipt.outcome, "completed");
  zeroed(comparisons.at(-1)?.[0]);
  assert.equal(comparisons.at(-1)?.[1]?.byteLength, 64);
  assert.equal(comparisons.at(-1)?.[1]?.some(byte => byte !== 0), true);
  session.close(); zeroed(comparisons.at(-1)?.[1]); zeroed(retained);
  assert.equal(guards.at(-1)?.snapshot().state, "closed");
  assert.throws(staged.nativeBearerToken, /inbound_authentication_denied/);
});

test("same-size failed presentation clears its bytes and revokes the retained token", async () => {
  const f = createEgressFixture(); const staged = sessions.prepareAuthenticatedHostHttpEgressSession(f.ports.identity);
  const token = staged.nativeBearerToken(); const session = staged.bind(f.ports);
  const foreign = `${token[0] === "a" ? "b" : "a"}${token.slice(1)}`;
  const receipt = await session.execute({...f.operation, connection: {...f.operation.connection, request: request(foreign)}});
  assert.equal(receipt.anomalyCode, "inbound_authentication_denied");
  zeroed(comparisons.at(-1)?.[0]); zeroed(comparisons.at(-1)?.[1]);
  assert.equal(guards.at(-1)?.snapshot().state, "closed");
  assert.equal(f.observations.materializationInputs.length, 0);
});

test("failed broker construction closes the partial guard and retained authorization with no retry", () => {
  const f = createEgressFixture(); const before = entropy.length; const staged = sessions.prepareAuthenticatedHostHttpEgressSession(f.ports.identity);
  const token = staged.nativeBearerToken(); const count = bindings.length; const retained = retainedTokens.at(-1);
  duringConstruction(() => {throw new Error(`synthetic construction failure: ${token}`);});
  try {
    assert.throws(() => staged.bind(f.ports), error => {
      assert.equal(String(error).includes(token), false);
      assert.match(String(error), /Host HTTP staged session rejected/); return true;
    });
  } finally {duringConstruction(undefined);}
  assert.equal(bindings.length, count + 1);
  assert.equal(guards.at(-1)?.snapshot().state, "closed");
  assert.throws(staged.nativeBearerToken, /inbound_authentication_denied/);
  assert.throws(() => staged.bind(f.ports), /Host HTTP staged session rejected/);
  assert.equal(bindings.length, count + 1); assert.equal(entropy.length, before + 1);
  zeroed(entropy[before]); zeroed(retained); assert.deepEqual(f.observations.order, []);
});

test("close-before-bind and identity rejection clear retained bytes without constructing a guard", () => {
  const f = createEgressFixture(); const count = guards.length;
  for (const closeFirst of [true, false]) {
    const staged = sessions.prepareAuthenticatedHostHttpEgressSession(f.ports.identity);
    const retained = retainedTokens.at(-1);
    if (closeFirst) {staged.close();}
    assert.throws(() => staged.bind({...f.ports, identity: {...f.ports.identity, custodyId: "other-custody"}}),
      /Host HTTP staged session rejected/);
    zeroed(retained); assert.throws(staged.nativeBearerToken, /inbound_authentication_denied/);
    assert.equal(guards.length, count);
  }
  const before = entropy.length;
  assert.throws(() => sessions.prepareAuthenticatedHostHttpEgressSession({...f.ports.identity, operationId: ""}),
    /Host HTTP staged session rejected/);
  assert.equal(entropy.length, before);
});

test("close or reentrant bind during construction cannot publish or leave a live guard", () => {
  for (const reenter of [false, true]) {
    const f = createEgressFixture(); const staged = sessions.prepareAuthenticatedHostHttpEgressSession(f.ports.identity);
    const count = bindings.length; const retained = retainedTokens.at(-1);
    duringConstruction(() => {
      if (reenter) {assert.throws(() => staged.bind(f.ports), /Host HTTP staged session rejected/);}
      else {staged.close();}
    });
    try {assert.throws(() => staged.bind(f.ports), /Host HTTP staged session rejected/);}
    finally {duringConstruction(undefined);}
    assert.equal(bindings.length, count + 1); assert.equal(guards.at(-1)?.snapshot().state, "closed");
    zeroed(retained);
    assert.throws(staged.nativeBearerToken, /inbound_authentication_denied/);
    assert.throws(() => staged.bind(f.ports), /Host HTTP staged session rejected/);
    assert.deepEqual(f.observations.order, []);
  }
});

test("ordinary open delegates to the same construction and cleanup mechanism", () => {
  const f = createEgressFixture(); const before = entropy.length; const count = bindings.length;
  duringConstruction(() => {throw new Error("synthetic construction failure");});
  try {assert.throws(() => sessions.openAuthenticatedHostHttpEgressSession(f.ports), /Host HTTP staged session rejected/);}
  finally {duringConstruction(undefined);}
  assert.equal(entropy.length, before + 1); assert.equal(bindings.length, count + 1);
  zeroed(entropy[before]); assert.equal(guards.at(-1)?.snapshot().state, "closed");
});

test("sensitive upstream rendering stays synthetic and is zeroed on success", async () => {
  const f = createEgressFixture(); const rendered = bytes("Bearer synthetic-only");
  const session = sessions.openAuthenticatedHostHttpEgressSession({...f.ports,
    materializer: {render: async () => [{name: "authorization", valueBytes: rendered}]}});
  try {
    const receipt = await session.execute({...f.operation, connection: {...f.operation.connection,
      request: request(session.nativeBearerToken())}});
    assert.equal(receipt.outcome, "completed"); zeroed(rendered);
  } finally {session.close();}
});
