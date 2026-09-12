import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import {
  createNodeHostHttpConsumptionJournal, type PreparedHostHttpConsumptionJournal,
} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/egress/node-host-http-consumption-journal.js";
import type { HostHttpConsumptionEnvelope } from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/egress/host-http-consumption-format.js";
import { digest, envelope, key, pin } from "./host-http-consumption-journal-fixture.mjs";

const linuxTest = process.platform === "linux" ? test : test.skip;
const fileName = "host-http-consumption-v1.journal";
const tombName = "host-http-consumption-v1.tombstone";

const fixture = async (t: TestContext) => {
  const root = await mkdtemp(join(tmpdir(), "ar-http-consumption-"));
  const path = join(root, "operation-private");
  await mkdir(path, { mode: 0o700 });
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = pin(path);
  return { root, path, directory, file: join(path, fileName), tomb: join(path, tombName) };
};

const prepare = async (t: TestContext, directory: ReturnType<typeof pin>, overrides = {}) => {
  const result = await createNodeHostHttpConsumptionJournal({ directory, envelope, ...overrides }).prepare();
  assert.equal(result.kind, "ready");
  const ready = result as PreparedHostHttpConsumptionJournal;
  t.after(() => ready.retire());
  return ready;
};

linuxTest("factory is resource-free and snapshots settings before explicit preparation", async t => {
  const f = await fixture(t);
  const mutable = { ...envelope };
  const directory = { ...f.directory };
  const factory = createNodeHostHttpConsumptionJournal({ directory, envelope: mutable });
  mutable.hostBootId = "boot:changed";
  directory.path = join(f.root, "does-not-exist");
  assert.deepEqual(await readdir(f.path), []);
  const result = await factory.prepare();
  assert.equal(result.kind, "ready");
  if (result.kind !== "ready") { return; }
  t.after(() => result.retire());
  assert.equal(result.journal.consume(key(), digest("c")), "consumed");
  const bytes = await readFile(f.file);
  assert.ok(bytes.includes(Buffer.from('"hostBootId":"boot:one"')));
  assert.ok(!bytes.includes(Buffer.from("boot:changed")));
  assert.equal((await factory.prepare()).kind, "unknown");
});

linuxTest("held real file is synced before admission, and exact keys survive retirement", async t => {
  const f = await fixture(t);
  const events: string[] = [];
  const write = fs.writeSync;
  const datasync = fs.fdatasyncSync;
  const sync = fs.fsyncSync;
  t.mock.method(fs, "writeSync", (...args: Parameters<typeof fs.writeSync>) => {
    events.push("write"); return Reflect.apply(write, fs, args);
  });
  t.mock.method(fs, "fdatasyncSync", (fd: number) => { events.push("datasync"); datasync(fd); });
  t.mock.method(fs, "fsyncSync", (fd: number) => { events.push("directory-sync"); sync(fd); });
  const ready = await prepare(t, f.directory);
  assert.deepEqual(events, ["write", "datasync", "directory-sync"]);
  assert.equal(ready.journal.consume(key(), digest("c")), "consumed");
  assert.deepEqual(events.slice(3), ["write", "datasync"]);
  const durable = await readFile(f.file);
  assert.ok(durable.includes(Buffer.from(JSON.stringify(key()))));
  assert.ok(durable.includes(Buffer.from(digest("c"))));
  assert.equal(fs.statSync(f.file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(f.file).nlink, 1);
  assert.equal(fs.statSync(f.file).uid, process.getuid!());
  assert.equal(await ready.retire(), "retired");
  assert.equal(ready.journal.consume(key("fresh"), digest("d")), "unknown");
  assert.deepEqual(await readFile(f.file), durable);
  assert.ok((await readFile(f.tomb)).includes(Buffer.from('"disposition":"retired"')));
  assert.deepEqual((await readdir(f.path)).toSorted(), [fileName, tombName].toSorted());
});

linuxTest("same key/fingerprint duplicates without another append; changed fingerprint seals", async t => {
  const f = await fixture(t);
  const ready = await prepare(t, f.directory);
  assert.equal(ready.journal.consume(key(), digest("c")), "consumed");
  const size = fs.statSync(f.file).size;
  assert.equal(ready.journal.consume({ ...key() }, digest("c")), "duplicate");
  assert.equal(fs.statSync(f.file).size, size);
  assert.equal(ready.journal.consume(key(), digest("d")), "mismatch");
  assert.equal(ready.journal.consume(key(), digest("c")), "unknown");
  assert.equal(ready.journal.consume(key("fresh"), digest("c")), "unknown");
  assert.equal(fs.statSync(f.file).size, size);
  assert.equal(await ready.retire(), "unknown");
  assert.ok((await readFile(f.tomb)).includes(Buffer.from('"disposition":"quarantined"')));
});

for (const field of ["tenantId", "projectId", "operationId"] as const) {
  linuxTest(`signed key collision in ${field} cannot cross the captured envelope`, async t => {
    const f = await fixture(t);
    const ready = await prepare(t, f.directory);
    const size = fs.statSync(f.file).size;
    assert.equal(ready.journal.consume({ ...key(), [field]: "foreign:one" }, digest("c")), "mismatch");
    assert.equal(ready.journal.consume(key(), digest("c")), "unknown");
    assert.equal(fs.statSync(f.file).size, size);
  });
}

linuxTest("distinct boundary IDs and equal fingerprints are distinct exact signed keys", async t => {
  const f = await fixture(t);
  const ready = await prepare(t, f.directory);
  for (const id of ["boundary:one", "boundary:ONE", "boundary_one", "boundary-one"]) {
    assert.equal(ready.journal.consume(key(id), digest("c")), "consumed");
  }
  assert.equal(ready.journal.consume(key("boundary:one"), digest("c")), "duplicate");
});

linuxTest("malformed, accessored, proxy, oversized and extra-field keys burn admission without executing accessors", async t => {
  let accessed = 0;
  const accessor = { ...key() };
  Object.defineProperty(accessor, "boundaryUseId", { get: () => { accessed += 1; return "boundary:one"; } });
  const cases = [null, { ...key(), namespace: "provider-process-egress/v1" }, { ...key(), extra: "value" },
    { ...key(), boundaryUseId: "x".repeat(129) }, { ...key(), boundaryUseId: "../file" }, accessor,
    new Proxy(key(), { get: () => { accessed += 1; throw new Error("getter called"); } })];
  for (const invalid of cases) {
    const f = await fixture(t);
    const ready = await prepare(t, f.directory);
    const size = fs.statSync(f.file).size;
    assert.equal(ready.journal.consume(invalid as ReturnType<typeof key>, digest("c")), "unknown");
    assert.equal(ready.journal.consume(key("new"), digest("c")), "unknown");
    assert.equal(fs.statSync(f.file).size, size);
  }
  assert.equal(accessed, 0);
});

linuxTest("malformed fingerprint seals without persisting request material", async t => {
  const f = await fixture(t);
  const ready = await prepare(t, f.directory);
  const untrusted = "synthetic-invalid-fingerprint";
  assert.equal(ready.journal.consume(key(), untrusted), "unknown");
  assert.ok(!(await readFile(f.file)).includes(Buffer.from(untrusted)));
  assert.ok(!(await readFile(f.tomb)).includes(Buffer.from(untrusted)));
});

linuxTest("same-instance reservation and independent descriptors exclude a competing writer", async t => {
  const f = await fixture(t);
  const factory = createNodeHostHttpConsumptionJournal({ directory: f.directory, envelope });
  const first = factory.prepare();
  assert.equal((await factory.prepare()).kind, "unknown");
  const owner = await first;
  assert.equal(owner.kind, "ready");
  if (owner.kind !== "ready") { return; }
  t.after(() => owner.retire());
  assert.equal((await createNodeHostHttpConsumptionJournal({ directory: f.directory, envelope }).prepare()).kind, "busy");
  assert.equal(owner.journal.consume(key(), digest("c")), "consumed");
  owner.quarantine();
  assert.equal((await createNodeHostHttpConsumptionJournal({ directory: f.directory, envelope }).prepare()).kind, "busy");
  await owner.retire();
  assert.equal((await createNodeHostHttpConsumptionJournal({ directory: f.directory, envelope }).prepare()).kind, "reconciliation_required");
});

linuxTest("racing independent preparations yield one owner and one busy, without rewriting the owner", async t => {
  const f = await fixture(t);
  const results = await Promise.all([1, 2].map(() =>
    createNodeHostHttpConsumptionJournal({ directory: f.directory, envelope }).prepare()));
  assert.deepEqual(results.map(result => result.kind).toSorted(), ["busy", "ready"]);
  for (const result of results) { if (result.kind === "ready") { await result.retire(); } }
});

linuxTest("every envelope dimension, including stale boot and fresh generation, denies restart", async t => {
  const f = await fixture(t);
  const owner = await prepare(t, f.directory);
  assert.equal(owner.journal.consume(key(), digest("c")), "consumed");
  await owner.retire();
  const before = await readFile(f.file);
  const tomb = await readFile(f.tomb);
  for (const field of Object.keys(envelope) as (keyof HostHttpConsumptionEnvelope)[]) {
    const value = field === "scopeDigest" || field === "selectedDockerAuthorityDigest" ? digest("d") : "different:one";
    const result = await createNodeHostHttpConsumptionJournal({ directory: f.directory,
      envelope: { ...envelope, [field]: value } }).prepare();
    assert.equal(result.kind, "reconciliation_required", field);
    assert.equal("journal" in result, false);
  }
  assert.deepEqual(await readFile(f.file), before);
  assert.deepEqual(await readFile(f.tomb), tomb);
});

linuxTest("configured and default boundary capacity are closed before an excess append", async t => {
  for (const limit of [1, 256]) {
    const f = await fixture(t);
    const ready = await prepare(t, f.directory, limit === 256 ? {} :
      { limits: { maxBoundaryUses: limit, maxJournalBytes: 1_048_576 } });
    for (let i = 0; i < limit; i += 1) { assert.equal(ready.journal.consume(key(`boundary:${i}`), digest("c")), "consumed"); }
    const size = fs.statSync(f.file).size;
    assert.equal(ready.journal.consume(key("exhausted"), digest("c")), "unknown");
    assert.equal(fs.statSync(f.file).size, size);
    assert.equal(ready.journal.consume(key("boundary:0"), digest("c")), "unknown");
  }
});

linuxTest("byte capacity reserves a whole bounded record before allocation", async t => {
  const f = await fixture(t);
  const ready = await prepare(t, f.directory, { limits: { maxBoundaryUses: 256, maxJournalBytes: 6_144 } });
  let consumed = 0;
  while (ready.journal.consume(key(`boundary:${consumed}`), digest("c")) === "consumed") { consumed += 1; }
  assert.ok(consumed > 0 && consumed < 256);
  assert.ok(fs.statSync(f.file).size <= 6_144);
  const size = fs.statSync(f.file).size;
  assert.equal(ready.journal.consume(key("after-full"), digest("c")), "unknown");
  assert.equal(fs.statSync(f.file).size, size);
});

linuxTest("invalid capacity and identity fail before touching the operation directory", async t => {
  const f = await fixture(t);
  for (const maxBoundaryUses of [0, 257, NaN, Infinity, 1.5]) {
    assert.throws(() => createNodeHostHttpConsumptionJournal({ directory: f.directory, envelope,
      limits: { maxBoundaryUses, maxJournalBytes: 1_048_576 } }));
  }
  assert.throws(() => createNodeHostHttpConsumptionJournal({ directory: f.directory,
    envelope: { ...envelope, signerIdentity: "not/an/opaque/identity" } }));
  assert.deepEqual(await readdir(f.path), []);
});

for (const residue of ["empty", "torn", "oversize", "unknown", "tombstone", "too-many"]) {
  linuxTest(`preexisting ${residue} residue never creates or resumes execution`, async t => {
    const f = await fixture(t);
    const path = residue === "unknown" ? join(f.path, "foreign-generation") : residue === "tombstone" ? f.tomb : f.file;
    const bytes = residue === "empty" ? Buffer.alloc(0) : residue === "oversize" ? Buffer.alloc(1_048_577) : Buffer.from("torn");
    await writeFile(path, bytes, { mode: 0o600 });
    if (residue === "too-many") {
      for (let i = 0; i < 4; i += 1) { await writeFile(join(f.path, `extra-${i}`), "x", { mode: 0o600 }); }
    }
    const before = await readFile(path);
    const result = await createNodeHostHttpConsumptionJournal({ directory: f.directory, envelope }).prepare();
    assert.equal(result.kind, "reconciliation_required");
    assert.deepEqual(await readFile(path), before);
    assert.equal("journal" in result, false);
  });
}
