import assert from "node:assert/strict";
import test from "node:test";
import {DockerProviderProcessIoError} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/docker-provider-process-bridge.js";
import {DOCKER_CUSTODY_PROVIDER_IO_MAX_BYTES} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/init/docker-custody-init-protocol.js";
import {cutoffFixture, deferred, tick, stdoutTail, stderrTail} from "./support/docker-bridge-cutoff-fixture.ts";

const zeroEffect = (error: unknown): boolean => {
  assert.ok(error instanceof DockerProviderProcessIoError);
  assert.deepEqual(error.writeResult, {kind: "closed", committedBytes: 0}); return true;
};
const unknownEffect = (error: unknown): boolean => {
  assert.ok(error instanceof DockerProviderProcessIoError);
  assert.deepEqual(error.writeResult, {kind: "unknown", committedBytes: "unknown"}); return true;
};
const inputFrames = (f: Awaited<ReturnType<typeof cutoffFixture>>) => f.channel.messages
  .filter(message => message.kind === "provider-input" || message.kind === "provider-input-eof");
const assertTail = async (f: Awaited<ReturnType<typeof cutoffFixture>>) => {
  assert.deepEqual(await f.observations, [
    {status: "fulfilled", value: stdoutTail}, {status: "fulfilled", value: stderrTail},
    {status: "fulfilled", value: {code: 17, signal: null}},
  ]);
  assert.equal(f.channel.readers, 1); assert.equal(f.channel.closes, 1);
  assert.equal(f.syscalls.spawns.length, 1);
};

for (const action of ["control", "write", "EOF", "write-and-EOF", "EOF-after-write"] as const) {
  test(`Host stop retains actual init tails and exit 17 after ${action} admission cutoff`, {timeout: 5_000}, async t => {
    const f = await cutoffFixture(t); const stopEntered = deferred(); const stopRelease = deferred();
    f.releases.push(() => {stopRelease.resolve();});
    f.controls.onStop = async () => {stopEntered.resolve(); await stopRelease.promise; f.tail();};
    if (action === "EOF-after-write") {await f.process.write(Buffer.from("accepted earlier"));}
    const gate = f.holdWrite();
    let rejection: Promise<void> | undefined; let closing: Promise<void> | undefined;
    if (action !== "control") {
      const pending = action.startsWith("EOF") ? f.process.closeInput() : f.process.write(Buffer.from("queued"));
      rejection = assert.rejects(pending, zeroEffect); await gate.entered.promise;
      if (action === "write-and-EOF") {
        await assert.rejects(f.process.write(Buffer.from("overlap")), /write-in-progress/);
        closing = f.process.closeInput(); assert.equal(f.process.closeInput(), closing);
        rejection = Promise.all([rejection, assert.rejects(closing, zeroEffect)]).then(() => {return;});
      }
    }
    const contained = f.contain(); await stopEntered.promise;
    gate.release.resolve(); await rejection; await tick();
    assert.equal(f.channel.closes, 0, "input rejection must not cancel the retained session before stop tail");
    assert.equal(f.channel.returns, 0); assert.equal(f.settled(), false);
    assert.equal(f.engine.running, true); assert.equal(f.engine.removed, false);
    if (action !== "control") {
      await assert.rejects(f.process.write(Buffer.from("no retry")), zeroEffect);
      const close = f.process.closeInput(); assert.equal(f.process.closeInput(), close); await assert.rejects(close, zeroEffect);
    }
    assert.equal(inputFrames(f).length, action === "EOF-after-write" ? 1 : 0);
    stopRelease.resolve(); assert.equal((await contained).kind, "closed"); await assertTail(f);
    assert.equal(f.engine.removed, true);
    assert.ok(f.events.indexOf("tail") < f.events.indexOf("channel-close"));
    assert.ok(f.events.indexOf("stopped") < f.events.indexOf("remove"));
  });
}

test("a committed prefix in the same logical write makes cutoff unknown and remains fatal", {timeout: 5_000}, async t => {
  const f = await cutoffFixture(t); const gate = f.holdWrite(2); const stopRelease = deferred();
  f.releases.push(() => {stopRelease.resolve();}); f.controls.onStop = () => stopRelease.promise;
  const writing = f.process.write(Buffer.alloc(DOCKER_CUSTODY_PROVIDER_IO_MAX_BYTES * 2 + 7, 120));
  const rejected = assert.rejects(writing, unknownEffect); await gate.entered.promise;
  const closing = f.process.closeInput(); const closeRejected = assert.rejects(closing, unknownEffect);
  const contained = f.contain(); gate.release.resolve(); await Promise.all([rejected, closeRejected]);
  assert.equal(Buffer.concat(f.syscalls.input).length, DOCKER_CUSTODY_PROVIDER_IO_MAX_BYTES);
  assert.equal(inputFrames(f).length, 1, "neither the second frame, tail nor EOF reached init");
  assert.ok((await f.observations).every(result => result.status === "rejected"));
  await assert.rejects(f.process.write(Buffer.from("no replay")), unknownEffect);
  stopRelease.resolve(); assert.equal((await contained).kind, "closed"); assert.equal(f.engine.removed, true);
});

for (const mode of ["rejected-before-commit", "rejected-after-commit", "generation-drift", "completion-race"] as const) {
  test(`${mode} cannot masquerade as zero-effect admission cutoff`, {timeout: 5_000}, async t => {
    const f = await cutoffFixture(t); const gate = f.holdWrite();
    if (mode === "rejected-before-commit") {
      f.controls.beforeWrite = async kind => {
        if (kind === "provider-input") {gate.entered.resolve(); await gate.release.promise; throw new Error("transport rejection");}
      };
    }
    if (mode === "rejected-after-commit") {
      f.controls.afterWrite = kind => {if (kind === "provider-input") {throw new Error("lost acknowledgement after bytes");}};
    }
    const writing = f.process.write(Buffer.from("possibly committed"));
    const rejected = assert.rejects(writing, unknownEffect); await gate.entered.promise;
    if (mode === "generation-drift") {f.controls.current = false;}
    if (mode === "completion-race") {f.tail(); await rejected;}
    gate.release.resolve(); await rejected;
    const observations = await f.observations;
    assert.equal(observations[2].status, "rejected", "pending IO cannot publish even an otherwise clean exit");
    if (mode !== "completion-race") {assert.ok(observations.every(result => result.status === "rejected"));}
    assert.equal(Buffer.concat(f.syscalls.input).length, mode === "rejected-after-commit" ? 18 : 0);
    await assert.rejects(f.process.write(Buffer.from("retry"))); await assert.rejects(f.process.closeInput());
    assert.equal((await f.contain()).kind, "closed"); assert.equal(f.engine.removed, true);
    assert.equal(f.channel.readers, 1); assert.equal(f.syscalls.spawns.length, 1);
  });
}

for (const fault of ["stale", "abort"] as const) {
  test(`zero-effect cutoff still observes subsequent ${fault} failure`, {timeout: 5_000}, async t => {
    const f = await cutoffFixture(t); const gate = f.holdWrite(); const stopRelease = deferred();
    f.releases.push(() => {stopRelease.resolve();}); f.controls.onStop = () => stopRelease.promise;
    const rejected = assert.rejects(f.process.write(Buffer.from("queued")), zeroEffect); await gate.entered.promise;
    const contained = f.contain(); gate.release.resolve(); await rejected;
    if (fault === "stale") {f.controls.current = false; f.tail();}
    else {f.abort.abort();}
    assert.ok((await f.observations).every(result => result.status === "rejected"));
    await assert.rejects(f.process.waitForExit());
    stopRelease.resolve(); assert.equal((await contained).kind, "closed"); assert.equal(f.engine.removed, true);
  });
}


test("joined admission abort fences queued transport input while retaining stop-tail drain", {timeout: 5_000}, async t => {
  const f = await cutoffFixture(t, true); const gate = f.holdWrite();
  const writing = f.process.write(Buffer.from("queued before cutoff"));
  const rejected = assert.rejects(writing, zeroEffect); await gate.entered.promise;
  f.abort.abort(); gate.release.resolve(); await rejected;
  assert.equal(inputFrames(f).length, 0); assert.equal(f.channel.closes, 0);
  assert.equal(f.settled(), false);
  f.controls.onStop = async () => {f.tail();};
  assert.equal((await f.contain()).kind, "closed"); await assertTail(f);
});
