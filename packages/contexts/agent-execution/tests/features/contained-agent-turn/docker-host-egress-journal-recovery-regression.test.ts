import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import {
  DockerEgressJournal,
  createDockerEgressCleanupObservation,
  createDockerEgressSubject,
  decodeDockerEgressTombstone,
  dockerEgressCleanupHandle,
  dockerEgressJournalLocator,
  replayDockerEgressBytes,
  type DockerEgressJournalSubject,
  type DockerEgressTrustedRuntimeIdentity,
} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/journal/index.js";
import { MemoryEgressStorage } from "../../fixtures/docker-journal-test-fixture.ts";

const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
const opaque = (prefix: string, value: string): string => `${prefix}${hash(value)}`;
const command = (value: string): string => opaque("command:", value);

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
  slotGenerationId: subject.identity.slotGenerationId, observerId: opaque("observer:", "absence-observer"),
  capabilityRevisionSha256: hash("observer-capability"), result: "absent",
});

test("validated prefix survives a corrupt tail only as quarantined cleanup evidence", async () => {
  const subject = makeSubject("prefix"); const storage = new MemoryEgressStorage();
  const journal = new DockerEgressJournal(storage, trustedFor(subject));
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

test("restart deterministically retires debt-free open and post-cleanup journals", async () => {
  for (const withCleanup of [false, true]) {
    const suffix = withCleanup ? "cleaned" : "open-only"; const subject = makeSubject(suffix);
    const storage = new MemoryEgressStorage(); const journal = new DockerEgressJournal(storage, trustedFor(subject));
    let sequence = (await journal.open(subject, command(`open-${suffix}`))).sequence;
    if (withCleanup) {
      sequence = (await journal.materializeIntent(subject, sequence, command("materialize-intent"), "private_network")).sequence;
      sequence = (await journal.materializeReceipt(subject, sequence, command("materialize-receipt"), "private_network")).sequence;
      sequence = (await journal.cleanupIntent(subject, sequence, command("cleanup-intent"), "private_network")).sequence;
      sequence = (await journal.cleanupReceipt(subject, sequence, command("cleanup-receipt"), "private_network",
        observation(subject))).sequence;
    }
    assert.deepEqual(await new DockerEgressJournal(storage, trustedFor(subject)).recoverCleanupDirectives(), []);
    assert.equal(storage.v3Files.has(dockerEgressJournalLocator(subject)), false);
    assert.equal(storage.tombstones.has(dockerEgressJournalLocator(subject)), true);

    const fresh = makeSubject(`${suffix}-fresh`); const freshJournal = new DockerEgressJournal(storage, trustedFor(fresh));
    assert.equal((await freshJournal.open(fresh, command(`fresh-${suffix}`))).event.kind, "open_intent");
  }
});

test("exact retired tombstone heals a failed live unlink on duplicate close and recovery", async () => {
  for (const retry of ["duplicate", "recovery"] as const) {
    const subject = makeSubject(`unlink-${retry}`); const storage = new MemoryEgressStorage();
    const journal = new DockerEgressJournal(storage, trustedFor(subject));
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
  const journal = new DockerEgressJournal(storage, trustedFor(subject));
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
  const journal = new DockerEgressJournal(storage, trustedFor(subject));
  const opened = await journal.open(subject, command("open-mismatch")); storage.failTombstoneAfterPublish = true;
  await assert.rejects(journal.close(subject, opened.sequence, command("close-mismatch")));
  const locator = dockerEgressJournalLocator(subject); const live = storage.v3Files.get(locator); assert.ok(live);

  const foreign = makeSubject("foreign"); const foreignStorage = new MemoryEgressStorage();
  const foreignJournal = new DockerEgressJournal(foreignStorage, trustedFor(foreign));
  const foreignOpen = await foreignJournal.open(foreign, command("open-foreign")); foreignStorage.failTombstoneAfterPublish = true;
  await assert.rejects(foreignJournal.close(foreign, foreignOpen.sequence, command("close-foreign")));
  live.bytes = Buffer.from(foreignStorage.v3Files.get(dockerEgressJournalLocator(foreign))!.bytes);
  await assert.rejects(journal.recoveryEvidence());
  assert.equal(storage.v3Files.has(locator), true);
});
