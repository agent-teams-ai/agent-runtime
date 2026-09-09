import assert from "node:assert/strict";
import fs from "node:fs";
import {readFile} from "node:fs/promises";
import {join} from "node:path";
import test, {type TestContext} from "node:test";
import {NodeCustodyHttpResources} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/node-custody-http-resources.js";
import {HostHttpConsumptionStorage} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/egress/host-http-consumption-storage.js";
import type {PreparedHostHttpConsumptionJournal} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/egress/node-host-http-consumption-journal.js";
import {fixture} from "./node-docker-deployment-recipe-fixture.ts";
import {committedDispatchProofFixture} from "./support/committed-dispatch-proof-fixture.ts";
import {ids, openInput} from "./support/current-provider-owner-fixture.ts";
import {call} from "../../fixtures/docker-engine-test-fixture.ts";

const fingerprint = `sha256:${"c".repeat(64)}`;
const key = {namespace: "provider-process-egress/v2" as const, tenantId: "tenant:test", projectId: "project:test",
  operationId: "operation:test", boundaryUseId: "boundary:one"};

const observe = (): never => {throw new Error("synthetic listener observations are not V4 evidence");};

// Concrete journal, storage, process lock, HTTP resource owner and deployment
// recipe. Only Engine/V4 observations and the listener are synthetic; all files
// and native lock work belong to this disposable test directory.
async function composed(t: TestContext) {
  const f = await fixture(t);
  const proof = committedDispatchProofFixture(openInput(ids("codex", "disposal"), "codex", {provider: "codex"}),
    {hostBootId: "host-boot:test", hostInstanceId: "host-instance:test", hostCustodyProof: {proofId: "proof:test"}} as never,
    {operationId: "operation:test", attemptId: "attempt:test", custodyId: "custody:test", executionGenerationId: "execution-generation:test"} as never);
  const controller = new AbortController();
  const owner = new NodeCustodyHttpResources({cutoff() {controller.abort();}}, new AbortController());
  let prepared: PreparedHostHttpConsumptionJournal | undefined;
  let listenerCloses = 0;
  let listenerSealed = false;
  const sealAdmission = () => {listenerSealed = true;};
  const closeListener = async () => {listenerCloses++; return {state: "closed" as const};};
  const result = await owner.prepare({committedDispatchProof: proof, underlyingCustodyRef: "custody:synthetic",
    executionSessionIdentity: {}, hostLifecycleGenerationSha256: "a".repeat(64), signal: controller.signal}, {
    listener: {async open() {return {address: {address: "127.0.0.1", family: "IPv4", port: 43129}, sealAdmission, observe, close: closeListener};},
      sealAdmission, observe, close: closeListener},
    accept: async () => {throw new Error("no exchanges in disposal fixture");},
    consumption: {async prepare() {
      const acquired = await f.recipe.consumption.prepare(f.references);
      assert.equal(acquired.kind, "ready"); if (acquired.kind === "ready") {prepared = acquired;}
      return acquired;
    }},
    listenerLifecycle: {bind: () => ({recordOpen: async () => ({kind: "recorded"}), recordRelease: async () => ({kind: "recorded"})})},
    localCut: {expectedClock: {authorityId: "clock:test", epoch: "1"}, operationDeadline: 1000,
      clock: {read: () => ({authorityId: "clock:test", epoch: "1", controlTime: 0}), within: async (_deadline, action) => action()}},
  });
  assert.equal(result.kind, "prepared"); assert.ok(prepared);
  return {...f, owner, prepared, listenerCloses: () => listenerCloses, listenerSealed: () => listenerSealed};
}

for (const mode of ["healthy-zero", "healthy-one", "quarantined", "append-ambiguity"] as const) {
  test(`concrete owner/recipe disposal preserves disposition: ${mode}`, async t => {
    const f = await composed(t);
    let closes = 0;
    const close = HostHttpConsumptionStorage.prototype.close;
    t.mock.method(HostHttpConsumptionStorage.prototype, "close", async function(this: HostHttpConsumptionStorage) {
      closes++; return close.call(this);
    });
    const uncertain = mode === "quarantined" || mode === "append-ambiguity";
    if (mode === "healthy-one") {assert.equal(f.prepared.journal.consume(key, fingerprint), "consumed");}
    if (mode === "quarantined") {f.prepared.quarantine();}
    if (mode === "append-ambiguity") {
      const write = fs.writeSync; let first = true;
      t.mock.method(fs, "writeSync", (...args: Parameters<typeof fs.writeSync>) => {
        const written = Reflect.apply(write, fs, args);
        if (first) {first = false; throw new Error("actual append acknowledged bytes lost");}
        return written;
      });
      assert.equal(f.prepared.journal.consume(key, fingerprint), "unknown");
    }
    const before = await readFile(join(f.consumptionPath, "host-http-consumption-v1.journal"));
    assert.equal(f.prepared.disposalEvidence?.().closed, false);
    const cleanup = f.owner.cleanupOutcome();
    assert.equal(f.listenerSealed(), true);
    assert.equal(f.prepared.journal.consume({...key, boundaryUseId: "boundary:late"}, fingerprint), "unknown");
    assert.deepEqual(await cleanup, {released: !uncertain, dependenciesReleased: true});
    assert.equal(await f.prepared.retire(), uncertain ? "unknown" : "retired");
    assert.deepEqual(f.prepared.disposalEvidence?.(), {persistedSeal: uncertain ? "quarantined" : "retired", closed: true});
    // Disposal alone never replaces missing V4 absence observations.
    assert.equal(await f.recipe.releaseAfterHostCleanup(call()), "pending");
    await f.partial();
    assert.equal(await f.recipe.releaseAfterHostCleanup(call()), "released");
    assert.equal(await f.recipe.releaseAfterHostCleanup(call()), "released");
    assert.deepEqual(await f.owner.cleanupOutcome(), {released: !uncertain, dependenciesReleased: true});
    assert.equal(await f.prepared.retire(), uncertain ? "unknown" : "retired");
    assert.equal(closes, 1); assert.equal(f.listenerCloses(), 1);
    assert.equal(f.journal.evidence().reconcileRequired, true);
    assert.deepEqual(f.closes, ["resource", "custody"]);
    assert.deepEqual(await readFile(join(f.consumptionPath, "host-http-consumption-v1.journal")), before);
    const tomb = await readFile(join(f.consumptionPath, "host-http-consumption-v1.tombstone"));
    assert.ok(tomb.includes(Buffer.from(`"acknowledgedUses":${mode === "healthy-one" ? 1 : 0}`)));
    assert.ok(tomb.includes(Buffer.from(`"disposition":"${uncertain ? "quarantined" : "retired"}"`)));
    if (mode === "append-ambiguity") {assert.ok(before.includes(Buffer.from('"boundaryUseId":"boundary:one"')));}
  });
}

for (const fault of ["tombstone-open", "write", "datasync", "directory-sync", "readback", "close", "missing-evidence"] as const) {
  test(`recipe retains consumption gate after ${fault}`, async t => {
    const f = await composed(t); await f.partial();
    if (fault === "tombstone-open") {t.mock.method(fs, "openSync", () => {throw new Error("tombstone open failed");});}
    if (fault === "write") {t.mock.method(fs, "writeSync", () => {throw new Error("tombstone write failed");});}
    if (fault === "datasync") {t.mock.method(fs, "fdatasyncSync", () => {throw new Error("tombstone sync failed");});}
    if (fault === "directory-sync") {t.mock.method(fs, "fsyncSync", () => {throw new Error("directory sync failed");});}
    if (fault === "readback") {
      // Quarantine bypasses the healthy pre-seal integrity read, so this fault
      // strikes the tombstone readback itself.
      t.mock.method(fs, "readSync", () => {throw new Error("tombstone readback failed");});
    }
    if (fault === "close") {
      const close = HostHttpConsumptionStorage.prototype.close;
      t.mock.method(HostHttpConsumptionStorage.prototype, "close", async function(this: HostHttpConsumptionStorage) {
        await close.call(this); throw new Error("storage close acknowledgement lost");
      });
    }
    if (fault === "missing-evidence") {
      // Simulate an older private owner: even a fulfilled unknown is no proof.
      t.mock.method(HostHttpConsumptionStorage.prototype, "persistTombstone", () => false);
    }
    f.prepared.quarantine();
    assert.deepEqual(await f.owner.cleanupOutcome(), {released: false, dependenciesReleased: true});
    assert.equal(await f.prepared.retire(), "unknown");
    assert.equal(await f.recipe.releaseAfterHostCleanup(call()), "pending");
    assert.equal(await f.recipe.releaseAfterHostCleanup(call()), "pending");
    assert.deepEqual(f.closes, []);
    const evidence = f.prepared.disposalEvidence?.();
    assert.ok(evidence?.persistedSeal === "unknown" || evidence?.closed === false);
  });
}

test("acknowledged quarantine cannot discharge recipe debt after lock release fails", async t => {
  const open = HostHttpConsumptionStorage.open;
  let held: HostHttpConsumptionStorage | undefined;
  t.mock.method(HostHttpConsumptionStorage, "open", async (...args: Parameters<typeof open>) => {
    held = await open(...args); return held;
  });
  const f = await composed(t); await f.partial(); assert.ok(held);
  f.prepared.quarantine();
  assert.deepEqual(f.prepared.disposalEvidence?.(), {persistedSeal: "quarantined", closed: false});
  // The test owns this disposable descriptor. Closing it makes the actual
  // lock holder's unlock fail; no retained or user process is involved.
  await held.directory.close();
  assert.deepEqual(await f.owner.cleanupOutcome(), {released: false, dependenciesReleased: true});
  assert.equal(await f.prepared.retire(), "unknown");
  assert.deepEqual(f.prepared.disposalEvidence?.(), {persistedSeal: "quarantined", closed: false});
  assert.equal(await f.recipe.releaseAfterHostCleanup(call()), "pending");
  assert.deepEqual(f.closes, []);
});

test("pending physical closure keeps the recipe pending and joins the original retirement", async t => {
  const f = await composed(t); await f.partial();
  const gate = Promise.withResolvers<void>();
  const close = HostHttpConsumptionStorage.prototype.close;
  let closes = 0;
  t.mock.method(HostHttpConsumptionStorage.prototype, "close", async function(this: HostHttpConsumptionStorage) {
    closes++; await gate.promise; return close.call(this);
  });
  f.prepared.quarantine();
  const cleanup = f.owner.cleanupOutcome();
  assert.equal(await f.recipe.releaseAfterHostCleanup(call()), "pending");
  assert.equal(f.prepared.disposalEvidence?.().closed, false);
  gate.resolve();
  assert.deepEqual(await cleanup, {released: false, dependenciesReleased: true});
  assert.equal(await f.recipe.releaseAfterHostCleanup(call()), "released");
  assert.equal(await f.prepared.retire(), "unknown");
  assert.equal(closes, 1);
});

for (const disposition of ["healthy", "quarantined"] as const) {
  test(`actual tombstone descriptor close failure latches uncertainty: ${disposition}`, async t => {
    const f = await composed(t); await f.partial();
    const open = fs.openSync; const close = fs.closeSync;
    let tombFd: number | undefined;
    let closeAttempts = 0;
    let tombstoneOpens = 0;
    t.mock.method(fs, "openSync", (...args: Parameters<typeof fs.openSync>) => {
      const fd = Reflect.apply(open, fs, args);
      if (String(args[0]).endsWith("host-http-consumption-v1.tombstone")) {
        tombFd = fd; tombstoneOpens++;
      }
      return fd;
    });
    t.mock.method(fs, "closeSync", (fd: number) => {
      if (fd === tombFd) {
        closeAttempts++;
        // Deliberately leave this known disposable descriptor open. Teardown
        // owns it; production must not retry an ambiguously closed descriptor.
        throw new Error("unacknowledged actual tombstone close");
      }
      return close(fd);
    });
    t.after(() => {if (tombFd !== undefined) {close(tombFd);}});
    const generation = await readFile(join(f.consumptionPath, "host-http-consumption-v1.journal"));
    if (disposition === "quarantined") {f.prepared.quarantine();}
    assert.deepEqual(await f.owner.cleanupOutcome(), {released: false, dependenciesReleased: true});
    assert.equal(closeAttempts, 1);
    const tombstone = await readFile(join(f.consumptionPath, "host-http-consumption-v1.tombstone"));
    assert.ok(tombstone.includes(Buffer.from(`"disposition":"${disposition === "healthy" ? "retired" : "quarantined"}"`)));
    for (let repeat = 0; repeat < 2; repeat++) {
      f.prepared.quarantine();
      assert.equal(await f.prepared.retire(), "unknown");
      // Physical generation/directory closure stays independent of seal proof.
      assert.deepEqual(f.prepared.disposalEvidence?.(), {persistedSeal: "unknown", closed: true});
      assert.equal(f.prepared.journal.consume(key, fingerprint), "unknown");
      assert.deepEqual(await f.owner.cleanupOutcome(), {released: false, dependenciesReleased: true});
      assert.equal(await f.recipe.releaseAfterHostCleanup(call()), "pending");
    }
    assert.equal(closeAttempts, 1); assert.equal(tombstoneOpens, 1);
    assert.deepEqual(f.closes, []);
    assert.equal(f.journal.evidence().reconcileRequired, true);
    assert.deepEqual(await readFile(join(f.consumptionPath, "host-http-consumption-v1.journal")), generation);
    assert.deepEqual(await readFile(join(f.consumptionPath, "host-http-consumption-v1.tombstone")), tombstone);
  });
}
