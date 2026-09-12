import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {test} from "node:test";
import {createStrictHttpEgressBroker} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/egress/strict-http-egress-broker.js";
import {createEgressFixture, defaultRoute} from "./http-egress-test-fixture.ts";

const target = "/v1/messages?beta=true";
const request = (path: string): string => `POST ${path} HTTP/1.1\r\nHost: broker.invalid\r\nContent-Length: 2\r\n\r\n{}`;
const digest = (value: string): string => createHash("sha256").update(value).digest("hex");

test("carries the exact provider query through ingress, signed authorization, and the upstream request", async () => {
  const fixture = createEgressFixture({request: [request(target)], route: {...defaultRoute, upstreamPath: target}});
  const operation = {...fixture.operation, expectedRequest: {...fixture.operation.expectedRequest, path: target}};
  const receipt = await createStrictHttpEgressBroker(fixture.ports).execute(operation);
  assert.equal(receipt.outcome, "completed");
  assert.equal(fixture.observations.dispatches, 1);
  assert.match(new TextDecoder().decode(fixture.observations.dispatchedRequests[0]), /^POST \/v1\/messages\?beta=true HTTP\/1\.1\r\n/);
  const expected = {digest: digest(target), byteLength: Buffer.byteLength(target)};
  assert.deepEqual(fixture.observations.provisionalInputs[0].request.requestTarget, expected);
  assert.deepEqual(fixture.observations.finalAuthorizationInputs[0].request.requestTarget, expected);
});

for (const actual of ["/v1/messages", "/v1/messages?beta=false", "/v1/messages?beta=true&beta=false",
  "/v1/messages?%62eta=true", "/v1/messages?beta=true&", "/v1/messages?beta=true?"]) {
  test(`rejects query identity drift ${actual} before authorization or any upstream open`, async () => {
    const fixture = createEgressFixture({request: [request(actual)], route: {...defaultRoute, upstreamPath: target}});
    const receipt = await createStrictHttpEgressBroker(fixture.ports).execute({...fixture.operation,
      expectedRequest: {...fixture.operation.expectedRequest, path: target}});
    assert.equal(receipt.anomalyCode, "inbound_route_mismatch");
    assert.equal(receipt.firstByteState, "not_sent");
    assert.equal(fixture.observations.provisionalInputs.length, 0);
    assert.equal(fixture.observations.renders, 0);
    assert.equal(fixture.observations.opens, 0);
    assert.equal(fixture.observations.dispatches, 0);
  });
}

test("the trusted upstream query stays independent of the child request-target", async () => {
  const fixture = createEgressFixture({route: {...defaultRoute, upstreamPath: target}});
  const receipt = await createStrictHttpEgressBroker(fixture.ports).execute(fixture.operation);
  assert.equal(receipt.outcome, "completed");
  assert.match(new TextDecoder().decode(fixture.observations.dispatchedRequests[0]), /^POST \/v1\/messages\?beta=true HTTP\/1\.1\r\n/);
  assert.equal(fixture.observations.finalAuthorizationInputs[0].request.requestTarget.digest, digest(target));
});

test("a final grant bound to another query cannot dispatch", async () => {
  const fixture = createEgressFixture({route: {...defaultRoute, upstreamPath: target},
    mutateGrant: grant => ({...grant, payload: {...grant.payload, request: {...grant.payload.request,
      requestTarget: {digest: digest("/v1/messages?beta=false"), byteLength: target.length + 1}}}})});
  const receipt = await createStrictHttpEgressBroker(fixture.ports).execute(fixture.operation);
  assert.notEqual(receipt.outcome, "completed");
  assert.equal(receipt.firstByteState, "not_sent");
  assert.equal(fixture.observations.dispatches, 0);
});
