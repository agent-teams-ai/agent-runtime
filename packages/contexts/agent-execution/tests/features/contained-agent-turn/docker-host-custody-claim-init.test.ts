import assert from "node:assert/strict";
import {rm} from "node:fs/promises";
import test from "node:test";
import {createDockerHostCustodyLifecycle} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/docker-host-custody-lifecycle.js";
import {FakeDockerEngine} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/engine/index.js";
import {DockerCustodyJournal} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/journal/index.js";
import {MemoryStorage, disposable, policy, createInput, engineCall, owner} from "./support/docker-host-custody-lifecycle-fixture.ts";
import {installSyntheticInit, initOptions, providerExec} from "./support/docker-claim-init-fixture.ts";

const tick = (): Promise<void> => new Promise(resolve => {setImmediate(resolve);});
const create = (root: string, events: string[] = [], acknowledge = true) => {
  const engine = new FakeDockerEngine(policy(root)); const storage = new MemoryStorage();
  const init = installSyntheticInit(engine, events, acknowledge);
  const lifecycle = createDockerHostCustodyLifecycle({engine, journalStorage: storage,
    residue: {async proveEmpty() {return "empty";}}});
  return {engine, storage, init, lifecycle};
};

test("lifecycle retains one attach, authenticates explicit readiness, and journals intent before the only exec sender", async t => {
  const root = await disposable(); t.after(() => rm(root, {recursive: true, force: true}));
  const events: string[] = []; const {engine, storage, init, lifecycle} = create(root, events);
  await tick(); assert.deepEqual(engine.events, []); assert.deepEqual(events.slice(), []); assert.equal(storage.files.size, 0);
  const launched = await lifecycle.launch({call: engineCall(), create: createInput(root), owner});
  assert.equal(init.attaches, 1); assert.deepEqual(events.slice(), ["attach"]);
  const session = launched.openInitSession(initOptions());
  assert.equal("execute" in session, false, "only the journal owner exposes exec");
  await tick(); assert.deepEqual(events.slice(), ["attach"]);
  await assert.rejects(engine.attachCustody(launched.authority, engineCall()), {code: "protocol-violation"});
  assert.throws(() => launched.openInitSession(initOptions()), /one-use/u);
  assert.equal((await session.ready()).kind, "ready");
  assert.deepEqual(events.slice(), ["attach", "init-reader", "host-handshake"]);
  const file = storage.files.values().next().value!; const append = file.append.bind(file);
  file.append = async (offset, bytes) => {
    await append(offset, bytes);
    if (Buffer.from(bytes).includes(Buffer.from('"state":"provider_exec_requested"'))) {events.push("exec-intent-acknowledged");}
  };
  const result = await lifecycle.executeProvider({authority: launched.authority, call: engineCall(), key: launched.key, exec: providerExec});
  assert.equal(result.state, "provider_exec_observed"); assert.equal(result.evidence.status, "proved");
  assert.deepEqual(events.slice(-2), ["exec-intent-acknowledged", "provider-exec"]);
  await assert.rejects(lifecycle.executeProvider({authority: launched.authority, call: engineCall(), key: launched.key, exec: providerExec}), /one-use/u);
  assert.equal(events.filter(value => value === "provider-exec").length, 1);
  await lifecycle.contain({authority: launched.authority, call: engineCall(), key: launched.key});
  assert.equal((await session.completion).kind, "failed", "start acknowledgement is not drain/terminal evidence");
});

test("no session, inert session or rejected readiness cannot send provider exec", async t => {
  for (const phase of ["missing-session", "inert-session", "wrong-identity"] as const) {
    await t.test(phase, async () => {
      const root = await disposable(); t.after(() => rm(root, {recursive: true, force: true}));
      const events: string[] = []; const {lifecycle} = create(root, events);
      const launched = await lifecycle.launch({call: engineCall(), create: createInput(root), owner});
      if (phase === "inert-session") {launched.openInitSession(initOptions());}
      if (phase === "wrong-identity") {
        for (const changed of [
          {operationNonce: "foreign"}, {launchFingerprintSha256: "0".repeat(64)},
          {expectedIdentity: {...initOptions().authority.expectedIdentity, containerImageSha256: "0".repeat(64)}},
        ]) {assert.throws(() => launched.openInitSession({...initOptions(), authority: {...initOptions().authority, ...changed}}), /retained launch authority/u);}
      }
      await assert.rejects(lifecycle.executeProvider({authority: launched.authority, call: engineCall(), key: launched.key, exec: providerExec}));
      assert.equal(events.includes("provider-exec"), false);
      await lifecycle.contain({authority: launched.authority, call: engineCall(), key: launched.key});
    });
  }
});

test("durable exec intent lost acknowledgement never sends or retries; restart is cleanup only", async t => {
  const root = await disposable(); t.after(() => rm(root, {recursive: true, force: true}));
  const events: string[] = []; const {engine, storage, lifecycle} = create(root, events);
  const launched = await lifecycle.launch({call: engineCall(), create: createInput(root), owner});
  await launched.openInitSession(initOptions()).ready();
  const file = storage.files.values().next().value!; const append = file.append.bind(file);
  file.append = async (offset, bytes) => {
    await append(offset, bytes);
    if (Buffer.from(bytes).includes(Buffer.from('"state":"provider_exec_requested"'))) {throw new Error("synthetic fsync ack lost");}
  };
  const input = {authority: launched.authority, call: engineCall(), key: launched.key, exec: providerExec};
  await assert.rejects(lifecycle.executeProvider(input)); assert.equal(events.includes("provider-exec"), false);
  await assert.rejects(lifecycle.executeProvider(input), /one-use/u);
  const restarted = createDockerHostCustodyLifecycle({engine, journalStorage: storage, residue: {async proveEmpty() {return "empty";}}});
  await assert.rejects(restarted.executeProvider(input), /unavailable/u);
  const recovered = await restarted.recover({async resolve() {return {authority: launched.authority, call: engineCall(), create: createInput(root)};}});
  assert.equal(recovered[0]?.kind, "closed");
  const journal = (await new DockerCustodyJournal(storage).recover())[0];
  assert.equal(journal?.providerExecution, "may_have_executed");
  await lifecycle.contain({authority: launched.authority, call: engineCall(), key: launched.key});
});

test("cutoff, signal, deadline and exact identity are rechecked after blocking exec intent acknowledgement", async t => {
  for (const boundary of ["signal", "deadline", "contain", "daemon", "container"] as const) {
    await t.test(boundary, async () => {
      const root = await disposable(); t.after(() => rm(root, {recursive: true, force: true}));
      const events: string[] = []; const {engine, storage, lifecycle} = create(root, events);
      const launched = await lifecycle.launch({call: engineCall(), create: createInput(root), owner});
      const session = launched.openInitSession(initOptions()); await session.ready();
      const abort = new AbortController(); const call = {...engineCall(), signal: abort.signal};
      const file = storage.files.values().next().value!; const append = file.append.bind(file);
      let unblock!: () => void; const gate = new Promise<void>(resolve => {unblock = resolve;});
      let entered!: () => void; const blocked = new Promise<void>(resolve => {entered = resolve;});
      file.append = async (offset, bytes) => {
        await append(offset, bytes);
        if (Buffer.from(bytes).includes(Buffer.from('"state":"provider_exec_requested"'))) {entered(); await gate;}
      };
      const pending = lifecycle.executeProvider({authority: launched.authority, call, key: launched.key, exec: providerExec});
      await blocked;
      let containment: ReturnType<typeof lifecycle.contain> | undefined;
      if (boundary === "signal") {abort.abort();}
      if (boundary === "deadline") {call.deadlineEpochMs = 1;}
      if (boundary === "contain") {containment = lifecycle.contain({authority: launched.authority, call: engineCall(), key: launched.key});}
      if (boundary === "daemon") {engine.restartDaemon("replacement");}
      if (boundary === "container") {engine.replaceId(launched.authority.containerId, {...launched.authority, createSpecificationSha256: "0".repeat(64)});}
      unblock(); await pending.catch(() => null); await containment;
      assert.equal(events.includes("provider-exec"), false);
      await assert.rejects(lifecycle.executeProvider({authority: launched.authority, call: engineCall(), key: launched.key, exec: providerExec}));
      if (boundary !== "daemon" && boundary !== "container") {await lifecycle.contain({authority: launched.authority, call: engineCall(), key: launched.key});}
      else {await session.close();}
    });
  }
});

test("abort after each launch await boundary prevents the next effect and closes the sole untransferred channel", async t => {
  for (const boundary of ["identity", "prepare", "create-intent", "create", "created", "init-intent", "attach", "start", "inspect", "init-ready"] as const) {
    await t.test(boundary, async () => {
      const root = await disposable(); t.after(() => rm(root, {recursive: true, force: true}));
      const {engine, storage, init, lifecycle} = create(root); const abort = new AbortController();
      const originalCreate = storage.create.bind(storage);
      storage.create = async locator => {
        const file = await originalCreate(locator); const append = file.append.bind(file);
        file.append = async (offset, bytes) => {
          await append(offset, bytes);
          const state = JSON.parse(Buffer.from(bytes).toString()).state;
          if (state === ({prepare: "prepared", "create-intent": "create_requested", created: "created", "init-intent": "init_start_requested", "init-ready": "init_ready"} as Record<string, string>)[boundary]) {abort.abort();}
        };
        return file;
      };
      for (const method of ["identity", "create", "attachCustody", "start", "inspect"] as const) {
        const original = engine[method].bind(engine);
        // Test-only instrumentation preserves each fake engine method's arguments and result.
        engine[method] = (async (...args: never[]) => {
          const result = await (original as (...input: never[]) => Promise<unknown>)(...args);
          if (method === (boundary === "attach" ? "attachCustody" : boundary) &&
              (method !== "inspect" || engine.events.includes("start:id"))) {abort.abort();}
          return result;
        }) as never;
      }
      await assert.rejects(lifecycle.launch({call: {...engineCall(), signal: abort.signal}, create: createInput(root), owner}));
      assert.equal(engine.events.filter(event => event === "attach:duplex").length <= 1, true);
      assert.equal(init.closes, init.attaches);
      if (["identity", "prepare", "create-intent"].includes(boundary)) {assert.equal(engine.events.some(event => event.startsWith("create:")), false);}
      if (["create", "created", "init-intent", "attach"].includes(boundary)) {assert.equal(engine.events.includes("start:id"), false);}
    });
  }
});

test("lost init start acknowledgement closes attach and never returns a transferable ready session", async t => {
  const root = await disposable(); t.after(() => rm(root, {recursive: true, force: true}));
  const {engine, init, lifecycle} = create(root);
  engine.enqueueMutationOutcome("start", {acknowledgement: "lost", effect: "applied"});
  await assert.rejects(lifecycle.launch({call: engineCall(), create: createInput(root), owner}));
  assert.equal(init.attaches, 1); assert.equal(init.closes, 1);
});

test("provider start acknowledgement loss stays journal uncertainty and cannot redispatch", async t => {
  const root = await disposable(); t.after(() => rm(root, {recursive: true, force: true}));
  const events: string[] = []; const {storage, lifecycle} = create(root, events, false);
  const launched = await lifecycle.launch({call: engineCall(), create: createInput(root), owner});
  const session = launched.openInitSession(initOptions()); await session.ready();
  const result = await lifecycle.executeProvider({authority: launched.authority, call: engineCall(), key: launched.key, exec: providerExec});
  assert.equal(result.evidence.status, "unproven");
  assert.equal((await session.completion).kind, "unknown");
  await assert.rejects(lifecycle.executeProvider({authority: launched.authority, call: engineCall(), key: launched.key, exec: providerExec}), /one-use/u);
  await lifecycle.contain({authority: launched.authority, call: engineCall(), key: launched.key});
  const recovered = (await new DockerCustodyJournal(storage).recover())[0];
  assert.equal(recovered?.providerExecution, "may_have_executed"); assert.equal(events.filter(value => value === "provider-exec").length, 1);
});

test("a distinct execution-call abort during start acknowledgement cannot be recorded as proved", async t => {
  const root = await disposable(); t.after(() => rm(root, {recursive: true, force: true}));
  const events: string[] = []; const {init, lifecycle} = create(root, events, false);
  const launched = await lifecycle.launch({call: engineCall(), create: createInput(root), owner});
  const session = launched.openInitSession(initOptions()); await session.ready();
  const abort = new AbortController();
  const execution = lifecycle.executeProvider({authority: launched.authority, call: {...engineCall(), signal: abort.signal}, key: launched.key, exec: providerExec});
  while (!events.includes("provider-exec")) {await tick();}
  abort.abort(); init.push({kind: "provider-exec-ack", requestId: providerExec.requestId, observation: "started"});
  assert.equal((await execution).evidence.status, "unproven");
  assert.equal((await session.completion).kind, "unknown");
  await lifecycle.contain({authority: launched.authority, call: engineCall(), key: launched.key});
});
