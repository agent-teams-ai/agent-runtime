import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_DOCKER_EGRESS_JOURNAL_LIMITS,
  DOCKER_EGRESS_CLEANUP_ORDER,
  DOCKER_EGRESS_RESOURCE_KINDS,
  DockerEgressJournal,
  classifyDockerEgressLegacyV2,
  createDockerCustodyRecord,
  createDockerEgressRecord,
  createDockerEgressSubject,
  dockerEgressJournalLocator,
  encodeDockerCustodyRecord,
  encodeDockerEgressRecord,
  replayDockerEgressBytes,
  validateDockerEgressSubject,
  type DockerEgressJournalSubject,
} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/journal/index.js";
import { MemoryFile, MemoryStorage, key as v2Key } from "../../fixtures/docker-journal-test-fixture.ts";

const digest = (character: string): string => character.repeat(64);
const subject = createDockerEgressSubject({
  identity: {
    operationId: "operation:egress-1", attemptId: "attempt:egress-1", effectId: "effect:egress-1",
    custodyId: "custody:egress-1", workspaceId: "workspace:egress-1", hostInstanceId: "host:egress-1",
    hostBootId: "boot:egress-1", resourceGenerationId: "resource-generation:egress-1",
  },
  authority: {
    scopeSha256: digest("1"), operationSha256: digest("2"), acceptedAuthoritySha256: digest("3"),
    brokerPolicySha256: digest("4"), routeAuthorizationSha256: digest("5"),
    materializationAuthorizationSha256: digest("6"),
  },
  resources: {
    privateNetworkId: "private-network:egress-1", brokerNamespaceId: "broker-netns:egress-1",
    brokerCgroupId: "broker-cgroup:egress-1", brokerProcessId: "broker-process:egress-1",
    brokerListenerId: "broker-listener:egress-1", brokerInboundSocketId: "broker-inbound-socket:egress-1",
    brokerUpstreamSocketId: "broker-upstream-socket:egress-1", providerEndpointId: "provider-endpoint:egress-1",
    networkEndpointId: "network-endpoint:egress-1", upstreamRuleGenerationId: "upstream-rule-generation:egress-1",
    providerContainerId: "provider-container:egress-1",
  },
});

const appendMaterialization = async (
  journal: DockerEgressJournal,
  value: DockerEgressJournalSubject = subject,
): Promise<number> => {
  let sequence = (await journal.open(value)).sequence;
  for (const resource of DOCKER_EGRESS_RESOURCE_KINDS) {
    sequence = (await journal.materializeIntent(value, sequence, resource)).sequence;
    sequence = (await journal.materializeReceipt(value, sequence, resource)).sequence;
  }
  return sequence;
};

test("V3 strict codec round-trips a deterministic digest-bound immutable record", () => {
  const record = createDockerEgressRecord({
    sequence: 0, subject, event: { kind: "open_intent" }, previousChecksumSha256: null,
  });
  const encoded = encodeDockerEgressRecord(record);
  const replay = replayDockerEgressBytes(encoded);
  assert.deepEqual(replay.records, [record]);
  assert.equal(Object.isFrozen(replay.records), true);
  assert.equal(Object.isFrozen(replay.records[0]?.subject.resources), true);
  assert.equal(Buffer.from(encoded).equals(Buffer.from(encodeDockerEgressRecord(record))), true);
  assert.equal(JSON.stringify(record).includes("timestamp"), false);
  assert.equal(JSON.stringify(record).includes("/"), false);
});

test("same host-local identity with any changed accepted authority digest conflicts", async () => {
  const journal = new DockerEgressJournal(new MemoryStorage());
  await journal.open(subject);
  const conflicting = createDockerEgressSubject({
    ...subject,
    authority: { ...subject.authority, brokerPolicySha256: digest("7") },
  });
  await assert.rejects(journal.open(conflicting), { name: "DockerEgressJournalConflictError" });
});

test("every materialization side effect has a durable intent and receipt and replay never recreates", async () => {
  const storage = new MemoryStorage();
  const journal = new DockerEgressJournal(storage);
  let sequence = (await journal.open(subject)).sequence;
  for (const resource of DOCKER_EGRESS_RESOURCE_KINDS) {
    sequence = (await journal.materializeIntent(subject, sequence, resource)).sequence;
    const afterIntent = (await journal.recover()).find(item => item.kind === "cleanup_only");
    assert.equal(afterIntent?.kind, "cleanup_only");
    assert.equal(afterIntent?.reconcileRequired, true);
    assert.equal("materialize" in (afterIntent ?? {}), false);
    sequence = (await journal.materializeReceipt(subject, sequence, resource)).sequence;
    const afterReceipt = (await journal.recover()).find(item => item.kind === "cleanup_only");
    assert.equal(afterReceipt?.kind, "cleanup_only");
    assert.equal(JSON.stringify(afterReceipt).includes("retry"), false);
  }
  const file = storage.files.get(dockerEgressJournalLocator(subject));
  assert.ok(file);
  const events = replayDockerEgressBytes(file.bytes).records.map(record => record.event);
  assert.equal(events.length, 1 + DOCKER_EGRESS_RESOURCE_KINDS.length * 2);
  for (const [index, resource] of DOCKER_EGRESS_RESOURCE_KINDS.entries()) {
    assert.deepEqual(events[index * 2 + 1], { kind: "materialize_intent", resource });
    assert.deepEqual(events[index * 2 + 2], { acknowledgement: "acknowledged", kind: "materialize_receipt", resource });
  }
});

test("lost acknowledgement becomes reconcile_required then cleanup is reverse ordered and idempotent", async () => {
  const storage = new MemoryStorage();
  const journal = new DockerEgressJournal(storage);
  let sequence = (await journal.open(subject)).sequence;
  for (const resource of DOCKER_EGRESS_RESOURCE_KINDS.slice(0, 5)) {
    sequence = (await journal.materializeIntent(subject, sequence, resource)).sequence;
    if (resource === "broker_listener") { break; }
    sequence = (await journal.materializeReceipt(subject, sequence, resource)).sequence;
  }
  sequence = (await journal.reconcileRequired(subject, sequence, "acknowledgement_unknown", "broker_listener")).sequence;
  assert.deepEqual((await journal.recover())[0], {
    kind: "cleanup_only", bindingSha256: subject.bindingSha256, nextCleanup: "broker_listener",
    reconcileRequired: true, status: "cleaning",
  });
  for (const resource of DOCKER_EGRESS_CLEANUP_ORDER.filter(item => DOCKER_EGRESS_RESOURCE_KINDS.indexOf(item) <= 4)) {
    sequence = (await journal.cleanupIntent(subject, sequence, resource)).sequence;
    sequence = (await journal.cleanupReceipt(subject, sequence, resource, "already_absent")).sequence;
  }
  const closed = await journal.close(subject, sequence);
  assert.equal(closed.event.kind, "closed");
  assert.deepEqual((await journal.recover())[0], {
    kind: "cleanup_only", bindingSha256: subject.bindingSha256, nextCleanup: null,
    reconcileRequired: false, status: "closed",
  });
  await assert.rejects(journal.cleanupIntent(subject, closed.sequence, "private_network"), {
    name: "DockerEgressJournalConflictError",
  });
});

test("restart after every cleanup intent and receipt resumes only the exact reverse dependency", async () => {
  const storage = new MemoryStorage();
  const journal = new DockerEgressJournal(storage);
  let sequence = await appendMaterialization(journal);
  for (const [index, resource] of DOCKER_EGRESS_CLEANUP_ORDER.entries()) {
    sequence = (await journal.cleanupIntent(subject, sequence, resource)).sequence;
    assert.deepEqual((await new DockerEgressJournal(storage).recover())[0], {
      kind: "cleanup_only", bindingSha256: subject.bindingSha256, nextCleanup: resource,
      reconcileRequired: true, status: "cleaning",
    });
    sequence = (await journal.cleanupReceipt(subject, sequence, resource, "acknowledged")).sequence;
    const expected = DOCKER_EGRESS_CLEANUP_ORDER[index + 1] ?? null;
    assert.deepEqual((await new DockerEgressJournal(storage).recover())[0], {
      kind: "cleanup_only", bindingSha256: subject.bindingSha256, nextCleanup: expected,
      reconcileRequired: false, status: "cleaning",
    });
  }
  await journal.close(subject, sequence);
});

test("cleanup failure fences closure and resource generation until exact absence is proved", async () => {
  const journal = new DockerEgressJournal(new MemoryStorage());
  let sequence = await appendMaterialization(journal);
  sequence = (await journal.cleanupIntent(subject, sequence, "provider_container")).sequence;
  sequence = (await journal.reconcileRequired(subject, sequence, "cleanup_failed", "provider_container")).sequence;
  await assert.rejects(journal.close(subject, sequence), { name: "DockerEgressJournalConflictError" });
  await assert.rejects(journal.materializeIntent(subject, sequence, "private_network"), { name: "DockerEgressJournalConflictError" });
  sequence = (await journal.quarantine(subject, sequence, "cleanup_incomplete")).sequence;
  sequence = (await journal.cleanupIntent(subject, sequence, "provider_container")).sequence;
  sequence = (await journal.cleanupReceipt(subject, sequence, "provider_container", "acknowledged")).sequence;
  const recovery = (await journal.recover()).find(item => item.kind === "cleanup_only");
  assert.equal(recovery?.status, "quarantined");
  await assert.rejects(journal.close(subject, sequence), { name: "DockerEgressJournalConflictError" });
});

test("concurrent open is exact-idempotent while concurrent cleanup CAS has one winner", async () => {
  const storage = new MemoryStorage();
  const journal = new DockerEgressJournal(storage);
  const opened = await Promise.all([journal.open(subject), journal.open(subject)]);
  assert.equal(opened[0]?.checksumSha256, opened[1]?.checksumSha256);
  let sequence = opened[0]?.sequence ?? -1;
  sequence = (await journal.materializeIntent(subject, sequence, "private_network")).sequence;
  sequence = (await journal.materializeReceipt(subject, sequence, "private_network")).sequence;
  const settled = await Promise.allSettled([
    journal.cleanupIntent(subject, sequence, "private_network"),
    journal.cleanupIntent(subject, sequence, "private_network"),
  ]);
  assert.equal(settled.filter(item => item.status === "fulfilled").length, 1);
  assert.equal(settled.filter(item => item.status === "rejected").length, 1);
});

test("wrong host, boot, scope, and resource generation cannot open the same identity", async () => {
  const journal = new DockerEgressJournal(new MemoryStorage());
  await journal.open(subject);
  for (const changed of [
    { hostInstanceId: "host:wrong" }, { hostBootId: "boot:wrong" },
    { resourceGenerationId: "resource-generation:wrong" },
  ]) {
    const candidate = createDockerEgressSubject({ ...subject, identity: { ...subject.identity, ...changed } });
    await assert.rejects(journal.open(candidate), { name: "DockerEgressJournalConflictError" });
  }
  const changedScope = createDockerEgressSubject({
    ...subject, authority: { ...subject.authority, scopeSha256: digest("8") },
  });
  await assert.rejects(journal.open(changedScope), { name: "DockerEgressJournalConflictError" });
});

test("strict shapes reject paths, secrets, accessors, symbols, proxies, and malformed digests", () => {
  assert.throws(() => validateDockerEgressSubject({ ...subject, secret: "token" }), /exact data-only shape/u);
  assert.throws(() => createDockerEgressSubject({
    ...subject, resources: { ...subject.resources, privateNetworkId: "/var/run/netns/private" },
  }), /bounded opaque/u);
  assert.throws(() => createDockerEgressSubject({
    ...subject, authority: { ...subject.authority, routeAuthorizationSha256: "latest" },
  }), /SHA-256/u);
  assert.throws(() => validateDockerEgressSubject({ ...subject, [Symbol("secret")]: "hidden" }), /exact data-only shape/u);
  const accessor = { ...subject };
  Object.defineProperty(accessor, "bindingSha256", { enumerable: true, get: () => subject.bindingSha256 });
  assert.throws(() => validateDockerEgressSubject(accessor), /data-only/u);
  let traps = 0;
  const proxy = new Proxy(subject, { getPrototypeOf: () => { traps += 1; return Object.prototype; } });
  assert.throws(() => validateDockerEgressSubject(proxy), /non-proxy/u);
  assert.equal(traps, 0);
});

test("corrupt, truncated, and oversized V3 journals fail closed into bounded quarantine evidence", async () => {
  for (const mutation of [
    (bytes: Buffer) => Buffer.from(bytes.toString().replace(subject.bindingSha256, digest("f"))),
    (bytes: Buffer) => bytes.subarray(0, bytes.byteLength - 1),
    (bytes: Buffer) => Buffer.concat([bytes, Buffer.alloc(DEFAULT_DOCKER_EGRESS_JOURNAL_LIMITS.maxJournalBytes)]),
  ]) {
    const storage = new MemoryStorage();
    await new DockerEgressJournal(storage).open(subject);
    const file = storage.files.get(dockerEgressJournalLocator(subject));
    assert.ok(file);
    file.bytes = mutation(file.bytes);
    const recovered = await new DockerEgressJournal(storage).recover();
    assert.deepEqual(recovered, [{
      kind: "cleanup_only", bindingSha256: dockerEgressJournalLocator(subject), nextCleanup: null,
      reconcileRequired: true, status: "quarantined",
    }]);
  }
});

test("V2 is cleanup-only; populated, partial, and malformed legacy state never upgrades authority", async () => {
  const first = createDockerCustodyRecord({
    attemptKey: v2Key, sequence: 0, state: "prepared", evidence: { status: "proved" }, previousChecksumSha256: null,
  });
  const second = createDockerCustodyRecord({
    attemptKey: v2Key, sequence: 1, state: "create_requested", evidence: { status: "proved" },
    previousChecksumSha256: first.checksumSha256,
  });
  const safe = classifyDockerEgressLegacyV2(encodeDockerCustodyRecord(first, DEFAULT_DOCKER_EGRESS_JOURNAL_LIMITS),
    DEFAULT_DOCKER_EGRESS_JOURNAL_LIMITS);
  assert.deepEqual(safe, { diagnostic: "legacy_empty", quarantineRequired: false, executionAuthority: null, cleanupIdentity: null });
  const populatedBytes = Buffer.concat([
    encodeDockerCustodyRecord(first, DEFAULT_DOCKER_EGRESS_JOURNAL_LIMITS),
    encodeDockerCustodyRecord(second, DEFAULT_DOCKER_EGRESS_JOURNAL_LIMITS),
  ]);
  assert.deepEqual(classifyDockerEgressLegacyV2(populatedBytes, DEFAULT_DOCKER_EGRESS_JOURNAL_LIMITS), {
    diagnostic: "legacy_populated_without_cleanup_identity", quarantineRequired: true,
    executionAuthority: null, cleanupIdentity: null,
  });
  assert.equal(classifyDockerEgressLegacyV2(populatedBytes.subarray(0, populatedBytes.length - 3),
    DEFAULT_DOCKER_EGRESS_JOURNAL_LIMITS).quarantineRequired, true);
  assert.equal(classifyDockerEgressLegacyV2(Buffer.from("{}\n"), DEFAULT_DOCKER_EGRESS_JOURNAL_LIMITS).quarantineRequired, true);

  const storage = new MemoryStorage();
  const legacy = new MemoryFile(); legacy.bytes = populatedBytes; storage.files.set(digest("a"), legacy);
  const recovery = await new DockerEgressJournal(storage).recover();
  assert.equal(recovery[0]?.kind, "legacy_cleanup_only");
  assert.equal(JSON.stringify(recovery).includes("acceptedAuthoritySha256"), false);
  assert.equal(JSON.stringify(recovery).includes("routeAuthorizationSha256"), false);
  assert.equal(JSON.stringify(recovery).includes("providerContainerId"), false);
});

test("terminal public evidence is digest-only and cannot reconstruct execution authority", async () => {
  const journal = new DockerEgressJournal(new MemoryStorage());
  const opened = await journal.open(subject);
  await journal.close(subject, opened.sequence);
  const evidence = (await journal.recover())[0];
  assert.deepEqual(Object.keys(evidence ?? {}).toSorted(), [
    "bindingSha256", "kind", "nextCleanup", "reconcileRequired", "status",
  ]);
  const serialized = JSON.stringify(evidence);
  for (const forbidden of ["authority", "route", "policy", "materialization", "workspace:", "host:", "boot:", "/", "secret", "output"]) {
    assert.equal(serialized.includes(forbidden), false);
  }
});
