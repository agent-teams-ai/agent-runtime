import assert from "node:assert/strict";
import { constants } from "node:fs";
import { spawn } from "node:child_process";
import { chmod, link, lstat, mkdir, open, opendir, readFile, realpath, readdir, rename, rm, symlink, unlink, writeFile, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import {
  DEFAULT_DOCKER_CUSTODY_JOURNAL_LIMITS,
  DOCKER_CUSTODY_STATES,
  DockerCustodyJournal,
  NodeDockerCustodyJournalStorage,
  createDockerCustodyRecord,
  dockerCustodyAttemptLocator,
  encodeDockerCustodyRecord,
  replayDockerCustodyBytes,
  validateDockerCustodyAttemptKey,
  type DockerCustodyLinuxFileSystemPort,
} from "../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/journal/index.js";
import {
  MemoryStorage,
  advance,
  authoritySha256,
  fingerprint,
  key,
} from "./fixtures/docker-journal-test-fixture.ts";

test("persists and syncs every exact monotone record before returning authority", async () => {
  const storage = new MemoryStorage();
  const journal = new DockerCustodyJournal(storage);
  await advance(journal);
  const file = storage.files.get(dockerCustodyAttemptLocator(key));
  assert.ok(file);
  assert.equal(file.syncs, DOCKER_CUSTODY_STATES.length);
  const replay = replayDockerCustodyBytes(file.bytes, DEFAULT_DOCKER_CUSTODY_JOURNAL_LIMITS);
  assert.deepEqual(replay.records.map(record => record.state), DOCKER_CUSTODY_STATES);
  assert.equal(replay.records.every((record, index) => record.sequence === index), true);
  assert.equal(replay.records.slice(0, 2).every(record => record.authoritySha256 === null), true);
  assert.equal(replay.records.slice(2).every(record => record.authoritySha256 === authoritySha256), true);
  assert.equal(replay.records.some(record => "timestamp" in record), false);
  assert.equal(replay.records[5]?.previousChecksumSha256, replay.records[4]?.checksumSha256);
});

test("recovery exposes observations and debt, never an action replay instruction", async () => {
  const storage = new MemoryStorage();
  const journal = new DockerCustodyJournal(storage);
  await advance(journal);
  const recovered = await new DockerCustodyJournal(storage).recover();
  assert.deepEqual(recovered, [{
    kind: "replayed",
    attemptKey: key,
    state: "closed",
    sequence: 11,
    evidence: { status: "proved" },
    hasDebt: true,
    providerExecution: "may_have_executed",
    tail: "complete",
  }]);
  assert.equal(JSON.stringify(recovered).includes("action"), false);
  assert.equal(JSON.stringify(recovered).includes("retry"), false);
  assert.equal(JSON.stringify(recovered).includes("outcome"), false);
});

test("one AttemptId owns one journal and every immutable binding mismatch conflicts", async () => {
  const storage = new MemoryStorage();
  const journal = new DockerCustodyJournal(storage);
  await journal.prepare(key);
  assert.equal((await journal.prepare(key)).state, "prepared");
  for (const changed of [
    { tenantId: "tenant:changed" },
    { projectId: "project:changed" },
    { operationId: "operation:changed" },
    { attemptId: "attempt:changed" },
    { custodyId: "custody:changed" },
    { hostInstanceId: "host:changed" },
    { hostBootId: "boot:changed" },
    { daemonIdentitySha256: "1".repeat(64) },
    { daemonBootGenerationSha256: "2".repeat(64) },
    { hostIdentitySha256: "3".repeat(64) },
    { hostBootGenerationSha256: "4".repeat(64) },
    { launchFingerprintSha256: "b".repeat(64) },
    { operationNonceSha256: "5".repeat(64) },
  ]) {
    await assert.rejects(journal.prepare({ ...key, ...changed }), { name: "DockerCustodyJournalConflictError" });
  }
  assert.equal(storage.files.size, 1);
});

test("CAS and exact next-state checks reject duplicate, skipped, and reordered transitions", async () => {
  const journal = new DockerCustodyJournal(new MemoryStorage());
  await journal.prepare(key);
  await assert.rejects(
    journal.observe({ authoritySha256, key, expectedSequence: 0, state: "created", evidence: { status: "proved" } }),
    { name: "DockerCustodyJournalConflictError" },
  );
  await journal.beforeAction({ key, expectedSequence: 0, state: "create_requested" });
  await assert.rejects(
    journal.beforeAction({ key, expectedSequence: 0, state: "create_requested" }),
    { name: "DockerCustodyJournalConflictError" },
  );
});

test("exact-shape bounded codec rejects unknown keys, paths, accessors, proxies, and non-digests", () => {
  assert.throws(() => validateDockerCustodyAttemptKey({ ...key, secret: "do-not-store" }), /exact data-only shape/u);
  assert.throws(() => validateDockerCustodyAttemptKey({ ...key, operationId: "../escape" }), /bounded opaque/u);
  assert.throws(() => validateDockerCustodyAttemptKey({ ...key, launchFingerprintSha256: "latest" }), /SHA-256/u);
  const accessor = { ...key };
  Object.defineProperty(accessor, "tenantId", { enumerable: true, get: () => "tenant-1" });
  assert.throws(() => validateDockerCustodyAttemptKey(accessor), /data-only/u);
  let proxyTrapCount = 0;
  const proxy = new Proxy({ ...key }, {
    getPrototypeOf: () => {proxyTrapCount += 1; return Object.prototype;},
    ownKeys: () => {proxyTrapCount += 1; return Reflect.ownKeys(key);},
    getOwnPropertyDescriptor: (target, property) => {proxyTrapCount += 1; return Reflect.getOwnPropertyDescriptor(target, property);},
  });
  assert.throws(() => validateDockerCustodyAttemptKey(proxy), /non-proxy/u);
  assert.equal(proxyTrapCount, 0);
  assert.throws(() => validateDockerCustodyAttemptKey({ ...key, [Symbol("hidden")]: "secret" }), /exact data-only shape/u);
  const first = createDockerCustodyRecord({
    attemptKey: key, sequence: 0, state: "prepared", evidence: { status: "proved" }, previousChecksumSha256: null,
  });
  for (const nested of [false, true]) {
    let traps = 0;
    const trapped = new Proxy(nested ? { ...key } : { ...first }, {
      get: (target, property, receiver) => {traps += 1; return Reflect.get(target, property, receiver) as unknown;},
      getPrototypeOf: target => {traps += 1; return Reflect.getPrototypeOf(target);},
      ownKeys: target => {traps += 1; return Reflect.ownKeys(target);},
      getOwnPropertyDescriptor: (target, property) => {traps += 1; return Reflect.getOwnPropertyDescriptor(target, property);},
    });
    const candidate = nested ? { ...first, attemptKey: trapped } : trapped;
    assert.throws(() => encodeDockerCustodyRecord(candidate as never, DEFAULT_DOCKER_CUSTODY_JOURNAL_LIMITS), /non-proxy/u);
    assert.equal(traps, 0);
  }
  for (const nested of [false, true]) {
    let getters = 0;
    const candidate = nested ? { ...key } : { ...first };
    Object.defineProperty(candidate, nested ? "tenantId" : "sequence", {
      enumerable: true, get: () => {getters += 1; return nested ? "tenant-1" : 0;},
    });
    const record = nested ? { ...first, attemptKey: candidate } : candidate;
    assert.throws(() => encodeDockerCustodyRecord(record as never, DEFAULT_DOCKER_CUSTODY_JOURNAL_LIMITS), /data-only/u);
    assert.equal(getters, 0);
  }
  assert.throws(() => encodeDockerCustodyRecord({ ...first, rawOutput: "provider secret" } as never, DEFAULT_DOCKER_CUSTODY_JOURNAL_LIMITS));
  for (const [field, value] of [
    ["version", "1"], ["sequence", true], ["state", { toString: () => "prepared" }],
    ["checksumSha256", { toString: () => first.checksumSha256 }],
  ] as const) {
    assert.throws(() => encodeDockerCustodyRecord({ ...first, [field]: value } as never, DEFAULT_DOCKER_CUSTODY_JOURNAL_LIMITS));
  }
  for (const [field, value] of [
    ["tenantId", 1], ["attemptId", true], ["custodyId", ["custody:1"]],
    ["hostInstanceId", { toString: () => "host:1" }], ["hostBootId", null],
    ["launchFingerprintSha256", { toString: () => fingerprint }],
  ] as const) {
    assert.throws(() => validateDockerCustodyAttemptKey({ ...key, [field]: value }));
  }
  assert.throws(() => createDockerCustodyRecord({
    attemptKey: key, sequence: "0", state: "prepared", evidence: { status: "proved" }, previousChecksumSha256: null,
  } as never));
  assert.throws(() => createDockerCustodyRecord({
    attemptKey: key, sequence: 0, state: 0, evidence: { status: "proved" }, previousChecksumSha256: null,
  } as never));
  assert.throws(() => createDockerCustodyRecord({
    attemptKey: key, sequence: 0, state: "prepared", evidence: { status: "unproven", reason: 0 }, previousChecksumSha256: null,
  } as never));
  assert.throws(() => createDockerCustodyRecord({
    attemptKey: key, sequence: 0, state: "prepared", evidence: { status: "proved" }, previousChecksumSha256: { toString: () => fingerprint },
  } as never));
});

test("checksum corruption and complete malformed records fail closed", () => {
  const record = createDockerCustodyRecord({
    attemptKey: key, sequence: 0, state: "prepared", evidence: { status: "proved" }, previousChecksumSha256: null,
  });
  const encoded = encodeDockerCustodyRecord(record, DEFAULT_DOCKER_CUSTODY_JOURNAL_LIMITS);
  const tampered = Buffer.from(encoded.toString().replace(fingerprint, "b".repeat(64)));
  assert.throws(() => replayDockerCustodyBytes(tampered, DEFAULT_DOCKER_CUSTODY_JOURNAL_LIMITS), { name: "DockerCustodyJournalCorruptionError" });
  assert.throws(() => replayDockerCustodyBytes(Buffer.from("{}\n"), DEFAULT_DOCKER_CUSTODY_JOURNAL_LIMITS), { name: "DockerCustodyJournalCorruptionError" });
});

test("partial tails preserve the last exact record as unproven recovery evidence", async () => {
  const storage = new MemoryStorage();
  const journal = new DockerCustodyJournal(storage);
  await journal.prepare(key);
  await journal.beforeAction({ key, expectedSequence: 0, state: "create_requested" });
  const file = storage.files.get(dockerCustodyAttemptLocator(key));
  assert.ok(file);
  file.bytes = Buffer.concat([file.bytes, Buffer.from('{"version":1')]);
  assert.deepEqual(await journal.recover(), [{
    kind: "unproven",
    locatorSha256: dockerCustodyAttemptLocator(key),
    reason: "partial_tail",
    lastValidRecord: replayDockerCustodyBytes(file.bytes, DEFAULT_DOCKER_CUSTODY_JOURNAL_LIMITS).records.at(-1),
    providerExecution: "unknown",
  }]);
  await assert.rejects(
    journal.observe({ authoritySha256, key, expectedSequence: 1, state: "created", evidence: { status: "proved" } }),
    { name: "DockerCustodyJournalCorruptionError" },
  );
});

test("a truncated previously durable provider request is unknown while only a complete pre-provider journal is not requested", async () => {
  const storage = new MemoryStorage();
  const journal = new DockerCustodyJournal(storage);
  await journal.prepare(key);
  assert.equal((await journal.recover())[0]?.providerExecution, "not_requested");
  await journal.beforeAction({ key, expectedSequence: 0, state: "create_requested" });
  await journal.observe({ authoritySha256, key, expectedSequence: 1, state: "created", evidence: { status: "proved" } });
  await journal.beforeAction({ key, expectedSequence: 2, state: "init_start_requested" });
  await journal.observe({ key, expectedSequence: 3, state: "init_ready", evidence: { status: "proved" } });
  await journal.beforeAction({ key, expectedSequence: 4, state: "provider_exec_requested" });
  const file = storage.files.get(dockerCustodyAttemptLocator(key));
  assert.ok(file);
  const finalNewline = file.bytes.lastIndexOf("\n".charCodeAt(0), file.bytes.byteLength - 2);
  assert.notEqual(finalNewline, -1);
  file.bytes = file.bytes.subarray(0, finalNewline + 17);
  const observation = (await journal.recover())[0];
  assert.equal(observation?.kind, "unproven");
  assert.equal(observation?.providerExecution, "unknown");
  assert.equal(JSON.stringify(observation).includes("retry"), false);
});

test("logical capacity is admitted before provider execution and live journals are never evicted", async () => {
  const storage = new MemoryStorage();
  const journal = new DockerCustodyJournal(storage, { maxJournalFiles: 1 });
  await journal.prepare(key);
  await assert.rejects(journal.prepare({
    ...key,
    attemptId: "attempt:2",
    custodyId: "custody:2",
    operationId: "operation:2",
    operationNonceSha256: "6".repeat(64),
  }), {
    name: "DockerCustodyJournalCapacityError",
  });
  assert.equal(storage.files.has(dockerCustodyAttemptLocator(key)), true);
});

test("debt-free closed journals retire by exact checksum so capacity is not a lifetime limit", async () => {
  const storage = new MemoryStorage();
  const journal = new DockerCustodyJournal(storage, { maxJournalFiles: 1 });
  const closed = await advance(journal, key, true);
  await assert.rejects(journal.retire({
    expectedChecksumSha256: "b".repeat(64),
    key,
  }), { name: "DockerCustodyJournalConflictError" });
  assert.equal(storage.files.size, 1);
  await journal.retire({ expectedChecksumSha256: closed.checksumSha256, key });
  assert.equal(storage.files.size, 0);
  const next = { ...key, attemptId: "attempt:after-retirement", custodyId: "custody:after-retirement" };
  await journal.prepare(next);
  assert.equal(storage.files.size, 1);
});

test("proved retirement admits more than 1,024 sequential attempts without exceeding the live-entry bound", async () => {
  const storage = new MemoryStorage();
  const journal = new DockerCustodyJournal(storage);
  for (let index = 0; index <= 1_024; index += 1) {
    const suffix = index.toString(16).padStart(64, "0");
    const current = {
      ...key,
      attemptId: `attempt:retirement-${index}`,
      custodyId: `custody:retirement-${index}`,
      operationId: `operation:retirement-${index}`,
      operationNonceSha256: suffix,
    };
    const closed = await advance(journal, current, true);
    await journal.retire({ expectedChecksumSha256: closed.checksumSha256, key: current });
  }
  assert.equal(storage.files.size, 0);
});

test("retirement refuses a closed journal carrying reconciliation debt", async () => {
  const storage = new MemoryStorage();
  const journal = new DockerCustodyJournal(storage);
  const closed = await advance(journal);
  await assert.rejects(journal.retire({ expectedChecksumSha256: closed.checksumSha256, key }), {
    name: "DockerCustodyJournalConflictError",
  });
  assert.equal(storage.files.size, 1);
});

const privateRoot = async (): Promise<string> => {
  const root = join(tmpdir(), `docker-custody-journal-${process.pid}-${crypto.randomUUID()}`);
  await mkdir(root, { mode: 0o700 });
  await chmod(root, 0o700);
  temporaryRoots.add(root);
  return root;
};

const temporaryRoots = new Set<string>();
const openStorages = new Set<NodeDockerCustodyJournalStorage>();
const nodeStorage = async (
  root: string,
  port?: DockerCustodyLinuxFileSystemPort,
): Promise<NodeDockerCustodyJournalStorage> => {
  const storage = await NodeDockerCustodyJournalStorage.open(root, port);
  openStorages.add(storage);
  return storage;
};
after(async () => {
  await Promise.all([...openStorages].map(storage => storage.close()));
  await Promise.all([...temporaryRoots].map(root => rm(root, { recursive: true, force: true })));
  const remaining = await Promise.all([...temporaryRoots].map(async root => {
    try {await lstat(root); return root;} catch (error) {
      return error instanceof Error && "code" in error && error.code === "ENOENT" ? undefined : root;
    }
  }));
  assert.equal(remaining.every(root => root === undefined), true);
});

test("node storage uses stable custody for exact durable restart replay", async () => {
  const root = await privateRoot();
  const storage = await nodeStorage(root);
  await advance(new DockerCustodyJournal(storage));
  const recovered = await new DockerCustodyJournal(await nodeStorage(root)).recover();
  assert.equal(recovered[0]?.kind, "replayed");
  assert.equal(recovered[0]?.providerExecution, "may_have_executed");
  const names = await import("node:fs/promises").then(fs => fs.readdir(root));
  assert.equal(names.length, 1);
  const bytes = await readFile(join(root, names[0] as string));
  assert.equal(bytes.at(-1), "\n".charCodeAt(0));
});

test("node storage durably retires an exact debt-free close and admits later work", async () => {
  const root = await privateRoot();
  const journal = new DockerCustodyJournal(await nodeStorage(root), { maxJournalFiles: 1 });
  const closed = await advance(journal, key, true);
  assert.equal((await readdir(root)).filter(name => name.endsWith(".journal")).length, 1);

  await journal.retire({ expectedChecksumSha256: closed.checksumSha256, key });
  assert.equal((await readdir(root)).filter(name => name.endsWith(".journal")).length, 0);
  const later = { ...key, attemptId: "attempt:node-after-retirement", custodyId: "custody:node-after-retirement" };
  await journal.prepare(later);
  assert.equal((await readdir(root)).filter(name => name.endsWith(".journal")).length, 1);
});

test("node retirement receipt survives restart and proves an identical lost-acknowledgement retry", async () => {
  const root = await privateRoot();
  const durableStorage = await nodeStorage(root);
  const lostAcknowledgementStorage: DockerCustodyJournalStorage = Object.freeze({
    create: (locator: string) => durableStorage.create(locator),
    exclusive: <Result>(operation: () => Promise<Result>) => durableStorage.exclusive(operation),
    open: (locator: string) => durableStorage.open(locator),
    openRetirement: (locator: string) => durableStorage.openRetirement(locator),
    async retire(locator: string, receipt: Uint8Array) {
      await durableStorage.retire(locator, receipt);
      throw new Error("synthetic lost retirement acknowledgement");
    },
    scan: (maxFiles: number) => durableStorage.scan(maxFiles),
  });
  const journal = new DockerCustodyJournal(lostAcknowledgementStorage);
  const closed = await advance(journal, key, true);
  await assert.rejects(journal.retire({ expectedChecksumSha256: closed.checksumSha256, key }), {
    name: "DockerCustodyJournalFilesystemError",
  });
  const afterRetirement = await readdir(root);
  assert.equal(afterRetirement.filter(name => name.endsWith(".journal")).length, 0);
  assert.equal(afterRetirement.filter(name => name.endsWith(".retired")).length, 1);

  await new DockerCustodyJournal(await nodeStorage(root)).retire({
    expectedChecksumSha256: closed.checksumSha256,
    key,
  });
  await assert.rejects(new DockerCustodyJournal(await nodeStorage(root)).retire({
    expectedChecksumSha256: "2".repeat(64),
    key,
  }), { name: "DockerCustodyJournalConflictError" });
  const unrelatedRoot = await privateRoot();
  await assert.rejects(new DockerCustodyJournal(await nodeStorage(unrelatedRoot)).retire({
    expectedChecksumSha256: closed.checksumSha256,
    key,
  }), { name: "DockerCustodyJournalUnavailableError" });
});

test("node storage rejects symlink roots, symlink journals, and hardlinked journals", async () => {
  const realRoot = await privateRoot();
  const rootParent = await privateRoot();
  const linkedRoot = join(rootParent, "linked-root");
  await symlink(realRoot, linkedRoot, "dir");
  await assert.rejects(NodeDockerCustodyJournalStorage.open(linkedRoot), { name: "DockerCustodyJournalFilesystemError" });

  const storage = await nodeStorage(realRoot);
  await new DockerCustodyJournal(storage).prepare(key);
  const name = (await import("node:fs/promises").then(fs => fs.readdir(realRoot)))[0] as string;
  const path = join(realRoot, name);
  await link(path, join(realRoot, "extra-hardlink"));
  await assert.rejects(storage.open(dockerCustodyAttemptLocator(key)), { name: "DockerCustodyJournalFilesystemError" });

  const symlinkRoot = await privateRoot();
  const locator = dockerCustodyAttemptLocator(key);
  const journalPath = join(symlinkRoot, `docker-custody-v1-${locator}.journal`);
  const outside = join(rootParent, "outside");
  await writeFile(outside, "");
  await symlink(outside, journalPath, "file");
  const symlinkStorage = await nodeStorage(symlinkRoot);
  await assert.rejects(symlinkStorage.open(locator), { name: "DockerCustodyJournalFilesystemError" });
});

test("an exact journal-name collision fails closed without creating another authority sequence", async () => {
  const root = await privateRoot();
  const locator = dockerCustodyAttemptLocator(key);
  await writeFile(join(root, `docker-custody-v1-${locator}.journal`), "collision\n", { mode: 0o600 });
  const journal = new DockerCustodyJournal(await nodeStorage(root));
  await assert.rejects(journal.prepare(key), { name: "DockerCustodyJournalCorruptionError" });
  assert.equal((await readdir(root)).filter(name => name.endsWith(".journal")).length, 1);
});

test("the descriptor-relative storage adapter is typed unsupported off Linux", async () => {
  const root = await privateRoot();
  await assert.rejects(NodeDockerCustodyJournalStorage.open(root, {
    platform: "darwin", lstat: path => lstat(path, { bigint: true }), open, opendir, realpath, unlink,
  }), { name: "DockerCustodyJournalFilesystemError", diagnostic: "unsupported_platform" });
});

test("node storage detects partial physical tails without truncation or action replay", async () => {
  const root = await privateRoot();
  const storage = await nodeStorage(root);
  const journal = new DockerCustodyJournal(storage);
  await journal.prepare(key);
  const name = (await import("node:fs/promises").then(fs => fs.readdir(root)))[0] as string;
  const handle = await open(join(root, name), "a");
  try {await handle.write('{"partial":'); await handle.datasync();} finally {await handle.close();}
  const before = await readFile(join(root, name));
  const observation = (await journal.recover())[0];
  assert.equal(observation?.kind, "unproven");
  assert.equal(observation?.kind === "unproven" ? observation.reason : "", "partial_tail");
  assert.deepEqual(await readFile(join(root, name)), before);
});

test("node storage serializes competing CAS appenders", async () => {
  const root = await privateRoot();
  const first = new DockerCustodyJournal(await nodeStorage(root));
  const second = new DockerCustodyJournal(await nodeStorage(root));
  await first.prepare(key);
  const results = await Promise.allSettled([
    first.beforeAction({ key, expectedSequence: 0, state: "create_requested" }),
    second.beforeAction({ key, expectedSequence: 0, state: "create_requested" }),
  ]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(results.filter(result => result.status === "rejected").length, 1);
  const recovered = await first.recover();
  assert.equal(recovered[0]?.kind === "replayed" ? recovered[0].sequence : -1, 1);
});

const runContender = async (
  root: string,
  contenderKey: DockerCustodyAttemptKey,
  mode = "append",
): Promise<string> => {
  const helper = join(import.meta.dirname, "fixtures", "docker-journal-contender.mjs");
  const encoded = Buffer.from(JSON.stringify(contenderKey)).toString("base64url");
  const child = spawn(process.execPath, [helper, root, encoded, mode], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", chunk => {stdout += chunk;});
  child.stderr.setEncoding("utf8").on("data", chunk => {stderr += chunk;});
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("synthetic Docker journal contender exceeded its 5 second deadline"));
    }, 5_000);
    child.once("error", error => {clearTimeout(timer); reject(error);});
    child.once("exit", code => {clearTimeout(timer); resolve(code);});
  });
  assert.equal(exitCode, 0, stderr);
  return stdout.trim();
};

test("actual child processes serialize cross-process action contenders", async () => {
  const root = await privateRoot();
  await new DockerCustodyJournal(await nodeStorage(root)).prepare(key);
  const results = await Promise.all([runContender(root, key), runContender(root, key)]);
  assert.equal(results.filter(result => result === "fulfilled").length, 1);
  assert.equal(results.every(result => ["fulfilled", "DockerCustodyJournalBusyError", "DockerCustodyJournalConflictError"].includes(result)), true);
  const recovered = await new DockerCustodyJournal(await nodeStorage(root)).recover();
  assert.equal(recovered[0]?.kind === "replayed" ? recovered[0].sequence : -1, 1);
});

test("an unknown lock is never broken and never grants action authority", async () => {
  const root = await privateRoot();
  const storage = await nodeStorage(root);
  await writeFile(join(root, ".docker-custody-v1.lock"), "unknown", { mode: 0o600 });
  await assert.rejects(new DockerCustodyJournal(storage).prepare(key), { name: "DockerCustodyJournalBusyError" });
  assert.equal((await readFile(join(root, ".docker-custody-v1.lock"), "utf8")), "unknown");
});

test("pinned root rejects root and ancestor retarget before authority", async () => {
  const original = await privateRoot();
  const storage = await nodeStorage(original);
  const moved = `${original}-moved`;
  temporaryRoots.add(moved);
  await rename(original, moved);
  await mkdir(original, { mode: 0o700 });
  await assert.rejects(new DockerCustodyJournal(storage).prepare(key), {
    name: "DockerCustodyJournalFilesystemError", diagnostic: "root_changed",
  });
  assert.deepEqual(await readdir(original), []);

  const parent = await privateRoot();
  const nested = join(parent, "journal");
  await mkdir(nested, { mode: 0o700 });
  const nestedStorage = await nodeStorage(nested);
  const movedParent = `${parent}-moved`;
  temporaryRoots.add(movedParent);
  await rename(parent, movedParent);
  await mkdir(parent, { mode: 0o700 });
  await mkdir(nested, { mode: 0o700 });
  await assert.rejects(new DockerCustodyJournal(nestedStorage).prepare(key), {
    name: "DockerCustodyJournalFilesystemError", diagnostic: "root_changed",
  });
  assert.deepEqual(await readdir(nested), []);
});

test("pinned root detects a retarget raced during the authority operation", async () => {
  const root = await privateRoot();
  const moved = `${root}-raced`;
  temporaryRoots.add(moved);
  let raced = false;
  const port: DockerCustodyLinuxFileSystemPort = {
    platform: process.platform,
    lstat: path => lstat(path, { bigint: true }),
    open: async (path, flags, mode) => {
      const handle = await open(path, flags, mode);
      if (!raced && (flags & constants.O_APPEND) !== 0) {
        raced = true;
        await rename(root, moved);
        await mkdir(root, { mode: 0o700 });
      }
      return handle;
    },
    opendir,
    realpath,
    unlink,
  };
  const journal = new DockerCustodyJournal(await nodeStorage(root, port));
  await assert.rejects(journal.prepare(key), {
    name: "DockerCustodyJournalFilesystemError", diagnostic: "root_changed",
  });
  assert.equal(raced, true);
  assert.deepEqual(await readdir(root), []);
});

test("pinned root revalidates restrictive mode immediately before returning authority", async () => {
  const root = await privateRoot();
  let broadened = false;
  const port: DockerCustodyLinuxFileSystemPort = {
    platform: process.platform,
    lstat: path => lstat(path, { bigint: true }),
    open: async (path, flags, mode) => {
      const handle = await open(path, flags, mode);
      if (!path.endsWith(".docker-custody-v1.lock")) {return handle;}
      return wrappedHandle(handle, { close: async () => {
        await handle.close();
        await chmod(root, 0o750);
        broadened = true;
      } });
    },
    opendir,
    realpath,
    unlink,
  };
  const storage = await nodeStorage(root, port);
  await assert.rejects(storage.exclusive(async () => "authority"), {
    name: "DockerCustodyJournalFilesystemError", diagnostic: "root_changed",
  });
  assert.equal(broadened, true);
  await chmod(root, 0o700);
});

const faultPort = (failureCode: "ENOSPC" | "EACCES"): DockerCustodyLinuxFileSystemPort => ({
  platform: process.platform,
  lstat: path => lstat(path, { bigint: true }),
  open: async (path, flags, mode) => {
    if ((flags & constants.O_APPEND) !== 0) {throw Object.assign(new Error("native path must not escape"), { code: failureCode });}
    return open(path, flags, mode);
  },
  opendir,
  realpath,
  unlink,
});

const staleMetadataPort = (): DockerCustodyLinuxFileSystemPort => ({
  platform: process.platform,
  lstat: async path => {
    const stats = await lstat(path, { bigint: true });
    return path.endsWith(".journal") ? new Proxy(stats, {
      get: (target, property, receiver) => property === "size" ? 0n : Reflect.get(target, property, receiver) as unknown,
    }) : stats;
  },
  open,
  opendir,
  realpath,
  unlink,
});

const wrappedHandle = (
  handle: FileHandle,
  overrides: Partial<Record<"close" | "datasync" | "stat" | "sync", (...args: never[]) => unknown>>,
): FileHandle => new Proxy(handle, {
  get: (target, property) => {
    const override = overrides[property as keyof typeof overrides];
    if (override !== undefined) {return override;}
    const value = Reflect.get(target, property, target) as unknown;
    return typeof value === "function" ? value.bind(target) as unknown : value;
  },
});

test("a same-owner rename replacement or hardlink raced after datasync never returns action authority", async () => {
  for (const race of ["replacement", "hardlink"] as const) {
    const root = await privateRoot();
    const locator = dockerCustodyAttemptLocator(key);
    const journalPath = join(root, `docker-custody-v1-${locator}.journal`);
    let armed = false;
    let raced = false;
    const port: DockerCustodyLinuxFileSystemPort = {
      platform: process.platform,
      lstat: path => lstat(path, { bigint: true }),
      open: async (path, flags, mode) => {
        const handle = await open(path, flags, mode);
        if (!path.endsWith(".journal")) {return handle;}
        return wrappedHandle(handle, {
          datasync: async () => {
            await handle.datasync();
            if (!armed || raced) {return;}
            raced = true;
            if (race === "replacement") {
              await rename(journalPath, join(root, "displaced-journal"));
              await writeFile(journalPath, "", { mode: 0o600 });
            } else {
              await link(journalPath, join(root, "raced-hardlink"));
            }
          },
        });
      },
      opendir,
      realpath,
      unlink,
    };
    const journal = new DockerCustodyJournal(await nodeStorage(root, port));
    await journal.prepare(key);
    armed = true;
    await assert.rejects(
      journal.beforeAction({ key, expectedSequence: 0, state: "create_requested" }),
      { name: "DockerCustodyJournalFilesystemError", diagnostic: "unsafe_entry" },
    );
    assert.equal(raced, true);
  }
});

test("every lock lifecycle failure is fixed, typed, and secret-safe", async () => {
  for (const stage of ["stat", "lstat", "open", "datasync", "unlink", "directory_sync", "close"] as const) {
    const root = await privateRoot();
    let injected = false;
    const fail = (): never => {
      injected = true;
      throw Object.assign(new Error(`native failure at ${root}`), { code: "EIO", cause: "secret", timestamp: Date.now() });
    };
    const port: DockerCustodyLinuxFileSystemPort = {
      platform: process.platform,
      lstat: async path => {
        if (stage === "lstat" && !injected && path.endsWith(".docker-custody-v1.lock")) {fail();}
        return lstat(path, { bigint: true });
      },
      open: async (path, flags, mode) => {
        const isLock = path.endsWith(".docker-custody-v1.lock");
        if (stage === "open" && isLock) {fail();}
        const handle = await open(path, flags, mode);
        if (isLock) {
          return wrappedHandle(handle, {
            ...(stage === "stat" ? { stat: async (...args: never[]) => !injected ? fail() : handle.stat(...args) } : {}),
            ...(stage === "datasync" ? { datasync: async () => !injected ? fail() : handle.datasync() } : {}),
            ...(stage === "close" ? { close: async () => {await handle.close(); fail();} } : {}),
          });
        }
        if (stage === "directory_sync" && path === root) {
          return wrappedHandle(handle, { sync: async () => !injected ? fail() : handle.sync() });
        }
        return handle;
      },
      opendir,
      realpath,
      unlink: async path => {
        if (stage === "unlink" && !injected && path.endsWith(".docker-custody-v1.lock")) {fail();}
        await unlink(path);
      },
    };
    const storage = await nodeStorage(root, port);
    await assert.rejects(storage.exclusive(async () => {}), error => {
      assert.equal(injected, true);
      assert.equal(error instanceof Error ? error.name : "", "DockerCustodyJournalFilesystemError");
      assert.equal((error as { diagnostic?: unknown }).diagnostic, "io_failure");
      assert.equal((error as Error).message.includes(root), false);
      assert.equal((error as Error).message.includes("native"), false);
      assert.equal("cause" in (error as object), false);
      assert.equal("timestamp" in (error as object), false);
      return true;
    });
  }
});

test("directory close rejection is fixed, typed, and secret-safe", async () => {
  const root = await privateRoot();
  let injected = false;
  const port: DockerCustodyLinuxFileSystemPort = {
    platform: process.platform,
    lstat: path => lstat(path, { bigint: true }),
    open,
    opendir: async path => {
      const directory = await opendir(path);
      return {
        read: () => directory.read(),
        close: async () => {
          await directory.close();
          injected = true;
          throw Object.assign(new Error(`native close failure at ${root}`), { code: "EIO", cause: "secret", timestamp: Date.now() });
        },
      };
    },
    realpath,
    unlink,
  };
  const journal = new DockerCustodyJournal(await nodeStorage(root, port));
  await assert.rejects(journal.prepare(key), error => {
    assert.equal(injected, true);
    assert.equal(error instanceof Error ? error.name : "", "DockerCustodyJournalFilesystemError");
    assert.equal((error as { diagnostic?: unknown }).diagnostic, "io_failure");
    assert.equal((error as Error).message.includes(root), false);
    assert.equal((error as Error).message.includes("native"), false);
    assert.equal("cause" in (error as object), false);
    assert.equal("timestamp" in (error as object), false);
    return true;
  });
});

test("journal close rejection fails every replay, CAS, append, and recovery path safely", async () => {
  for (const path of ["append", "replay", "cas", "recovery"] as const) {
    const root = await privateRoot();
    if (path !== "append") {
      const setup = await nodeStorage(root);
      await new DockerCustodyJournal(setup).prepare(key);
    }
    let injected = false;
    const port: DockerCustodyLinuxFileSystemPort = {
      platform: process.platform,
      lstat: candidate => lstat(candidate, { bigint: true }),
      open: async (candidate, flags, mode) => {
        const handle = await open(candidate, flags, mode);
        if (!candidate.endsWith(".journal")) {return handle;}
        return wrappedHandle(handle, { close: async () => {
          await handle.close();
          injected = true;
          throw Object.assign(new Error(`native close failure at ${root}`), {
            code: "EIO", cause: "secret", timestamp: Date.now(),
          });
        } });
      },
      opendir,
      realpath,
      unlink,
    };
    const journal = new DockerCustodyJournal(await nodeStorage(root, port));
    const operation = path === "append" || path === "replay" ? journal.prepare(key)
      : path === "cas" ? journal.beforeAction({ key, expectedSequence: 0, state: "create_requested" })
        : journal.recover();
    await assert.rejects(operation, error => {
      assert.equal(injected, true);
      assert.equal(error instanceof Error ? error.name : "", "DockerCustodyJournalFilesystemError");
      assert.equal((error as { diagnostic?: unknown }).diagnostic, "io_failure");
      assert.equal((error as Error).message.includes(root), false);
      assert.equal((error as Error).message.includes("native"), false);
      assert.equal("cause" in (error as object), false);
      assert.equal("timestamp" in (error as object), false);
      return true;
    });
  }
});

test("recovery accounts actual descriptor reads instead of stale metadata", async () => {
  const root = await privateRoot();
  const storage = await nodeStorage(root, staleMetadataPort());
  await new DockerCustodyJournal(storage).prepare(key);
  const recovered = await new DockerCustodyJournal(storage).recover();
  assert.equal(recovered[0]?.kind, "replayed");
  assert.equal(recovered[0]?.kind === "replayed" ? recovered[0].sequence : -1, 0);
});

test("injectable Linux filesystem failures are fixed, typed, and secret-safe", async () => {
  for (const [code, diagnostic] of [["ENOSPC", "storage_full"], ["EACCES", "permission_denied"]] as const) {
    const root = await privateRoot();
    const journal = new DockerCustodyJournal(await nodeStorage(root, faultPort(code)));
    await assert.rejects(journal.prepare(key), error => {
      assert.equal(error instanceof Error ? error.name : "", "DockerCustodyJournalFilesystemError");
      assert.equal((error as { diagnostic?: unknown }).diagnostic, diagnostic);
      assert.equal((error as Error).message.includes(root), false);
      assert.equal((error as Error).message.includes("native"), false);
      return true;
    });
  }
});

test("cross-process namespace admission allows only one journal at its bound", async () => {
  const root = await privateRoot();
  const other = {
    ...key,
    attemptId: "attempt:other",
    custodyId: "custody:other",
    operationId: "operation:other",
    operationNonceSha256: "7".repeat(64),
  };
  const results = await Promise.all([runContender(root, key, "prepare-bounded"), runContender(root, other, "prepare-bounded")]);
  assert.equal(results.filter(result => result === "fulfilled").length, 1);
  assert.equal(results.every(result => ["fulfilled", "DockerCustodyJournalBusyError", "DockerCustodyJournalCapacityError"].includes(result)), true);
  assert.equal((await readdir(root)).filter(name => name.endsWith(".journal")).length, 1);
  const rejectedKey = results[0] === "fulfilled" ? other : key;
  assert.equal(await runContender(root, rejectedKey, "prepare-bounded"), "DockerCustodyJournalCapacityError");
});
