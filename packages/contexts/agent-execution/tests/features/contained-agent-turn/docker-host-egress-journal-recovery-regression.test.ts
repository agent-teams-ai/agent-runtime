import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import {
  DEFAULT_DOCKER_EGRESS_JOURNAL_LIMITS,
  DockerEgressJournal,
  createDockerEgressCleanupObservation,
  createDockerEgressRecord,
  createDockerEgressSubject,
  createDockerEgressTombstone,
  decodeDockerEgressTombstone,
  dockerEgressCleanupHandle,
  dockerEgressJournalLocator,
  encodeDockerEgressRecord,
  encodeDockerEgressTombstone,
  replayDockerEgressBytes,
  type DockerEgressJournalSubject,
  type DockerEgressTrustedRuntimeIdentity,
} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/journal/index.js";
import { MemoryEgressFile, MemoryEgressStorage } from "../../fixtures/docker-journal-test-fixture.ts";

const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
const opaque = (prefix: string, value: string): string => `${prefix}${hash(value)}`;
const command = (value: string): string => opaque("command:", value);
const canonical = (value: unknown): string => JSON.stringify(order(value));
const order = (value: unknown): unknown => {
  if (Array.isArray(value)) { return value.map(order); }
  if (value === null || typeof value !== "object") { return value; }
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).toSorted(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0).map(([key, item]) => [key, order(item)]));
};
const uncheckedTombstone = (input: Readonly<{
  locatorSha256: string; bindingSha256: string | null; disposition: "retired" | "quarantined";
  terminalRecord: ReturnType<typeof createDockerEgressRecord> | null;
}>): Uint8Array => {
  const body = { version: 3, ...input }; const checksumSha256 = hash(canonical(body));
  return Buffer.from(`${canonical({ ...body, checksumSha256 })}\n`);
};
const observerAuthority = Object.freeze({
  observerId: opaque("observer:", "absence-observer"),
  capabilityRevisionSha256: hash("observer-capability"),
});
const expandedLimits = Object.freeze({
  ...DEFAULT_DOCKER_EGRESS_JOURNAL_LIMITS,
  maxRecordsPerJournal: 128,
  maxJournalBytes: 128 * DEFAULT_DOCKER_EGRESS_JOURNAL_LIMITS.maxRecordBytes,
});

const makeSubject = (generation: string): DockerEgressJournalSubject => createDockerEgressSubject({
  identity: {
    operationId: opaque("operation:", `operation-${generation}`), attemptId: opaque("attempt:", `attempt-${generation}`),
    effectId: opaque("effect:", `effect-${generation}`), custodyId: opaque("custody:", `custody-${generation}`),
    workspaceId: opaque("workspace:", `workspace-${generation}`), hostSlotId: opaque("host-slot:", `slot-${generation}`),
    hostInstanceId: opaque("host-instance:", `host-${generation}`), hostBootId: opaque("host-boot:", `boot-${generation}`),
    executionGenerationId: opaque("execution-generation:", `execution-${generation}`),
    daemonId: opaque("daemon:", `daemon-${generation}`), daemonGenerationId: opaque("daemon-generation:", `daemon-gen-${generation}`),
    slotGenerationId: opaque("slot-generation:", `slot-gen-${generation}`), exactFingerprintSha256: hash(`fingerprint-${generation}`),
  },
  authority: {
    scopeSha256: hash(`scope-${generation}`), operationSha256: hash(`operation-binding-${generation}`),
    acceptedAuthoritySha256: hash(`accepted-authority-${generation}`), brokerPolicySha256: hash(`broker-policy-${generation}`),
    routeAuthorizationSha256: hash(`route-authorization-${generation}`),
    materializationAuthorizationSha256: hash(`materialization-authorization-${generation}`),
  },
  resources: {
    privateNetworkHandle: opaque("private-network-handle:", `private-network-${generation}`),
    brokerNamespaceHandle: opaque("broker-netns-handle:", `broker-namespace-${generation}`),
    brokerCgroupHandle: opaque("broker-cgroup-handle:", `broker-cgroup-${generation}`),
    brokerProcessHandle: opaque("broker-process-handle:", `broker-process-${generation}`),
    brokerListenerHandle: opaque("broker-listener-handle:", `broker-listener-${generation}`),
    brokerInboundSocketHandle: opaque("broker-inbound-socket-handle:", `broker-inbound-${generation}`),
    brokerUpstreamSocketHandle: opaque("broker-upstream-socket-handle:", `broker-upstream-${generation}`),
    providerEndpointHandle: opaque("provider-endpoint-handle:", `provider-endpoint-${generation}`),
    networkEndpointHandle: opaque("network-endpoint-handle:", `network-endpoint-${generation}`),
    upstreamRuleHandle: opaque("upstream-rule-handle:", `upstream-rule-${generation}`),
    providerContainerHandle: opaque("provider-container-handle:", `provider-container-${generation}`),
  },
});
const trustedFor = (subject: DockerEgressJournalSubject): DockerEgressTrustedRuntimeIdentity => Object.freeze({
  scopeSha256: subject.authority.scopeSha256, hostSlotId: subject.identity.hostSlotId,
  hostInstanceId: subject.identity.hostInstanceId, hostBootId: subject.identity.hostBootId,
  executionGenerationId: subject.identity.executionGenerationId, daemonId: subject.identity.daemonId,
  daemonGenerationId: subject.identity.daemonGenerationId, slotGenerationId: subject.identity.slotGenerationId,
});
const observation = (subject: DockerEgressJournalSubject) => createDockerEgressCleanupObservation({
  resource: "private_network", cleanupHandle: dockerEgressCleanupHandle(subject, "private_network"),
  scopeSha256: subject.authority.scopeSha256, hostInstanceId: subject.identity.hostInstanceId,
  hostBootId: subject.identity.hostBootId, executionGenerationId: subject.identity.executionGenerationId,
  daemonId: subject.identity.daemonId, daemonGenerationId: subject.identity.daemonGenerationId,
  slotGenerationId: subject.identity.slotGenerationId, ...observerAuthority, result: "absent",
});
const closedRecords = (subject: DockerEgressJournalSubject, suffix: string) => {
  const opened = createDockerEgressRecord({ sequence: 0, subject, commandId: command(`open-${suffix}`),
    event: { kind: "open_intent" }, previousChecksumSha256: null });
  const closed = createDockerEgressRecord({ sequence: 1, subject, commandId: command(`close-${suffix}`),
    event: { kind: "closed" }, previousChecksumSha256: opened.checksumSha256 });
  return { opened, closed };
};
const assertOnlyIdentityReused = (prior: DockerEgressJournalSubject, successor: DockerEgressJournalSubject,
  reused: "custodyId" | "workspaceId"): void => {
  for (const key of Object.keys(prior.identity) as Array<keyof DockerEgressJournalSubject["identity"]>) {
    assert.equal(prior.identity[key] === successor.identity[key], key === reused, `${String(key)} freshness`);
  }
  for (const key of Object.keys(prior.resources) as Array<keyof DockerEgressJournalSubject["resources"]>) {
    assert.notEqual(prior.resources[key], successor.resources[key], `${String(key)} freshness`);
  }
};

test("retired tombstones require an exact locator-bound closed terminal record", async () => {
  const subject = makeSubject("invalid-retirement"); const locator = dockerEgressJournalLocator(subject);
  const { opened, closed } = closedRecords(subject, "invalid-retirement");
  const cases = [
    { name: "null", storedLocator: locator, bindingSha256: null, terminalRecord: null },
    { name: "nonclosed", storedLocator: locator, bindingSha256: subject.bindingSha256, terminalRecord: opened },
    { name: "wrong-locator", storedLocator: hash("wrong-retirement-locator"),
      bindingSha256: subject.bindingSha256, terminalRecord: closed },
    { name: "inconsistent-binding", storedLocator: locator, bindingSha256: hash("wrong-retirement-binding"), terminalRecord: closed },
  ] as const;
  for (const item of cases) {
    const storage = new MemoryEgressStorage(); const bytes = uncheckedTombstone({
      locatorSha256: item.storedLocator, bindingSha256: item.bindingSha256,
      disposition: "retired", terminalRecord: item.terminalRecord,
    });
    assert.throws(() => decodeDockerEgressTombstone(bytes), { name: "DockerEgressJournalCorruptionError" });
    const file = new MemoryEgressFile(); file.bytes = Buffer.from(bytes); storage.tombstones.set(item.storedLocator, file);
    const journal = new DockerEgressJournal(storage, trustedFor(subject), observerAuthority);
    await assert.rejects(journal.open(subject, command(`fenced-${item.name}`)));
    const evidence = await journal.recoveryEvidence();
    assert.deepEqual(evidence, [{ kind: "quarantine_evidence", locatorSha256: item.storedLocator,
      bindingSha256: null, status: "quarantined" }]);
    assert.equal(evidence.some(entry => entry.kind === "retirement_evidence"), false);
  }
});

test("retired tombstones require a bounded chained terminal while preserving retirement without historical reconstruction", () => {
  const subject = makeSubject("retirement-chain-boundary"); const locator = dockerEgressJournalLocator(subject);
  const lastSequence = DEFAULT_DOCKER_EGRESS_JOURNAL_LIMITS.maxRecordsPerJournal - 1;
  const bounded = createDockerEgressRecord({ sequence: lastSequence, subject, commandId: command("bounded-close"),
    event: { kind: "closed" }, previousChecksumSha256: hash("bounded-predecessor") });
  const tombstone = createDockerEgressTombstone({ locatorSha256: locator, bindingSha256: subject.bindingSha256,
    disposition: "retired", terminalRecord: bounded });
  assert.equal(decodeDockerEgressTombstone(encodeDockerEgressTombstone(tombstone)).terminalRecord?.sequence, lastSequence);

  for (const terminalRecord of [
    createDockerEgressRecord({ sequence: 0, subject, commandId: command("zero-close"),
      event: { kind: "closed" }, previousChecksumSha256: hash("zero-predecessor") }),
    createDockerEgressRecord({ sequence: DEFAULT_DOCKER_EGRESS_JOURNAL_LIMITS.maxRecordsPerJournal, subject,
      commandId: command("over-bound-close"), event: { kind: "closed" }, previousChecksumSha256: hash("over-bound-predecessor") }),
  ]) {
    assert.throws(() => createDockerEgressTombstone({ locatorSha256: locator, bindingSha256: subject.bindingSha256,
      disposition: "retired", terminalRecord }), /exact closed terminal record/u);
  }
});

test("checksum-valid retired tombstone with an unchained terminal fails retry and recovery closed", async () => {
  const subject = makeSubject("unchained-retirement"); const locator = dockerEgressJournalLocator(subject);
  const impossible = createDockerEgressRecord({ sequence: 1, subject, commandId: command("unchained-close"),
    event: { kind: "closed" }, previousChecksumSha256: null });
  const bytes = uncheckedTombstone({ locatorSha256: locator, bindingSha256: subject.bindingSha256,
    disposition: "retired", terminalRecord: impossible });
  assert.throws(() => decodeDockerEgressTombstone(bytes), { name: "DockerEgressJournalCorruptionError" });

  const storage = new MemoryEgressStorage(); const file = new MemoryEgressFile(); file.bytes = Buffer.from(bytes);
  storage.tombstones.set(locator, file);
  const journal = new DockerEgressJournal(storage, trustedFor(subject), observerAuthority);
  await assert.rejects(journal.close(subject, 0, impossible.commandId), { name: "DockerEgressJournalCorruptionError" });
  assert.deepEqual(await journal.recoverCleanupDirectives(), []);
  const evidence = await journal.recoveryEvidence();
  assert.deepEqual(evidence, [{ kind: "quarantine_evidence", locatorSha256: locator,
    bindingSha256: null, status: "quarantined" }]);
  assert.equal(evidence.some(entry => entry.kind === "retirement_evidence" || entry.kind === "cleanup_evidence"), false);
  assert.equal(storage.tombstones.has(locator), true);
  assert.equal(storage.v3Files.has(locator), false);
});

test("recovery closes and retires a reachable long failed-cleanup chain under configured bounds", async () => {
  const subject = makeSubject("long-recovery-retirement"); const locator = dockerEgressJournalLocator(subject);
  const storage = new MemoryEgressStorage();
  const journal = new DockerEgressJournal(storage, trustedFor(subject), observerAuthority, expandedLimits);
  let sequence = (await journal.open(subject, command("long-recovery-open"))).sequence;
  sequence = (await journal.materializeIntent(subject, sequence, command("long-recovery-materialize-intent"),
    "private_network")).sequence;
  sequence = (await journal.materializeReceipt(subject, sequence, command("long-recovery-materialize-receipt"),
    "private_network")).sequence;
  for (let attempt = 0; attempt < 47; attempt += 1) {
    sequence = (await journal.cleanupIntent(subject, sequence, command(`long-recovery-cleanup-intent-${attempt}`),
      "private_network")).sequence;
    sequence = (await journal.reconcileRequired(subject, sequence, command(`long-recovery-cleanup-failed-${attempt}`),
      "cleanup_failed", "private_network")).sequence;
  }
  sequence = (await journal.cleanupIntent(subject, sequence, command("long-recovery-final-cleanup-intent"),
    "private_network")).sequence;
  sequence = (await journal.cleanupReceipt(subject, sequence, command("long-recovery-final-cleanup-receipt"),
    "private_network", observation(subject))).sequence;
  assert.ok(sequence >= DEFAULT_DOCKER_EGRESS_JOURNAL_LIMITS.maxRecordsPerJournal);

  const restarted = new DockerEgressJournal(storage, trustedFor(subject), observerAuthority, expandedLimits);
  assert.deepEqual(await restarted.recoveryEvidence(), [{ kind: "retirement_evidence", locatorSha256: locator,
    bindingSha256: subject.bindingSha256, status: "retired" }]);
  assert.equal(storage.v3Files.has(locator), false);
  const tombstoneFile = storage.tombstones.get(locator); assert.ok(tombstoneFile);
  const tombstone = decodeDockerEgressTombstone(tombstoneFile.bytes, expandedLimits);
  assert.equal(tombstone.terminalRecord?.sequence, sequence + 1);
  assert.ok(tombstone.terminalRecord);
  assert.deepEqual(await restarted.close(subject, sequence, tombstone.terminalRecord.commandId), tombstone.terminalRecord);
});

test("quarantined prefix evidence remains decodable but cannot authorize tombstone retry", async () => {
  const subject = makeSubject("quarantined-prefix"); const locator = dockerEgressJournalLocator(subject);
  const { opened, closed } = closedRecords(subject, "quarantined-prefix");
  const tombstone = createDockerEgressTombstone({ locatorSha256: locator, bindingSha256: subject.bindingSha256,
    disposition: "quarantined", terminalRecord: opened });
  assert.equal(decodeDockerEgressTombstone(encodeDockerEgressTombstone(tombstone)).terminalRecord?.checksumSha256,
    opened.checksumSha256);
  const storage = new MemoryEgressStorage(); const file = new MemoryEgressFile();
  file.bytes = Buffer.from(encodeDockerEgressTombstone(tombstone)); storage.tombstones.set(locator, file);
  const journal = new DockerEgressJournal(storage, trustedFor(subject), observerAuthority);
  await assert.rejects(journal.close(subject, 0, opened.commandId), { name: "DockerEgressJournalConflictError" });
  assert.deepEqual(await journal.recoveryEvidence(), [{ kind: "quarantine_evidence", locatorSha256: locator,
    bindingSha256: subject.bindingSha256, status: "quarantined" }]);
  const closedStorage = new MemoryEgressStorage(); const closedFile = new MemoryEgressFile();
  const closedQuarantine = createDockerEgressTombstone({ locatorSha256: locator, bindingSha256: subject.bindingSha256,
    disposition: "quarantined", terminalRecord: closed });
  closedFile.bytes = Buffer.from(encodeDockerEgressTombstone(closedQuarantine));
  closedStorage.tombstones.set(locator, closedFile);
  await assert.rejects(new DockerEgressJournal(closedStorage, trustedFor(subject), observerAuthority)
    .close(subject, 0, closed.commandId), { name: "DockerEgressJournalConflictError" });
});

test("a tombstone-only exact close retry succeeds only from valid retirement evidence", async () => {
  const subject = makeSubject("tombstone-only-retry"); const locator = dockerEgressJournalLocator(subject);
  const { closed } = closedRecords(subject, "tombstone-only-retry"); const storage = new MemoryEgressStorage();
  const tombstone = createDockerEgressTombstone({ locatorSha256: locator, bindingSha256: subject.bindingSha256,
    disposition: "retired", terminalRecord: closed });
  await storage.persistTombstone(locator, encodeDockerEgressTombstone(tombstone), false);
  const journal = new DockerEgressJournal(storage, trustedFor(subject), observerAuthority);
  assert.deepEqual(await journal.close(subject, 0, closed.commandId), closed);
  await assert.rejects(journal.reconcileRequired(subject, 0, closed.commandId, "journal_corrupt", null),
    { name: "DockerEgressJournalConflictError" });
  assert.equal(storage.v3Files.has(locator), false);
});

test("operation-private custody and workspace identities cannot cross retired or live successor generations", async () => {
  for (const identity of ["custodyId", "workspaceId"] as const) {
    for (const disposition of ["retired", "live"] as const) {
      const prior = makeSubject(`${identity}-${disposition}-prior`);
      const fresh = makeSubject(`${identity}-${disposition}-successor`);
      const successor = createDockerEgressSubject({ ...fresh,
        identity: { ...fresh.identity, [identity]: prior.identity[identity] } });
      assertOnlyIdentityReused(prior, successor, identity);
      const storage = new MemoryEgressStorage(); const locator = dockerEgressJournalLocator(prior);
      const records = closedRecords(prior, `${identity}-${disposition}`);
      if (disposition === "retired") {
        const tombstone = createDockerEgressTombstone({ locatorSha256: locator, bindingSha256: prior.bindingSha256,
          disposition: "retired", terminalRecord: records.closed });
        await storage.persistTombstone(locator, encodeDockerEgressTombstone(tombstone), false);
      } else {
        const file = storage.v3Files.get(locator) ?? await storage.createWithFirstRecord(locator, encodeDockerEgressRecord(records.opened));
        await file.append(file.byteLength, encodeDockerEgressRecord(records.closed));
      }
      await assert.rejects(new DockerEgressJournal(storage, trustedFor(successor), observerAuthority)
        .open(successor, command(`${identity}-${disposition}-reuse`)), { name: "DockerEgressJournalConflictError" });
    }
  }
});

test("validated prefix survives a corrupt tail only as quarantined cleanup evidence", async () => {
  const subject = makeSubject("prefix"); const storage = new MemoryEgressStorage();
  const journal = new DockerEgressJournal(storage, trustedFor(subject), observerAuthority);
  const opened = await journal.open(subject, command("open-prefix"));
  const intent = await journal.materializeIntent(subject, opened.sequence, command("intent-prefix"), "private_network");
  const file = storage.v3Files.get(dockerEgressJournalLocator(subject)); assert.ok(file);
  file.bytes = Buffer.concat([file.bytes, Buffer.from('{"malformed":true}\n')]);

  const decoded = replayDockerEgressBytes(file.bytes);
  assert.equal(decoded.tail, "partial");
  assert.deepEqual(decoded.records.map(record => record.sequence), [0, 1]);
  await assert.rejects(journal.open(subject, command("open-over-corrupt-tail")),
    { name: "DockerEgressJournalConflictError" });
  const tombstone = storage.tombstones.get(dockerEgressJournalLocator(subject)); assert.ok(tombstone);
  assert.equal(decodeDockerEgressTombstone(tombstone.bytes).bindingSha256, subject.bindingSha256);
  assert.deepEqual(await journal.recoverCleanupDirectives(), [{
    kind: "cleanup_only", subject, sequence: intent.sequence, resource: "private_network",
    cleanupHandle: subject.resources.privateNetworkHandle, reconcileRequired: true,
  }]);
  const evidence = await journal.recoveryEvidence();
  assert.equal(evidence.some(item => item.bindingSha256 === subject.bindingSha256 && item.status === "quarantined"), true);
  await assert.rejects(journal.cleanupIntent(subject, intent.sequence, command("no-append-over-tail"), "private_network"),
    { name: "DockerEgressJournalCorruptionError" });
});

test("replay rejects a foreign observer even when observation and outer record chains are recomputed", async () => {
  const subject = makeSubject("forged-observer"); const storage = new MemoryEgressStorage();
  const journal = new DockerEgressJournal(storage, trustedFor(subject), observerAuthority);
  let sequence = (await journal.open(subject, command("forged-open"))).sequence;
  sequence = (await journal.materializeIntent(subject, sequence, command("forged-mi"), "private_network")).sequence;
  sequence = (await journal.materializeReceipt(subject, sequence, command("forged-mr"), "private_network")).sequence;
  const intent = await journal.cleanupIntent(subject, sequence, command("forged-ci"), "private_network");
  const foreign = createDockerEgressCleanupObservation({
    ...observation(subject), observerId: opaque("observer:", "foreign-but-well-formed"),
  });
  const forgedReceipt = createDockerEgressRecord({ sequence: intent.sequence + 1, subject,
    commandId: command("forged-receipt"), event: { kind: "cleanup_receipt", resource: "private_network", observation: foreign },
    previousChecksumSha256: intent.checksumSha256 });
  const forgedClose = createDockerEgressRecord({ sequence: forgedReceipt.sequence + 1, subject,
    commandId: command("forged-close"), event: { kind: "closed" }, previousChecksumSha256: forgedReceipt.checksumSha256 });
  const locator = dockerEgressJournalLocator(subject); const file = storage.v3Files.get(locator); assert.ok(file);
  file.bytes = Buffer.concat([
    ...replayDockerEgressBytes(file.bytes).records.map(record => encodeDockerEgressRecord(record)),
    encodeDockerEgressRecord(forgedReceipt), encodeDockerEgressRecord(forgedClose),
  ]);
  assert.equal(replayDockerEgressBytes(file.bytes).tail, "complete");

  const restarted = new DockerEgressJournal(storage, trustedFor(subject), observerAuthority);
  assert.deepEqual(await restarted.recoverCleanupDirectives(), [{
    kind: "cleanup_only", subject, sequence: intent.sequence, resource: "private_network",
    cleanupHandle: subject.resources.privateNetworkHandle, reconcileRequired: true,
  }]);
  const tombstone = storage.tombstones.get(locator); assert.ok(tombstone);
  const decoded = decodeDockerEgressTombstone(tombstone.bytes);
  assert.equal(decoded.disposition, "quarantined");
  assert.equal(decoded.terminalRecord?.checksumSha256, intent.checksumSha256);
  assert.equal(storage.v3Files.has(locator), true);
  await assert.rejects(restarted.close(subject, forgedClose.sequence, command("cannot-retire")),
    { name: "DockerEgressJournalCorruptionError" });
});

test("restart deterministically retires debt-free open and post-cleanup journals", async () => {
  for (const withCleanup of [false, true]) {
    const suffix = withCleanup ? "cleaned" : "open-only"; const subject = makeSubject(suffix);
    const storage = new MemoryEgressStorage(); const journal = new DockerEgressJournal(storage, trustedFor(subject), observerAuthority);
    let sequence = (await journal.open(subject, command(`open-${suffix}`))).sequence;
    if (withCleanup) {
      sequence = (await journal.materializeIntent(subject, sequence, command("materialize-intent"), "private_network")).sequence;
      sequence = (await journal.materializeReceipt(subject, sequence, command("materialize-receipt"), "private_network")).sequence;
      sequence = (await journal.cleanupIntent(subject, sequence, command("cleanup-intent"), "private_network")).sequence;
      sequence = (await journal.cleanupReceipt(subject, sequence, command("cleanup-receipt"), "private_network",
        observation(subject))).sequence;
    }
    assert.deepEqual(await new DockerEgressJournal(storage, trustedFor(subject), observerAuthority).recoverCleanupDirectives(), []);
    assert.equal(storage.v3Files.has(dockerEgressJournalLocator(subject)), false);
    assert.equal(storage.tombstones.has(dockerEgressJournalLocator(subject)), true);

    const fresh = makeSubject(`${suffix}-fresh`);
    const freshJournal = new DockerEgressJournal(storage, trustedFor(fresh), observerAuthority);
    assert.equal((await freshJournal.open(fresh, command(`fresh-${suffix}`))).event.kind, "open_intent");
  }
});

test("exact retired tombstone heals a failed live unlink on duplicate close and recovery", async () => {
  for (const retry of ["duplicate", "recovery"] as const) {
    const subject = makeSubject(`unlink-${retry}`); const storage = new MemoryEgressStorage();
    const journal = new DockerEgressJournal(storage, trustedFor(subject), observerAuthority);
    const opened = await journal.open(subject, command(`open-${retry}`));
    storage.failTombstoneAfterPublish = true;
    await assert.rejects(journal.close(subject, opened.sequence, command(`close-${retry}`)));
    const locator = dockerEgressJournalLocator(subject);
    assert.equal(storage.tombstones.has(locator), true); assert.equal(storage.v3Files.has(locator), true);
    if (retry === "duplicate") {
      assert.equal((await journal.close(subject, opened.sequence, command(`close-${retry}`))).event.kind, "closed");
    } else {
      assert.deepEqual(await journal.recoverCleanupDirectives(), []);
    }
    assert.equal(storage.v3Files.has(locator), false);
  }
});

test("retirement retry preserves a damaged tail even after a matching closed prefix", async () => {
  const subject = makeSubject("closed-damaged-tail"); const storage = new MemoryEgressStorage();
  const journal = new DockerEgressJournal(storage, trustedFor(subject), observerAuthority);
  const opened = await journal.open(subject, command("open-damaged-tail"));
  storage.failTombstoneAfterPublish = true;
  await assert.rejects(journal.close(subject, opened.sequence, command("close-damaged-tail")));
  const locator = dockerEgressJournalLocator(subject);
  const live = storage.v3Files.get(locator); assert.ok(live);
  live.bytes = Buffer.concat([live.bytes, Buffer.from("damaged-tail")]);
  const preserved = Buffer.from(live.bytes);
  await assert.rejects(journal.recoveryEvidence());
  assert.equal(storage.v3Files.has(locator), true);
  assert.deepEqual(storage.v3Files.get(locator)?.bytes, preserved);
});

test("retirement retry preserves a valid foreign live file that does not match its tombstone", async () => {
  const subject = makeSubject("mismatch"); const storage = new MemoryEgressStorage();
  const journal = new DockerEgressJournal(storage, trustedFor(subject), observerAuthority);
  const opened = await journal.open(subject, command("open-mismatch")); storage.failTombstoneAfterPublish = true;
  await assert.rejects(journal.close(subject, opened.sequence, command("close-mismatch")));
  const locator = dockerEgressJournalLocator(subject); const live = storage.v3Files.get(locator); assert.ok(live);

  const foreign = makeSubject("foreign"); const foreignStorage = new MemoryEgressStorage();
  const foreignJournal = new DockerEgressJournal(foreignStorage, trustedFor(foreign), observerAuthority);
  const foreignOpen = await foreignJournal.open(foreign, command("open-foreign")); foreignStorage.failTombstoneAfterPublish = true;
  await assert.rejects(foreignJournal.close(foreign, foreignOpen.sequence, command("close-foreign")));
  live.bytes = Buffer.from(foreignStorage.v3Files.get(dockerEgressJournalLocator(foreign))!.bytes);
  await assert.rejects(journal.recoveryEvidence());
  assert.equal(storage.v3Files.has(locator), true);
});
