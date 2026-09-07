import assert from "node:assert/strict";
import test from "node:test";
import {prepareDockerProviderProcessIo, createDockerProviderProcessBridge, dockerProviderProcessMountFacts}
  from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/docker-provider-process-entrypoint.js";
import {fixture, deferred, tick} from "./support/docker-provider-process-fixture.ts";

for (const state of ["disabled-before-open", "revoked-after-open", "active"] as const) {
  test(`process bridge preserves observation authority: ${state}`, {timeout: 5_000}, async t => {
    const f = fixture(); const a = await f.launch();
    t.after(async () => {await a.contain(); await f.channel.close();});
    let calls = 0;
    const init = {...a.input.init, active: state !== "disabled-before-open",
      isObservationActive() {assert.equal(this, init, "predicate retains its original receiver"); calls += 1; return this.active;}};
    const opening = f.registry.open({...a.input, init});
    if (state === "disabled-before-open") {
      await assert.rejects(opening, /authenticated-readiness-unproven/);
      assert.ok(calls > 0); assert.equal(f.channel.messages.filter(m => m.kind === "provider-exec").length, 0);
      return;
    }
    const process = await opening;
    const observations = Promise.allSettled([process.stdout[Symbol.asyncIterator]().next(), process.waitForExit()]);
    const callsBeforeOutput = calls;
    if (state === "revoked-after-open") {init.active = false;}
    f.channel.outputBytes("stdout", "after predicate change"); f.channel.rootExit(); f.channel.drain();
    const results = await observations;
    assert.ok(calls > callsBeforeOutput);
    if (state === "revoked-after-open") {
      assert.ok(results.every(result => result.status === "rejected"), "revoked observation cannot publish bytes or clean exit");
      await assert.rejects(process.write(Buffer.from("no later input")));
    } else {
      assert.equal(results[0].status, "fulfilled");
      if (results[0].status === "fulfilled") {assert.deepEqual(results[0].value, {done: false, value: Uint8Array.from(Buffer.from("after predicate change"))});}
      assert.deepEqual(results[1], {status: "fulfilled", value: {code: 0, signal: null}});
    }
    assert.equal(f.channel.messages.filter(m => m.kind === "provider-exec").length, 1);
    assert.equal(f.channel.readers, 1);
  });
}


for (const phase of ["before-exec", "late-ack", "after-exec"] as const) {
  test(`independent observation lifetime retains cleanup after admission cutoff: ${phase}`, async t => {
    const f = fixture(); const abort = new AbortController();
    const a = await f.launch({admission: {signal: abort.signal, deadlineEpochMs: Date.now() + 10_000},
      observation: {isActive: () => true}});
    t.after(() => a.contain());
    a.input.init.signal = abort.signal;
    const preparedIo = prepareDockerProviderProcessIo(a.input); await preparedIo.ready();
    if (phase === "before-exec") {
      abort.abort();
      await assert.rejects(createDockerProviderProcessBridge().open({...a.input, preparedIo}));
      assert.equal(f.events.includes("provider-exec"), false);
      assert.equal(f.channel.closes, 0); return;
    }
    const gate = deferred(); const entered = deferred();
    f.channel.onMessage = async message => {
      if (phase === "late-ack" && message.kind === "provider-exec") {entered.resolve(); await gate.promise;}
      f.channel.respond(message);
    };
    const opening = createDockerProviderProcessBridge().open({...a.input, preparedIo});
    if (phase === "late-ack") {
      const rejected = assert.rejects(opening); await entered.promise;
      abort.abort(); gate.resolve(); await rejected;
    } else {
      const process = await opening; abort.abort();
      await assert.rejects(process.write(Buffer.from("cut off")));
      f.channel.rootExit(); f.channel.drain();
      assert.deepEqual(await process.waitForExit(), {code: 0, signal: null});
    }
    if (phase === "late-ack") {
      assert.equal(f.channel.closes, 0, "late acknowledgement did not cancel the sole observation reader");
      f.channel.rootExit(); f.channel.drain(); await tick();
    }
    assert.equal(f.channel.readers, 1);
    assert.equal((await a.contain()).kind, "closed");
    assert.equal(preparedIo.observation.supervisorFinality, "unproven");
  });
}

test("Engine stage expiry cannot shorten admission or renew its original deadline", async t => {
  const f = fixture(); const now = Date.now();
  const engineStage = new AbortController();
  f.launchInput.call = {signal: engineStage.signal, deadlineEpochMs: now + 1_000};
  const a = await f.launch({admission: {signal: new AbortController().signal, deadlineEpochMs: now + 10_000},
    observation: {isActive: () => true}});
  t.after(() => a.contain());
  const realNow = Date.now;
  try {
    engineStage.abort();
    Date.now = () => now + 2_000;
    const preparedIo = prepareDockerProviderProcessIo(a.input); await preparedIo.ready();
    assert.equal(dockerProviderProcessMountFacts(a.launched).workspaceSource, a.input.expected.workspaceAuthorityPath);
    const process = await createDockerProviderProcessBridge().open({...a.input, preparedIo,
      call: {...a.input.call, deadlineEpochMs: now + 100_000},
      exec: {...a.input.exec, wallDeadlineUnixMs: now + 100_000}});
    const exec = f.channel.messages.find(message => message.kind === "provider-exec");
    assert.equal(exec?.wallDeadlineUnixMs, now + 10_000);
    Date.now = () => now + 10_001;
    await assert.rejects(process.write(Buffer.from("deadline cannot be renewed")));
    await assert.rejects(createDockerProviderProcessBridge().open({...a.input,
      call: {...a.input.call, deadlineEpochMs: now + 100_000}}));
    f.channel.rootExit(); f.channel.drain(); await process.waitForExit();
  } finally {Date.now = realNow;}
  assert.equal(f.events.filter(event => event === "provider-exec").length, 1);
});


test("original admission cutoff during durable exec intent blocks a late execution", async t => {
  const f = fixture(); const abort = new AbortController();
  const a = await f.launch({admission: {signal: abort.signal, deadlineEpochMs: Date.now() + 10_000},
    observation: {isActive: () => true}}); t.after(() => a.contain());
  const preparedIo = prepareDockerProviderProcessIo(a.input); await preparedIo.ready();
  const file = f.storage.files.values().next().value!; const append = file.append.bind(file);
  const gate = deferred(); const entered = deferred();
  file.append = async (offset, bytes) => {
    await append(offset, bytes);
    if (Buffer.from(bytes).includes(Buffer.from('"state":"provider_exec_requested"'))) {entered.resolve(); await gate.promise;}
  };
  const opening = createDockerProviderProcessBridge().open({...a.input, preparedIo});
  const rejected = assert.rejects(opening); await entered.promise;
  abort.abort(); gate.resolve(); await rejected;
  assert.equal(f.events.includes("provider-exec"), false); assert.equal(f.channel.closes, 0);
  await assert.rejects(createDockerProviderProcessBridge().open({...a.input, preparedIo}));
});
