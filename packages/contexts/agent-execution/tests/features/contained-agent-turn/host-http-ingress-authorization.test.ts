import assert from "node:assert/strict";
import { test } from "node:test";
import { createHostHttpEgressSession, openAuthenticatedHostHttpEgressSession } from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/egress/host-http-egress-session.js";
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

test("missing broker-session owners fail during construction before any native ingress", () => {
  for (const name of ["ids", "resolver", "evidence"] as const) {
    const f = createEgressFixture();
    const missing = {...f.ports, [name]: undefined} as never;
    assert.throws(() => openAuthenticatedHostHttpEgressSession(missing), /Host HTTP staged session rejected/u, name);
    assert.throws(() => createHostHttpEgressSession(missing), /Host HTTP staged session rejected/u, name);
    noProviderEffects(f);
  }
  for (const name of ["ids", "resolver", "evidence-record"] as const) {
    const f = createEgressFixture();
    const incomplete = name === "ids" ? {...f.ports, ids: {}}
      : name === "resolver" ? {...f.ports, resolver: {}}
      : {...f.ports, evidence: {digest: f.ports.evidence.digest}};
    assert.throws(() => openAuthenticatedHostHttpEgressSession(incomplete as never),
      /Host HTTP staged session rejected/u, name);
    noProviderEffects(f);
  }
});


test("broker owner inspection rejects accessors and proxies without invoking them", () => {
  for (const [name, method] of [["ids", "fresh"], ["resolver", "resolve"],
    ["evidence", "digest"], ["evidence", "record"]] as const) {
    const f = createEgressFixture();
    let getterCalls = 0;
    const owner = name === "evidence" && method === "record"
      ? {digest: f.ports.evidence.digest} : {};
    Object.defineProperty(owner, method, {enumerable: true, get() {
      getterCalls += 1;
      throw new Error("untrusted owner accessor ran");
    }});
    const dependencies = {...f.ports, [name]: owner} as never;
    assert.throws(() => createHostHttpEgressSession(dependencies), /Host HTTP staged session rejected/u);
    assert.throws(() => openAuthenticatedHostHttpEgressSession(dependencies), /Host HTTP staged session rejected/u);
    assert.equal(getterCalls, 0);
    noProviderEffects(f);
  }
  const f = createEgressFixture();
  let proxyReads = 0;
  const proxy = new Proxy({fresh: () => f.ports.ids.fresh()}, {get() {
    proxyReads += 1;
    throw new Error("untrusted owner proxy ran");
  }});
  assert.throws(() => createHostHttpEgressSession({...f.ports, ids: proxy}),
    /Host HTTP staged session rejected/u);
  assert.throws(() => openAuthenticatedHostHttpEgressSession({...f.ports, ids: proxy}),
    /Host HTTP staged session rejected/u);
  assert.equal(proxyReads, 0);
  noProviderEffects(f);
});

test("callable Proxy owner methods fail before ingress without invoking their traps", () => {
  for (const [name, method] of [["ids", "fresh"], ["resolver", "resolve"],
    ["evidence", "digest"], ["evidence", "record"]] as const) {
    const f = createEgressFixture();
    let calls = 0;
    const proxiedMethod = new Proxy(() => {calls += 1; throw new Error("untrusted method called");}, {
      apply() {calls += 1; throw new Error("untrusted method proxy invoked");},
    });
    const owner = name === "evidence" && method === "record"
      ? {digest: f.ports.evidence.digest, record: proxiedMethod} : {[method]: proxiedMethod};
    const dependencies = {...f.ports, [name]: owner} as never;
    assert.throws(() => createHostHttpEgressSession(dependencies), /Host HTTP staged session rejected/u);
    assert.throws(() => openAuthenticatedHostHttpEgressSession(dependencies), /Host HTTP staged session rejected/u);
    assert.equal(calls, 0);
    noProviderEffects(f);
  }
});

test("raw broker session rejects a top-level identity getter before calling it", () => {
  const f = createEgressFixture();
  let reads = 0;
  const dependencies = {...f.ports};
  Object.defineProperty(dependencies, "identity", {enumerable: true, get() {
    reads += 1;
    throw new Error("untrusted identity getter ran");
  }});
  assert.throws(() => createHostHttpEgressSession(dependencies), /Host HTTP staged session rejected/u);
  assert.equal(reads, 0);
  noProviderEffects(f);
});

test("broker owner inspection accepts concrete prototype methods", () => {
  const f = createEgressFixture();
  class BoundaryIds {
    fresh() {return f.ports.ids.fresh();}
  }
  const session = openAuthenticatedHostHttpEgressSession({...f.ports, ids: new BoundaryIds()});
  session.close();
  noProviderEffects(f);
});

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
