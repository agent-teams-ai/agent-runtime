import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_DOCKER_CUSTODY_JOURNAL_LIMITS,
  DOCKER_CUSTODY_STATES,
  DockerCustodyJournal,
  createDockerCustodyRecord,
  dockerCustodyAttemptLocator,
  encodeDockerCustodyRecord,
  replayDockerCustodyBytes,
  validateDockerCustodyAttemptKey,
} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/journal/index.js";
import {
  MemoryStorage,
  advance,
  authoritySha256,
  fingerprint,
  key,
} from "../../fixtures/docker-journal-test-fixture.ts";

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
