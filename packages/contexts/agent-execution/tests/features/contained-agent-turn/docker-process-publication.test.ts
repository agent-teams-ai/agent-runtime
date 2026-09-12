import assert from "node:assert/strict";
import test from "node:test";
import {createDockerCodexCurrentKernelOwner} from "../../../dist/features/contained-agent-turn/composition/docker-codex-current-kernel-owner.js";
import {prepareDockerProviderProcessIo, takeDockerProviderProcessAbandonment} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/docker-provider-process-entrypoint.js";
import {publicationFixture} from "./support/docker-publication-fixture.ts";
import {instance} from "./support/docker-provider-observation-fixture.ts";
import {deferred, fixture, tick} from "./support/docker-provider-process-fixture.ts";

for (const cutoff of ["dispose", "cancel", "reject"] as const) {
  test(`post-open ${cutoff} drains unpublished output and authenticated final observations`, {timeout: 5000}, async t => {
    const f = await publicationFixture(); t.after(() => f.contain());
    // Observation custody is independent of the creator's admission signal.
    // The real session still retains its configured byte/time bounds.
    const observationDeadline = Date.now() + 4000;
    const init = {...f.options.process.init, isObservationActive: () => Date.now() < observationDeadline};
    const preparedIo = prepareDockerProviderProcessIo({...f.options.process, init}); await preparedIo.ready();
    const owner = createDockerCodexCurrentKernelOwner({...f.options, process: {...f.options.process, init, preparedIo}});
    f.channel.onMessage = message => {
      f.channel.respond(message);
      if (message.kind === "provider-exec") {f.channel.push(instance(message));}
    };
    const reached = deferred(); const release = deferred();
    const pending = owner.provider.execute({...f.input, isCancellationRequested: async () => {
      if (!f.events.includes("provider-exec")) {return false;}
      reached.resolve(); await release.promise;
      if (cutoff === "reject") {throw new Error("synthetic cancellation store failure");}
      return cutoff === "cancel";
    }});
    await reached.promise;
    // The bridge has succeeded; the creator is suspended in its final check.
    if (cutoff === "dispose") {owner.dispose();}
    release.resolve(); assert.equal((await pending).kind, "indeterminate");
    f.channel.outputBytes("stdout", "never publish");
    f.channel.outputBytes("stderr", "private diagnostic");
    f.channel.rootExit(); f.channel.drain(); await tick(); await tick();
    assert.deepEqual(f.output, []);
    assert.equal(f.events.includes("provider-input"), false);
    assert.equal(preparedIo.observation.rootExit?.exitCode, 0);
    assert.equal(preparedIo.observation.channelEof, true);
    assert.equal(preparedIo.observation.status, "complete");
    assert.equal(preparedIo.observation.stdout.bytes, Buffer.byteLength("never publish"));
    assert.equal(preparedIo.observation.stderr.bytes, Buffer.byteLength("private diagnostic"));
    assert.equal(f.channel.values.length, 0);
    assert.equal(f.channel.readers, 1);
    assert.equal(f.events.filter(event => event === "provider-exec").length, 1);
  });
}

for (const first of ["stdout", "stderr"] as const) {
  test(`first ${first} iterator fences abandonment for both published streams`, async t => {
    const f = fixture(); const a = await f.launch(); t.after(() => a.contain());
    const preparedIo = prepareDockerProviderProcessIo(a.input); await preparedIo.ready();
    const process = await f.registry.open({...a.input, preparedIo});
    const abandon = takeDockerProviderProcessAbandonment(process);
    assert.throws(() => takeDockerProviderProcessAbandonment(process), /unavailable/u);
    assert.equal("abandon" in process, false);
    const one = process[first][Symbol.asyncIterator]();
    abandon(); abandon();
    const second = first === "stdout" ? "stderr" : "stdout";
    const two = process[second][Symbol.asyncIterator]();
    f.channel.outputBytes(first, "preserved first");
    f.channel.outputBytes(second, "preserved second");
    assert.equal(Buffer.from((await one.next()).value).toString(), "preserved first");
    assert.equal(Buffer.from((await two.next()).value).toString(), "preserved second");
    const eof = Promise.all([one.next(), two.next()]);
    f.channel.rootExit(); f.channel.drain();
    assert.deepEqual(await process.waitForExit(), {code: 0, signal: null});
    assert.ok((await eof).every(result => result.done));
  });
}

test("one-use abandonment releases an already blocked slot and prevents later protocol claim", async t => {
  const f = fixture(); const a = await f.launch(); t.after(() => a.contain());
  const preparedIo = prepareDockerProviderProcessIo(a.input); await preparedIo.ready();
  const process = await f.registry.open({...a.input, preparedIo});
  const abandon = takeDockerProviderProcessAbandonment(process);
  f.channel.outputBytes("stdout", "blocked"); await tick();
  f.channel.rootExit(); f.channel.drain();
  abandon(); abandon();
  assert.throws(() => process.stdout[Symbol.asyncIterator](), /abandoned/u);
  assert.throws(() => process.stderr[Symbol.asyncIterator](), /abandoned/u);
  assert.deepEqual(await process.waitForExit(), {code: 0, signal: null});
  assert.equal(preparedIo.observation.channelEof, true);
  assert.equal(f.channel.readers, 1);
});

test("dispose after creator return but before protocol ownership still abandons", {timeout: 5000}, async t => {
  const f = await publicationFixture(); t.after(() => f.contain());
  const preparedIo = prepareDockerProviderProcessIo(f.options.process); await preparedIo.ready();
  const owner = createDockerCodexCurrentKernelOwner({...f.options, process: {...f.options.process, preparedIo}});
  const reached = deferred(); const release = deferred();
  const pending = owner.provider.execute({...f.input, start: {...f.input.start,
    async createProcess(create: () => unknown) {
      const result = await create(); reached.resolve(); await release.promise; return result;
    },
  } as typeof f.input.start});
  await reached.promise; owner.dispose(); release.resolve();
  assert.equal((await pending).kind, "indeterminate");
  f.channel.outputBytes("stdout", "unpublished handoff"); f.channel.rootExit(); f.channel.drain();
  await tick(); await tick();
  assert.equal(preparedIo.observation.rootExit?.exitCode, 0);
  assert.equal(preparedIo.observation.channelEof, true);
  assert.deepEqual(f.output, []);
});
