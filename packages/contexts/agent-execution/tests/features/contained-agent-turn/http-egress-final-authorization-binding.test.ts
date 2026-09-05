import assert from "node:assert/strict";
import {describe, test} from "node:test";
import type {HostHttpGrant, HostHttpProvisionalDecision} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/egress/http-egress-ports.js";
import {createStrictHttpEgressBroker} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/egress/strict-http-egress-broker.js";
import {createEgressFixture, SECRET_MARKER} from "./http-egress-test-fixture.ts";

describe("HTTP signed final authorization binding", () => {
  test("presents the complete provisional, resolver, TLS, PA, and request facts to final authorization", async () => {
    const fixture = createEgressFixture({addresses: ["2606:2800:0220:0001:0248:1893:25c8:1946", "93.184.216.34"]});
    const receipt = await createStrictHttpEgressBroker(fixture.ports).execute(fixture.operation);
    assert.equal(receipt.outcome, "completed");
    const input = fixture.observations.finalAuthorizationInputs[0];
    assert.equal(input.contractVersion, "provider-process-egress-final/v2");
    assert.equal(input.provisional.contractVersion, "provider-process-egress-provisional-decision/v2");
    assert.deepEqual(input.resolver.addresses.map((value: {address: string}) => value.address),
      ["2606:2800:0220:0001:0248:1893:25c8:1946", "93.184.216.34"]);
    assert.deepEqual(input.pinnedDestination, {address: "93.184.216.34", port: 443});
    assert.deepEqual(input.observedPeer, input.pinnedDestination);
    assert.equal(input.tls.certificateValidated, true);
    assert.equal(input.request, input.provisional.request);
  });

  test("rejects every substituted provisional request, policy, scope, and PA authority fact", async () => {
    const changes: Array<(value: HostHttpProvisionalDecision) => HostHttpProvisionalDecision> = [
      value => Object.freeze({...value, authorizationRequestId: "other-request"}),
      value => Object.freeze({...value, scope: Object.freeze({...value.scope, operationId: "other-operation"})}),
      value => Object.freeze({...value, policy: Object.freeze({...value.policy, dnsIdentity: "other.example"})}),
      value => Object.freeze({...value, providerAccess: Object.freeze({...value.providerAccess, accessRef: "other-access"})}),
      value => Object.freeze({...value, request: Object.freeze({...value.request,
        body: Object.freeze({...value.request.body, digest: "other-body"})})}),
    ];
    for (const mutateProvisional of changes) {
      const fixture = createEgressFixture({mutateProvisional});
      const receipt = await createStrictHttpEgressBroker(fixture.ports).execute(fixture.operation);
      assert.equal(receipt.anomalyCode, "provisional_denied");
      assert.equal(receipt.firstByteState, "not_sent");
      assert.equal(fixture.observations.opens, 0);
    }
  });

  test("rejects substituted final operation, request, PA, policy, limit, and consumption bindings", async () => {
    const changes: Array<(value: HostHttpGrant) => HostHttpGrant> = [
      value => Object.freeze({...value, payload: Object.freeze({...value.payload,
        scope: Object.freeze({...value.payload.scope, operationId: "other-operation"})})}),
      value => Object.freeze({...value, payload: Object.freeze({...value.payload,
        request: Object.freeze({...value.payload.request, body: Object.freeze({...value.payload.request.body, digest: "other"})})})}),
      value => Object.freeze({...value, payload: Object.freeze({...value.payload,
        providerAccess: Object.freeze({...value.payload.providerAccess, routeGeneration: "other"})})}),
      value => Object.freeze({...value, payload: Object.freeze({...value.payload,
        policy: Object.freeze({...value.payload.policy, policyGeneration: "other"})})}),
      value => Object.freeze({...value, payload: Object.freeze({...value.payload,
        limits: Object.freeze({...value.payload.limits, responseBytes: value.payload.limits.responseBytes + 1})})}),
      value => Object.freeze({...value, payload: Object.freeze({...value.payload, consumption: Object.freeze({
        ...value.payload.consumption, journalKey: Object.freeze({...value.payload.consumption.journalKey,
          boundaryUseId: "other-boundary"})})})}),
    ];
    for (const mutateGrant of changes) {
      const fixture = createEgressFixture({mutateGrant});
      const receipt = await createStrictHttpEgressBroker(fixture.ports).execute(fixture.operation);
      assert.equal(receipt.anomalyCode, "final_denied");
      assert.equal(receipt.firstByteState, "not_sent");
      assert.equal(fixture.observations.dispatches, 0);
    }
  });

  test("retains signed resolver identity, epoch, count, and canonical address binding", async () => {
    const substitutions = [
      {resolverIdentity: "other-resolver"}, {resolverEpoch: "other-epoch"}, {resolutionCount: 2},
      {normalizedAddresses: [{family: "ipv4", address: "93.184.216.35", classification: "public"}]},
      {normalizedAddresses: [{family: "ipv6", address: "93.184.216.34", classification: "public"}]},
      {normalizedAddresses: [{family: "ipv4", address: "93.184.216.34", classification: "private"}]},
    ];
    for (const substitution of substitutions) {
      const fixture = createEgressFixture({mutateGrant: value => Object.freeze({...value,
        payload: Object.freeze({...value.payload, resolver: Object.freeze({...value.payload.resolver,
          ...substitution})})}) as HostHttpGrant});
      const receipt = await createStrictHttpEgressBroker(fixture.ports).execute(fixture.operation);
      assert.equal(receipt.anomalyCode, "final_denied");
      assert.equal(receipt.firstByteState, "not_sent");
      assert.equal(fixture.observations.dispatches, 0);
    }
  });

  test("rejects final signing-key, evidence-key, signature, and V1 contract substitution", async () => {
    const changes: Array<(value: HostHttpGrant) => HostHttpGrant> = [
      value => Object.freeze({...value, signature: Object.freeze({...value.signature, keyRef: "other-key"})}),
      value => Object.freeze({...value, evidence: Object.freeze({...value.evidence,
        signingKey: Object.freeze({...value.evidence.signingKey, signerRevision: "other-revision"})})}),
      value => Object.freeze({...value, payload: Object.freeze({...value.payload,
        contractVersion: "provider-process-first-application-byte-grant/v1" as never})}),
    ];
    for (const mutateGrant of changes) {
      const fixture = createEgressFixture({mutateGrant});
      const receipt = await createStrictHttpEgressBroker(fixture.ports).execute(fixture.operation);
      assert.equal(receipt.anomalyCode, "final_denied");
      assert.equal(fixture.observations.dispatches, 0);
    }
  });

  for (const [name, bindingAtFirstByte] of [
    ["peer address", {peerAddress: "93.184.216.35"}], ["peer port", {peerPort: 8443}],
    ["TLS protocol", {tlsProtocol: "TLSv1.2"}], ["SNI", {sni: "other.example"}],
    ["certificate", {certificateDigest: "sha256:other"}], ["pin", {pinDigest: "sha256:other"}],
    ["ALPN", {alpn: "h2"}],
  ] as const) {
    test(`rejects ${name} drift at the one-shot byte handoff`, async () => {
      const fixture = createEgressFixture({bindingAtFirstByte: bindingAtFirstByte as never});
      const receipt = await createStrictHttpEgressBroker(fixture.ports).execute(fixture.operation);
      assert.equal(receipt.anomalyCode, "transport_binding_drift");
      assert.equal(receipt.firstByteState, "not_sent");
      assert.equal(fixture.observations.dispatches, 0);
    });
  }

  test("normalizes address membership while rejecting duplicates and 6to4", async () => {
    for (const addresses of [["93.184.216.34", "93.184.216.34"],
      ["2606:2800:0220:0001:0248:1893:25c8:1946", "2606:2800:220:1:248:1893:25c8:1946"],
      ["2002:7f00:1::"]]) {
      const fixture = createEgressFixture({addresses, selectedAddress: addresses[0]});
      const receipt = await createStrictHttpEgressBroker(fixture.ports).execute(fixture.operation);
      assert.equal(receipt.anomalyCode, "resolution_denied");
      assert.equal(fixture.observations.opens, 0);
    }
  });

  test("snapshots request identity and effective limits before asynchronous authorization", async () => {
    const base = createEgressFixture(); const sourceLimits = {...base.operation.limits};
    const sourceRequest = {...base.operation.expectedRequest};
    const fixture = createEgressFixture({mutateGrant: value => {sourceLimits.maxOutputBytes += 1;
      sourceRequest.requestId = "mutated-request"; return value;}});
    const receipt = await createStrictHttpEgressBroker(fixture.ports).execute({...fixture.operation,
      limits: sourceLimits, expectedRequest: sourceRequest});
    assert.equal(receipt.outcome, "completed");
    assert.equal(receipt.requestId, "request-egress-1");
    assert.equal(fixture.observations.finalAuthorizationInputs[0].request.body.byteLength, 2);
  });

  test("signed projections and retained final inputs contain digests but no credential bytes", async () => {
    const fixture = createEgressFixture();
    await createStrictHttpEgressBroker(fixture.ports).execute(fixture.operation);
    assert.doesNotMatch(JSON.stringify(fixture.observations.provisionalInputs), new RegExp(SECRET_MARKER));
    assert.doesNotMatch(JSON.stringify(fixture.observations.finalAuthorizationInputs), new RegExp(SECRET_MARKER));
  });
});
