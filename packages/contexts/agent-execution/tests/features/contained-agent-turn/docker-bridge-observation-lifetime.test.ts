import assert from "node:assert/strict";
import test from "node:test";
import {fixture} from "./support/docker-provider-process-fixture.ts";

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
