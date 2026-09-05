import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";

import { createNodeHostHttpConsumptionJournal,
  type PreparedHostHttpConsumptionJournal } from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/egress/node-host-http-consumption-journal.js";
import { digest, envelope, key, pin } from "./host-http-consumption-journal-fixture.mjs";

const linuxTest = process.platform === "linux" ? test : test.skip;
const fixture = async (t: TestContext, ready = true) => {
  const root = await mkdtemp(join(tmpdir(), "ar-http-consumption-fault-"));
  const path = join(root, "operation");
  await mkdir(path, { mode: 0o700 });
  const directory = pin(path);
  let owner: PreparedHostHttpConsumptionJournal | undefined;
  t.after(async () => { t.mock.restoreAll(); await owner?.retire(); await rm(root, { recursive: true, force: true }); });
  if (ready) {
    const result = await createNodeHostHttpConsumptionJournal({ directory, envelope }).prepare();
    assert.equal(result.kind, "ready");
    if (result.kind === "ready") { owner = result; }
  }
  return { root, path, directory, owner: owner!, file: join(path, "host-http-consumption-v1.journal"),
    tomb: join(path, "host-http-consumption-v1.tombstone") };
};

for (const fault of ["short", "zero", "partial-throw", "ENOSPC", "sync-ack-loss", "write-ack-loss", "loop-bound"]) {
  linuxTest(`${fault} at the synchronous tail burns the key, fresh IDs, and restart`, async t => {
    const f = await fixture(t);
    const before = fs.statSync(f.file).size;
    const write = fs.writeSync;
    const sync = fs.fdatasyncSync;
    let writes = 0;
    if (fault === "sync-ack-loss") {
      t.mock.method(fs, "fdatasyncSync", (fd: number) => { sync(fd); throw new Error("synthetic sync acknowledgement loss"); });
    } else {
      t.mock.method(fs, "writeSync", (fd: number, bytes: Buffer, offset: number, length: number, position: null) => {
        writes += 1;
        if (fault === "loop-bound") { return write(fd, bytes, offset, 1, position); }
        if (writes !== 1) { return write(fd, bytes, offset, length, position); }
        if (fault === "short") { return write(fd, bytes, offset, 17, position); }
        if (fault === "zero") { return 0; }
        if (fault === "ENOSPC") { throw Object.assign(new Error("synthetic disk full"), { code: "ENOSPC" }); }
        write(fd, bytes, offset, fault === "partial-throw" ? 17 : length, position);
        throw new Error("synthetic write acknowledgement loss");
      });
    }
    assert.equal(f.owner.journal.consume(key(), digest("c")), "unknown");
    assert.equal(f.owner.journal.consume(key(), digest("c")), "unknown");
    assert.equal(f.owner.journal.consume(key("fresh"), digest("c")), "unknown");
    if (["short", "partial-throw", "write-ack-loss", "sync-ack-loss", "loop-bound"].includes(fault)) {
      assert.ok(fs.statSync(f.file).size > before);
    }
    if (fault === "loop-bound") { assert.ok(writes <= 64); }
    t.mock.restoreAll();
    assert.equal(await f.owner.retire(), "unknown");
    const persisted = await readFile(f.file);
    assert.equal((await createNodeHostHttpConsumptionJournal({ directory: f.directory,
      envelope: { ...envelope, hostBootId: "boot:next" } }).prepare()).kind, "reconciliation_required");
    assert.deepEqual(await readFile(f.file), persisted);
  });
}

for (const method of ["fdatasyncSync", "fsyncSync"] as const) {
  linuxTest(`pre-admission ${method} acknowledgement loss never publishes a journal`, async t => {
    const f = await fixture(t, false);
    const sync = fs[method];
    let calls = 0;
    t.mock.method(fs, method, (fd: number) => { sync(fd); if (++calls === 1) { throw new Error("synthetic lost header ack"); } });
    const result = await createNodeHostHttpConsumptionJournal({ directory: f.directory, envelope }).prepare();
    assert.equal(result.kind, "unknown");
    assert.equal("journal" in result, false);
    assert.ok(fs.statSync(f.file).size > 0);
    assert.ok((await readFile(f.tomb)).includes(Buffer.from("quarantined")));
    t.mock.restoreAll();
    assert.equal((await createNodeHostHttpConsumptionJournal({ directory: f.directory, envelope }).prepare()).kind, "reconciliation_required");
  });
}

linuxTest("tombstone fsync failure reports unknown without deleting the durable generation", async t => {
  const f = await fixture(t);
  const sync = fs.fsyncSync;
  t.mock.method(fs, "fsyncSync", (fd: number) => { sync(fd); throw new Error("synthetic tombstone ack loss"); });
  assert.equal(await f.owner.retire(), "unknown");
  assert.equal(f.owner.journal.consume(key(), digest("c")), "unknown");
  t.mock.restoreAll();
  assert.ok(fs.existsSync(f.file));
  assert.ok(fs.existsSync(f.tomb));
  assert.equal((await createNodeHostHttpConsumptionJournal({ directory: f.directory, envelope }).prepare()).kind, "reconciliation_required");
});

for (const drift of ["replace-root", "symlink-root", "symlink-ancestor", "hardlink-file", "symlink-file",
  "replace-file", "file-mode", "root-mode", "corrupt-header", "truncate", "corrupt-tail", "extra-entry"]) {
  linuxTest(`${drift} fails closed without another acknowledged consumption`, async t => {
    const f = await fixture(t);
    assert.equal(f.owner.journal.consume(key(), digest("c")), "consumed");
    const moved = join(f.root, "moved");
    if (drift === "replace-root" || drift === "symlink-root") {
      fs.renameSync(f.path, moved);
      if (drift === "replace-root") { fs.mkdirSync(f.path, { mode: 0o700 }); }
      else { fs.symlinkSync(moved, f.path); }
    }
    if (drift === "symlink-ancestor") {
      const parent = `${f.root}-moved`;
      fs.renameSync(f.root, parent); fs.symlinkSync(parent, f.root);
      t.after(() => rm(parent, { recursive: true, force: true }));
    }
    if (drift === "hardlink-file") { fs.linkSync(f.file, join(f.root, "linked")); }
    if (drift === "symlink-file") { fs.renameSync(f.file, moved); fs.symlinkSync(moved, f.file); }
    if (drift === "replace-file") { fs.renameSync(f.file, moved); fs.copyFileSync(moved, f.file); }
    if (drift === "file-mode") { fs.chmodSync(f.file, 0o644); }
    if (drift === "root-mode") { fs.chmodSync(f.path, 0o755); }
    if (drift === "truncate") { fs.truncateSync(f.file, 1); }
    if (drift === "extra-entry") { fs.writeFileSync(join(f.path, "intruder"), "x", { mode: 0o600 }); }
    if (drift === "corrupt-header" || drift === "corrupt-tail") {
      const fd = fs.openSync(f.file, "r+");
      fs.writeSync(fd, Buffer.from("X"), 0, 1, drift === "corrupt-header" ? 40 : fs.statSync(f.file).size - 2);
      fs.closeSync(fd);
    }
    assert.equal(f.owner.journal.consume(key("fresh"), digest("c")), "unknown");
    assert.equal(f.owner.journal.consume(key(), digest("c")), "unknown");
    assert.equal(await f.owner.retire(), "unknown");
    if (drift === "replace-root" || drift === "symlink-root") {
      assert.ok(fs.existsSync(join(moved, "host-http-consumption-v1.tombstone")));
      assert.equal((await createNodeHostHttpConsumptionJournal({ directory: f.directory, envelope }).prepare()).kind, "unknown");
    }
  });
}

linuxTest("root replacement during fdatasync is caught by the postwrite cut", async t => {
  const f = await fixture(t);
  const sync = fs.fdatasyncSync;
  let calls = 0;
  const moved = join(f.root, "moved");
  t.mock.method(fs, "fdatasyncSync", (fd: number) => {
    sync(fd);
    if (++calls === 1) { fs.renameSync(f.path, moved); fs.mkdirSync(f.path, { mode: 0o700 }); }
  });
  assert.equal(f.owner.journal.consume(key(), digest("c")), "unknown");
  assert.ok(fs.statSync(join(moved, "host-http-consumption-v1.journal")).size > 1_000);
  assert.ok(fs.existsSync(join(moved, "host-http-consumption-v1.tombstone")));
  assert.deepEqual(fs.readdirSync(f.path), []);
});

linuxTest("a concurrent checksum-valid prefix substitution cannot become the next expected tail", async t => {
  const f = await fixture(t);
  assert.equal(f.owner.journal.consume(key(), digest("c")), "consumed");
  const foreign = await fixture(t, false);
  const other = await createNodeHostHttpConsumptionJournal({ directory: foreign.directory,
    envelope: { ...envelope, hostBootId: "boot:two" } }).prepare();
  assert.equal(other.kind, "ready");
  if (other.kind !== "ready") { return; }
  t.after(() => other.retire());
  assert.equal(other.journal.consume(key(), digest("c")), "consumed");
  const changed = fs.readFileSync(foreign.file);
  assert.equal(changed.length, fs.statSync(f.file).size);
  const write = fs.writeSync;
  let once = false;
  t.mock.method(fs, "writeSync", (fd: number, bytes: Buffer, offset: number, length: number, position: null) => {
    if (!once) {
      once = true;
      // Substitute another real, fully durable envelope's equal-length tail.
      const writable = fs.openSync(f.file, "r+");
      write(writable, changed, 0, changed.length, 0);
      fs.closeSync(writable);
    }
    return write(fd, bytes, offset, length, position);
  });
  assert.equal(f.owner.journal.consume(key("fresh"), digest("c")), "unknown");
  assert.equal(f.owner.journal.consume(key("again"), digest("c")), "unknown");
});

for (const residue of ["symlink", "hardlink", "nonprivate", "torn-tombstone"]) {
  linuxTest(`preexisting ${residue} is never followed, repaired, or truncated`, async t => {
    const f = await fixture(t, false);
    const outside = join(f.root, "synthetic-unrelated-file");
    fs.writeFileSync(outside, "must remain unchanged", { mode: 0o600 });
    if (residue === "symlink") { fs.symlinkSync(outside, f.file); }
    if (residue === "hardlink") { fs.linkSync(outside, f.file); }
    if (residue === "nonprivate") { fs.writeFileSync(f.file, "old", { mode: 0o644 }); }
    if (residue === "torn-tombstone") { fs.writeFileSync(f.tomb, "old", { mode: 0o600 }); }
    const result = await createNodeHostHttpConsumptionJournal({ directory: f.directory, envelope }).prepare();
    assert.equal(result.kind, "reconciliation_required");
    assert.equal(fs.readFileSync(outside, "utf8"), "must remain unchanged");
    if (residue === "torn-tombstone") { assert.equal(fs.readFileSync(f.tomb, "utf8"), "old"); }
  });
}

linuxTest("real kernel lock loss is observed before the next write", async t => {
  const f = await fixture(t, false);
  const sync = fs.fsyncSync;
  let lockedFd = -1;
  t.mock.method(fs, "fsyncSync", (fd: number) => { lockedFd = fd; sync(fd); });
  const prepared = await createNodeHostHttpConsumptionJournal({ directory: f.directory, envelope }).prepare();
  assert.equal(prepared.kind, "ready");
  if (prepared.kind !== "ready") { return; }
  t.after(() => prepared.retire());
  t.mock.restoreAll();
  const loaded = { exports: {} } as NodeModule;
  const entry = fileURLToPath(import.meta.resolve("@agent-teams/filesystem-custody"));
  process.dlopen(loaded, join(entry, "..", "rename-no-replace.node"));
  (loaded.exports as { unlockDirectory(fd: number): void }).unlockDirectory(lockedFd);
  const before = fs.statSync(f.file).size;
  assert.equal(prepared.journal.consume(key(), digest("c")), "unknown");
  assert.equal(fs.statSync(f.file).size, before);
  assert.equal(await prepared.retire(), "unknown");
  assert.equal((await createNodeHostHttpConsumptionJournal({ directory: f.directory, envelope }).prepare()).kind, "reconciliation_required");
});

linuxTest("unsupported existing native lock primitive publishes no file or fallback lock", async t => {
  const f = await fixture(t, false);
  // A separate synthetic process gives the existing lock loader an empty cache.
  const script = `import fs from 'node:fs';
    process.dlopen = () => { throw new Error('synthetic unavailable native binding'); };
    const {createNodeHostHttpConsumptionJournal} = await import(${JSON.stringify(new URL("../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/egress/node-host-http-consumption-journal.js", import.meta.url).href)});
    const result = await createNodeHostHttpConsumptionJournal(${JSON.stringify({ directory: f.directory, envelope })}).prepare();
    fs.writeSync(1, result.kind);`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { env: {}, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", chunk => { output += String(chunk); });
  const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
  assert.equal(code, 0); assert.equal(output, "unsupported");
  assert.deepEqual(fs.readdirSync(f.path), []);
});

for (const phase of ["partial-header", "header-sync", "after-header", "partial-record", "record-sync", "after-consume"]) {
  linuxTest(`SIGKILL at ${phase} releases exclusion but cannot resume execution`, { timeout: 10_000 }, async t => {
    const f = await fixture(t, false);
    const helper = join(import.meta.dirname, "host-http-consumption-journal-fixture.mjs");
    const child = spawn(process.execPath, [helper, "--crash-fixture", JSON.stringify(f.directory), phase],
      { env: {}, stdio: ["ignore", "pipe", "pipe"] });
    const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once("error", reject); child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    t.after(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); } await exit; });
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("disposable child did not reach crash cut")), 5_000);
      let output = "";
      child.stdout.on("data", chunk => {
        output += String(chunk);
        if (output.includes(`stopped:${phase}\n`)) { clearTimeout(timeout); resolve(); }
      });
      child.once("error", error => { clearTimeout(timeout); reject(error); });
      child.once("exit", () => { clearTimeout(timeout); reject(new Error("disposable child exited early")); });
    });
    // Independent PROCESS exclusion is checked while the actual holder is stopped.
    assert.equal((await createNodeHostHttpConsumptionJournal({ directory: f.directory, envelope }).prepare()).kind, "busy");
    assert.equal(child.kill("SIGKILL"), true);
    assert.deepEqual(await exit, { code: null, signal: "SIGKILL" });
    const before = await readFile(f.file);
    const fresh = { ...envelope, hostBootId: "boot:new", executionGenerationId: "generation:new" };
    const result = await createNodeHostHttpConsumptionJournal({ directory: f.directory, envelope: fresh }).prepare();
    assert.equal(result.kind, "reconciliation_required");
    assert.equal("journal" in result, false);
    assert.deepEqual(await readFile(f.file), before);
    assert.ok((await readFile(f.tomb)).includes(Buffer.from("quarantined")));
  });
}
