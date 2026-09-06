import assert from "node:assert/strict";
import test from "node:test";
import { fixture as hostFixture } from "./node-custody-http-reservation-fixture.ts";
import { networkFixture } from "../../fixtures/docker-operation-network-fixture.ts";
const {createDockerHostHttpResources} = await import("../../../dist/features/contained-agent-turn/composition/docker-host-http-resources.js");

test("composition rejects structural Host preparation suppliers before any Engine IO", () => {
  const network = networkFixture();
  assert.throws(() => createDockerHostHttpResources({host: {httpPreparation: () => ({acquire() {}})},
    network: network.resourceInput, hostLifecycleGenerationSha256: "a".repeat(64)}));
  assert.deepEqual(network.state.calls, []);
});

test("composition is inert and genuine Host reservation acquisition precedes network preparation", async () => {
  const host = hostFixture(); const network = networkFixture();
  const product = createDockerHostHttpResources({host: host.core, network: network.resourceInput,
    hostLifecycleGenerationSha256: "a".repeat(64)});
  assert.deepEqual(network.state.calls, []);
  assert.equal(product.observationOwner.readObservation({kind: "listener_allocated"}), undefined);
  await assert.rejects(product.prepare({} as never, host.handoff("foreign-reservation") as never, {} as never, Date.now() + 5_000));
  assert.deepEqual(network.state.calls, []);
});

test("current Host lifecycle generation mismatch prevents allocation after a real reservation claim", async () => {
  const host = hostFixture(); const network = networkFixture(); const reservation = await host.reserve();
  const product = createDockerHostHttpResources({host: host.core, network: network.resourceInput,
    hostLifecycleGenerationSha256: "a".repeat(64)});
  await assert.rejects(product.prepare({} as never, host.handoff(reservation.custodyRef) as never,
    {} as never, Date.now() + 5_000), /generation changed/u);
  assert.deepEqual(network.state.calls, []);
});
