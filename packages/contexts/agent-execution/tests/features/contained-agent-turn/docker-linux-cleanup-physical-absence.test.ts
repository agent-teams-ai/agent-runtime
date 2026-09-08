import assert from "node:assert/strict";
import test from "node:test";
import {postClaimFixture} from "./support/docker-linux-post-claim-fixture.ts";
import {createDockerLinuxPostClaimPreparation} from "../../../dist/features/contained-agent-turn/composition/docker-linux-post-claim-preparation.js";
import {v4Decode} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/journal/host-http-egress-v4-codec.js";

for (const uncertainty of [false, true]) {
  test(`owned network cleanup requires physical listener proof despite aggregate debt: uncertainty=${uncertainty}`, async t => {
    const f = await postClaimFixture(t);
    const resources = f.dependencies.resources;
    const preparation = createDockerLinuxPostClaimPreparation({...f.dependencies,
      resources: {...resources, listenerFor(host) {
        const listener = resources.listenerFor(host);
        return {...listener,
          observe: () => uncertainty ? {...listener.observe(), uncertainty: ["server-close-unproven"]} : listener.observe(),
          async close() {await listener.close(); return {state: "unknown" as const};},
        };
      }},
    });
    assert.equal((await preparation.prepareClaimed(f.claimed)).kind, "quarantined");
    assert.ok(f.physical.closes > 0);
    const kinds = v4Decode(f.v4Storage.journal!).map(record => record.event.kind);
    assert.equal(kinds.includes("listener_absent"), !uncertainty);
    assert.equal(kinds.includes("network_release"), !uncertainty);
    assert.equal(kinds.includes("network_absent"), !uncertainty);
    assert.equal(f.network.state.calls.some(call => call.startsWith("DELETE ")), !uncertainty);
    assert.equal(f.network.state.network === undefined, !uncertainty);
  });
}
