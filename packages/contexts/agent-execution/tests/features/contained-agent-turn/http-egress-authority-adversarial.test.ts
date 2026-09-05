import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { HostHttpGrant } from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/egress/http-egress-ports.js";
import { createStrictHttpEgressBroker } from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/egress/strict-http-egress-broker.js";
import { isPublicEgressAddress } from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/egress/public-address-policy.js";
import { createEgressFixture, defaultRoute, denyDecision } from "./http-egress-test-fixture.ts";

describe("strict egress authority ordering", () => {
  const unsafeAddresses = [
    "0.0.0.0", "10.0.0.1", "100.64.0.1", "127.0.0.1", "169.254.169.254",
    "172.16.0.1", "192.0.2.1", "192.168.1.1", "198.18.0.1", "198.51.100.2",
    "203.0.113.8", "224.0.0.1", "240.0.0.1", "255.255.255.255", "::", "::1",
    "::ffff:127.0.0.1", "fc00::1", "fe80::1", "ff02::1", "2001:db8::1",
  ] as const;

  test("admits only syntactically public addresses", () => {
    for (const address of unsafeAddresses) {assert.equal(isPublicEgressAddress(address), false, address);}
    assert.equal(isPublicEgressAddress("93.184.216.34"), true);
    assert.equal(isPublicEgressAddress("2606:2800:220:1:248:1893:25c8:1946"), true);
  });

  for (const address of unsafeAddresses) {
    test(`denies unsafe resolution ${address} after provisional authorization and before dial`, async () => {
      const fixture = createEgressFixture({ addresses: [address], selectedAddress: address });
      const receipt = await createStrictHttpEgressBroker(fixture.ports).execute(fixture.operation);
      assert.equal(receipt.anomalyCode, "resolution_denied");
      assert.equal(receipt.upstreamRequestBytes, 0);
      assert.equal(fixture.observations.order.indexOf("provisional") < fixture.observations.order.indexOf("resolve"), true);
      assert.equal(fixture.observations.opens, 0);
    });
  }

  test("denies a mixed public/private rebinding answer", async () => {
    const fixture = createEgressFixture({ addresses: ["93.184.216.34", "10.0.0.7"] });
    const receipt = await createStrictHttpEgressBroker(fixture.ports).execute(fixture.operation);
    assert.equal(receipt.anomalyCode, "resolution_denied");
    assert.equal(fixture.observations.opens, 0);
  });

  test("denies public-to-private peer rebinding", async () => {
    const fixture = createEgressFixture({
      binding: Object.freeze({
        peerAddress: "10.0.0.7",
        tlsProtocol: "TLSv1.3",
        sni: defaultRoute.sni,
        sniDigest: defaultRoute.sniDigest,
        certificateDigest: defaultRoute.certificateDigest,
        pinDigest: defaultRoute.pinDigest,
        alpn: defaultRoute.alpn,
      }),
    });
    const receipt = await createStrictHttpEgressBroker(fixture.ports).execute(fixture.operation);
    assert.equal(receipt.anomalyCode, "transport_binding_drift");
    assert.equal(receipt.upstreamRequestBytes, 0);
    assert.equal(fixture.observations.dispatches, 0);
  });

  const bindingDrifts = [
    { name: "peer", changes: { peerAddress: "93.184.216.35" } },
    { name: "requested SNI", changes: { requestedSni: "other.example" } },
    { name: "observed SNI", changes: { observedSni: "other.example" } },
    { name: "chain validation", changes: { chainValidated: false as never } },
    { name: "DNS identity", changes: { dnsIdentity: "other.example" } },
    { name: "ALPN", changes: { alpn: "h2" } },
  ] as const;

  for (const drift of bindingDrifts) {
    test(`denies ${drift.name} drift before the first upstream byte`, async () => {
      const fixture = createEgressFixture({
        binding: Object.freeze({
          peerAddress: "93.184.216.34",
          tlsProtocol: "TLSv1.3" as const,
          sni: defaultRoute.sni,
          sniDigest: defaultRoute.sniDigest,
          certificateDigest: defaultRoute.certificateDigest,
          pinDigest: defaultRoute.pinDigest,
          alpn: defaultRoute.alpn,
          ...drift.changes,
        }),
      });
      const receipt = await createStrictHttpEgressBroker(fixture.ports).execute(fixture.operation);
      assert.equal(receipt.anomalyCode, "transport_binding_drift");
      assert.equal(receipt.firstByteState, "not_sent");
      assert.equal(fixture.observations.dispatches, 0);
    });
  }

  const providerAccessDrifts = ["bindingRevision", "credentialGeneration", "credentialBindingDigest", "accessRef",
    "providerRouteRef"] as const;
  for (const key of providerAccessDrifts) {
    test(`denies Provider Access ${key} drift before credential rendering`, async () => {
      const fixture = createEgressFixture({paReceiptChange: {[key]: key.includes("Generation") || key === "bindingRevision"
        ? 999 : "drifted-authority"}});
      const receipt = await createStrictHttpEgressBroker(fixture.ports).execute(fixture.operation);
      assert.equal(receipt.anomalyCode, "provider_access_denied");
      assert.equal(fixture.observations.renders, 0);
      assert.equal(fixture.observations.dispatches, 0);
    });
  }

  for (const scenario of [
    { name: "provisional deny", options: { provisional: denyDecision(defaultRoute, "provisional-deny") }, anomaly: "provisional_denied" },
    { name: "provisional expiry", options: { provisional: Object.freeze({ ...denyDecision(defaultRoute, "provisional-expired"), decision: "allow" as const, validUntil: 0 }) }, anomaly: "provisional_denied" },
    { name: "provisional timeout", options: { provisional: "timeout" as const }, anomaly: "provisional_timeout" },
    { name: "final deny", options: { final: denyDecision(defaultRoute, "final-deny") }, anomaly: "final_denied" },
    { name: "final expiry", options: { mutateGrant: (grant: HostHttpGrant) => Object.freeze({...grant,
      payload: Object.freeze({...grant.payload, time: Object.freeze({...grant.payload.time,
        expiresAtControlTime: 0})})}) }, anomaly: "final_denied" },
    { name: "final timeout", options: { final: "timeout" as const }, anomaly: "final_timeout" },
  ] as const) {
    test(`${scenario.name} proves zero upstream request bytes`, async () => {
      const fixture = createEgressFixture(scenario.options);
      const receipt = await createStrictHttpEgressBroker(fixture.ports).execute(fixture.operation);
      assert.equal(receipt.anomalyCode, scenario.anomaly);
      assert.equal(receipt.upstreamRequestBytes, 0);
      assert.equal(receipt.firstByteState, "not_sent");
      assert.equal(fixture.observations.dispatches, 0);
    });
  }

  test("Provider Access revocation after dial proves zero request bytes", async () => {
    const fixture = createEgressFixture({secondObserveDenied: true});
    const receipt = await createStrictHttpEgressBroker(fixture.ports).execute(fixture.operation);
    assert.equal(receipt.anomalyCode, "provider_generation_drift");
    assert.equal(receipt.upstreamRequestBytes, 0);
    assert.equal(fixture.observations.dispatches, 0);
  });

  for (const [name, mutateGrant] of [
    ["operation", (grant: HostHttpGrant) => Object.freeze({...grant, payload: Object.freeze({...grant.payload,
      scope: Object.freeze({...grant.payload.scope, operationId: `${grant.payload.scope.operationId}-drifted`})})})],
    ["request digest", (grant: HostHttpGrant) => Object.freeze({...grant, payload: Object.freeze({...grant.payload,
      request: Object.freeze({...grant.payload.request, body: Object.freeze({...grant.payload.request.body,
        digest: `${grant.payload.request.body.digest}-drifted`})})})})],
    ["route authority", (grant: HostHttpGrant) => Object.freeze({...grant, payload: Object.freeze({...grant.payload,
      providerAccess: Object.freeze({...grant.payload.providerAccess, routeRef: `${grant.payload.providerAccess.routeRef}-drifted`})})})],
    ["observed peer", (grant: HostHttpGrant) => Object.freeze({...grant, payload: Object.freeze({...grant.payload,
      selectedPeer: Object.freeze({...grant.payload.selectedPeer, address: "93.184.216.35"})})})],
    ["output limit", (grant: HostHttpGrant) => Object.freeze({...grant, payload: Object.freeze({...grant.payload,
      limits: Object.freeze({...grant.payload.limits, responseBytes: grant.payload.limits.responseBytes + 1})})})],
  ] as const) {
    test(`final authorization rejects ${name} drift with zero bytes`, async () => {
      const fixture = createEgressFixture({mutateGrant});
      const receipt = await createStrictHttpEgressBroker(fixture.ports).execute(fixture.operation);
      assert.equal(receipt.anomalyCode, "final_denied");
      assert.equal(receipt.upstreamRequestBytes, 0);
      assert.equal(fixture.observations.dispatches, 0);
    });
  }
});
