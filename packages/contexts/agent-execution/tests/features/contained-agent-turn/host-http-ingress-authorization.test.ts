import assert from "node:assert/strict";
import { test } from "node:test";
import { openAuthenticatedHostHttpEgressSession } from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/egress/host-http-egress-session.js";
import { issueHostHttpIngressAuthorization } from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/egress/host-http-ingress-authorization.js";
import { bytes, chunks, createEgressFixture, SECRET_MARKER } from "./http-egress-test-fixture.ts";
import { cases, nativeFixture } from "./native-http-request-profile-fixture.ts";
import type { EgressFixture } from "./http-egress-test-fixture.ts";

const wire = (headers: string) => `POST /invoke HTTP/1.1\r\nHost: broker.invalid\r\nContent-Type: application/json\r\nContent-Length: 2\r\n${headers}\r\n{}`;
const operation = (f: EgressFixture, request: string) => ({...f.operation,
  connection: {...f.operation.connection, request: chunks([request])}});
const noProviderEffects = (f: EgressFixture) => {
  assert.equal(f.observations.materializationInputs.length, 0);
  assert.equal(f.observations.provisionalInputs.length, 0);
  assert.equal(f.observations.renders, 0);
  assert.equal(f.observations.opens, 0);
  assert.equal(f.observations.dispatches, 0);
};

test("authenticated ingress strips only its local bearer and retains raw byte accounting", async t => {
  const f = createEgressFixture(); const session = openAuthenticatedHostHttpEgressSession({...f.ports,
    materializer: {render: async () => [{name: "authorization", valueBytes: bytes(`Bearer ${SECRET_MARKER}`)}]},
  });
  t.after(session.close);
  const token = session.nativeBearerToken(); assert.equal(/^[a-f0-9]{64}$/.test(token), true);
  const request = wire(`aUtHoRiZaTiOn: Bearer ${token}\r\n`);
  const receipt = await session.execute(operation(f, request));
  assert.equal(receipt.outcome, "completed");
  assert.equal(receipt.inboundRequestBytes, bytes(request).byteLength);
  const upstream = new TextDecoder().decode(f.observations.dispatchedRequests[0]);
  assert.equal(upstream.includes(token), false);
  assert.equal(upstream.includes(SECRET_MARKER), true);
  assert.equal(upstream.split("\r\n").filter(line => line.startsWith("authorization:")).length, 1);
  assert.equal(JSON.stringify([f.observations.materializationInputs, f.observations.provisionalInputs,
    f.observations.finalAuthorizationInputs, f.observations.receipts]).includes(token), false);
  assert.equal(session.nativeBearerToken(), token);
  assert.equal(JSON.stringify(session), "{}");
  assert.equal((await session.execute(operation(f, request))).outcome, "completed");
});

test("missing, malformed and foreign bearer values fail before fresh IDs or PA effects", async t => {
  for (const value of [undefined, "", "Basic xyz", "Bearer invalid", `bearer ${"a".repeat(43)}`,
    `Bearer ${"a".repeat(43)}`, `Bearer  ${"a".repeat(43)}`, `Bearer ${"a".repeat(42)}=`]) {
    const f = createEgressFixture(); let idCalls = 0;
    const session = openAuthenticatedHostHttpEgressSession({...f.ports, ids: {fresh() {
      idCalls += 1; return f.ports.ids.fresh();
    }}}); t.after(session.close);
    const request = wire(value === undefined ? "" : `Authorization: ${value}\r\n`);
    const receipt = await session.execute(operation(f, request));
    assert.equal(receipt.anomalyCode, "inbound_authentication_denied");
    assert.equal(receipt.inboundRequestBytes, bytes(request).byteLength);
    assert.equal(receipt.firstByteState, "not_sent"); assert.equal(idCalls, 0); noProviderEffects(f);
    assert.equal(receipt.inboundClosure, "closed");
    assert.throws(session.nativeBearerToken, /inbound_authentication_denied/);
    if (value) {assert.equal(JSON.stringify(receipt).includes(value), false);}
  }
});

test("local capabilities are independent even for sessions with equal textual identities", async t => {
  const left = createEgressFixture(); const right = createEgressFixture();
  const a = openAuthenticatedHostHttpEgressSession(left.ports);
  const b = openAuthenticatedHostHttpEgressSession(right.ports); t.after(a.close); t.after(b.close);
  assert.notEqual(a.nativeBearerToken(), b.nativeBearerToken());
  const receipt = await b.execute(operation(right, wire(`Authorization: Bearer ${a.nativeBearerToken()}\r\n`)));
  assert.equal(receipt.anomalyCode, "inbound_authentication_denied"); noProviderEffects(right);
});

test("duplicate authorization and competing credential carriers are never accepted", async t => {
  for (const extra of ["Authorization: other\r\n", "Proxy-Authorization: other\r\n", "X-Api-Key: other\r\n"]) {
    const f = createEgressFixture(); const session = openAuthenticatedHostHttpEgressSession(f.ports);
    t.after(session.close); const token = session.nativeBearerToken();
    const receipt = await session.execute(operation(f, wire(`Authorization: Bearer ${token}\r\n${extra}`)));
    assert.equal(receipt.anomalyCode, extra.startsWith("Authorization") ? "inbound_smuggling" : "inbound_authentication_denied");
    noProviderEffects(f); assert.throws(session.nativeBearerToken, /inbound_authentication_denied/);
  }
});

test("a malformed request cannot use a correct bearer to bypass framing or route checks", async t => {
  for (const mutate of [(request: string) => request.replace("/invoke", "/other"),
    (request: string) => `${request}X`,
    (request: string) => request.replace("Content-Length: 2", "Transfer-Encoding: chunked")]) {
    const f = createEgressFixture(); const session = openAuthenticatedHostHttpEgressSession(f.ports);
    t.after(session.close); const token = session.nativeBearerToken();
    const receipt = await session.execute(operation(f, mutate(wire(`Authorization: Bearer ${token}\r\n`))));
    assert.notEqual(receipt.outcome, "completed"); noProviderEffects(f);
    assert.throws(session.nativeBearerToken, /inbound_authentication_denied/);
  }
});

test("explicit close revokes native token access and all subsequent ingress", async () => {
  const f = createEgressFixture(); const session = openAuthenticatedHostHttpEgressSession(f.ports);
  const token = session.nativeBearerToken(); session.close(); session.close();
  assert.throws(session.nativeBearerToken, /inbound_authentication_denied/);
  const receipt = await session.execute(operation(f, wire(`Authorization: Bearer ${token}\r\n`)));
  assert.notEqual(receipt.outcome, "completed"); noProviderEffects(f);
});

test("close during request reading denies before PA even when the full frame arrives later", async () => {
  const f = createEgressFixture(); const session = openAuthenticatedHostHttpEgressSession(f.ports);
  const request = wire(`Authorization: Bearer ${session.nativeBearerToken()}\r\n`);
  const receipt = await session.execute({...f.operation, connection: {...f.operation.connection,
    request: (async function* () {session.close(); yield bytes(request);})()}});
  assert.equal(receipt.anomalyCode, "inbound_authentication_denied"); noProviderEffects(f);
});

test("close at materialization or synchronous consumption prevents the first outbound byte", async t => {
  for (const phase of ["materialization", "consumption"]) {
    const f = createEgressFixture(); let session: ReturnType<typeof openAuthenticatedHostHttpEgressSession>;
    session = openAuthenticatedHostHttpEgressSession({...f.ports,
      materializer: {render: async receipt => {if (phase === "materialization") {session.close();}
        return f.ports.materializer.render(receipt);}},
      journal: {consume: () => {if (phase === "consumption") {session.close();} return "consumed";}},
    }); t.after(session.close);
    const receipt = await session.execute(operation(f, wire(`Authorization: Bearer ${session.nativeBearerToken()}\r\n`)));
    assert.equal(receipt.firstByteState, "not_sent"); assert.equal(f.observations.dispatches, 0);
    assert.notEqual(receipt.outcome, "completed"); assert.throws(session.nativeBearerToken);
  }
});

test("downstream failure and invalid operation permanently retire the local token", async t => {
  const f = createEgressFixture({evidence: "unknown"});
  const session = openAuthenticatedHostHttpEgressSession(f.ports); t.after(session.close);
  const token = session.nativeBearerToken();
  assert.notEqual((await session.execute(operation(f, wire(`Authorization: Bearer ${token}\r\n`)))).outcome, "completed");
  assert.throws(session.nativeBearerToken);
  const invalid = openAuthenticatedHostHttpEgressSession(createEgressFixture().ports); t.after(invalid.close);
  await assert.rejects(invalid.execute({} as never)); assert.throws(invalid.nativeBearerToken);
});

test("private authorization keeps exact body identity and raw wire count while removing bearer", () => {
  const ingress = issueHostHttpIngressAuthorization();
  try {
    const body = bytes("body"); const token = ingress.nativeBearerToken();
    const request = Object.freeze({method: "POST", path: "/invoke", body, wireBytes: 200,
      headers: Object.freeze([{name: "authorization", value: `Bearer ${token}`},
        {name: "content-type", value: "application/json"}])});
    const authorized = ingress.authenticate(request);
    assert.equal(authorized.body, body); assert.equal(authorized.wireBytes, 200);
    assert.deepEqual(authorized.headers, [{name: "content-type", value: "application/json"}]);
    ingress.close(); assert.throws(() => ingress.authenticate(request), /inbound_authentication_denied/);
  } finally {ingress.close();}
});


test("all four native POST profiles authenticate local bearer and retain their own upstream credentials", async t => {
  for (const candidate of cases) {
    const f = nativeFixture(candidate); const session = openAuthenticatedHostHttpEgressSession(f.ports);
    t.after(session.close); const token = session.nativeBearerToken(); let rawBytes = 0;
    const request = (async function* () {
      let first = true;
      for await (const chunk of f.operation.connection.request) {
        const next = first ? bytes(new TextDecoder().decode(chunk).replace("Bearer fixture-broker", `Bearer ${token}`)) : chunk;
        first = false; rawBytes += next.byteLength; yield next;
      }
    })();
    const receipt = await session.execute({...f.operation, connection: {...f.operation.connection, request}});
    assert.equal(receipt.outcome, "completed", candidate.factory.name);
    assert.equal(receipt.inboundRequestBytes, rawBytes);
    const upstream = new TextDecoder().decode(f.observations.dispatchedRequests[0]);
    assert.equal(upstream.includes(token), false);
    for (const name of candidate.credentials) {assert.equal(upstream.includes(`${name}: `), true);}
    assert.equal(JSON.stringify(f.observations.receipts).includes(token), false);
  }
});

test("a correct local bearer cannot change the session's operation or attempt binding", async t => {
  for (const change of [{operationId: "foreign-operation"}, {attemptId: "foreign-attempt"}]) {
    const f = createEgressFixture(); const session = openAuthenticatedHostHttpEgressSession(f.ports);
    t.after(session.close); const token = session.nativeBearerToken();
    const receipt = await session.execute({...operation(f, wire(`Authorization: Bearer ${token}\r\n`)), ...change});
    assert.notEqual(receipt.outcome, "completed"); noProviderEffects(f);
    assert.throws(session.nativeBearerToken);
  }
});
