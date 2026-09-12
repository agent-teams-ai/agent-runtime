import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, link, lstat, mkdir, mkdtemp, open, opendir, readFile, readdir, realpath, rename, rm, symlink, truncate, unlink, writeFile, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { v4Decode, v4Hash, v4Locator } from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/journal/host-http-egress-v4-codec.js";
import { HostHttpEgressV4Journal } from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/journal/host-http-egress-v4-journal.js";
import { HostHttpEgressV4NodeStorage, type HostHttpEgressV4FileSystem } from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/journal/host-http-egress-v4-node-storage.js";
import { HOST_HTTP_EGRESS_V4_LIMITS as LIMITS } from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/journal/host-http-egress-v4-types.js";
import type { HostHttpEgressV4Intent, HostHttpEgressV4Observed } from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/journal/host-http-egress-v4-types.js";
import { container, id, subject, SyntheticV4Owner, V4Fixture } from "../../fixtures/host-http-egress-v4-fixture.ts";

const linuxTest = process.platform === "linux" ? test : test.skip;
const name = `host-http-egress-v4-${v4Locator(subject)}.journal`;
const nodeFiles: HostHttpEgressV4FileSystem = { lstat: path => lstat(path, { bigint: true }), realpath, open, opendir };
const rootFor = async (t: TestContext): Promise<string> => {
  const root = await mkdtemp("/tmp/host-http-egress-v4-test-");
  t.after(async () => { await rm(root, { recursive: true, force: true }); }); return root;
};
const create = (t: TestContext, root: string, files?: HostHttpEgressV4FileSystem) => {
  const storage = new HostHttpEgressV4NodeStorage(root, files);
  const journal = new HostHttpEgressV4Journal(storage, subject, new SyntheticV4Owner());
  t.after(async () => { await journal.close().catch(() => {}); }); return { storage, journal };
};
const networkIntent = async (journal: HostHttpEgressV4Journal) => journal.recordIntent(`command:${v4Hash("network")}`,
  { kind: "network_intent", targetSha256: journal.target("network_intent") });

linuxTest("Node constructor performs no filesystem or process-lock work", async () => {
  let calls = 0;
  const files = new Proxy(nodeFiles, { get: () => { calls += 1; throw new Error("constructor I/O"); } });
  const storage = new HostHttpEgressV4NodeStorage("/never-opened-v4", files);
  assert.equal(calls, 0); await assert.rejects(storage.prepare(v4Locator(subject))); assert.equal(calls, 1);
});

linuxTest("one real filesystem owner; close retains history and reopening supplies cleanup only", async t => {
  const root = await rootFor(t); const first = create(t, root); await first.journal.prepare(id("command"));
  const second = create(t, root); await assert.rejects(second.journal.prepare(id("command")), { code: "quarantined" });
  await networkIntent(first.journal); const before = await readFile(join(root, name));
  await first.journal.close(); assert.equal(first.journal.evidence().resourceLedger, "open");
  assert.deepEqual(await readFile(join(root, name)), before);
  const resumed = create(t, root); assert.equal((await resumed.journal.prepare(id("command"))).kind, "cleanup_only");
  const handles = await resumed.journal.cleanupHandles(); assert.equal(handles.handles.network?.handle, subject.networkHandle);
  assert.equal(handles.handles.network?.actualSha256, null); assert.equal((await networkIntent(resumed.journal)).kind, "duplicate");
  await assert.rejects(resumed.journal.recordIntent(`command:${v4Hash("fresh-network")}`,
    { kind: "network_intent", targetSha256: resumed.journal.target("network_intent") }));
  assert.equal((await lstat(join(root, name))).mode & 0o777, 0o600);
  assert.equal((await readdir(root)).length, 2);
});

linuxTest("real filesystem persists two exchanges and a retained retirement tombstone without rewriting history", async t => {
  const root = await rootFor(t); const storage = new HostHttpEgressV4NodeStorage(root); const owner = new SyntheticV4Owner();
  const journal = new HostHttpEgressV4Journal(storage, subject, owner); let serial = 0;
  t.after(async () => { await journal.close().catch(() => {}); });
  const command = () => `command:${v4Hash(++serial)}`;
  const intent = (kind: HostHttpEgressV4Intent) => journal.recordIntent(command(), { kind, targetSha256: journal.target(kind) });
  const observe = (kind: HostHttpEgressV4Observed) => journal.recordObservation(command(), owner.token({ kind,
    subjectSha256: v4Hash(subject), observerSha256: subject.observerSha256, targetSha256: journal.target(kind),
    actualSha256: v4Hash([kind, serial]), evidenceSha256: v4Hash(["synthetic", serial]),
    container: kind === "container_attached" || kind === "container_absent" ? container : null,
    writeOutcome: kind === "sockets_closed" ? "settled" : null }));
  await journal.prepare(command()); await intent("network_intent"); await observe("network_allocated");
  await intent("listener_intent"); await observe("listener_allocated"); await observe("container_attached");
  await intent("route_intent"); await observe("route_installed");
  for (let index = 0; index < 2; index += 1) {
    await intent("inbound_intent"); await observe("inbound_allocated"); await intent("upstream_intent"); await observe("upstream_allocated");
    await intent("sockets_close"); await observe("sockets_closed");
  }
  await intent("cutoff"); await observe("cutoff_observed"); await observe("container_absent");
  await intent("listener_release"); await observe("listener_absent"); await intent("network_release"); await observe("network_absent");
  await intent("retired"); await journal.close();
  const before = await readFile(join(root, name)); const marker = name.replace(".journal", ".tombstone");
  const tombstone = await readFile(join(root, marker)); const recovered = create(t, root);
  assert.equal((await recovered.journal.prepare(command())).kind, "cleanup_only");
  assert.equal(recovered.journal.evidence().resourceLedger, "retired"); assert.equal(recovered.journal.evidence().reconcileRequired, false);
  await recovered.journal.close(); assert.deepEqual(await readFile(join(root, name)), before);
  assert.deepEqual(await readFile(join(root, marker)), tombstone); assert.equal((await readdir(root)).length, 2);
});

for (const fault of ["short", "fsync", "dirsync", "quota"] as const) {
  linuxTest(`real filesystem ${fault} failure loses acknowledgement and permanently seals the writer`, async t => {
    const root = await rootFor(t); let fileWrites = 0; let fileSyncs = 0; let directorySyncs = 0;
    const files: HostHttpEgressV4FileSystem = { ...nodeFiles, open: async (path, flags, mode) => {
      const handle = await open(path, flags, mode);
      return new Proxy(handle, { get(target, property) {
        if (property === "write" && path.endsWith(".journal")) {
          return async (bytes: Uint8Array) => {
            fileWrites += 1;
            if (fileWrites === 2 && fault === "quota") { throw Object.assign(new Error("synthetic ENOSPC"), { code: "ENOSPC" }); }
            return target.write(fileWrites === 2 && fault === "short" ? bytes.subarray(0, 10) : bytes);
          };
        }
        if (property === "sync") {
          return async () => {
            await target.sync();
            if (path.endsWith(".journal")) { fileSyncs += 1; if (fileSyncs === 2 && fault === "fsync") { throw new Error("lost fsync ack"); } }
            if (path === root) { directorySyncs += 1; if (directorySyncs === 2 && fault === "dirsync") { throw new Error("lost directory ack"); } }
          };
        }
        const value: unknown = Reflect.get(target, property, target); return typeof value === "function" ? value.bind(target) : value;
      } });
    } };
    const first = create(t, root, files); await first.journal.prepare(id("command"));
    await assert.rejects(networkIntent(first.journal), { code: "quarantined" });
    assert.equal(first.journal.evidence().reconcileRequired, true);
    await assert.rejects(networkIntent(first.journal), { code: "quarantined" });
    await first.journal.close(); const restarted = create(t, root);
    if (fault === "short") { await assert.rejects(restarted.journal.prepare(id("command")), { code: "quarantined" }); }
    else {
      assert.equal((await restarted.journal.prepare(id("command"))).kind, "cleanup_only");
      assert.equal(restarted.journal.evidence().reconcileRequired, true);
    }
  });
}

for (const tamper of ["root", "lock", "journal-replaced", "same-size-write", "new-entry", "new-tombstone"] as const) {
  linuxTest(`live ${tamper} loss is detected before the next resource intent`, async t => {
    const root = await rootFor(t); let directory: FileHandle | undefined;
    const files: HostHttpEgressV4FileSystem = { ...nodeFiles, open: async (path, flags, mode) => {
      const handle = await open(path, flags, mode); if (path === root) { directory = handle; } return handle;
    } };
    const first = create(t, root, files); await first.journal.prepare(id("command"));
    switch (tamper) {
      case "root": {
        const moved = `${root}-moved`; await rename(root, moved); await mkdir(root, { mode: 0o700 });
        t.after(async () => { await rm(moved, { recursive: true, force: true }); }); break;
      }
      case "lock": await directory!.close(); break;
      case "journal-replaced": await rename(join(root, name), join(root, "old")); await writeFile(join(root, name), "", { mode: 0o600 }); break;
      case "same-size-write": {
        const handle = await open(join(root, name), "r+"); await handle.write(Buffer.from("!"), 0, 1, 0); await handle.close(); break;
      }
      case "new-entry": await writeFile(join(root, "unknown"), "", { mode: 0o600 }); break;
      case "new-tombstone": await writeFile(join(root, name.replace(".journal", ".tombstone")), "", { mode: 0o600 }); break;
    }
    await assert.rejects(networkIntent(first.journal), { code: "quarantined" });
    assert.equal(first.journal.evidence().admission, "closed");
  });
}

for (const tamper of ["symlink", "hardlink", "mode", "partial", "corrupt", "oversized", "overlap", "legacy", "root-symlink"] as const) {
  linuxTest(`restart rejects ${tamper} before effects and exposes no cleanup handles`, async t => {
    const root = await rootFor(t); const f = new V4Fixture(); await f.setup(); const bytes = f.storage.journal!;
    const path = join(root, name); await writeFile(path, bytes, { mode: 0o600 });
    let selectedRoot = root;
    switch (tamper) {
      case "symlink": await rename(path, join(root, "source")); await symlink(join(root, "source"), path); break;
      case "hardlink": await link(path, join(root, "second-link")); break;
      case "mode": await chmod(path, 0o644); break;
      case "partial": await truncate(path, bytes.length - 1); break;
      case "corrupt": await writeFile(path, "untrusted invalid bytes\n"); break;
      case "oversized": await truncate(path, LIMITS.maxBytes + 1); break;
      case "overlap": await writeFile(join(root, `host-http-egress-v4-${v4Hash("overlap")}.journal`), bytes, { mode: 0o600 }); break;
      case "legacy": await rename(path, join(root, "docker-egress-custody-v3-legacy.journal")); break;
      case "root-symlink": {
        selectedRoot = `${root}-link`; await symlink(root, selectedRoot);
        t.after(async () => { await unlink(selectedRoot); }); break;
      }
    }
    const { journal } = create(t, selectedRoot);
    await assert.rejects(journal.prepare(id("command")), { code: "quarantined" });
    await assert.rejects(journal.cleanupHandles(), { code: "quarantined" });
    assert.ok(!JSON.stringify(journal.evidence()).includes(root));
  });
}

for (const checkpoint of ["opened", "network", "active", "cutoff"] as const) {
  linuxTest(`SIGKILL at ${checkpoint}: kernel lock releases, exact durable generation remains cleanup-only`, { timeout: 15_000 }, async t => {
    const root = await rootFor(t);
    const helper = join(import.meta.dirname, "../../fixtures/host-http-egress-v4-crash-child.mjs");
    const child = spawn(process.execPath, [helper, root, checkpoint], { stdio: ["ignore", "pipe", "pipe"] });
    const exited = once(child, "exit"); let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    t.after(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); } await exited; });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`crash fixture readiness timeout ${stderr}`)), 5_000);
      child.once("error", reject); child.once("exit", () => { clearTimeout(timer); reject(new Error(`early fixture exit ${stderr}`)); });
      child.stdout.on("data", (chunk: Buffer) => { if (chunk.toString().includes("ready\n")) { clearTimeout(timer); resolve(); } });
    });
    const contender = create(t, root); await assert.rejects(contender.journal.prepare(id("command")));
    assert.equal(child.kill("SIGKILL"), true); assert.deepEqual(await exited, [null, "SIGKILL"]);
    const recovered = create(t, root); const result = await recovered.journal.prepare(id("command"));
    assert.equal(result.kind, "cleanup_only"); await assert.rejects(networkIntent(recovered.journal));
    const handles = await recovered.journal.cleanupHandles();
    assert.equal(handles.handles.network !== null, checkpoint !== "opened");
    assert.equal(handles.handles.sockets !== null, checkpoint === "active" || checkpoint === "cutoff");
    assert.equal(v4Decode(await readFile(join(root, name)))[0]!.version, 4);
  });
}
