import assert from "node:assert/strict";
import { test } from "node:test";
import { snapshotHostHttpRoute, presentationFields } from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/egress/http-egress-session-authority.js";
import { createPreparedHttpRequestV1, PreparedHttpRequestV1Error } from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/egress/prepared-http-request-v1.js";
import { nativeHttpRequestProfile } from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/egress/native-http-request-profile.js";
import { createStrictHttpEgressBroker } from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/egress/strict-http-egress-broker.js";
import { bytes } from "./http-egress-test-fixture.ts";
import { cases, headers, body, request, nativeFixture, credential, type ProfileCase } from "./native-http-request-profile-fixture.ts";

const input = (candidate: ProfileCase = cases[0]) => ({methodBytes: bytes("POST"), targetBytes: bytes(candidate.path),
  hostBytes: bytes(candidate.host), bodyBytes: body(),
  presentationFields: presentationFields(request(candidate), candidate.factory("synthetic-receipt")),
  credentialHeaderNameAllowlist: candidate.credentials.slice(),
  credentialFields: candidate.credentials.map(name => ({name, valueBytes: bytes(credential(name))})),
});
const denied = (value: unknown) => assert.throws(() => createPreparedHttpRequestV1(value as never), PreparedHttpRequestV1Error);
const envelope = (candidate: ProfileCase = cases[0]) => {
  const value = input(candidate).presentationFields;
  assert.ok("fields" in value); return value;
};

for (const candidate of cases) {
  test(`${candidate.factory.name}: serializer binds explicit profile to exact target, host, method and credential mode`, () => {
    for (const change of [{methodBytes: bytes("GET")}, {methodBytes: bytes("post")}, {hostBytes: bytes(`${candidate.host}:443`)},
      {hostBytes: bytes(candidate.host.toUpperCase())}, {hostBytes: bytes("arbitrary.example")},
      {targetBytes: bytes(`${candidate.path}/`)}, {targetBytes: bytes(`${candidate.path}#fragment`)},
      {targetBytes: bytes(`${candidate.path}&beta=true`)}, {credentialHeaderNameAllowlist: ["cookie"]},
      {credentialHeaderNameAllowlist: [...candidate.credentials, "x-fake-credential"]}, {credentialFields: []}]) {
      denied({...input(candidate), ...change});
    }
    const copied = envelope(candidate);
    denied({...input(candidate), presentationFields: copied.fields});
    for (const id of [undefined, null, "generic", "constructor", "toString", {}, Symbol("profile")]) {
      denied({...input(candidate), presentationFields: {...copied, requestProfile: id}});
    }
    for (const other of cases.filter(value => value !== candidate)) {
      denied({...input(candidate), presentationFields: {...copied, requestProfile: other.factory("synthetic-receipt").requestProfile}});
    }
    const profile = nativeHttpRequestProfile(copied.requestProfile)!;
    for (const name of profile.requiredHeaderNames) {
      denied({...input(candidate), presentationFields: {...copied, fields: copied.fields.filter(field => field.name !== name)}});
    }
  });
}

for (const invalid of ["bad\r\ninjected: true", "\u0000", "\u0001", "\u007f", "\u0085", "é", "\ud800", "\u202e", "a\tb", "", " leading", "trailing "]) {
  test(`native presentation rejects unsafe value ${JSON.stringify(invalid)} at both seams`, () => {
    const candidate = cases[0];
    const altered = headers("codex").map(field => field.name === "x-codex-turn-metadata" ? {...field, value: invalid} : field);
    assert.throws(() => presentationFields(request(candidate, altered), candidate.factory("synthetic-receipt")));
    const value = envelope(candidate);
    denied({...input(candidate), presentationFields: {...value, fields: value.fields.map(field => field.name === "x-codex-turn-metadata"
      ? {...field, valueBytes: bytes(invalid)} : field)}});
  });
}

test("native prepared byte names reject case aliases, duplicates, protocol credentials and transport presentation", () => {
  const value = envelope();
  for (const name of ["Version", "VERSION", "version\r\n", "vérsion", "x-arbitrary", "authorization", "x-api-key",
    "chatgpt-account-id", "host", "content-length", "accept-encoding", "connection", "te", "transfer-encoding", "anthropic-beta"]) {
    denied({...input(), presentationFields: {...value, fields: value.fields.map(field => field.name === "version"
      ? {...field, name} : field)}});
  }
  denied({...input(), presentationFields: {...value, fields: [...value.fields, value.fields[0]]}});
  denied({...input(), credentialFields: [{name: "authorization", valueBytes: bytes("synthetic")},
    {name: "Authorization", valueBytes: bytes("duplicate")}]});
  for (const candidate of cases) {
    for (const name of [...candidate.factory("synthetic-receipt").forwardedRequestHeaderNames, "accept-encoding", "connection",
      "content-length", "host", "proxy-authorization", "transfer-encoding", "trailer", "upgrade"]) {
      const generic = {...input(), presentationFields: [], credentialHeaderNameAllowlist: [name],
        credentialFields: [{name, valueBytes: bytes("synthetic")}]};
      denied(generic);
    }
  }
});

const altered = (size: number) => headers("codex").map(field => field.name === "x-codex-turn-metadata"
    ? {...field, value: "x".repeat(size)} : field);

test("native presentation limits admit the exact value bound and reject byte, aggregate and field overflow", () => {
  const candidate = cases[0]; const route = candidate.factory("synthetic-receipt");
  const exact = presentationFields(request(candidate, altered(4_096)), route);
  const prepared = createPreparedHttpRequestV1({...input(), presentationFields: exact}); prepared.dispose();
  assert.throws(() => presentationFields(request(candidate, altered(4_097)), route));
  const value = envelope();
  denied({...input(), presentationFields: {...value, fields: value.fields.map(field => field.name === "x-codex-turn-metadata"
    ? {...field, valueBytes: bytes("x".repeat(4_097))} : field)}});
  const overflow = headers("codex").map(field => ["version", "content-type"].includes(field.name) ? field : {...field, value: "x".repeat(4_096)});
  assert.throws(() => presentationFields(request(candidate, overflow), route));
  denied({...input(), presentationFields: {...value, fields: overflow.map(field => ({name: field.name, valueBytes: bytes(field.value)}))}});
  assert.throws(() => presentationFields(request(candidate, Array.from({length: 25}, () => ({name: "accept", value: "x"}))), route));
  denied({...input(), presentationFields: {...value, fields: Array(100).fill(value.fields[0])}});
  denied({...input(), credentialFields: input().credentialFields.map(field => ({...field, valueBytes: bytes("x".repeat(16_385))}))});
  denied({...input(), bodyBytes: new Uint8Array(1_048_577)});
});

test("route and request descriptors reject getters, proxies, inherited fields and array hooks without invocation", () => {
  let calls = 0;
  const trap = () => {calls += 1; throw new Error("must not execute");};
  const hostileProxy = (value: object) => new Proxy(value, {get: trap, getPrototypeOf: trap, ownKeys: trap,
    getOwnPropertyDescriptor: trap});
  const route = cases[0].factory("synthetic-receipt");
  assert.equal(snapshotHostHttpRoute(hostileProxy(route)), undefined);
  assert.equal(snapshotHostHttpRoute(Object.create(route)), undefined);
  for (const name of Object.keys(route)) {
    const access = Object.defineProperty({...route}, name, {get: trap});
    assert.equal(snapshotHostHttpRoute(Object.freeze(access)), undefined);
  }
  for (const field of ["forwardedRequestHeaderNames", "credentialFieldNames"] as const) {
    for (const value of [hostileProxy([...route[field]]), Object.defineProperty([...route[field]], "0", {get: trap}),
      Object.assign([...route[field]], {[Symbol.iterator]: trap}), Object.assign([...route[field]], {extra: "x"}),
      Object.assign([...route[field]], {0: "Version"}), [...route[field], route[field][0]]]) {
      assert.equal(snapshotHostHttpRoute(Object.freeze({...route, [field]: value})), undefined);
    }
  }
  const native = request(cases[0]);
  for (const name of Object.keys(native)) {
    assert.throws(() => presentationFields(Object.defineProperty({...native}, name, {get: trap}), route));
  }
  for (const value of [hostileProxy(native), {...native, headers: hostileProxy(native.headers)},
    {...native, headers: [hostileProxy(native.headers[0]!)]},
    {...native, headers: Object.defineProperty([...native.headers], "0", {get: trap})},
    {...native, headers: Object.assign([...native.headers], {[Symbol.iterator]: trap})},
    {...native, headers: [Object.defineProperty({...native.headers[0]}, "value", {get: trap})]},
    {...native, headers: [Object.create(native.headers[0]!)]}]) {
    assert.throws(() => presentationFields(value as never, route));
  }
  assert.equal(calls, 0);
});

test("rejected frozen, nonextensible and revoked route arrays never reach immutability reflection", () => {
  let calls = 0;
  const trap = () => {calls += 1; throw new Error("must not execute proxy reflection");};
  const route = cases[0].factory("synthetic-receipt");
  for (const name of ["forwardedRequestHeaderNames", "credentialFieldNames"] as const) {
    for (const array of [Object.freeze([...route[name]]), Object.preventExtensions([...route[name]])]) {
      const value = new Proxy(array, {get: trap, ownKeys: trap, getOwnPropertyDescriptor: trap, isExtensible: trap});
      assert.equal(snapshotHostHttpRoute(Object.freeze({...route, [name]: value})), undefined);
    }
    const revoked = Proxy.revocable([...route[name]], {}); revoked.revoke();
    assert.equal(snapshotHostHttpRoute(Object.freeze({...route, [name]: revoked.proxy})), undefined);
  }
  const native = request(cases[0]);
  const frozenHeaders = new Proxy(Object.freeze([...native.headers]), {ownKeys: trap, isExtensible: trap});
  assert.throws(() => presentationFields({...native, headers: frozenHeaders}, route));
  const revokedHeaders = Proxy.revocable(native.headers, {}); revokedHeaders.revoke();
  assert.throws(() => presentationFields({...native, headers: revokedHeaders.proxy}, route));
  assert.equal(calls, 0);
});

test("prepared profile carrier, nested arrays, names and bytes never execute getters or proxy traps", () => {
  let calls = 0;
  const trap = () => {calls += 1; throw new Error("must not execute");};
  const proxy = (value: object) => new Proxy(value, {get: trap, getPrototypeOf: trap, ownKeys: trap, getOwnPropertyDescriptor: trap});
  const prepared = input(); const value = envelope();
  denied(proxy(prepared));
  for (const name of Object.keys(prepared)) {denied(Object.defineProperty({...prepared}, name, {get: trap}));}
  for (const presentation of [proxy(value), {...value, extra: true}, Object.create(value),
    Object.defineProperty({...value}, "requestProfile", {get: trap}), Object.defineProperty({...value}, "fields", {get: trap}),
    {...value, fields: proxy(value.fields)}, {...value, fields: [proxy(value.fields[0]!)]},
    {...value, fields: Object.assign([...value.fields], {[Symbol.iterator]: trap})},
    {...value, fields: Object.defineProperty([...value.fields], "0", {get: trap})},
    {...value, fields: value.fields.map(field => ({...field, valueBytes: proxy(field.valueBytes)}))},
    {...value, fields: value.fields.map(field => Object.defineProperty({...field}, "name", {get: trap}))},
    {...value, fields: value.fields.map(field => Object.defineProperty({...field}, "valueBytes", {get: trap}))}]) {
    denied({...prepared, presentationFields: presentation});
  }
  const revoked = Proxy.revocable(value, {}); revoked.revoke();
  denied({...prepared, presentationFields: revoked.proxy});
  assert.equal(calls, 0);
});

test("native admission snapshots headers and prepared custody detaches all mutable byte sources", () => {
  const native = request(cases[0]); const route = cases[0].factory("synthetic-receipt");
  const selected = presentationFields(native, route); assert.ok("fields" in selected);
  native.headers[0] = {name: "x-arbitrary", value: "mutated"};
  const preparedInput = {...input(), presentationFields: selected};
  const prepared = createPreparedHttpRequestV1(preparedInput); const custody = prepared.consume(); assert.ok(custody);
  const wire = custody.wireBytes.slice(); const projectionBytes = custody.headerProjectionBytes.slice();
  for (const field of selected.fields) {field.valueBytes.fill(88);}
  preparedInput.bodyBytes.fill(89); preparedInput.hostBytes.fill(90);
  for (const field of preparedInput.credentialFields) {field.valueBytes.fill(91);}
  assert.deepEqual(custody.wireBytes, wire); assert.deepEqual(custody.headerProjectionBytes, projectionBytes);
  assert.equal(prepared.consume(), undefined); custody.dispose();
  assert.ok(custody.wireBytes.every(byte => byte === 0)); assert.ok(custody.headerProjectionBytes.every(byte => byte === 0));
});

test("native transport connection nominations are refused and encoded metadata cannot smuggle fields", async () => {
  for (const extra of [{name: "Connection", value: "version"}, {name: "version", value: "0.150.1\r\nX-Arbitrary: injected"}]) {
    const fixture = nativeFixture(cases[0], [...headers("codex"), extra]);
    const result = await createStrictHttpEgressBroker(fixture.ports).execute(fixture.operation);
    assert.notEqual(result.outcome, "completed"); assert.equal(fixture.observations.opens, 0);
    assert.equal(fixture.observations.renders, 0);
  }
});
