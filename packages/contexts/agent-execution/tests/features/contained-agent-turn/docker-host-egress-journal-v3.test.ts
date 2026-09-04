import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, readlink, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  DEFAULT_DOCKER_CUSTODY_JOURNAL_LIMITS,
  DEFAULT_DOCKER_EGRESS_JOURNAL_LIMITS,
  DOCKER_EGRESS_CLEANUP_ORDER,
  DOCKER_EGRESS_RESOURCE_KINDS,
  DockerEgressJournal,
  NodeDockerEgressJournalStorage,
  classifyDockerEgressLegacyV2,
  createDockerCustodyRecord,
  createDockerEgressCleanupObservation,
  createDockerEgressRecord,
  createDockerEgressSubject,
  dockerEgressCleanupHandle,
  dockerEgressJournalLocator,
  encodeDockerCustodyRecord,
  encodeDockerEgressRecord,
  replayDockerEgressBytes,
  validateDockerEgressSubject,
  type DockerEgressJournalSubject,
  type DockerEgressResourceKind,
  type DockerEgressTrustedRuntimeIdentity,
} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/journal/index.js";
import { MemoryEgressFile, MemoryEgressStorage, key as v2Key } from "../../fixtures/docker-journal-test-fixture.ts";

const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
const opaque = (prefix: string, value: string): string => `${prefix}${hash(value)}`;
const command = (value: string): string => opaque("command:", value);
const observerAuthority = Object.freeze({
  observerId: opaque("observer:", "docker-absence-observer"),
  capabilityRevisionSha256: hash("capability-revision"),
});

const subject = createDockerEgressSubject({
  identity: {
    operationId: opaque("operation:", "operation"), attemptId: opaque("attempt:", "attempt"),
    effectId: opaque("effect:", "effect"), custodyId: opaque("custody:", "custody"),
    workspaceId: opaque("workspace:", "workspace"), hostSlotId: opaque("host-slot:", "host-slot"),
    hostInstanceId: opaque("host-instance:", "host-instance"), hostBootId: opaque("host-boot:", "host-boot"),
    executionGenerationId: opaque("execution-generation:", "execution-generation"), daemonId: opaque("daemon:", "daemon"),
    daemonGenerationId: opaque("daemon-generation:", "daemon-generation"),
    slotGenerationId: opaque("slot-generation:", "slot-generation"), exactFingerprintSha256: hash("fingerprint"),
  },
  authority: {
    scopeSha256: hash("scope"), operationSha256: hash("operation-binding"),
    acceptedAuthoritySha256: hash("accepted-authority"), brokerPolicySha256: hash("broker-policy"),
    routeAuthorizationSha256: hash("route-authorization"),
    materializationAuthorizationSha256: hash("materialization-authorization"),
  },
  resources: {
    privateNetworkHandle: opaque("private-network-handle:", "private-network"),
    brokerNamespaceHandle: opaque("broker-netns-handle:", "broker-namespace"),
    brokerCgroupHandle: opaque("broker-cgroup-handle:", "broker-cgroup"),
    brokerProcessHandle: opaque("broker-process-handle:", "broker-process"),
    brokerListenerHandle: opaque("broker-listener-handle:", "broker-listener"),
    brokerInboundSocketHandle: opaque("broker-inbound-socket-handle:", "broker-inbound-socket"),
    brokerUpstreamSocketHandle: opaque("broker-upstream-socket-handle:", "broker-upstream-socket"),
    providerEndpointHandle: opaque("provider-endpoint-handle:", "provider-endpoint"),
    networkEndpointHandle: opaque("network-endpoint-handle:", "network-endpoint"),
    upstreamRuleHandle: opaque("upstream-rule-handle:", "upstream-rule"),
    providerContainerHandle: opaque("provider-container-handle:", "provider-container"),
  },
});
const trusted: DockerEgressTrustedRuntimeIdentity = Object.freeze({
  scopeSha256: subject.authority.scopeSha256, hostSlotId: subject.identity.hostSlotId,
  hostInstanceId: subject.identity.hostInstanceId, hostBootId: subject.identity.hostBootId,
  executionGenerationId: subject.identity.executionGenerationId, daemonId: subject.identity.daemonId,
  daemonGenerationId: subject.identity.daemonGenerationId, slotGenerationId: subject.identity.slotGenerationId,
});
const changedSubject = (identity: Partial<DockerEgressJournalSubject["identity"]> = {},
  resources: Partial<DockerEgressJournalSubject["resources"]> = {}): DockerEgressJournalSubject => createDockerEgressSubject({
  ...subject, identity: { ...subject.identity, ...identity }, resources: { ...subject.resources, ...resources },
});
const observation = (resource: DockerEgressResourceKind, value = subject) => createDockerEgressCleanupObservation({
  resource, cleanupHandle: dockerEgressCleanupHandle(value, resource), scopeSha256: value.authority.scopeSha256,
  hostInstanceId: value.identity.hostInstanceId, hostBootId: value.identity.hostBootId,
  executionGenerationId: value.identity.executionGenerationId, daemonId: value.identity.daemonId,
  daemonGenerationId: value.identity.daemonGenerationId, slotGenerationId: value.identity.slotGenerationId,
  ...observerAuthority, result: "absent",
});
const materialize = async (journal: DockerEgressJournal, value = subject): Promise<number> => {
  let sequence = (await journal.open(value, command("open"))).sequence;
  for (const resource of DOCKER_EGRESS_RESOURCE_KINDS) {
    sequence = (await journal.materializeIntent(value, sequence, command(`materialize-intent:${resource}`), resource)).sequence;
    sequence = (await journal.materializeReceipt(value, sequence, command(`materialize-receipt:${resource}`), resource)).sequence;
  }
  return sequence;
};
const clean = async (journal: DockerEgressJournal, sequence: number, value = subject): Promise<number> => {
  for (const resource of DOCKER_EGRESS_CLEANUP_ORDER) {
    sequence = (await journal.cleanupIntent(value, sequence, command(`cleanup-intent:${resource}`), resource)).sequence;
    sequence = (await journal.cleanupReceipt(value, sequence, command(`cleanup-receipt:${resource}`), resource,
      observation(resource, value))).sequence;
  }
  return sequence;
};

test("V3 records are strict, chained, command-digest bound, immutable, and locator bound", () => {
  const record = createDockerEgressRecord({ sequence: 0, subject, commandId: command("codec-open"),
    event: { kind: "open_intent" }, previousChecksumSha256: null });
  const replay = replayDockerEgressBytes(encodeDockerEgressRecord(record));
  assert.deepEqual(replay.records, [record]);
  assert.equal(Object.isFrozen(record), true);
  assert.notEqual(record.commandDigestSha256, record.checksumSha256);
  assert.notEqual(dockerEgressJournalLocator(subject), subject.bindingSha256);
  assert.throws(() => replayDockerEgressBytes(Buffer.from(
    `${Buffer.from(encodeDockerEgressRecord(record)).toString().replace('"sequence":0', '"sequence":0,"sequence":0')}`,
  )), { name: "DockerEgressJournalCorruptionError" });
  assert.throws(() => replayDockerEgressBytes(Buffer.from([0xc3, 0x28, 0x0a])), { name: "DockerEgressJournalCorruptionError" });
});

test("lost append acknowledgements retry by exact command digest and conflicting reuse is rejected", async () => {
  const storage = new MemoryEgressStorage(); const journal = new DockerEgressJournal(storage, trusted, observerAuthority);
  const opened = await journal.open(subject, command("open")); const file = storage.v3Files.get(dockerEgressJournalLocator(subject));
  assert.ok(file); file.failAfterAppend = true;
  await assert.rejects(journal.materializeIntent(subject, opened.sequence, command("lost-intent"), "private_network"));
  const retried = await journal.materializeIntent(subject, opened.sequence, command("lost-intent"), "private_network");
  assert.equal(retried.sequence, 1);
  const exactAgain = await journal.materializeIntent(subject, opened.sequence, command("lost-intent"), "private_network");
  assert.equal(exactAgain.checksumSha256, retried.checksumSha256);
  await assert.rejects(journal.materializeReceipt(subject, opened.sequence, command("lost-intent"), "private_network"),
    { name: "DockerEgressJournalConflictError" });
});

test("atomic open retries a lost create acknowledgement and recovers only an exact locator-bound zero-byte publication", async () => {
  const storage = new MemoryEgressStorage(); const journal = new DockerEgressJournal(storage, trusted, observerAuthority);
  storage.failCreateAfterPublish = true;
  await assert.rejects(journal.open(subject, command("open")));
  assert.equal((await journal.open(subject, command("open"))).sequence, 0);
  const zeroStorage = new MemoryEgressStorage(); zeroStorage.v3Files.set(dockerEgressJournalLocator(subject), new MemoryEgressFile());
  const zeroJournal = new DockerEgressJournal(zeroStorage, trusted, observerAuthority);
  assert.equal((await zeroJournal.open(subject, command("zero-open"))).sequence, 0);
  assert.notEqual(zeroStorage.v3Files.get(dockerEgressJournalLocator(subject))?.byteLength, 0);
});

test("live debt globally fences admission and effect, attempt, generation, and cleanup handles are unique", async () => {
  const storage = new MemoryEgressStorage(); const journal = new DockerEgressJournal(storage, trusted, observerAuthority);
  await journal.open(subject, command("open"));
  const independent = changedSubject({ operationId: opaque("operation:", "other"), effectId: opaque("effect:", "other"),
    attemptId: opaque("attempt:", "other"), exactFingerprintSha256: hash("other") });
  await assert.rejects(journal.open(independent, command("other-open")), { name: "DockerEgressJournalConflictError" });
  for (const collision of [
    changedSubject({ operationId: opaque("operation:", "collision") }),
    changedSubject({ effectId: opaque("effect:", "collision") }),
    changedSubject({ attemptId: opaque("attempt:", "collision") }),
    changedSubject({ executionGenerationId: opaque("execution-generation:", "collision") }),
    changedSubject({}, { privateNetworkHandle: opaque("private-network-handle:", "collision") }),
  ]) {await assert.rejects(journal.open(collision, command(`collision:${collision.bindingSha256}`)));}
});

test("retirement tombstone is durable, prevents resurrection, and serves a lost-close exact retry", async () => {
  const storage = new MemoryEgressStorage(); const journal = new DockerEgressJournal(storage, trusted, observerAuthority);
  const finalCleanup = await clean(journal, await materialize(journal));
  storage.failTombstoneAfterPublish = true;
  await assert.rejects(journal.close(subject, finalCleanup, command("close")));
  const closed = await journal.close(subject, finalCleanup, command("close"));
  assert.equal(closed.event.kind, "closed");
  assert.equal(storage.tombstones.has(dockerEgressJournalLocator(subject)), true);
  await assert.rejects(journal.open(subject, command("resurrect")), { name: "DockerEgressJournalConflictError" });
});

test("cleanup receipts require an immutable absence observation bound to the exact debt", async () => {
  const storage = new MemoryEgressStorage(); const journal = new DockerEgressJournal(storage, trusted, observerAuthority);
  let sequence = (await journal.open(subject, command("open"))).sequence;
  sequence = (await journal.materializeIntent(subject, sequence, command("mi"), "private_network")).sequence;
  sequence = (await journal.materializeReceipt(subject, sequence, command("mr"), "private_network")).sequence;
  sequence = (await journal.cleanupIntent(subject, sequence, command("ci"), "private_network")).sequence;
  const wrong = observation("private_network");
  await assert.rejects(journal.cleanupReceipt(subject, sequence, command("bad-observation"), "private_network",
    { ...wrong, scopeSha256: hash("wrong") }));
  sequence = (await journal.cleanupReceipt(subject, sequence, command("cr"), "private_network", wrong)).sequence;
  const closed = await journal.close(subject, sequence, command("close"));
  assert.equal(closed.event.kind, "closed");
  assert.equal(JSON.stringify(await journal.recoveryEvidence()).includes("private-network-handle"), false);
});

test("cleanup receipt append rejects rehashed observations from the wrong observer or capability revision", async () => {
  const storage = new MemoryEgressStorage(); const journal = new DockerEgressJournal(storage, trusted, observerAuthority);
  let sequence = (await journal.open(subject, command("authority-open"))).sequence;
  sequence = (await journal.materializeIntent(subject, sequence, command("authority-mi"), "private_network")).sequence;
  sequence = (await journal.materializeReceipt(subject, sequence, command("authority-mr"), "private_network")).sequence;
  sequence = (await journal.cleanupIntent(subject, sequence, command("authority-ci"), "private_network")).sequence;
  const exact = observation("private_network");
  const wrongObservations = [
    createDockerEgressCleanupObservation({ ...exact, observerId: opaque("observer:", "wrong-observer") }),
    createDockerEgressCleanupObservation({ ...exact, capabilityRevisionSha256: hash("wrong-capability-revision") }),
  ];
  for (const [index, wrong] of wrongObservations.entries()) {
    assert.notEqual(wrong.observationSha256, exact.observationSha256);
    await assert.rejects(journal.cleanupReceipt(subject, sequence, command(`wrong-authority-${index}`),
      "private_network", wrong), { name: "DockerEgressJournalConflictError" });
  }
  assert.deepEqual(await journal.recoverCleanupDirectives(), [{
    kind: "cleanup_only", subject, sequence, resource: "private_network",
    cleanupHandle: subject.resources.privateNetworkHandle, reconcileRequired: true,
  }]);
  sequence = (await journal.cleanupReceipt(subject, sequence, command("exact-authority"), "private_network", exact)).sequence;
  assert.equal((await journal.close(subject, sequence, command("authority-close"))).event.kind, "closed");
});

test("cleanup observer authority is strict, required, and snapshotted at construction", async () => {
  assert.throws(() => new DockerEgressJournal(new MemoryEgressStorage(), trusted, undefined as never), /plain non-proxy/u);
  assert.throws(() => new DockerEgressJournal(new MemoryEgressStorage(), trusted,
    { ...observerAuthority, unexpected: true } as never), /exact data-only shape/u);
  const mutable = { ...observerAuthority };
  const storage = new MemoryEgressStorage(); const journal = new DockerEgressJournal(storage, trusted, mutable);
  mutable.observerId = opaque("observer:", "mutated-after-construction");
  mutable.capabilityRevisionSha256 = hash("mutated-after-construction");
  let sequence = (await journal.open(subject, command("snapshot-open"))).sequence;
  sequence = (await journal.materializeIntent(subject, sequence, command("snapshot-mi"), "private_network")).sequence;
  sequence = (await journal.materializeReceipt(subject, sequence, command("snapshot-mr"), "private_network")).sequence;
  sequence = (await journal.cleanupIntent(subject, sequence, command("snapshot-ci"), "private_network")).sequence;
  assert.equal((await journal.cleanupReceipt(subject, sequence, command("snapshot-cr"), "private_network",
    observation("private_network"))).event.kind, "cleanup_receipt");
});

test("cleanup observation handles must use the resource-specific prefix", () => {
  const correct = observation("private_network");
  for (const cleanupHandle of [subject.resources.providerContainerHandle, opaque("arbitrary:", "network")]) {
    assert.throws(() => createDockerEgressCleanupObservation({...correct, cleanupHandle}), /fixed-format opaque/u);
  }
});

test("physical cleanup cannot clear unrelated unscoped reconciliation debt", async () => {
  const storage = new MemoryEgressStorage(); const journal = new DockerEgressJournal(storage, trusted, observerAuthority);
  let sequence = (await journal.open(subject, command("open"))).sequence;
  sequence = (await journal.materializeIntent(subject, sequence, command("mi"), "private_network")).sequence;
  sequence = (await journal.materializeReceipt(subject, sequence, command("mr"), "private_network")).sequence;
  sequence = (await journal.reconcileRequired(subject, sequence, command("global-debt"), "journal_corrupt", null)).sequence;
  sequence = (await journal.cleanupIntent(subject, sequence, command("ci"), "private_network")).sequence;
  sequence = (await journal.cleanupReceipt(subject, sequence, command("cr"), "private_network", observation("private_network"))).sequence;
  await assert.rejects(journal.close(subject, sequence, command("unsafe-close")), {name: "DockerEgressJournalConflictError"});
});

test("restart returns only a validated cleanup-only directive with private subject, sequence, and handle", async () => {
  const storage = new MemoryEgressStorage(); const journal = new DockerEgressJournal(storage, trusted, observerAuthority);
  let sequence = (await journal.open(subject, command("open"))).sequence;
  sequence = (await journal.materializeIntent(subject, sequence, command("intent"), "private_network")).sequence;
  const directives = await new DockerEgressJournal(storage, trusted, observerAuthority).recoverCleanupDirectives();
  assert.deepEqual(directives, [{ kind: "cleanup_only", subject, sequence, resource: "private_network",
    cleanupHandle: subject.resources.privateNetworkHandle, reconcileRequired: true }]);
  const stale = { ...trusted, hostBootId: opaque("host-boot:", "successor") };
  assert.deepEqual(await new DockerEgressJournal(storage, stale, observerAuthority).recoverCleanupDirectives(), []);
  assert.equal(storage.tombstones.has(dockerEgressJournalLocator(subject)), true);
});

test("V2 remains in a separate read-only namespace with original strict bounds and unsafe input fences admission", async () => {
  const first = createDockerCustodyRecord({ attemptKey: v2Key, sequence: 0, state: "prepared",
    evidence: { status: "proved" }, previousChecksumSha256: null });
  const second = createDockerCustodyRecord({ attemptKey: v2Key, sequence: 1, state: "create_requested",
    evidence: { status: "proved" }, previousChecksumSha256: first.checksumSha256 });
  const safeBytes = encodeDockerCustodyRecord(first, DEFAULT_DOCKER_CUSTODY_JOURNAL_LIMITS);
  assert.equal(classifyDockerEgressLegacyV2(safeBytes).quarantineRequired, false);
  const unsafeBytes = Buffer.concat([safeBytes, encodeDockerCustodyRecord(second, DEFAULT_DOCKER_CUSTODY_JOURNAL_LIMITS)]);
  assert.equal(classifyDockerEgressLegacyV2(unsafeBytes).quarantineRequired, true);
  assert.equal(classifyDockerEgressLegacyV2(Buffer.alloc(DEFAULT_DOCKER_CUSTODY_JOURNAL_LIMITS.maxJournalBytes + 1)).diagnostic,
    "legacy_oversized");
  assert.equal(classifyDockerEgressLegacyV2(Buffer.from('{"version":2,"version":2}\n')).diagnostic, "legacy_corrupt");
  const storage = new MemoryEgressStorage(); const legacy = new MemoryEgressFile(); legacy.bytes = unsafeBytes;
  storage.legacyV2Files.set(hash("legacy-locator"), legacy);
  await assert.rejects(new DockerEgressJournal(storage, trusted, observerAuthority).open(subject, command("open")),
    { name: "DockerEgressJournalConflictError" });
  assert.equal(storage.v3Files.size, 0);
});

test("corrupt and misplaced V3 journals persist locator-only quarantine evidence and fence admission", async () => {
  for (const misplaced of [false, true]) {
    const storage = new MemoryEgressStorage(); const journal = new DockerEgressJournal(storage, trusted, observerAuthority);
    await journal.open(subject, command("open")); const expected = dockerEgressJournalLocator(subject);
    if (misplaced) { const file = storage.v3Files.get(expected)!; storage.v3Files.delete(expected); storage.v3Files.set(hash("moved"), file); }
    else { storage.v3Files.get(expected)!.bytes[8] = 0xff; }
    const evidence = await journal.recoveryEvidence();
    assert.equal(evidence.some(item => item.kind === "quarantine_evidence" && item.locatorSha256 === (misplaced ? hash("moved") : expected)), true);
    assert.equal(JSON.stringify(evidence).includes("cleanupHandle"), false);
    await assert.rejects(journal.open(subject, command("another-open")));
  }
});

test("scan bytes are globally pre-charged before any journal read", async () => {
  const storage = new MemoryEgressStorage();
  const first = new MemoryEgressFile(); first.bytes = Buffer.alloc(DEFAULT_DOCKER_EGRESS_JOURNAL_LIMITS.maxJournalBytes);
  const second = new MemoryEgressFile(); second.bytes = Buffer.alloc(DEFAULT_DOCKER_EGRESS_JOURNAL_LIMITS.maxJournalBytes);
  let reads = 0; let closes = 0;
  first.read = async () => { reads += 1; return first.bytes; }; second.read = async () => { reads += 1; return second.bytes; };
  first.close = async () => {closes += 1;}; second.close = async () => {closes += 1;};
  storage.v3Files.set(hash("one"), first); storage.v3Files.set(hash("two"), second);
  const bounded = new DockerEgressJournal(storage, trusted, observerAuthority, {
    maxRestartScanBytes: DEFAULT_DOCKER_EGRESS_JOURNAL_LIMITS.maxJournalBytes,
  });
  await assert.rejects(bounded.recoveryEvidence(), { name: "DockerEgressJournalCapacityError" });
  assert.equal(reads, 0);
  assert.equal(closes, 2);
});

const openSandboxDescriptors = async (root: string): Promise<number> => {
  const targets = await Promise.all((await readdir("/proc/self/fd")).map(name =>
    readlink(join("/proc/self/fd", name)).catch(() => "")));
  return targets.filter(target => target === root || target.startsWith(`${root}/`)).length;
};

test("Linux file storage persists retirement across reopen without changing legacy files or leaking handles", {
  skip: process.platform !== "linux",
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "ar-egress-storage-test-"));
  const v3 = join(root, "v3"); const v2 = join(root, "v2");
  let storage: NodeDockerEgressJournalStorage | undefined;
  try {
    await mkdir(v3, {mode: 0o700}); await mkdir(v2, {mode: 0o700});
    const untouched = join(v2, "legacy-owner-note");
    await writeFile(untouched, "not owned by V3\n", {mode: 0o600});
    storage = await NodeDockerEgressJournalStorage.open(v3, v2);
    const journal = new DockerEgressJournal(storage, trusted, observerAuthority);
    const sequence = await clean(journal, await materialize(journal));
    const closed = await journal.close(subject, sequence, command("close"));
    const tombstoneName = `docker-egress-custody-v3-${dockerEgressJournalLocator(subject)}.tombstone`;
    assert.deepEqual(await readdir(v3), [tombstoneName]);
    assert.equal((await stat(join(v3, tombstoneName))).mode & 0o777, 0o600);
    await storage.close(); storage = undefined;
    assert.equal(await openSandboxDescriptors(root), 0);
    storage = await NodeDockerEgressJournalStorage.open(v3, v2);
    const restarted = new DockerEgressJournal(storage, trusted, observerAuthority);
    for (let iteration = 0; iteration < 3; iteration += 1) {
      assert.deepEqual(await restarted.close(subject, sequence, command("close")), closed);
    }
    assert.equal(await openSandboxDescriptors(root), 2);
    await assert.rejects(restarted.open(subject, command("reopen")), {name: "DockerEgressJournalConflictError"});
    assert.equal(await readFile(untouched, "utf8"), "not owned by V3\n");
  } finally {
    await storage?.close();
    assert.equal(await openSandboxDescriptors(root), 0);
    await rm(root, {recursive: true, force: true});
  }
});

test("canonical inputs reject network, path, secret, sparse/accessor, proxy, and non-fixed handles", () => {
  for (const forbidden of ["/var/run/netns/x", "../x", "https://host/x", "127.0.0.1", "[::1]:443", "token=abc",
    "account@example.com", "private-network-handle:not-a-digest"]) {
    assert.throws(() => changedSubject({}, { privateNetworkHandle: forbidden }), /fixed-format opaque/u);
  }
  assert.throws(() => validateDockerEgressSubject({ ...subject, secret: "credential" }), /exact data-only shape/u);
  const accessor = { ...subject };
  Object.defineProperty(accessor, "bindingSha256", { enumerable: true, get: () => subject.bindingSha256 });
  assert.throws(() => validateDockerEgressSubject(accessor), /data-only/u);
  let traps = 0;
  assert.throws(() => validateDockerEgressSubject(new Proxy(subject, { getPrototypeOf: () => { traps += 1; return Object.prototype; } })),
    /non-proxy/u);
  assert.equal(traps, 0);
  const sparse: unknown[] = []; sparse.length = 2;
  assert.throws(() => validateDockerEgressSubject(sparse));
});

test("record and byte reservations cover receipt, unknown, quarantine, and every reverse cleanup", async () => {
  const storage = new MemoryEgressStorage(); const journal = new DockerEgressJournal(storage, trusted, observerAuthority);
  let sequence = (await journal.open(subject, command("open"))).sequence;
  for (const [index, resource] of DOCKER_EGRESS_RESOURCE_KINDS.entries()) {
    const intent = await journal.materializeIntent(subject, sequence, command(`intent-${resource}`), resource); sequence = intent.sequence;
    assert.equal(intent.event.kind, "materialize_intent");
    if (intent.event.kind === "materialize_intent") {assert.equal(intent.event.reservation.recordCount, 4 + (index + 1) * 2);}
    sequence = (await journal.materializeReceipt(subject, sequence, command(`receipt-${resource}`), resource)).sequence;
  }
  const cleanup = await journal.cleanupIntent(subject, sequence, command("cleanup-intent"), "provider_container");
  assert.deepEqual(cleanup.event.kind === "cleanup_intent" ? cleanup.event.reservation : null,
    { recordCount: 3, byteCount: 3 * DEFAULT_DOCKER_EGRESS_JOURNAL_LIMITS.maxRecordBytes });
});
