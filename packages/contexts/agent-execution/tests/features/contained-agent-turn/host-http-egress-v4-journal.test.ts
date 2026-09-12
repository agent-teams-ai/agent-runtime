import assert from "node:assert/strict";
import { test } from "node:test";
import { v4Decode, v4DecodeTombstone, v4Encode, v4Hash, v4Observation, v4Record, v4Subject } from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/journal/host-http-egress-v4-codec.js";
import { validateAuthorityShape } from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/engine/docker-engine-codec.js";
import type { HostHttpEgressV4Observed } from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/journal/host-http-egress-v4-types.js";
import { HostHttpEgressV4Journal } from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/journal/host-http-egress-v4-journal.js";
import { v4Replay } from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/journal/host-http-egress-v4-replay.js";
import { HOST_HTTP_EGRESS_V4_LIMITS as LIMITS } from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/journal/host-http-egress-v4-types.js";
import { container, id, MemoryV4Storage, subject, SyntheticV4Owner, V4Fixture } from "../../fixtures/host-http-egress-v4-fixture.ts";

test("V4 constructor is inert; two sequential exchanges have no pipelined admission or execution authority", async () => {
  const f = new V4Fixture(); assert.equal(f.storage.calls, 0); assert.equal(f.owner.reads, 0);
  await f.setup(); await f.intent("inbound_intent");
  await assert.rejects(f.intent("inbound_intent"), { code: "conflict" });
  await assert.rejects(f.intent("upstream_intent"), { code: "conflict" });
  await f.observe("inbound_allocated"); await f.intent("upstream_intent"); await f.observe("upstream_allocated");
  await assert.rejects(f.intent("inbound_intent"), { code: "conflict" });
  await f.intent("sockets_close"); await assert.rejects(f.intent("inbound_intent"), { code: "conflict" });
  await f.observe("sockets_closed"); await f.exchange(); await f.settle();
  assert.equal(f.state().exchanges, 2); assert.equal(f.journal.evidence().resourceLedger, "retired");
  assert.equal(f.journal.evidence().reconcileRequired, false);
  const events = v4Decode(f.storage.journal!).map(record => record.event.kind);
  assert.deepEqual(events.slice(0, 8), ["opened", "network_intent", "network_allocated", "listener_intent", "listener_allocated", "container_attached", "route_intent", "route_installed"]);
  assert.equal(events.filter(kind => kind === "inbound_intent").length, 2);
  assert.deepEqual(events.slice(-8), ["cutoff", "cutoff_observed", "container_absent", "listener_release", "listener_absent", "network_release", "network_absent", "retired"]);
  assert.equal(v4DecodeTombstone(f.storage.marker!).disposition, "retired");
  assert.ok(!JSON.stringify(f.journal.evidence()).includes(container.containerId));
  assert.ok(!("operationStatus" in f.journal.evidence()));
});

test("exact order, immutable command duplicate, changed digest conflict and no effect retry", async () => {
  const f = new V4Fixture(); await f.open();
  await assert.rejects(f.intent("listener_intent"), { code: "conflict" });
  await assert.rejects(f.observe("network_allocated"), { code: "conflict" });
  const command = f.command(); const intent = { kind: "network_intent" as const, targetSha256: f.journal.target("network_intent") };
  const first = await f.journal.recordIntent(command, intent); const count = f.storage.calls;
  assert.deepEqual(await f.journal.recordIntent(command, intent), { ...first, kind: "duplicate" });
  assert.equal(f.storage.calls, count);
  await assert.rejects(f.journal.recordIntent(command, { ...intent, targetSha256: v4Hash("changed") }), { code: "conflict" });
  await f.observe("network_allocated");
  assert.equal((await f.journal.recordIntent(command, intent)).kind, "duplicate");
  const encoded = v4Decode(f.storage.journal!);
  assert.equal(v4Replay(encoded, subject).network.phase, 2);
  const replayed = new V4Fixture(f.storage); assert.equal((await replayed.open()).kind, "cleanup_only");
  assert.equal((await replayed.journal.recordIntent(command, intent)).kind, "duplicate");
  await assert.rejects(replayed.intent("listener_intent"), { code: "conflict" });
  await replayed.settle();
});

test("forged observations, another owner's capability, wrong scope/target and exact Docker replacement are rejected", async () => {
  const f = new V4Fixture(); await f.setup();
  await assert.rejects(f.journal.recordObservation(f.command(), f.data("container_absent")), { code: "conflict" });
  const stranger = new SyntheticV4Owner();
  await assert.rejects(f.journal.recordObservation(f.command(), stranger.token(f.data("container_absent"))), { code: "conflict" });
  await assert.rejects(f.intent("listener_release"), { code: "conflict" });
  await assert.rejects(f.observe("container_absent"), { code: "conflict" });
  await f.intent("cutoff"); await assert.rejects(f.observe("container_absent"), { code: "conflict" });
  await f.observe("cutoff_observed");
  for (const field of ["subjectSha256", "observerSha256", "targetSha256"] as const) {
    await assert.rejects(f.observe("container_absent", { [field]: v4Hash("foreign") }), { code: "conflict" });
  }
  for (const field of Object.keys(container) as (keyof typeof container)[]) {
    const value = field === "imageDigest" ? `registry.invalid:5443/runtime@sha256:${v4Hash("foreign")}` : v4Hash("foreign");
    await assert.rejects(f.observe("container_absent", { container: { ...container, [field]: value } }), { code: "conflict" });
  }
  await assert.rejects(f.observe("container_absent", { container: null }), { code: "conflict" });
  await f.settle();
});

test("every setup/active-exchange/cleanup prefix is cleanup-only on restart, retains exact handles and retires with debt", async () => {
  const baseline = new V4Fixture(); await baseline.setup(); await baseline.exchange(); await baseline.exchange(); await baseline.settle();
  const records = v4Decode(baseline.storage.journal!);
  for (let length = 1; length <= records.length; length += 1) {
    const storage = new MemoryV4Storage(); storage.journal = Buffer.concat(records.slice(0, length).map(record => v4Encode(record)));
    const f = new V4Fixture(storage); assert.equal((await f.open()).kind, "cleanup_only", `prefix ${length}`);
    assert.equal(f.journal.evidence().admission, "closed");
    await assert.rejects(f.intent("inbound_intent"));
    const cleanup = await f.journal.cleanupHandles(); assert.equal(cleanup.kind, "cleanup_only");
    assert.deepEqual(cleanup.handles.custodyAttempt, subject.attempt);
    if (cleanup.handles.network !== null) { assert.equal(cleanup.handles.network.handle, subject.networkHandle); }
    await f.settle(); assert.equal(f.journal.evidence().resourceLedger, "retired");
    assert.equal(f.journal.evidence().reconcileRequired, true);
    const again = new V4Fixture(storage); await again.open();
    assert.equal(again.journal.evidence().resourceLedger, "retired"); assert.equal(again.journal.evidence().reconcileRequired, true);
  }
});

test("failed partial setup at every live intent/receipt prefix settles without fabricating allocation receipts", async () => {
  const baseline = new V4Fixture(); await baseline.setup();
  const records = v4Decode(baseline.storage.journal!);
  for (let length = 1; length <= records.length; length += 1) {
    const f = new V4Fixture(); await f.open();
    for (const record of records.slice(1, length)) {
      if ("observation" in record.event) { await f.observe(record.event.kind); }
      else if (record.event.kind !== "opened") { await f.intent(record.event.kind); }
    }
    await f.settle(); const state = f.state();
    assert.equal(state.retired, true);
    const wasPending = v4Replay(records.slice(0, length), subject);
    assert.equal(f.journal.evidence().reconcileRequired, [wasPending.network, wasPending.listener, wasPending.route].some(r => r.phase === 1));
  }
});

for (const fault of ["before", "after", "short"] as const) {
  test(`append ${fault} failure is absorbing unknown; valid complete prefixes reconcile only`, async () => {
    const f = new V4Fixture(); await f.open(); f.storage.fault = fault;
    await assert.rejects(f.intent("network_intent"), { code: "quarantined" });
    const calls = f.storage.calls; await assert.rejects(f.intent("network_intent")); assert.equal(f.storage.calls, calls);
    assert.equal(f.journal.evidence().reconcileRequired, true);
    const restarted = new V4Fixture(f.storage);
    if (fault === "short") { await assert.rejects(restarted.open(), { code: "quarantined" }); }
    else { await restarted.open(); await restarted.settle(); assert.equal(restarted.journal.evidence().reconcileRequired, true); }
  });
}

test("initial append and final tombstone lost acknowledgements cannot reopen materialization", async () => {
  const f = new V4Fixture(); f.storage.fault = "after"; await assert.rejects(f.open());
  const recovered = new V4Fixture(f.storage); await recovered.open(); await recovered.settle();
  const complete = new V4Fixture(); await complete.setup(); complete.storage.fault = "tombstone";
  await assert.rejects(complete.settle(), { code: "quarantined" });
  const after = new V4Fixture(complete.storage); await after.open();
  assert.equal(after.journal.evidence().resourceLedger, "retired"); await assert.rejects(after.intent("network_intent"));
});

test("record AND byte capacity are reserved before allocation, with enough completion/cleanup headroom", async () => {
  for (const capacity of [{ maxRecords: 38, maxBytes: LIMITS.maxBytes }, { maxRecords: LIMITS.maxRecords, maxBytes: 26 * LIMITS.maxRecordBytes }]) {
    const f = new V4Fixture(new MemoryV4Storage(), capacity); await f.setup();
    let completed = 0;
    for (;;) {
      const before = f.storage.journal!.length;
      try { await f.intent("inbound_intent"); }
      catch (error) {
        assert.equal((error as { code: string }).code, "capacity"); assert.equal(f.storage.journal!.length, before); break;
      }
      await f.observe("inbound_allocated"); await f.intent("upstream_intent"); await f.observe("upstream_allocated");
      await f.intent("sockets_close"); await f.observe("sockets_closed"); completed += 1;
      assert.ok(completed < 256);
    }
    await f.settle(); assert.equal(f.state().retired, true); assert.ok(completed >= 1);
  }
  const tiny = new V4Fixture(new MemoryV4Storage(), { maxRecords: 24, maxBytes: LIMITS.maxBytes });
  await assert.rejects(tiny.open(), { code: "capacity" }); assert.equal(tiny.storage.journal, null);
});

test("exactly 256 exchanges fit the fixed bounded mirror; 257th and actual socket identity reuse fail", async () => {
  const f = new V4Fixture(); await f.setup();
  for (let exchange = 0; exchange < 256; exchange += 1) { await f.exchange(); }
  await assert.rejects(f.intent("inbound_intent"), { code: "conflict" }); await f.settle();
  assert.equal(f.state().exchanges, 256); assert.ok(v4Decode(f.storage.journal!).length < LIMITS.maxRecords);
  const g = new V4Fixture(); await g.setup(); await g.intent("inbound_intent");
  const actualSha256 = v4Hash("same-socket"); await g.observe("inbound_allocated", { actualSha256 });
  await g.intent("sockets_close"); await g.observe("sockets_closed"); await g.intent("inbound_intent");
  await assert.rejects(g.observe("inbound_allocated", { actualSha256 }), { code: "conflict" });
});

test("cutoff precedes active/pending closure; uncertain socket writes survive physical cleanup", async () => {
  for (const stage of ["before", "pending", "active", "after"] as const) {
    const f = new V4Fixture(); await f.setup();
    if (stage === "after") { await f.exchange(); }
    if (stage === "pending" || stage === "active") { await f.intent("inbound_intent"); }
    if (stage === "active") { await f.observe("inbound_allocated"); await f.intent("upstream_intent"); await f.observe("upstream_allocated"); }
    await f.intent("cutoff"); await assert.rejects(f.intent("inbound_intent")); await f.observe("cutoff_observed");
    if (stage === "pending" || stage === "active") {
      await assert.rejects(f.observe("container_absent"), { code: "conflict" });
      await f.intent("sockets_close"); await f.observe("sockets_closed", { writeOutcome: "unknown" });
    }
    await f.settle(); assert.equal(f.journal.evidence().reconcileRequired, stage === "pending" || stage === "active");
  }
});

test("bounded malicious records, duplicates, rehashed out-of-order events and subject accessors are rejected", async () => {
  const f = new V4Fixture(); await f.setup(); const records = v4Decode(f.storage.journal!);
  const badBytes = [Buffer.alloc(LIMITS.maxBytes + 1), Buffer.from("x".repeat(LIMITS.maxRecordBytes + 1) + "\n"),
    Buffer.from('{"version":4,"version":4}\n'), Buffer.from("[".repeat(40) + "0" + "]".repeat(40) + "\n"),
    f.storage.journal!.slice(0, -1), Buffer.from("\xff\n", "latin1")];
  for (const bytes of badBytes) { assert.throws(() => v4Decode(bytes)); }
  for (let i = 0; i < records.length; i += 1) {
    const mutated = Buffer.from(f.storage.journal!); const offset = Math.floor(mutated.length * i / records.length);
    mutated[offset] = mutated[offset]! ^ 1;
    assert.throws(() => v4Decode(mutated));
  }
  const duplicate = v4Record({ ...records[1]!, sequence: 2, previousSha256: records[1]!.checksumSha256 });
  assert.throws(() => v4Replay([records[0]!, records[1]!, duplicate], subject));
  const outOfOrder = v4Record({ ...records[6]!, sequence: 1, previousSha256: records[0]!.checksumSha256 });
  assert.throws(() => v4Replay([records[0]!, outOfOrder], subject));
  let touched = 0;
  const accessor = { ...subject }; Object.defineProperty(accessor, "scopeSha256", { get: () => { touched += 1; return v4Hash("bad"); } });
  assert.throws(() => v4Subject(accessor)); assert.equal(touched, 0);
  assert.throws(() => v4Subject(new Proxy(subject, { getPrototypeOf: () => { touched += 1; return Object.prototype; } })));
  assert.equal(touched, 0);
  for (const networkHandle of ["/tmp/secret", "https://endpoint", "token=synthetic", subject.listenerHandle]) {
    assert.throws(() => v4Subject({ ...subject, networkHandle }));
  }
});

test("stale scope, boot, daemon, execution and custody generations yield no cleanup capability", async () => {
  const f = new V4Fixture(); await f.setup();
  const subjects = [ { ...subject, executionGenerationId: `execution-generation:${v4Hash("next")}` },
    { ...subject, scopeSha256: v4Hash("next") }, { ...subject, committedClaimSha256: v4Hash("next") },
    ...["daemonBootGenerationSha256", "daemonIdentitySha256", "hostBootGenerationSha256"].map(key => ({ ...subject, attempt: { ...subject.attempt, [key]: v4Hash("next") } })),
    { ...subject, attempt: { ...subject.attempt, hostBootId: `host-boot:${v4Hash("next")}`, custodyId: id("custody") } } ];
  for (const changed of subjects) {
    const storage = new MemoryV4Storage(); storage.journal = f.storage.journal!.slice();
    const journal = new HostHttpEgressV4Journal(storage, changed, new SyntheticV4Owner());
    await assert.rejects(journal.prepare(id("command")), { code: "quarantined" });
    await assert.rejects(journal.cleanupHandles(), { code: "quarantined" });
  }
});

test("same-instance overlap has zero queue and ownership loss quarantines before further append", async () => {
  const f = new V4Fixture(); await f.open();
  const gate = Promise.withResolvers<void>(); const original = f.storage.append.bind(f.storage);
  f.storage.append = async (expected, bytes) => { await gate.promise; await original(expected, bytes); };
  const pending = f.intent("network_intent");
  await assert.rejects(f.journal.recordIntent(f.command(), { kind: "cutoff", targetSha256: v4Hash(null) }), { code: "busy" });
  gate.resolve(); await pending; f.storage.owned = false;
  const calls = f.storage.calls; await assert.rejects(f.observe("network_allocated"), { code: "quarantined" });
  assert.equal(f.storage.calls, calls);
});

for (const fault of ["before", "after"] as const) {
  test(`every setup intent/receipt ${fault}-append failure preserves reconciliation through cleanup`, async () => {
    const baseline = new V4Fixture(); await baseline.setup(); const events = v4Decode(baseline.storage.journal!).slice(1).map(record => record.event);
    for (let failed = 0; failed < events.length; failed += 1) {
      const f = new V4Fixture(); await f.open();
      for (const [index, event] of events.entries()) {
        if (index === failed) { f.storage.fault = fault; }
        const result = "observation" in event ? f.observe(event.kind) : f.intent(event.kind as "network_intent");
        if (index === failed) { await assert.rejects(result, { code: "quarantined" }); break; }
        await result;
      }
      const recovered = new V4Fixture(f.storage); await recovered.open(); await recovered.settle();
      assert.equal(recovered.journal.evidence().resourceLedger, "retired");
      assert.equal(recovered.journal.evidence().reconcileRequired, true);
    }
  });
}

test("observation duplicates replay without new writes, uncertainty seals later exchanges, cleanup handles are detached", async () => {
  const f = new V4Fixture(); await f.open(); await f.intent("network_intent");
  const token = f.owner.token(f.data("network_allocated")); const command = f.command();
  const first = await f.journal.recordObservation(command, token);
  const count = f.storage.calls; assert.deepEqual(await f.journal.recordObservation(command, token), { ...first, kind: "duplicate" });
  assert.equal(f.storage.calls, count);
  await assert.rejects(f.journal.recordObservation(command, f.owner.token(f.data("network_allocated"))), { code: "conflict" });
  const g = new V4Fixture(); await g.setup(); const cleanup = await g.journal.cleanupHandles();
  assert.throws(() => { Object.assign(cleanup.handles.container!, { containerId: v4Hash("forged") }); });
  assert.equal(g.state().container?.containerId, container.containerId);
  await g.intent("inbound_intent"); await g.observe("inbound_allocated");
  await g.intent("upstream_intent"); await g.observe("upstream_allocated"); await g.intent("sockets_close");
  await g.observe("sockets_closed", { writeOutcome: "unknown" });
  await assert.rejects(g.intent("inbound_intent"), { code: "conflict" });
  await g.settle(); assert.equal(g.journal.evidence().reconcileRequired, true);
});

test("tombstone corruption, wrong tail and premature retirement cannot authorize cleanup or reuse", async () => {
  const baseline = new V4Fixture(); await baseline.setup(); await baseline.settle();
  for (const kind of ["partial", "wrong-tail", "wrong-subject", "missing-journal"] as const) {
    const storage = new MemoryV4Storage(); storage.journal = baseline.storage.journal!.slice(); storage.marker = baseline.storage.marker!.slice();
    if (kind === "partial") { storage.marker = storage.marker.slice(0, -1); }
    else if (kind === "missing-journal") { storage.journal = null; }
    else {
      const { checksumSha256: _checksum, ...body } = v4DecodeTombstone(storage.marker);
      const changed = { ...body, [kind === "wrong-tail" ? "tailSha256" : "subjectSha256"]: v4Hash("forged") };
      storage.marker = Buffer.from(JSON.stringify({ ...changed, checksumSha256: v4Hash(changed) }) + "\n");
    }
    const f = new V4Fixture(storage); await assert.rejects(f.open()); await assert.rejects(f.journal.cleanupHandles());
  }
  const fresh = new V4Fixture(); await fresh.open(); await assert.rejects(fresh.intent("retired"), { code: "conflict" });
});

// Deliberately cross the TypeScript boundary as a JavaScript caller would.
const runtimeIntent = (f: V4Fixture, command: string, value: unknown) =>
  f.journal.recordIntent(command, value as Parameters<HostHttpEgressV4Journal["recordIntent"]>[1]);
const nonIntentKinds = ["opened", "network_allocated", "listener_allocated", "container_attached", "route_installed",
  "inbound_allocated", "upstream_allocated", "sockets_closed", "cutoff_observed", "container_absent",
  "listener_absent", "network_absent"] as const satisfies readonly ("opened" | HostHttpEgressV4Observed)[];

for (const kind of nonIntentKinds) {
  test(`runtime intent boundary rejects ${kind} at its otherwise admissible recipe position`, async () => {
    const baseline = new V4Fixture(); await baseline.setup(); await baseline.exchange(); await baseline.settle();
    const f = new V4Fixture(); await f.open();
    for (const record of v4Decode(baseline.storage.journal!)) {
      const event = record.event;
      if (event.kind === kind) { break; }
      if ("observation" in event) { await f.observe(event.kind); }
      else if (event.kind !== "opened") { await f.intent(event.kind); }
    }
    const event = kind === "opened" ? { kind, subject } : { kind, observation: f.data(kind) };
    const before = f.storage.journal!.slice(); const evidence = f.journal.evidence();
    const calls = f.storage.calls; const reads = f.owner.reads; const command = f.command();
    await assert.rejects(runtimeIntent(f, command, event), { code: "conflict" });
    // Neither the ordinary observation shape nor the two-field intent shape may pass.
    await assert.rejects(runtimeIntent(f, command, { kind, targetSha256: v4Hash(null) }), { code: "conflict" });
    assert.deepEqual(f.storage.journal, before); assert.equal(f.storage.marker, null);
    assert.deepEqual(f.journal.evidence(), evidence); assert.equal(f.storage.calls, calls); assert.equal(f.owner.reads, reads);
    if ("observation" in event) {
      assert.equal((await f.journal.recordObservation(command, f.owner.token(event.observation))).kind, "recorded");
      assert.equal(f.owner.reads, reads + 1);
    }
  });
}

test("runtime intent boundary rejects malformed data without accessors, proxy traps or persistence", async () => {
  const f = new V4Fixture(); await f.open(); const valid = { kind: "network_intent", targetSha256: f.journal.target("network_intent") };
  let touched = 0;
  const getter = () => { touched += 1; return valid.kind; };
  const accessor = Object.defineProperty({ ...valid }, "kind", { get: getter });
  const targetAccessor = Object.defineProperty({ ...valid }, "targetSha256", { get: getter });
  const hidden = Object.defineProperty({ ...valid }, "kind", { enumerable: false });
  const proxy = new Proxy(valid, { get: getter, ownKeys: () => { touched += 1; return []; },
    getPrototypeOf: () => { touched += 1; return Object.prototype; } });
  const malformed: unknown[] = [null, undefined, true, 7, "network_intent", [], new Date(0), {},
    { kind: "network_intent" }, { targetSha256: valid.targetSha256 }, { ...valid, extra: true },
    { ...valid, [Symbol("extra")]: true }, { ...valid, kind: "unknown" }, { ...valid, kind: null },
    { ...valid, kind: 1 }, { ...valid, targetSha256: null }, { ...valid, targetSha256: 1 },
    { ...valid, targetSha256: "a".repeat(63) }, { ...valid, targetSha256: "A".repeat(64) },
    { ...valid, targetSha256: `sha256:${valid.targetSha256}` }, { ...valid, observation: {} },
    { kind: "network_intent", observation: {} }, Object.create(valid), Object.assign(Object.create(null), valid),
    accessor, targetAccessor, hidden, proxy];
  const before = f.storage.journal!.slice(); const evidence = f.journal.evidence(); const calls = f.storage.calls;
  for (const input of malformed) { await assert.rejects(runtimeIntent(f, f.command(), input), { code: "conflict" }); }
  assert.equal(touched, 0); assert.equal(f.owner.reads, 0); assert.equal(f.storage.calls, calls);
  assert.deepEqual(f.storage.journal, before); assert.equal(f.storage.marker, null); assert.deepEqual(f.journal.evidence(), evidence);
  assert.equal((await f.intent("network_intent")).kind, "recorded");
});

test("runtime intent is snapshotted before awaited ownership checks; concurrent calls cannot swap in an observation", async () => {
  const f = new V4Fixture(); await f.open(); await f.intent("network_intent");
  const input: Record<string, unknown> = { kind: "cutoff", targetSha256: f.journal.target("cutoff") };
  const observation = f.data("network_allocated");
  const command = f.command(); const before = f.storage.journal!.slice();
  const entered = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
  const original = f.storage.assertOwned.bind(f.storage);
  f.storage.assertOwned = async () => { entered.resolve(); await release.promise; await original(); };
  const pending = runtimeIntent(f, command, input); await entered.promise;
  try {
    delete input.targetSha256; input.kind = "network_allocated"; input.observation = observation;
    await assert.rejects(runtimeIntent(f, f.command(), input), { code: "busy" });
    assert.deepEqual(f.storage.journal, before);
  } finally { release.resolve(); }
  assert.equal((await pending).kind, "recorded");
  assert.equal(v4Decode(f.storage.journal!).at(-1)!.event.kind, "cutoff");
  assert.equal(f.owner.reads, 0); assert.equal(f.state().network.phase, 1);
  assert.equal(f.journal.evidence().admission, "closed"); assert.equal(f.journal.evidence().reconcileRequired, true);
  await f.journal.close(); const recovered = new V4Fixture(f.storage); await recovered.open(); await recovered.settle();
  assert.equal(recovered.journal.evidence().resourceLedger, "retired"); assert.equal(recovered.journal.evidence().reconcileRequired, true);
});

const imageSha256 = "a".repeat(64);
const imageCases: readonly (readonly [unknown, boolean])[] = [
  [`runtime@sha256:${imageSha256}`, true], [`registry.invalid:5443/team/runtime@sha256:${imageSha256}`, true],
  [`registry.invalid:00001/team-a/runtime_b.v1:Release_1.2-3@sha256:${imageSha256}`, true],
  [`runtime:tag@sha256:${imageSha256}`, true], [`runtime:123456@sha256:${imageSha256}`, true],
  [`sha256:${imageSha256}`, true], [`@sha256:${imageSha256}`, false], ["runtime:latest", false],
  [`https://registry.invalid/runtime@sha256:${imageSha256}`, false],
  [`user@registry.invalid/runtime@sha256:${imageSha256}`, false],
  [`Registry.invalid/runtime@sha256:${imageSha256}`, false], [`registry.invalid/Runtime@sha256:${imageSha256}`, false],
  [`registry.invalid:123456/runtime@sha256:${imageSha256}`, false],
  [`registry.invalid//runtime@sha256:${imageSha256}`, false], [`runtime__name@sha256:${imageSha256}`, false],
  [`runtime@SHA256:${imageSha256}`, false], [`runtime@sha256:${imageSha256.toUpperCase()}`, false],
  [`runtime@sha256:${imageSha256.slice(1)}`, false], [`runtime@sha256:${imageSha256}a`, false],
  [`runtime@sha512:${imageSha256}`, false], [` runtime@sha256:${imageSha256}`, false],
  [`runtime@sha256:${imageSha256}\n`, false], [`runtime@sha256:${imageSha256}?tag=x`, false],
  [`sha256:${imageSha256.slice(1)}`, false], [`sha256:${imageSha256}a`, false],
  [`sha256:${imageSha256.toUpperCase()}`, false], [`sha256:${imageSha256}\n`, false],
  [`runtime@sha256:${imageSha256}#fragment`, false], [null, false], [undefined, false], [1, false], [{}, false],
];
for (const [index, [imageDigest, valid]] of imageCases.entries()) {
  test(`V4 image case ${index} matches existing engine authority validation without rewriting`, () => {
    const authority = { ...container, imageDigest: imageDigest as string };
    const candidate = { ...subject, imageDigest };
    const observation = { kind: "container_attached", subjectSha256: v4Hash(candidate), observerSha256: subject.observerSha256,
      targetSha256: v4Hash(null), actualSha256: v4Hash("container"), evidenceSha256: v4Hash("evidence"), container: authority, writeOutcome: null };
    if (valid) {
      assert.deepEqual(validateAuthorityShape(authority), authority);
      assert.equal(v4Subject(candidate).imageDigest, imageDigest);
      assert.deepEqual(v4Observation(observation).container, authority);
      const record = v4Record({ sequence: 0, subjectSha256: v4Hash(candidate), commandId: id("command"),
        event: { kind: "opened", subject: v4Subject(candidate) }, previousSha256: null });
      assert.deepEqual(v4Decode(v4Encode(record))[0], record);
    } else {
      assert.throws(() => validateAuthorityShape(authority), { code: "invalid-authority" });
      assert.throws(() => v4Subject(candidate)); assert.throws(() => v4Observation(observation));
    }
  });
}

test("exact engine image authority survives attachment, cleanup handles and cleanup-only restart", async () => {
  assert.deepEqual(validateAuthorityShape(container), container);
  const f = new V4Fixture(); await f.setup();
  const attached = v4Decode(f.storage.journal!).find(record => record.event.kind === "container_attached")!;
  assert.ok("observation" in attached.event); assert.deepEqual(attached.event.observation.container, container);
  assert.deepEqual((await f.journal.cleanupHandles()).handles.container, container);
  await f.intent("cutoff"); await f.observe("cutoff_observed");
  for (const imageDigest of [container.imageDigest.replace("/runtime@", "/other@"),
    container.imageDigest.replace(":5443/", ":5444/"), container.imageDigest.replace("@", ":tag@")]) {
    const relabeled = { ...container, imageDigest }; assert.deepEqual(validateAuthorityShape(relabeled), relabeled);
    const before = f.storage.journal!.slice();
    await assert.rejects(f.observe("container_absent", { container: relabeled }), { code: "conflict" });
    assert.deepEqual(f.storage.journal, before);
  }
  await f.journal.close(); const recovered = new V4Fixture(f.storage); assert.equal((await recovered.open()).kind, "cleanup_only");
  assert.deepEqual((await recovered.journal.cleanupHandles()).handles.container, container);
  await assert.rejects(recovered.intent("inbound_intent"), { code: "conflict" }); await recovered.settle();
  assert.equal(recovered.journal.evidence().reconcileRequired, true);
});
