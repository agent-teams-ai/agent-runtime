import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import { fixture } from "./node-custody-http-resources-fixture.ts";
import { HostHttpEgressV4Journal } from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/journal/host-http-egress-v4-journal.js";
import { createDockerHostHttpEgressObservers, joinHostHttpEgressV4Observers } from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/host-http-egress-v4-observers.js";
import { v4Decode, v4Hash } from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/journal/host-http-egress-v4-codec.js";
import { MemoryV4Storage, SyntheticV4Owner } from "../../fixtures/host-http-egress-v4-fixture.ts";

// Exercise the private composition function verbatim without widening exports.
const source = readFileSync(new URL("../../../src/features/contained-agent-turn/composition/docker-linux-post-claim-preparation.ts", import.meta.url), "utf8");
const start = source.indexOf("const createResourceCleanup = (");
const end = source.indexOf("/** Keep one retained cleanup flight", start);
assert.ok(start >= 0 && end > start);
const createCleanup = new Function(`${stripTypeScriptTypes(source.slice(start, end), {mode: "transform"})}; return createResourceCleanup;`)();

for (const uncertain of [false, true]) {
  test(`journal quarantine preserves aggregate debt; listener uncertainty=${uncertain}`, async () => {
    const f = await fixture({unknownClose: uncertain});
    assert.equal((await f.prepare()).kind, "prepared");
    await f.authorizeRelease();
    // Real observer, separate memory ledger with synthetic prerequisite owners.
    const physical = createDockerHostHttpEgressObservers({subject: f.subject, removal: {readObservation: () => undefined}});
    const synthetic = new SyntheticV4Owner();
    const storage = new MemoryV4Storage();
    const journal = new HostHttpEgressV4Journal(storage, f.subject,
      joinHostHttpEgressV4Observers([synthetic, physical.observationOwner]));
    let serial = 0;
    const command = () => `command:${v4Hash(++serial)}`;
    await journal.prepare(command()); physical.bind(journal);
    const intent = async (kind: Parameters<typeof journal.target>[0]) => {
      assert.equal((await journal.recordIntent(command(), {kind, targetSha256: journal.target(kind)} as never)).kind, "recorded");
    };
    const observe = async (kind: Parameters<typeof journal.target>[0]) => {
      assert.equal((await journal.recordObservation(command(), synthetic.token({kind,
        subjectSha256: v4Hash(f.subject), observerSha256: f.subject.observerSha256,
        targetSha256: journal.target(kind), actualSha256: v4Hash([kind, serial]),
        evidenceSha256: v4Hash([serial, kind]), container: null, writeOutcome: null} as never))).kind, "recorded");
    };
    await intent("network_intent"); await observe("network_allocated");
    await intent("listener_intent"); await observe("listener_allocated");
    await intent("cutoff"); await observe("cutoff_observed"); await observe("container_absent");
    await intent("listener_release");
    let cleanupCalls = 0;
    let observed = 0;
    let networkCleanups = 0;
    const resources = {
      product: {cutoff: () => f.controller.abort(), listener: f.resourceInput.listener,
        cleanupResources: async () => {cleanupCalls++; return (await f.release()).kind === "released";}},
      observers: {observeListenerAbsent: async (listener: typeof f.resourceInput.listener) => {
        await physical.observeListenerAbsent(listener); observed++;
      }},
      networkAttempted: true, launchAttempted: false,
      lifecycle: {removalObservation: {observeNoCreation: async () => ({})}}, launchKey: {},
      network: {cutoff() {}, cleanupNetwork: async () => {
        // Test double for the existing own-network owner. Physical absence must
        // be acknowledged before invoking it; no Docker effects are performed.
        assert.ok(v4Decode(storage.journal!).some(record => record.event.kind === "listener_absent"));
        networkCleanups++; return "absent";
      }},
    };
    Object.assign(resources.observers, {observeContainerAbsent: async () => {}});
    const cleanup = createCleanup(resources, {routeAdmission: {}, cleanupCall: () => ({}),
      cleanupMs: 1000, observationDeadline: Date.now() + 10_000});
    if (uncertain) {f.advance(25_000);}
    assert.equal(await cleanup(), false);
    assert.equal(observed, uncertain ? 0 : 1);
    assert.equal(networkCleanups, uncertain ? 0 : 1);
    assert.equal(f.storage.tombstones, 1);
    assert.match(f.storage.disposition, /quarantined/u);
    assert.equal((await f.release()).kind, "unproven");
    if (!uncertain) {
      assert.equal(f.servers[0]!.closeCalls, 1);
      assert.equal(f.servers[0]!.listening, false);
      assert.equal(await cleanup(), false);
      assert.equal(cleanupCalls, 2); // Cached absence must never cache aggregate release.
      assert.equal(observed, 1);
    }
  });
}
