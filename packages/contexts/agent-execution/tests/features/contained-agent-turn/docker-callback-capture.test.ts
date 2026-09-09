import assert from "node:assert/strict";
import test from "node:test";
import {prepareDockerProviderProcessIo, createDockerProviderProcessBridge} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/docker-provider-process-bridge.js";
import {connectionFixture, installProtocol} from "./support/docker-codex-kernel-fixture.ts";

const names = ["isCurrentGeneration", "isObservationActive", "monotonicNow"] as const;
for (const route of ["prepare", "bridge", "owner", "prepared-owner"] as const) {
  for (const name of names) {
    for (const kind of ["getter", "proxy", "accessor"] as const) {
      test(`${route} ${name} ${kind} never executes property traps`, async t => {
        const f = await connectionFixture(); t.after(() => f.contain());
        if (route === "prepared-owner") {
          const preparedIo = prepareDockerProviderProcessIo(f.options.process);
          Object.assign(f.options.process, {preparedIo});
          await preparedIo.ready();
        }
        let hits = 0;
        const trap = () => {hits++; throw new Error("callback-property-trap");};
        const callback = function () {return name === "monotonicNow" ? performance.now() : true;};
        const init = {...f.options.process.init};
        if (kind === "accessor") {Object.defineProperty(init, name, {get: trap});}
        else {init[name] = (kind === "getter" ? Object.defineProperty(callback, "bind", {get: trap})
          : new Proxy(callback, {get: trap, apply: trap, getOwnPropertyDescriptor: trap})) as never;}
        f.options.process.init = init;
        const before = [...f.events]; const readers = f.channel.readers;
        const run = async () => {
          if (route === "prepare") {prepareDockerProviderProcessIo(f.options.process);}
          else if (route === "bridge") {await createDockerProviderProcessBridge().open(f.options.process);}
          else {f.owner();}
        };
        if (kind === "getter") {await run();}
        else {await assert.rejects(run, TypeError); assert.deepEqual(f.events, before); assert.equal(f.channel.readers, readers);}
        assert.equal(hits, 0);
        assert.equal(f.events.includes("provider-exec"), route === "bridge" && kind === "getter");
      });
    }
  }
  test(`${route} callbacks retain the original receiver without callable property reads`, async t => {
    const f = await connectionFixture(); t.after(() => f.contain());
    const init = {...f.options.process.init}; const calls = new Map<string, unknown[]>();
    for (const name of names) {
      calls.set(name, []);
      init[name] = function (this: unknown) {calls.get(name)!.push(this); return name === "monotonicNow" ? performance.now() : true;} as never;
    }
    f.options.process.init = init;
    if (route === "prepare" || route === "prepared-owner") {
      const preparedIo = prepareDockerProviderProcessIo(f.options.process);
      Object.assign(f.options.process, {preparedIo});
      await preparedIo.ready();
    }
    if (route === "owner" || route === "prepared-owner") {
      installProtocol(f);
      assert.deepEqual(await f.owner().provider.execute(f.input), {kind: "completed", outcome: "succeeded"});
    } else if (route === "bridge") {await createDockerProviderProcessBridge().open(f.options.process);}
    for (const name of names) {
      assert.ok(calls.get(name)!.length > 0, `${name} invoked`);
      assert.ok(calls.get(name)!.every(receiver => receiver === init), `${name} original receiver`);
    }
  });
}

for (const name of names) {
  test(`prepared owner rejects substituted ${name} identity`, async t => {
    const f = await connectionFixture(); t.after(() => f.contain());
    f.options.process.init = {...f.options.process.init,
      isObservationActive: () => true, monotonicNow: () => performance.now()};
    const preparedIo = prepareDockerProviderProcessIo(f.options.process); await preparedIo.ready();
    Object.assign(f.options.process, {preparedIo});
    f.options.process.init = {...f.options.process.init,
      [name]: () => name === "monotonicNow" ? performance.now() : true};
    installProtocol(f);
    assert.equal((await f.owner().provider.execute(f.input)).kind, "indeterminate");
    assert.equal(f.events.includes("provider-exec"), false);
    assert.equal(f.channel.readers, 1);
  });
}
