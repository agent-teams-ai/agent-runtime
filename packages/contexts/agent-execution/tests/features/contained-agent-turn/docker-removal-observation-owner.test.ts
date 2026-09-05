import assert from "node:assert/strict";
import {rm} from "node:fs/promises";
import {test, type TestContext} from "node:test";
import {createDockerHostCustodyLifecycle} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/docker-host-custody-lifecycle.js";
import {FakeDockerEngine} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/engine/index.js";
import type {DockerContainerObservation} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/engine/docker-engine-port.js";
import {MemoryStorage, disposable, policy, createInput, engineCall, owner, digest} from "./support/docker-host-custody-lifecycle-fixture.ts";
import {installSyntheticInit} from "./support/docker-claim-init-fixture.ts";

const fixture = async (t: TestContext, heldCleanup?: Promise<void>) => {
  const root = await disposable(); t.after(() => rm(root, {recursive: true, force: true}));
  const engine = new FakeDockerEngine(policy(root)); const storage = new MemoryStorage();
  installSyntheticInit(engine, []);
  if (heldCleanup !== undefined) {
    const attach = engine.attachCustody.bind(engine);
    engine.attachCustody = async (...args) => {
      const channel = await attach(...args);
      return {...channel, async close() {await heldCleanup; await channel.close();}};
    };
  }
  const inspect = engine.inspect.bind(engine);
  const inspections: string[] = [];
  let change: ((observation: DockerContainerObservation) => Promise<DockerContainerObservation>) | undefined;
  engine.inspect = async (...args) => {
    inspections.push(args[0].containerId);
    const observed = await inspect(...args); return change === undefined ? observed : change(observed);
  };
  const lifecycle = createDockerHostCustodyLifecycle({engine, journalStorage: storage,
    residue: {async proveEmpty() {return "empty";}}});
  assert.deepEqual(engine.events, [], "owner construction is effect-free");
  const launched = await lifecycle.launch({call: engineCall(), create: createInput(root), owner});
  const input = () => ({...launched, call: engineCall()});
  return {engine, storage, lifecycle, launched, input, inspections,
    changeObservation(next: NonNullable<typeof change>) {change = next;},
    close: () => lifecycle.contain(input()),
  };
};

test("only the retaining lifecycle can resolve its exact post-containment absence token", async t => {
  const f = await fixture(t); const g = await fixture(t);
  const token = await f.lifecycle.removalObservation.containAndObserve(f.input()); assert.ok(token);
  const observation = f.lifecycle.removalObservation.readObservation(token); assert.ok(observation);
  assert.deepEqual(observation.authority, f.launched.authority);
  assert.deepEqual(observation.attemptKey, f.launched.key);
  assert.match(observation.journalChecksumSha256, /^[a-f0-9]{64}$/);
  assert.equal((await f.engine.inspect(f.launched.authority, engineCall())).existence, "absent");
  assert.equal(f.inspections.at(-1), f.launched.authority.containerId);
  assert.equal(f.lifecycle.removalObservation.readObservation({...token}), undefined);
  assert.equal(f.lifecycle.removalObservation.readObservation({removed: true}), undefined);
  assert.equal(g.lifecycle.removalObservation.readObservation(token), undefined);
  assert.equal(JSON.stringify(token), "{}");
  for (const value of [token, observation, observation.authority, observation.attemptKey]) {assert.ok(Object.isFrozen(value));}
  assert.notEqual(observation.authority, f.launched.authority);
  await g.close();
});

test("a closed journal is followed by fresh Engine absence inspection on every observation", async t => {
  const f = await fixture(t); assert.equal((await f.close()).kind, "closed");
  const before = f.inspections.length;
  assert.ok(await f.lifecycle.removalObservation.containAndObserve(f.input()));
  assert.deepEqual(f.inspections.slice(before), [f.launched.authority.containerId]);
  f.changeObservation(async () => {throw new Error("synthetic Engine unavailable");});
  assert.equal(await f.lifecycle.removalObservation.containAndObserve(f.input()), undefined);
});

test("present, foreign container and foreign daemon/host observations confer no removal proof", async t => {
  for (const kind of ["present", "container", "image", "daemon", "boot", "host", "host-boot"]) {
    const f = await fixture(t); const present = await f.engine.inspect(f.launched.authority, engineCall());
    await f.close();
    f.changeObservation(async absent => {
      if (kind === "present") {return present;}
      if (kind === "container") {return {...absent, authority: {...absent.authority, containerId: "f".repeat(64)}};}
      if (kind === "image") {return {...absent, authority: {...absent.authority, imageDigest: `wrong@sha256:${digest("image")}`}};}
      const field = kind === "daemon" ? "daemonIdentitySha256" : kind === "boot" ? "daemonBootGenerationSha256"
        : kind === "host" ? "hostIdentitySha256" : "hostBootGenerationSha256";
      return {...absent, engine: {...absent.engine, [field]: digest("foreign")}};
    });
    assert.equal(await f.lifecycle.removalObservation.containAndObserve(f.input()), undefined, kind);
  }
});

test("a different authority cannot borrow an owned closed journal or trigger inspection", async t => {
  const f = await fixture(t); await f.close(); const before = f.engine.events.length;
  assert.equal(await f.lifecycle.removalObservation.containAndObserve({...f.input(),
    authority: {...f.launched.authority, containerId: "a".repeat(64)}}), undefined);
  assert.equal(await f.lifecycle.removalObservation.containAndObserve({...f.input(),
    key: {...f.launched.key, operationId: "foreign-operation"}}), undefined);
  assert.equal(f.engine.events.length, before);
});

test("journal loss cannot be promoted from best-effort physical containment into a release token", async t => {
  const f = await fixture(t); f.storage.files.clear();
  assert.equal(await f.lifecycle.removalObservation.containAndObserve(f.input()), undefined);
  assert.equal((await f.engine.inspect(f.launched.authority, engineCall())).existence, "absent");
});

test("unknown removal acknowledgement without effect remains unproved until a fresh successful containment", async t => {
  const f = await fixture(t);
  f.engine.enqueueMutationOutcome("remove", {acknowledgement: "lost", effect: "not-applied"});
  assert.equal(await f.lifecycle.removalObservation.containAndObserve(f.input()), undefined);
  assert.ok(await f.lifecycle.removalObservation.containAndObserve(f.input()));
});

test("already expired or cancelled calls cause no containment effects", async t => {
  const f = await fixture(t); const before = f.engine.events.length;
  assert.equal(await f.lifecycle.removalObservation.containAndObserve({...f.input(),
    call: {...engineCall(), deadlineEpochMs: Date.now() - 1}}), undefined);
  assert.equal(await f.lifecycle.removalObservation.containAndObserve({...f.input(),
    call: {...engineCall(), signal: AbortSignal.abort()}}), undefined);
  assert.equal(f.engine.events.length, before); await f.close();
});

test("cancellation during fresh inspection cannot mint a late token", async t => {
  const f = await fixture(t); await f.close(); const cutoff = new AbortController();
  f.changeObservation(async observed => {cutoff.abort(); return observed;});
  assert.equal(await f.lifecycle.removalObservation.containAndObserve({...f.input(),
    call: {...engineCall(), signal: cutoff.signal}}), undefined);
});

test("caller mutation after entry cannot redirect the retained owner or result", async t => {
  const f = await fixture(t); await f.close();
  const entered = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
  t.after(() => release.resolve());
  f.changeObservation(async observed => {entered.resolve(); await release.promise; return observed;});
  const authority = {...f.launched.authority}; const key = {...f.launched.key}; const call = {...engineCall()};
  const observing = f.lifecycle.removalObservation.containAndObserve({authority, key, call});
  await entered.promise; authority.containerId = "a".repeat(64); key.operationId = "changed"; call.deadlineEpochMs = 0;
  release.resolve(); const token = await observing; assert.ok(token);
  const observed = f.lifecycle.removalObservation.readObservation(token); assert.ok(observed);
  assert.deepEqual(observed.authority, f.launched.authority); assert.deepEqual(observed.attemptKey, f.launched.key);
});

test("the removal owner retains Engine and containment methods at construction", async t => {
  const f = await fixture(t); await f.close();
  f.engine.inspect = async () => {throw new Error("replaced inspect must not be called");};
  f.lifecycle.contain = async () => {throw new Error("replaced contain must not be called");};
  assert.ok(await f.lifecycle.removalObservation.containAndObserve(f.input()));
});

test("actual container absence cannot hide unsettled owned attach cleanup", async t => {
  const gate = Promise.withResolvers<void>(); t.after(() => gate.resolve());
  const f = await fixture(t, gate.promise);
  assert.equal(await f.lifecycle.removalObservation.containAndObserve({...f.input(),
    call: {...engineCall(), deadlineEpochMs: Date.now() + 25}}), undefined);
  assert.equal((await f.engine.inspect(f.launched.authority, engineCall())).existence, "absent");
  gate.resolve(); await new Promise<void>(resolve => {setImmediate(resolve);});
  assert.ok(await f.lifecycle.removalObservation.containAndObserve(f.input()));
});

test("authority accessors are rejected before executing caller code or containment", async t => {
  const f = await fixture(t); const before = f.engine.events.length; let reads = 0;
  const authority = {...f.launched.authority};
  Object.defineProperty(authority, "containerId", {enumerable: true, get() {reads += 1; return f.launched.authority.containerId;}});
  assert.equal(await f.lifecycle.removalObservation.containAndObserve({...f.input(), authority}), undefined);
  assert.equal(reads, 0); assert.equal(f.engine.events.length, before); await f.close();
});
