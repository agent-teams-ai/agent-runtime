import assert from "node:assert/strict";
import {rm} from "node:fs/promises";
import test from "node:test";
import {setTimeout as delay} from "node:timers/promises";
import {createDockerHostCustodyLifecycle} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/docker-host-custody-lifecycle.js";
import {FakeDockerEngine} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/engine/index.js";
import {DockerCustodyJournal} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/journal/index.js";
import {MemoryStorage, disposable, policy, createInput, engineCall, owner, digest} from "./support/docker-host-custody-lifecycle-fixture.ts";
import {installSyntheticInit, initOptions, providerExec} from "./support/docker-claim-init-fixture.ts";

const tick = (): Promise<void> => new Promise(resolve => {setImmediate(resolve);});
const deferred = () => Promise.withResolvers<void>();
const cleanupCall = () => ({...engineCall(), deadlineEpochMs: Date.now() + 20});
const setup = (root: string) => {
  const engine = new FakeDockerEngine(policy(root)); const storage = new MemoryStorage();
  const events: string[] = []; const init = installSyntheticInit(engine, events);
  const lifecycle = createDockerHostCustodyLifecycle({engine, journalStorage: storage, journalLimits: {maxJournalFiles: 1},
    residue: {async proveEmpty() {return "empty";}}});
  const launch = (id = "first") => lifecycle.launch({call: engineCall(), create: createInput(root, digest(id === "first" ? "operation" : id)),
    owner: {...owner, operationId: `operation:${id}`, attemptId: `attempt:${id}`, custodyId: `custody:${id}`}});
  return {engine, storage, events, init, lifecycle, launch};
};

for (const phase of ["attached", "ready", "started", "cancelled"] as const) {
  for (const held of (phase === "attached" ? ["channel"] : ["channel", "iterator"]) as readonly ("channel" | "iterator")[]) {
    test(`containment stops Docker independently of held ${held} cleanup after ${phase}`, async t => {
      const root = await disposable(); t.after(() => rm(root, {recursive: true, force: true}));
      const {engine, storage, events, init, lifecycle, launch} = setup(root);
      const gate = deferred(); t.after(() => gate.resolve());
      const attach = engine.attachCustody.bind(engine); let closeCalls = 0; let returnCalls = 0;
      engine.attachCustody = async (...args) => {
        const channel = await attach(...args);
        return {...channel,
          async close() {closeCalls += 1; if (held === "channel") {await gate.promise;} await channel.close();},
          output: {[Symbol.asyncIterator]() {
            const iterator = channel.output[Symbol.asyncIterator]();
            return {next: () => iterator.next(), async return() {
              returnCalls += 1; if (held === "iterator") {await gate.promise;}
              return iterator.return!();
            }};
          }},
        };
      };
      const launched = await launch();
      const session = phase === "attached" ? undefined : launched.openInitSession(initOptions());
      if (session !== undefined) {assert.equal((await session.ready()).kind, "ready");}
      if (phase === "started") {
        await lifecycle.executeProvider({...launched, call: engineCall(), exec: providerExec});
        engine.enqueueMutationOutcome("stop", {acknowledgement: "lost", effect: "not-applied"});
      }
      if (phase === "cancelled") {void session!.cancel(); await session!.completion;}
      const containing = lifecycle.contain({...launched, call: {...engineCall(), deadlineEpochMs: Date.now() + 20}});
      await assert.rejects(lifecycle.executeProvider({...launched, call: engineCall(), exec: providerExec}), /cut off/u);
      const result = await Promise.race([containing, delay(100).then(() => "blocked" as const)]);
      assert.notEqual(result, "blocked", "protocol cleanup must not hold physical containment");
      assert.ok(engine.events.includes(phase === "started" ? "kill:id" : "stop:id"));
      assert.equal(result !== "blocked" && result.kind, "indeterminate");
      const journal = await new DockerCustodyJournal(storage).lookup(launched.key);
      await assert.rejects(lifecycle.retire({key: launched.key, expectedChecksumSha256: journal.checksumSha256}));
      const resolver = {async resolve() {return {...launched, call: cleanupCall(), create: createInput(root)};}};
      assert.equal((await lifecycle.recover(resolver))[0]?.kind, "indeterminate");
      assert.equal((await lifecycle.contain({...launched, call: cleanupCall()})).kind, "indeterminate");
      gate.resolve(); await tick();
      if (session !== undefined) {
        assert.equal((await session.completion).kind, "failed");
        init.push({kind: "provider-exec-ack", requestId: providerExec.requestId, observation: "started"});
        assert.equal((await session.writeInput(Buffer.from("late"))).kind, "closed");
      }
      const closed = await lifecycle.contain({...launched, call: engineCall()});
      assert.equal(closed.kind, "closed"); assert.equal(closeCalls, 1); assert.equal(returnCalls, session === undefined ? 0 : 1);
      assert.equal(events.filter(event => event === "provider-exec").length, phase === "started" ? 1 : 0);
      assert.ok("journal" in closed);
      await lifecycle.retire({key: launched.key, expectedChecksumSha256: closed.journal.checksumSha256});
      assert.equal(storage.files.size, 0);
    });
  }
}

test("prejournal failure releases only volatile capacity, fences reentrant attempts, and admits distinct identities after storage recovers", async t => {
  const root = await disposable(); t.after(() => rm(root, {recursive: true, force: true}));
  const {engine, storage, lifecycle, launch} = setup(root); const create = storage.create.bind(storage);
  for (const id of ["first", "second"]) {
    storage.create = async () => {
      await assert.rejects(launch(id), /unused launch capacity/u);
      await assert.rejects(launch("concurrent"), /unused launch capacity/u);
      throw new Error("synthetic storage unavailable before journal creation");
    };
    await assert.rejects(launch(id), /unavailable/u);
    assert.equal(storage.files.size, 0);
    assert.deepEqual(await lifecycle.recover({async resolve() {throw new Error("no journal to resolve");}}), []);
    storage.create = create;
    await assert.rejects(launch(id), /unused launch capacity/u, "one-use fence survives volatile release");
    await assert.rejects(lifecycle.launch({call: engineCall(), create: createInput(root, digest(`replacement:${id}`)),
      owner: {...owner, operationId: `operation:${id}`, attemptId: `attempt:${id}`}}), /unused launch capacity/u);
  }
  assert.equal(engine.events.some(event => event.startsWith("create:")), false);
  const launched = await launch("third");
  const closed = await lifecycle.contain({...launched, call: engineCall()});
  assert.equal(closed.kind, "closed"); assert.equal(storage.files.size, 1);
});

test("lost create acknowledgement retains volatile quarantine and durable cleanup authority", async t => {
  const root = await disposable(); t.after(() => rm(root, {recursive: true, force: true}));
  const {engine, storage, lifecycle, launch} = setup(root);
  const create = engine.create.bind(engine);
  engine.create = async (...args) => {await create(...args); throw new Error("synthetic create acknowledgement lost");};
  await assert.rejects(launch());
  const [entry] = [...storage.files]; assert.ok(entry);
  const [locator, file] = entry; const bytes = Buffer.from(file.bytes);
  storage.files.delete(locator); // Synthetic journal loss must not turn ambiguous effects into capacity.
  await assert.rejects(launch("distinct"), /unused launch capacity/u);
  await assert.rejects(launch(), /unused launch capacity/u);
  storage.files.set(locator, file); assert.deepEqual(file.bytes, bytes);
  const recovered = await lifecycle.recover({async resolve() {return {call: engineCall(), create: createInput(root)};}});
  assert.equal(recovered[0]?.kind, "closed");
  assert.equal(engine.events.filter(event => event.startsWith("create:")).length, 1);
  assert.equal(engine.events.includes("start:id"), false);
});

test("pre-create acknowledgement loss keeps journal capacity authoritative until recovery and retirement", async t => {
  const root = await disposable(); t.after(() => rm(root, {recursive: true, force: true}));
  const {engine, storage, lifecycle, launch} = setup(root); const create = storage.create.bind(storage);
  storage.create = async locator => {
    const file = await create(locator); const append = file.append.bind(file);
    file.append = async (offset, bytes) => {await append(offset, bytes); throw new Error("synthetic prepared acknowledgement lost");};
    return file;
  };
  await assert.rejects(launch()); storage.create = create;
  await assert.rejects(launch("blocked-by-journal"), {name: "DockerCustodyJournalCapacityError"});
  assert.equal(engine.events.some(event => event.startsWith("create:")), false); assert.equal(storage.files.size, 1);
  const file = storage.files.values().next().value!;
  file.append = async (offset, bytes) => {assert.equal(offset, file.byteLength); file.bytes = Buffer.concat([file.bytes, bytes]);};
  const [recovered] = await lifecycle.recover({async resolve() {throw new Error("prepared is zero Docker effect");}});
  assert.ok(recovered?.kind === "closed");
  await lifecycle.retire({key: recovered.journal.attemptKey, expectedChecksumSha256: recovered.journal.checksumSha256});
  const launched = await lifecycle.launch({call: engineCall(), create: createInput(root, digest("fresh")),
    owner: {...owner, attemptId: "attempt:fresh", custodyId: "custody:fresh"}});
  assert.equal((await lifecycle.contain({...launched, call: engineCall()})).kind, "closed");
});

for (const phase of ["attached", "ready", "iterator"] as const) {
  test(`rejected ${phase} cleanup remains quarantined without unhandled rejection or repeated closure`, async t => {
    const root = await disposable(); t.after(() => rm(root, {recursive: true, force: true}));
    const {engine, storage, lifecycle, launch} = setup(root); const attach = engine.attachCustody.bind(engine);
    let calls = 0;
    const reject = async () => {calls += 1; throw new Error("synthetic cleanup acknowledgement lost");};
    engine.attachCustody = async (...args) => {
      const channel = await attach(...args);
      return {...channel, close: phase === "iterator" ? channel.close : reject,
        output: {[Symbol.asyncIterator]() {
          const iterator = channel.output[Symbol.asyncIterator]();
          return {next: () => iterator.next(), return: phase === "iterator" ? reject : iterator.return!.bind(iterator)};
        }}};
    };
    const launched = await launch();
    if (phase !== "attached") {await launched.openInitSession(initOptions()).ready();}
    for (let index = 0; index < 2; index += 1) {
      assert.equal((await lifecycle.contain({...launched, call: engineCall()})).kind, "indeterminate");
      const journal = await new DockerCustodyJournal(storage).lookup(launched.key);
      await assert.rejects(lifecycle.retire({key: launched.key, expectedChecksumSha256: journal.checksumSha256}));
    }
    assert.equal((await engine.inspect(launched.authority, engineCall())).existence, "absent");
    assert.equal(calls, 1);
  });
}

test("containment fences late attach completion and reentrant closure until the owned handle settles", async t => {
  const root = await disposable(); t.after(() => rm(root, {recursive: true, force: true}));
  const {engine, storage, lifecycle, launch, init} = setup(root);
  const entered = Promise.withResolvers<Parameters<typeof lifecycle.contain>[0]>();
  const gate = deferred(); t.after(() => gate.resolve()); const attach = engine.attachCustody.bind(engine);
  let reentrant: ReturnType<typeof lifecycle.contain> | undefined;
  engine.attachCustody = async (...args) => {
    const channel = await attach(...args);
    const [journal] = await new DockerCustodyJournal(storage).recover();
    assert.ok(journal?.kind === "replayed");
    const input = {authority: args[0], key: journal.attemptKey, call: engineCall()};
    entered.resolve(input); await gate.promise;
    return {...channel, async close() {reentrant = lifecycle.contain(input); await channel.close();}};
  };
  const launching = launch(); const rejected = assert.rejects(launching, /cut off/u);
  const input = await entered.promise;
  assert.equal((await lifecycle.contain({...input, call: {...engineCall(), deadlineEpochMs: Date.now() + 20}})).kind, "indeterminate");
  const journal = await new DockerCustodyJournal(storage).lookup(input.key);
  await assert.rejects(lifecycle.retire({key: input.key, expectedChecksumSha256: journal.checksumSha256}));
  gate.resolve(); await rejected; await tick(); await reentrant;
  assert.equal((await lifecycle.contain({...input, call: engineCall()})).kind, "closed");
  assert.equal(init.attaches, 1); assert.equal(init.closes, 1); assert.equal(engine.events.includes("start:id"), false);
});

test("disposal during an init output callback fences late callback completion and subsequent frames", async t => {
  const root = await disposable(); t.after(() => rm(root, {recursive: true, force: true}));
  const {lifecycle, launch, init, events} = setup(root); const gate = deferred(); const entered = deferred();
  t.after(() => gate.resolve()); const launched = await launch(); let roots = 0;
  const session = launched.openInitSession({...initOptions(), onOutput: () => {entered.resolve(); return gate.promise;},
    onRootExit: () => {roots += 1;}});
  await session.ready(); await lifecycle.executeProvider({...launched, call: engineCall(), exec: providerExec});
  init.push({kind: "provider-output", requestId: providerExec.requestId, bytesBase64: "eA==", stream: "stdout"});
  await entered.promise; await lifecycle.contain({...launched, call: engineCall()});
  const result = await session.completion; assert.equal(result.kind, "failed");
  gate.resolve(); init.push({kind: "provider-observation", requestId: providerExec.requestId,
    observation: "root-exited", exitCode: 0, signal: null, treeEmptyClaim: "not-claimed"});
  await tick(); assert.strictEqual(await session.completion, result); assert.equal(roots, 0);
  assert.equal(events.filter(event => event === "provider-exec").length, 1);
});
