import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { test, after } from "node:test";
import { DarwinRouteDurableStorage, darwinDigest, inspectDarwinRouteResidue } from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/darwin-route-durable-storage.js";
import { createDarwinHostHttpConsumptionJournal } from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/egress/darwin-host-http-consumption-journal.js";
import { DarwinRouteLifecycleJournal } from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/darwin-route-lifecycle-journal.js";

// Actual emitted adapters + disposable filesystem; only platform/ancestor trust
// and native lock binding are simulated. This is not Darwin storage evidence.
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
Object.defineProperty(process, "platform", {...platform, value: "darwin"});
after(() => Object.defineProperty(process, "platform", platform));
const originalDlopen = process.dlopen;
const originalLstat = fs.lstatSync;
const locked = new Set<string>();
process.dlopen = module => {module.exports = {
  tryLockDirectory(fd: number) {const s = fs.fstatSync(fd); const key = `${s.dev}:${s.ino}`;
    if (locked.has(key)) {return false;} locked.add(key); return true;},
  unlockDirectory(fd: number) {const s = fs.fstatSync(fd); assert.equal(locked.delete(`${s.dev}:${s.ino}`), true);},
};};
fs.lstatSync = ((file: fs.PathLike, options?: {bigint?: boolean}) => {
  const result = originalLstat(file, options as never);
  if (file === os.tmpdir()) {Object.defineProperty(result, "mode", {value: options?.bigint ? 0o40755n : 0o40755});}
  return result;
}) as typeof fs.lstatSync;
syncBuiltinESMExports();
after(() => {process.dlopen = originalDlopen; fs.lstatSync = originalLstat; syncBuiltinESMExports(); assert.equal(locked.size, 0);});
const fixture = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ar69-darwin-store-test-")); fs.chmodSync(root, 0o700);
  const s = fs.lstatSync(root); const pin = {path: root, dev: String(s.dev), ino: String(s.ino)};
  const store = new DarwinRouteDurableStorage(pin, darwinDigest("operation-1"));
  return {root, pin, store, cleanup: () => fs.rmSync(root, {recursive: true, force: true})};
};
const envelope = {tenantId: "tenant", projectId: "project", operationId: "operation", attemptId: "attempt",
  custodyId: "custody", hostBootId: "boot", generation: "generation", authorityVectorDigest: "vector", listenerIdentity: "listener"};
const key = {namespace: "provider-process-egress/v2" as const, tenantId: "tenant", projectId: "project", operationId: "operation", boundaryUseId: "use"};
const fingerprint = `sha256:${"a".repeat(64)}`;

test("Darwin synchronous consumption persists before return, duplicates burn once and conflicts quarantine", async t => {
  const f = fixture(); t.after(f.cleanup); await f.store.open(); t.after(() => f.store.close());
  f.store.create("lifecycle", {operation: "operation"});
  const journal = await createDarwinHostHttpConsumptionJournal(f.store, envelope).prepare(); assert.equal(journal.kind, "ready");
  if (journal.kind !== "ready") {return;}
  assert.equal(journal.journal.consume(key, fingerprint), "consumed");
  const records = inspectDarwinRouteResidue(f.store.path.replace("lifecycle", "consumption")) as {kind: string}[];
  assert.deepEqual(records.map(record => record.kind), ["header", "consume"]);
  assert.equal(journal.journal.consume(key, fingerprint), "duplicate");
  assert.equal(journal.journal.consume(key, `sha256:${"b".repeat(64)}`), "mismatch");
  assert.equal(journal.journal.consume({...key, boundaryUseId: "other"}, fingerprint), "unknown");
  assert.equal(await journal.retire(), "unknown");
});

test("distinct directory opens contend; any original operation residue forbids replay after lock release", async t => {
  const f = fixture(); t.after(f.cleanup); await f.store.open();
  f.store.create("lifecycle", {operation: "operation", generation: "one"});
  const second = new DarwinRouteDurableStorage(f.pin, f.store.locator);
  await assert.rejects(second.open()); assert.equal(await second.close(), false);
  assert.equal(await f.store.close(), true);
  const restart = new DarwinRouteDurableStorage(f.pin, f.store.locator);
  await assert.rejects(restart.open()); assert.equal(await restart.close(), false);
  assert.equal((inspectDarwinRouteResidue(f.store.path)[0] as {data: {generation: string}}).data.generation, "one");
});

test("partial writes complete synchronously; fsync uncertainty never authorizes a consumption retry", async t => {
  const f = fixture(); t.after(f.cleanup); await f.store.open(); t.after(() => f.store.close());
  f.store.create("lifecycle", {operation: "operation"});
  const prepared = await createDarwinHostHttpConsumptionJournal(f.store, envelope).prepare(); assert.equal(prepared.kind, "ready");
  if (prepared.kind !== "ready") {return;}
  const write = fs.writeSync;
  const partial = t.mock.method(fs, "writeSync", (fd: number, bytes: Buffer, offset: number, length: number, position: number) =>
    write(fd, bytes, offset, Math.min(length, 7), position)); syncBuiltinESMExports();
  assert.equal(prepared.journal.consume(key, fingerprint), "consumed");
  assert.ok(partial.mock.callCount() > 1); partial.mock.restore(); syncBuiltinESMExports();
  const sync = t.mock.method(fs, "fsyncSync", () => {throw new Error("lost durability acknowledgement");}); syncBuiltinESMExports();
  assert.equal(prepared.journal.consume({...key, boundaryUseId: "second"}, fingerprint), "unknown");
  sync.mock.restore(); syncBuiltinESMExports();
  assert.equal(prepared.journal.consume({...key, boundaryUseId: "second"}, fingerprint), "unknown");
  assert.equal(await prepared.retire(), "unknown");
});

test("foreign operation, zero write, lost directory sync, and file replacement fail closed", async t => {
  for (const mode of ["foreign", "zero", "directory-sync", "replace"] as const) {
    const f = fixture(); t.after(f.cleanup); await f.store.open(); t.after(() => f.store.close());
    if (mode === "directory-sync") {
      const sync = t.mock.method(fs, "fsyncSync", fd => {if (fs.fstatSync(fd).isDirectory()) {throw new Error("directory sync failure");}});
      syncBuiltinESMExports(); assert.throws(() => f.store.create("lifecycle", {}));
      sync.mock.restore(); syncBuiltinESMExports(); continue;
    }
    f.store.create("lifecycle", {});
    const prepared = await createDarwinHostHttpConsumptionJournal(f.store, envelope).prepare(); assert.equal(prepared.kind, "ready");
    if (prepared.kind !== "ready") {continue;}
    if (mode === "foreign") {
      assert.equal(prepared.journal.consume({...key, operationId: "foreign"}, fingerprint), "mismatch");
    } else if (mode === "replace") {
      fs.renameSync(f.store.path, `${f.store.path}.old`); fs.writeFileSync(f.store.path, "replacement", {mode: 0o600});
      assert.equal(prepared.journal.consume(key, fingerprint), "unknown");
    } else {
      const write = t.mock.method(fs, "writeSync", () => 0); syncBuiltinESMExports();
      assert.equal(prepared.journal.consume(key, fingerprint), "unknown");
      write.mock.restore(); syncBuiltinESMExports();
    }
    assert.equal(await prepared.retire(), "unknown");
  }
});

test("recordRelease is durable intent; listener_closed requires underlying acknowledgement", async t => {
  const f = fixture(); t.after(f.cleanup);
  const lifetime = {signal: new AbortController().signal, committedDispatchProof: {operationId: "operation"}, hostLifecycleGenerationSha256: "generation"};
  const journal = new DarwinRouteLifecycleJournal(f.store, lifetime as never); await journal.prepare();
  t.after(() => f.store.close());
  const acknowledged = Promise.withResolvers<{state: "closed"}>(); let closeCalls = 0;
  const listener = journal.wrapListener({open: async () => ({address: {address: "127.0.0.1", family: "IPv4", port: 30000}, sealAdmission() {}}),
    close: () => {closeCalls++; return acknowledged.promise;}, observe() {}, sealAdmission() {}} as never);
  const bound = journal.listenerLifecycle.bind(lifetime as never);
  await bound.recordOpen(); await listener.open(undefined as never, undefined as never);
  journal.cutoff(); await bound.recordRelease(); const closing = listener.close();
  const kinds = () => (inspectDarwinRouteResidue(f.store.path) as {kind: string}[]).map(record => record.kind);
  assert.ok(kinds().includes("listener_close_intent")); assert.equal(kinds().includes("listener_closed"), false);
  acknowledged.resolve({state: "closed"}); assert.deepEqual(await closing, {state: "closed"});
  assert.ok(kinds().includes("listener_closed")); await bound.recordRelease(); await listener.close(); assert.equal(closeCalls, 1);
  assert.equal(await journal.close(true), true);
});

test("forensic inspection rejects torn/checksum residue and never reconstructs executable state", async t => {
  const f = fixture(); t.after(f.cleanup); await f.store.open(); f.store.create("lifecycle", {}); await f.store.close();
  const bytes = fs.readFileSync(f.store.path);
  for (const bad of [bytes.subarray(0, bytes.length - 1), Buffer.alloc(64), Buffer.from(bytes)]) {
    if (bad.length === bytes.length) {bad[bad.length - 1] ^= 1;}
    fs.writeFileSync(f.store.path, bad); assert.throws(() => inspectDarwinRouteResidue(f.store.path));
  }
});

test("bound listener remains cleanup-owned when its durable bound acknowledgement fails", async t => {
  const f = fixture(); t.after(f.cleanup);
  const lifetime = {signal: new AbortController().signal, committedDispatchProof: {operationId: "operation"}, hostLifecycleGenerationSha256: "generation"};
  const journal = new DarwinRouteLifecycleJournal(f.store, lifetime as never); await journal.prepare(); t.after(() => f.store.close());
  let closes = 0;
  const listener = journal.wrapListener({open: async () => ({address: {address: "127.0.0.1", family: "IPv4", port: 30000}, sealAdmission() {}}),
    close: async () => {closes++; return {state: "closed"};}, observe() {}, sealAdmission() {}} as never);
  const bound = journal.listenerLifecycle.bind(lifetime as never); await bound.recordOpen();
  const append = f.store.append.bind(f.store);
  const failure = t.mock.method(f.store, "append", (name, kind, data) => {
    append(name, kind, data); if (kind === "listener_bound") {throw new Error("lost acknowledgement");}
  });
  await assert.rejects(listener.open(undefined as never, undefined as never));
  failure.mock.restore(); journal.cutoff(); await bound.recordRelease();
  assert.deepEqual(await listener.close(), {state: "closed"}); assert.equal(closes, 1);
  assert.equal(await journal.close(true), false); // uncertain observation never becomes a clean receipt
});

test("lost retained FD and replaced ancestor are refused without reopening a generation", async t => {
  for (const mode of ["fd", "ancestor"] as const) {
    const f = fixture(); t.after(f.cleanup); await f.store.open(); f.store.create("lifecycle", {});
    const original = fs.fstatSync;
    const mutation = mode === "fd" ? t.mock.method(fs, "fstatSync", (fd, options) => {
      const s = original(fd, options as never); if (s.isFile()) {throw Object.assign(new Error("lost FD"), {code: "EBADF"});} return s;
    }) : t.mock.method(fs, "lstatSync", (file, options) => {
      const s = originalLstat(file, options as never);
      if (file === os.tmpdir()) {Object.defineProperty(s, "mode", {value: options?.bigint ? 0o40755n : 0o40755});}
      if (file === f.root) {Object.defineProperty(s, "ino", {value: options?.bigint ? 999999n : 999999});}
      return s;
    });
    syncBuiltinESMExports(); assert.throws(() => f.store.append("lifecycle", "effect", {}));
    mutation.mock.restore(); syncBuiltinESMExports(); assert.equal(await f.store.close(), false);
    assert.equal((inspectDarwinRouteResidue(f.store.path) as {kind: string}[]).some(record => record.kind === "effect"), false);
  }
});
