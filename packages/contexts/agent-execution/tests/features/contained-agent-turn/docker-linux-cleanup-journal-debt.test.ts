import assert from "node:assert/strict";
import test from "node:test";
import {fixture} from "./node-custody-http-resources-fixture.ts";
const {NodeCustodyHttpResources} = await import("../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/node-custody-http-resources.js");


for (const deploymentDebt of [false, true]) {
  test(`owner separates actual journal quarantine from deployment debt=${deploymentDebt}`, async () => {
    const f = await fixture();
    const owner = new NodeCustodyHttpResources({cutoff() {}}, new AbortController());
    const original = f.resourceInput.listener;
    const listener = {...original, async close() {
      const result = await original.close();
      return deploymentDebt ? {state: "unknown" as const} : result;
    }};
    assert.equal((await owner.prepare(f.lifetime, {...f.resourceInput, listener})).kind, "prepared");
    await f.authorizeRelease();
    assert.deepEqual(await owner.cleanupOutcome(), {released: false, dependenciesReleased: !deploymentDebt});
    assert.equal(f.servers[0]!.listening, false);
    assert.equal(f.storage.tombstones, 1);
    assert.match(f.storage.disposition, /quarantined/u);
    assert.equal(await owner.cleanup(), false);
  });
}
