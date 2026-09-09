import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";
import {HostHttpEgressV4Journal} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/docker-provider-process-entrypoint.js";
import {HostHttpConsumptionStorage} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/egress/host-http-consumption-storage.js";
import {SyntheticV4Owner, subject} from "../../fixtures/host-http-egress-v4-fixture.ts";
import {call} from "../../fixtures/docker-engine-test-fixture.ts";
import {v4Decode, v4DecodeTombstone, v4Hash} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/journal/host-http-egress-v4-codec.js";
import {v4Replay} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/journal/host-http-egress-v4-replay.js";
import {fixture} from "./node-docker-deployment-recipe-fixture.ts";

test("recipe retires partial listener setup while preserving reconciliation and its tombstone", async t => {
  const f = await fixture(t); await f.partial();
  assert.equal(await f.recipe.releaseAfterHostCleanup(call()), "released");
  assert.deepEqual(f.closes, ["resource", "custody"]);
  assert.equal(f.journal.evidence().resourceLedger, "retired");
  assert.equal(f.journal.evidence().reconcileRequired, true);
  const records = v4Decode(f.storage.journal!);
  assert.deepEqual(records.map(record => record.event.kind), ["opened", "network_intent", "network_allocated", "listener_intent",
    "cutoff", "cutoff_observed", "container_absent", "listener_release", "listener_absent", "network_release", "network_absent", "retired"]);
  assert.equal(v4Replay(records, subject).reconcileRequired, true);
  const tomb = v4DecodeTombstone(await readFile(f.tombstonePath));
  assert.equal(tomb.disposition, "retired"); assert.equal(tomb.reconcileRequired, true);
  assert.equal(tomb.tailSha256, records.at(-1)!.checksumSha256);
  const recovered = new HostHttpEgressV4Journal(f.storage, subject, new SyntheticV4Owner());
  assert.equal((await recovered.prepare(`command:${v4Hash("reopen")}`)).kind, "cleanup_only");
  assert.equal(recovered.evidence().resourceLedger, "retired");
  assert.equal(recovered.evidence().reconcileRequired, true);
  assert.equal(recovered.evidence().admission, "closed");
  assert.equal(await f.recipe.releaseAfterHostCleanup(call()), "released");
  assert.deepEqual(f.closes, ["resource", "custody"]);
});

for (const missing of ["cutoff_observed", "container_absent", "listener_absent", "network_absent"] as const) {
  test(`recipe retains custody without ${missing}`, async t => {
    const f = await fixture(t); await f.partial(missing);
    assert.equal(await f.recipe.releaseAfterHostCleanup(call()), "pending");
    assert.deepEqual(f.closes, []); assert.equal(f.storage.marker, null);
    assert.equal(f.journal.evidence().resourceLedger, "open");
    assert.equal(f.journal.evidence().reconcileRequired, true);
  });
}

for (const fault of ["before", "tombstone"] as const) {
  test(`recipe retains quarantined storage after ${fault} acknowledgement failure`, async t => {
    const f = await fixture(t); await f.partial(); f.storage.fault = fault;
    assert.equal(await f.recipe.releaseAfterHostCleanup(call()), "pending");
    assert.equal(await f.recipe.releaseAfterHostCleanup(call()), "pending");
    assert.equal(f.journal.evidence().resourceLedger, "quarantined");
    assert.deepEqual(f.closes, []);
  });
}

for (const result of ["duplicate", "recorded"] as const) {
  test(`recipe refuses ${result} without retired evidence`, async t => {
    const f = await fixture(t); await f.partial();
    t.mock.method(f.journal, "recordIntent", async () => ({kind: result, checksumSha256: v4Hash("synthetic")}));
    assert.equal(await f.recipe.releaseAfterHostCleanup(call()), "pending");
    assert.deepEqual(f.closes, []); assert.equal(f.storage.marker, null);
  });
}

test("recipe retains resources when consumption preparation is unknown", async t => {
  const f = await fixture(t); await f.partial();
  t.mock.method(HostHttpConsumptionStorage, "open", async () => {throw new Error("synthetic storage uncertainty");});
  assert.equal((await f.recipe.consumption.prepare(f.references)).kind, "unknown");
  assert.equal(await f.recipe.releaseAfterHostCleanup(call()), "pending");
  assert.deepEqual(f.closes, []); assert.equal(f.storage.marker, null);
});

test("recipe checks the record acknowledgement even when retired evidence exists", async t => {
  const f = await fixture(t); await f.partial();
  const record = f.journal.recordIntent.bind(f.journal);
  t.mock.method(f.journal, "recordIntent", async (...args: Parameters<typeof record>) => {
    const result = await record(...args);
    return {...result, kind: "duplicate" as const};
  });
  assert.equal(await f.recipe.releaseAfterHostCleanup(call()), "pending");
  assert.equal(f.journal.evidence().resourceLedger, "retired");
  assert.deepEqual(f.closes, []);
});

test("recipe retries retirement after the missing network absence arrives", async t => {
  const f = await fixture(t); await f.partial("network_absent");
  assert.equal(await f.recipe.releaseAfterHostCleanup(call()), "pending");
  assert.deepEqual(f.closes, []);
  await f.observe("network_absent");
  assert.equal(await f.recipe.releaseAfterHostCleanup(call()), "released");
  assert.equal(f.journal.evidence().reconcileRequired, true);
  assert.deepEqual(f.closes, ["resource", "custody"]);
});
