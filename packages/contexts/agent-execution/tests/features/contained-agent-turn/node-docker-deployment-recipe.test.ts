import assert from "node:assert/strict";
import {mkdtemp, open, readFile, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test, {type TestContext} from "node:test";
import {createNodeDockerDeploymentRecipe} from "../../../dist/features/contained-agent-turn/composition/node-docker-deployment-recipe.js";
import {NodeUnixSocketDockerEngine, NodeDockerCustodyJournalStorage, HostHttpEgressV4NodeStorage,
  HostHttpEgressV4Journal} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/docker-provider-process-entrypoint.js";
import {HostHttpConsumptionStorage} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/egress/host-http-consumption-storage.js";
import {MemoryV4Storage, SyntheticV4Owner, subject} from "../../fixtures/host-http-egress-v4-fixture.ts";
import {call, policy} from "../../fixtures/docker-engine-test-fixture.ts";
import {v4Decode, v4DecodeTombstone, v4Hash} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/journal/host-http-egress-v4-codec.js";
import {v4Replay} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/journal/host-http-egress-v4-replay.js";
import type {HostHttpEgressV4Intent, HostHttpEgressV4Observed} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/journal/host-http-egress-v4-types.js";

// Synthetic Engine identity and storage seams only: no socket, container, native
// process lock or provider launch. The production recipe and V4 validator run.
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "ar-recipe-retirement-"));
  t.after(() => rm(root, {recursive: true, force: true}));
  const storage = new MemoryV4Storage();
  const closes: string[] = [];
  t.mock.method(NodeUnixSocketDockerEngine.prototype, "identity", async () => ({}));
  t.mock.method(NodeDockerCustodyJournalStorage, "open", async () => ({close: async () => {closes.push("custody");}}));
  for (const method of ["prepare", "assertOwned", "append"] as const) {
    t.mock.method(HostHttpEgressV4NodeStorage.prototype, method, storage[method].bind(storage));
  }
  const tombstonePath = join(root, "retained.tombstone");
  t.mock.method(HostHttpEgressV4NodeStorage.prototype, "tombstone", async (bytes: Uint8Array) => {
    await storage.tombstone(bytes);
    const file = await open(tombstonePath, "wx", 0o600);
    try {await file.writeFile(bytes); await file.sync();} finally {await file.close();}
  });
  t.mock.method(HostHttpEgressV4NodeStorage.prototype, "close", async () => {closes.push("resource");});
  const pin = {path: "/synthetic/never-executed", sha256: "a".repeat(64)};
  const references = {selectedDockerAuthorityDigest: `sha256:${"a".repeat(64)}`,
    networkNamespaceIdentity: "network:test", cgroupIdentity: "cgroup:test", listenerIdentity: "listener:test", signerIdentity: "signer:test"};
  const recipe = createNodeDockerDeploymentRecipe({enginePolicy: policy(root), custodyJournalRoot: join(root, "custody"),
    resourceJournalRoot: join(root, "resource"), nsenter: pin, nft: pin,
    consumption: {directory: {path: join(root, "consumption"), device: "1", inode: "1"},
      readEnvelope: refs => ({...refs, tenantId: "tenant:test", projectId: "project:test", operationId: "operation:test",
        scopeDigest: `sha256:${"b".repeat(64)}`, attemptId: "attempt:test", custodyId: "custody:test",
        hostInstanceId: "host:test", hostBootId: "boot:test", executionGenerationId: "generation:test"})}});
  await recipe.preparation.engineIdentity(call());
  recipe.preparation.openLifecycle(policy(root));
  const owner = new SyntheticV4Owner();
  const journal = await recipe.preparation.openResourceJournal({subject, observer: owner});
  let serial = 0;
  const command = () => `command:${v4Hash(++serial)}`;
  const intent = (kind: HostHttpEgressV4Intent) => journal.recordIntent(command(), {kind, targetSha256: journal.target(kind)});
  const observe = (kind: HostHttpEgressV4Observed) => journal.recordObservation(command(), owner.token({kind,
    subjectSha256: v4Hash(subject), observerSha256: subject.observerSha256, targetSha256: journal.target(kind),
    actualSha256: v4Hash([kind, serial]), evidenceSha256: v4Hash(["evidence", serial]), container: null, writeOutcome: null}));
  async function partial(missing?: HostHttpEgressV4Observed) {
    await intent("network_intent"); await observe("network_allocated"); await intent("listener_intent");
    await intent("cutoff");
    assert.equal(journal.evidence().reconcileRequired, true);
    // Later endpoint observations have prerequisites. Keep the valid prefix
    // when removing an earlier proof instead of inventing impossible evidence.
    if (missing === "cutoff_observed") {return;}
    await observe("cutoff_observed");
    if (missing === "container_absent") {return;}
    await observe("container_absent"); await intent("listener_release");
    if (missing === "listener_absent") {return;}
    await observe("listener_absent"); await intent("network_release");
    if (missing !== "network_absent") {await observe("network_absent");}
  }
  return {recipe, journal, storage, closes, partial, observe, references, tombstonePath};
}

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
