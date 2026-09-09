import assert from "node:assert/strict";
import {test} from "node:test";
import {NodeHttpEgressTrustedResolver} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/egress/node-http-egress-trusted-resolver.js";
import {createStrictHttpEgressBroker} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/egress/strict-http-egress-broker.js";
import {createEgressFixture} from "./http-egress-test-fixture.ts";

const absent = () => Promise.reject(Object.assign(new Error("absent"), {code: "ENODATA"}));
const options = {resolverIdentity: "node-dns", resolverEpoch: "boot-1", timeoutMs: 100};

test("broker binds the complete Node observation and its selected literal into final authorization", async () => {
  const fixture = createEgressFixture();
  const calls: string[] = [];
  let cancellations = 0;
  const resolver = new NodeHttpEgressTrustedResolver(options, fixture.ports.clock, () => ({
    resolve4: async host => {calls.push(host); return ["93.184.216.34"];},
    resolve6: absent, cancel: () => {cancellations++;},
  }));
  const receipt = await createStrictHttpEgressBroker({...fixture.ports, resolver, transport: {
    beginOpen: input => {
      assert.equal(input.selectedAddress, "93.184.216.34");
      assert.equal(input.originHost, "provider.example");
      assert.equal(input.sni, "provider.example");
      return fixture.ports.transport.beginOpen(input);
    },
  }}).execute(fixture.operation);
  assert.equal(receipt.outcome, "completed");
  assert.equal(fixture.observations.dispatches, 1);
  assert.equal(cancellations, 1);
  assert.deepEqual(calls, ["provider.example"]);
  const [authorization] = fixture.observations.finalAuthorizationInputs;
  assert.deepEqual(authorization.resolver, {
    resolverIdentity: "node-dns", resolverEpoch: "boot-1", resolutionCount: 1,
    addresses: [{address: "93.184.216.34", family: "ipv4", classification: "public"}],
  });
  assert.deepEqual(authorization.pinnedDestination, {address: "93.184.216.34", port: 443});
});

for (const failure of ["private", "partial", "empty"]) {
  test(`Node DNS ${failure} failure prevents TLS opening and final authorization`, async () => {
    const fixture = createEgressFixture();
    let cancellations = 0;
    const resolver = new NodeHttpEgressTrustedResolver(options, fixture.ports.clock, () => ({
      resolve4: async () => failure === "private" ? ["93.184.216.34", "10.0.0.1"]
        : failure === "empty" ? [] : ["93.184.216.34"],
      resolve6: failure === "partial" ? async () => {throw new Error("timeout");} : absent,
      cancel: () => {cancellations++;},
    }));
    const receipt = await createStrictHttpEgressBroker({...fixture.ports, resolver}).execute(fixture.operation);
    assert.equal(receipt.outcome, "denied");
    assert.equal(receipt.anomalyCode, "resolution_denied");
    assert.equal(receipt.firstByteState, "not_sent");
    assert.equal(fixture.observations.opens, 0);
    assert.equal(fixture.observations.dispatches, 0);
    assert.equal(fixture.observations.finalAuthorizationInputs.length, 0);
    assert.equal(cancellations, 1);
  });
}
