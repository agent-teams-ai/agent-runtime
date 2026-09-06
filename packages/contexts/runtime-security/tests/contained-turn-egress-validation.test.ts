import assert from "node:assert/strict";
import test from "node:test";
import { containedTurnEgressProviderBindingDigest, createContainedTurnEgressGateway } from "../dist/composition.js";
import { deniedRequest, dispatch, frame, harness, host, receipt, request, route, sha, wire } from "./fixtures/contained-turn-egress.ts";

test("literal dot path segments reject requests and route authority before transport", async () => {
  for (const path of ["/.", "/..", "/./v1", "/../admin", "/v1/./turn", "/v1/../admin",
    "/v1/.", "/v1/..", "/v1/./", "/v1/../", "/v1/.?mode=test", "/v1/..?mode=test",
    "/v1/%2e/turn", "/v1/%2E%2e/admin"]) {
    await deniedRequest(request({path}));
    const selected = route({pathConstraint: path});
    assert.equal(containedTurnEgressProviderBindingDigest(selected), undefined, path);
    const fixture = harness({route: selected});
    assert.deepEqual(await createContainedTurnEgressGateway(host(), fixture.dependencies).exchange(request()),
      {status: "denied", reason: "route_unavailable", deniedApplicationBytes: 0}, path);
    assert.deepEqual(fixture.events, ["route:resolve"]);
    assert.equal(fixture.emittedApplicationBytes.length, 0);
  }
});

test("valid dotted paths and query dot text retain exact target bytes and canonical digests", async () => {
  for (const path of ["/", "/v1/turn", "/v1/", "/.well-known/config.json", "/v1/model..json",
    "/v1/.../turn", "/v1/%41", "/v1/turn?next=/../admin", "/v1/turn?next=/./"]) {
    const selected = route({pathConstraint: path});
    const providerBindingDigest = containedTurnEgressProviderBindingDigest(selected);
    assert.ok(providerBindingDigest, path);
    const candidate = request({path, dispatch: {...dispatch, providerBindingDigest}});
    const fixture = harness({route: selected, dispatchOutcome: Object.freeze({status: "consumed",
      lifecycleState: "claim_committed", receipt: receipt({providerBindingDigest})})});
    assert.equal((await createContainedTurnEgressGateway(host(), fixture.dependencies).exchange(candidate)).status, "completed", path);
    assert.deepEqual(fixture.emittedApplicationBytes, [Uint8Array.from(wire(candidate))]);
    assert.equal(fixture.authorizations[0]?.target.pathDigest, sha(frame("contained-turn-egress-path/v1", [path])));
    assert.equal(fixture.authorizations[0]?.applicationBytesDigest, sha(wire(candidate)));
  }
});

test("duplicate normalized header names reject even with identical or nonadjacent values", async () => {
  for (const name of ["accept", "content-type", "x-request-class"]) {
    for (const value of ["application/json", "text/plain"]) {
      await deniedRequest(request({headers: [{name, value: "application/json"}, {name, value}]}));
      await deniedRequest(request({headers: [{name, value: "application/json"},
        {name: "x-other", value: "synthetic"}, {name, value}]}));
    }
  }
  // Names already must be lowercase; case variants do not become a normalization escape.
  await deniedRequest(request({headers: [{name: "accept", value: "application/json"}, {name: "Accept", value: "text/plain"}]}));
  await deniedRequest(request({headers: [{name: "Accept", value: "application/json"}]}));
  await deniedRequest(request({headers: [{name: "authorization", value: "synthetic"}]}));
});

test("unique normalized headers retain order, values, and the existing canonical digest", async () => {
  const headers = [{name: "accept", value: "application/json"}, {name: "content-type", value: "application/json"},
    {name: "x-request-class", value: ""}, {name: "x-request-class-2", value: "synthetic"}];
  const digests: string[] = [];
  for (const values of [headers, headers.toReversed(), []]) {
    const candidate = request({headers: values}); const fixture = harness();
    assert.equal((await createContainedTurnEgressGateway(host(), fixture.dependencies).exchange(candidate)).status, "completed");
    assert.deepEqual(fixture.transported.headers, values);
    assert.deepEqual(fixture.emittedApplicationBytes, [Uint8Array.from(wire(candidate))]);
    const digest = fixture.authorizations[0]!.headerDigest;
    assert.equal(digest, sha(frame("contained-turn-egress-headers/v1", values.flatMap(header => [header.name, header.value]))));
    digests.push(digest);
  }
  assert.equal(new Set(digests).size, 3);
});
