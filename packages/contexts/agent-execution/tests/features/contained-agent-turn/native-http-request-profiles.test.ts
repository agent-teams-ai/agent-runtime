import assert from "node:assert/strict";
import { test } from "node:test";
import { createStrictHttpEgressBroker } from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/egress/strict-http-egress-broker.js";
import { snapshotHostHttpRoute, presentationFields } from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/egress/http-egress-session-authority.js";
import { createPreparedHttpRequestV1 } from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/egress/prepared-http-request-v1.js";
import { nativeHttpRequestProfile } from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/egress/native-http-request-profile.js";
import { bytes, createEgressFixture } from "./http-egress-test-fixture.ts";
import { cases, headers, body, beta, request, nativeFixture, credential, projection, sha } from "./native-http-request-profile-fixture.ts";

const decoder = new TextDecoder();
for (const candidate of cases) {
  test(`${candidate.factory.name}: exact native bytes, body and signed canonical projection`, async () => {
    const fixture = nativeFixture(candidate);
    const result = await createStrictHttpEgressBroker(fixture.ports).execute(fixture.operation);
    assert.equal(result.outcome, "completed");
    const lines = headers(candidate.provider).toSorted((a, b) => a.name < b.name ? -1 : 1)
      .map(field => `${field.name}: ${field.value}\r\n`);
    lines.push(`Host: ${candidate.host}\r\n`, ...candidate.credentials.slice().toSorted().map(name => `${name}: ${credential(name)}\r\n`),
      `Content-Length: ${body().byteLength}\r\n`);
    const expected = Buffer.concat([Buffer.from(`POST ${candidate.path} HTTP/1.1\r\n${lines.join("")}\r\n`), body()]);
    assert.deepEqual(fixture.observations.dispatchedRequests[0], new Uint8Array(expected));
    const provisional = fixture.observations.provisionalInputs[0].request;
    const final = fixture.observations.finalAuthorizationInputs[0];
    assert.deepEqual(provisional, final.request);
    assert.equal(fixture.ports.verifier.verifyProvisionalDecision(final.provisional), true);
    assert.equal(fixture.ports.verifier.verifyProvisionalDecision({...final.provisional, request: {...provisional,
      headers: {...provisional.headers, canonicalDigest: "tampered"}}}), false);
    assert.deepEqual(provisional.authority, {hostname: candidate.host, port: 443});
    assert.deepEqual(provisional.requestTarget, {digest: sha(bytes(candidate.path)), byteLength: candidate.path.length});
    assert.deepEqual(provisional.body, {digest: sha(body()), byteLength: body().byteLength});
    assert.equal(provisional.headers.canonicalDigest, sha(projection(lines)));
    assert.equal(provisional.headers.fieldCount, lines.length);
    assert.deepEqual(provisional.headers.credentialFields, candidate.credentials.slice().toSorted().map(name => ({name,
      credentialBindingDigest: fixture.ports.providerAccessSnapshot.ownerAuthorityDigest,
      valueDigest: sha(bytes(credential(name))), byteLength: bytes(credential(name)).length})));
    assert.ok(fixture.rendered.every(value => value.every(byte => byte === 0)));
    assert.deepEqual(fixture.nativeBody, body(), "the inbound caller retains its own body bytes");
    assert.doesNotMatch(decoder.decode(expected), /fixture-broker|synthetic-ambient-account|broker.invalid|accept-encoding:|connection:/i);
    assert.doesNotMatch(JSON.stringify(fixture.observations.receipts), /synthetic-PA-/);
    assert.equal(fixture.observations.opens, 1); assert.equal(fixture.observations.dispatches, 1);
  });

  test(`${candidate.factory.name}: immutable exact route, no alternate origins, paths, modes or profiles`, () => {
    const route = candidate.factory("synthetic-route-receipt");
    assert.deepEqual(snapshotHostHttpRoute(route), route);
    assert.ok(Object.isFrozen(route)); assert.ok(Object.isFrozen(route.credentialFieldNames));
    assert.ok(Object.isFrozen(route.forwardedRequestHeaderNames));
    assert.equal(snapshotHostHttpRoute({...route}), undefined, "mutable native route rejected");
    for (const change of [{originHost: "other.example"}, {originHost: candidate.host.toUpperCase()}, {originPort: 444},
      {upstreamPath: `${candidate.path}&extra=true`}, {upstreamPath: `${candidate.path}/`}, {upstreamMethod: "GET"},
      {requestProfile: "unknown"}, {requestProfile: undefined}, {extra: true},
      {credentialFieldNames: Object.freeze(["cookie"])}, {forwardedRequestHeaderNames: Object.freeze(["accept", "content-type"])},
      {forwardedRequestHeaderNames: [...route.forwardedRequestHeaderNames]}, {credentialFieldNames: [...route.credentialFieldNames]}]) {
      assert.equal(snapshotHostHttpRoute(Object.freeze({...route, ...change})), undefined);
    }
    for (const name of route.forwardedRequestHeaderNames) {
      assert.equal(snapshotHostHttpRoute(Object.freeze({...route, credentialFieldNames: Object.freeze([name])})), undefined);
    }
    for (const alternative of cases.filter(value => value !== candidate)) {
      const selected = alternative.factory("synthetic-route-receipt");
      assert.equal(snapshotHostHttpRoute(Object.freeze({...route, requestProfile: selected.requestProfile})), undefined);
    }
  });

  test(`${candidate.factory.name}: missing required native fields fail before PA or transport`, async () => {
    const profile = nativeHttpRequestProfile(candidate.factory("synthetic-route-receipt").requestProfile)!;
    for (const name of profile.requiredHeaderNames) {
      const fixture = nativeFixture(candidate, headers(candidate.provider).filter(field => field.name !== name));
      const result = await createStrictHttpEgressBroker(fixture.ports).execute(fixture.operation);
      assert.equal(result.outcome, "denied", name); assert.equal(fixture.observations.renders, 0);
      assert.equal(fixture.observations.materializationInputs.length, 0); assert.equal(fixture.observations.opens, 0);
    }
  });

  test(`${candidate.factory.name}: wrong provider and unexpected native target never materialize`, async () => {
    for (const options of [{provider: candidate.provider === "codex" ? "claude" as const : "codex" as const},
      {path: `${candidate.path}?extra=true`}, {path: "/invoke"}, {method: "GET"}]) {
      const fixture = nativeFixture(candidate, headers(candidate.provider), options);
      const result = await createStrictHttpEgressBroker(fixture.ports).execute(fixture.operation);
      assert.notEqual(result.outcome, "completed"); assert.equal(fixture.observations.renders, 0);
      assert.equal(fixture.observations.materializationInputs.length, 0); assert.equal(fixture.observations.opens, 0);
    }
  });

  test(`${candidate.factory.name}: canonical reordering and metadata mutation affect signed bytes precisely`, async () => {
    const original = nativeFixture(candidate); const reordered = nativeFixture(candidate, headers(candidate.provider).toReversed());
    const fieldName = candidate.provider === "codex" ? "x-codex-turn-metadata" : "x-claude-code-session-id";
    const changed = nativeFixture(candidate, headers(candidate.provider).map(field => field.name === fieldName
      ? {...field, value: "synthetic-alternate-metadata"} : field));
    for (const fixture of [original, reordered, changed]) {
      assert.equal((await createStrictHttpEgressBroker(fixture.ports).execute(fixture.operation)).outcome, "completed");
    }
    assert.deepEqual(original.observations.dispatchedRequests, reordered.observations.dispatchedRequests);
    assert.equal(original.observations.provisionalInputs[0].request.headers.canonicalDigest,
      reordered.observations.provisionalInputs[0].request.headers.canonicalDigest);
    assert.notEqual(original.observations.provisionalInputs[0].request.headers.canonicalDigest,
      changed.observations.provisionalInputs[0].request.headers.canonicalDigest);
  });
}

for (const [name, value] of [["version", "0.150.2"], ["content-type", "text/plain"], ["anthropic-version", "2023-06-02"],
  ["anthropic-beta", `${beta},unknown-beta`], ["anthropic-beta", beta.split(",").toReversed().join(",")],
  ["x-app", "web"], ["anthropic-dangerous-direct-browser-access", "false"], ["x-stainless-retry-count", "1"]]) {
  test(`literal native value rejects ${name}=${value}`, async () => {
    const candidate = name === "version" ? cases[0] : cases[2];
    const fixture = nativeFixture(candidate, headers(candidate.provider).map(field => field.name === name ? {...field, value} : field));
    const result = await createStrictHttpEgressBroker(fixture.ports).execute(fixture.operation);
    assert.equal(result.outcome, "denied"); assert.equal(fixture.observations.renders, 0);
    assert.equal(fixture.observations.opens, 0);
  });
}

for (const name of ["x-arbitrary", "x-api-key", "cookie", "proxy-authorization", "proxy-authenticate", "proxy-connection",
  "keep-alive", "te", "trailer", "transfer-encoding", "upgrade", "expect"]) {
  test(`native whitelist never forwards or accepts ${name}`, async () => {
    const fixture = nativeFixture(cases[0], [...headers("codex"), {name, value: "synthetic"}]);
    const result = await createStrictHttpEgressBroker(fixture.ports).execute(fixture.operation);
    assert.notEqual(result.outcome, "completed"); assert.equal(fixture.observations.renders, 0);
    assert.equal(fixture.observations.opens, 0);
  });
}

test("cross-provider protocol substitution and duplicate case aliases fail closed", async () => {
  for (const candidate of [cases[0], cases[2]]) {
    const other = candidate.provider === "codex" ? "anthropic-beta" : "x-codex-turn-metadata";
    for (const extra of [{name: other, value: "synthetic"}, {name: "Content-Type", value: "application/json"},
      {name: "CONTENT-TYPE", value: "application/json"}, {name: "Accept-Encoding", value: "identity"},
      {name: "Authorization", value: "Bearer duplicate"}, {name: "Host", value: "broker.invalid"}]) {
      const fixture = nativeFixture(candidate, [...headers(candidate.provider), extra]);
      assert.notEqual((await createStrictHttpEgressBroker(fixture.ports).execute(fixture.operation)).outcome, "completed");
      assert.equal(fixture.observations.opens, 0); assert.equal(fixture.observations.renders, 0);
    }
  }
});

test("auxiliary native routes and Claude query variants stay unsupported", async () => {
  for (const path of ["/api/hello", "/v1/messages", "/v1/messages?beta=false", "/v1/messages?%62eta=true",
    "/v1/messages?beta=True", "/v1/messages?beta=true&", "/v1/messages?beta=true&beta=true"]) {
    const fixture = nativeFixture(cases[2], headers("claude"), {path});
    assert.equal((await createStrictHttpEgressBroker(fixture.ports).execute(fixture.operation)).outcome, "rejected");
    assert.equal(fixture.observations.renders, 0);
  }
  const auxiliary = nativeFixture(cases[0], headers("codex"), {method: "GET", path: "/backend-api/wham/settings/user"});
  assert.equal((await createStrictHttpEgressBroker(auxiliary.ports).execute(auxiliary.operation)).outcome, "rejected");
  assert.equal(auxiliary.observations.opens, 0);
  const preflight = nativeFixture(cases[2], headers("claude"), {method: "HEAD", path: "/api/hello"});
  assert.equal((await createStrictHttpEgressBroker(preflight.ports).execute(preflight.operation)).outcome, "rejected");
  assert.equal(preflight.observations.opens, 0);
});

test("generic synthetic routes remain two-header and do not inherit native admission", async () => {
  const fixture = createEgressFixture();
  const route = {...fixture.ports.route, forwardedRequestHeaderNames: ["version"]};
  assert.equal(snapshotHostHttpRoute(route), undefined);
  assert.throws(() => createPreparedHttpRequestV1({methodBytes: bytes("POST"), targetBytes: bytes("/v1/responses"),
    hostBytes: bytes("api.openai.com"), presentationFields: [{name: "version", valueBytes: bytes("0.153.4")}],
    credentialHeaderNameAllowlist: ["authorization"], credentialFields: [{name: "authorization", valueBytes: bytes("synthetic")}],
    bodyBytes: body()}));
  assert.equal((await createStrictHttpEgressBroker(fixture.ports).execute(fixture.operation)).outcome, "completed");
});

test("negative 503 closes the session and cannot authorize a native retry", async () => {
  const fixture = nativeFixture(cases[2], headers("claude"), {response: "HTTP/1.1 503 Unavailable\r\nContent-Length: 0\r\n\r\n"});
  const broker = createStrictHttpEgressBroker(fixture.ports);
  const result = await broker.execute(fixture.operation);
  assert.equal(result.anomalyCode, "upstream_server_error");
  const retried = await broker.execute(fixture.operation);
  assert.equal(retried.firstByteState, "not_sent");
  assert.equal(fixture.observations.opens, 1); assert.equal(fixture.observations.dispatches, 1);
  assert.equal(fixture.observations.renders, 1); assert.equal(fixture.observations.closes, 1);
});

test("native materializer credentials are mandatory, explicit, and never fall back to ambient authorization", async () => {
  for (const candidate of cases) {
    for (const rendered of [[], [{name: "authorization", valueBytes: bytes("synthetic")}],
      [{name: "x-api-key", valueBytes: bytes("synthetic")}], [{name: "version", valueBytes: bytes("synthetic")}]] ) {
      if (rendered.length === candidate.credentials.length && rendered.every(field => candidate.credentials.includes(field.name as never))) {continue;}
      const fixture = nativeFixture(candidate);
      const ports = {...fixture.ports, materializer: {render: async () => rendered}};
      assert.equal((await createStrictHttpEgressBroker(ports).execute(fixture.operation)).outcome, "denied");
      assert.equal(fixture.observations.opens, 0);
    }
  }
});

test("Codex optional per-turn metadata can be absent without inventing values", () => {
  const route = cases[0].factory("synthetic-route-receipt");
  const required = headers("codex").filter(field => ["accept", "content-type", "version", "originator", "user-agent"].includes(field.name));
  const fields = presentationFields(request(cases[0], required), route);
  assert.ok("fields" in fields); assert.equal(fields.fields.length, required.length);
});
