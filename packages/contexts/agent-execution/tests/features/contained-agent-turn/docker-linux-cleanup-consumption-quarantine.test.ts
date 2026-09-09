import assert from "node:assert/strict";
import test from "node:test";
import {registerHooks} from "node:module";

// Concrete consumption journal over memory storage and a synthetic lock only.
// The composition's lifecycle, V4 ledger and network owner are the actual owners.
const memoryUrl = `data:text/javascript,${encodeURIComponent(`
export const state = {created: 0, tombstones: [], locks: 0};
export const captureConsumptionDirectory = input => input;
export class HostHttpConsumptionStorage {
  directory = {}; remainingBytes = 1048576;
  static async open() {return new this();}
  hasResidue() {return false;}
  create() {state.created++;}
  assertIntact() {}
  append() {}
  persistTombstone(bytes) {state.tombstones.push(bytes.toString()); return true;}
  async close() {}
}
export async function withStableDirectoryProcessLock(directory, action) {
  state.locks++; try {await action();} finally {state.locks--;}
}
`)}`;

test("actual composition permits physical cleanup for concrete journal-only quarantine", async t => {
  const hook = registerHooks({resolve(specifier, context, next) {
    if (specifier === "synthetic:cleanup-consumption-storage") {return {url: memoryUrl, shortCircuit: true};}
    if (context.parentURL?.includes("node-host-http-consumption-journal") &&
      ["@agent-teams/filesystem-custody", "./host-http-consumption-storage.js"].includes(specifier)) {
      return {url: memoryUrl, shortCircuit: true};
    }
    return next(specifier, context);
  }});
  t.after(() => hook.deregister());
  const {state} = await import("synthetic:cleanup-consumption-storage");
  const {createNodeHostHttpConsumptionJournal} = await import("../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/egress/node-host-http-consumption-journal.js");
  const {postClaimFixture} = await import("./support/docker-linux-post-claim-fixture.ts");
  const {createDockerLinuxPostClaimPreparation} = await import("../../../dist/features/contained-agent-turn/composition/docker-linux-post-claim-preparation.js");
  const {v4Decode} = await import("../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/journal/host-http-egress-v4-codec.js");
  const f = await postClaimFixture(t);
  f.route.lease = f.syntheticLease(); f.route.release = "closed";
  const proof = f.proof;
  const owner = createDockerLinuxPostClaimPreparation({...f.dependencies,
    publishRouteFirstWrite() {throw new Error("synthetic post-consumption preparation failure");}, resources: {...f.dependencies.resources,
    consumption: {prepare(references) {
      return createNodeHostHttpConsumptionJournal({directory: {path: "/synthetic/consumption", device: "1", inode: "1"},
        envelope: {tenantId: proof.tenantId, projectId: proof.projectId, operationId: proof.operationId,
          scopeDigest: `sha256:${f.subject.scopeSha256}`, attemptId: proof.attemptId, custodyId: proof.custodyId,
          hostInstanceId: proof.hostInstanceId, hostBootId: proof.hostBootId, executionGenerationId: proof.executionGenerationId,
          ...references, signerIdentity: "synthetic:signer"}}).prepare().then(result => {
          // Exercise real uncertainty, independently of ordinary healthy cutoff.
          if (result.kind === "ready") {result.quarantine();}
          return result;
        });
    }},
  }});
  assert.equal((await owner.prepareClaimed(f.claimed)).kind, "quarantined");
  assert.equal(state.created, 1);
  assert.equal(state.tombstones.length, 1);
  assert.match(state.tombstones[0], /quarantined/u);
  assert.equal(state.locks, 0);
  assert.equal(f.readback.listenerState, "closed");
  assert.equal(f.network.state.network, undefined);
  assert.ok(f.events.indexOf("remove") < f.events.indexOf("route-release"));
  const kinds = v4Decode(f.v4Storage.journal!).map(record => record.event.kind);
  assert.ok(kinds.includes("listener_absent")); assert.ok(kinds.includes("network_absent"));
  assert.equal(kinds.includes("retired"), false);
});
