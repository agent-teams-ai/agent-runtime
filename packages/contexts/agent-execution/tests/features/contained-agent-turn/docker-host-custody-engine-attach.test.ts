import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import { PassThrough } from "node:stream";
import { test } from "node:test";

import { NodeUnixSocketDockerEngine } from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/engine/index.js";
import type { DockerEngineCall } from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/engine/index.js";
import { call, createInput, disposable, policy } from "../../fixtures/docker-engine-test-fixture.ts";
import { multiplex } from "./docker-engine-transport-test-fixture.ts";
import { syntheticDaemon } from "../../fixtures/docker-engine-synthetic-daemon.ts";

test("attach invalidation fences start at the synchronous transport-write seam", async t => {
  const root = await disposable();
  t.after(async () => {await rm(root, { force: true, recursive: true });});
  for (const mode of ["close", "error", "abort"] as const) {
    await t.test(mode, async () => {
      const daemon = syntheticDaemon();
      const engine = new NodeUnixSocketDockerEngine({client: daemon.client, policy: policy(root)});
      const authority = await engine.create(createInput(root, createHash("sha256").update(mode).digest("hex")), call());
      const controller = new AbortController();
      const channel = await engine.attachCustody(authority, {
        deadlineEpochMs: Date.now() + 10_000,
        signal: controller.signal,
      });
      const barrier = daemon.pauseNextMutationWrite("before");
      const starting = engine.start(authority, call());
      await barrier.reached;
      if (mode === "close") {await channel.close();}
      if (mode === "error") {daemon.failHijack();}
      if (mode === "abort") {controller.abort();}
      await new Promise<void>(resolve => {setImmediate(resolve);});
      barrier.release();
      await assert.rejects(starting, {code: mode === "abort" ? "aborted" : "daemon-disconnected"});
      const observation = await engine.inspect(authority, call());
      assert.equal(observation.existence, "present");
      if (observation.existence === "present") {assert.equal(observation.state.status, "created");}
      await channel.close();
      controller.abort();
      assert.equal(daemon.hijackCloseCount, 1);
      await assert.rejects(engine.attachCustody(authority, call()), {code: "protocol-violation"});
    });
  }
});

test("attach invokes a private-field-shaped hijack client with its receiver intact", async t => {
  const root = await disposable();
  t.after(async () => {await rm(root, { force: true, recursive: true });});
  const daemon = syntheticDaemon();
  class ReceiverSensitiveClient {
    readonly #delegate = daemon.client;
    public constructor() {
      for (const name of ["buffered", "endpointIdentity", "hijack", "stream"] as const) {
        Object.defineProperty(this, name, {
          configurable: true, enumerable: true, value: ReceiverSensitiveClient.prototype[name], writable: true,
        });
      }
      Object.setPrototypeOf(this, Object.prototype);
    }
    public buffered(...args: Parameters<typeof daemon.client.buffered>) {return this.#delegate.buffered(...args);}
    public endpointIdentity(...args: Parameters<typeof daemon.client.endpointIdentity>) {
      return this.#delegate.endpointIdentity(...args);
    }
    public hijack(...args: Parameters<typeof daemon.client.hijack>) {return this.#delegate.hijack(...args);}
    public stream(...args: Parameters<typeof daemon.client.stream>) {return this.#delegate.stream(...args);}
  }
  const engine = new NodeUnixSocketDockerEngine({
    client: new ReceiverSensitiveClient() as unknown as SyntheticDaemon["client"], policy: policy(root),
  });
  const authority = await engine.create(createInput(root), call());
  const channel = await engine.attachCustody(authority, call());
  await channel.close();
  assert.equal(daemon.hijackCloseCount, 1);
});

test("attach awaits exact hijack closure when the socket dies during post-hijack identity verification", async t => {
  const root = await disposable();
  t.after(async () => {await rm(root, { force: true, recursive: true });});
  const daemon = syntheticDaemon();
  let hijackInput: PassThrough | undefined;
  let closeFinished = false;
  let identityReached!: () => void;
  let releaseIdentity!: () => void;
  const reached = new Promise<void>(resolve => {identityReached = resolve;});
  const identityWait = new Promise<void>(resolve => {releaseIdentity = resolve;});
  let hijacked = false;
  const client = {
    buffered: daemon.client.buffered,
    async endpointIdentity() {
      if (hijacked) {identityReached(); await identityWait;}
      return daemon.client.endpointIdentity();
    },
    async hijack(input: Parameters<typeof daemon.client.hijack>[0]) {
      const raw = await daemon.client.hijack(input);
      hijacked = true;
      hijackInput = raw.input;
      return {...raw, close: async () => {await raw.close(); closeFinished = true;}};
    },
    stream: daemon.client.stream,
  };
  const engine = new NodeUnixSocketDockerEngine({client, policy: policy(root)});
  const authority = await engine.create(createInput(root), call());
  const opening = engine.attachCustody(authority, call());
  await reached;
  hijackInput?.destroy();
  releaseIdentity();
  await assert.rejects(opening, {code: "daemon-disconnected"});
  assert.equal(closeFinished, true);
  assert.equal(daemon.hijackCloseCount, 1);
});

test("attach rejects when post-hijack identity observation resolves after the hard deadline", async t => {
  const root = await disposable();
  t.after(async () => {await rm(root, { force: true, recursive: true });});
  const daemon = syntheticDaemon();
  let identityReached!: () => void;
  let releaseIdentity!: () => void;
  const reached = new Promise<void>(resolve => {identityReached = resolve;});
  const identityWait = new Promise<void>(resolve => {releaseIdentity = resolve;});
  let hijacked = false;
  const client = {
    buffered: daemon.client.buffered,
    async endpointIdentity() {
      if (hijacked) {identityReached(); await identityWait;}
      return daemon.client.endpointIdentity();
    },
    async hijack(input: Parameters<typeof daemon.client.hijack>[0]) {
      const raw = await daemon.client.hijack(input);
      hijacked = true;
      return raw;
    },
    stream: daemon.client.stream,
  };
  const engine = new NodeUnixSocketDockerEngine({client, policy: policy(root)});
  const authority = await engine.create(createInput(root), call());
  const now = Date.now();
  t.mock.timers.enable({apis: ["Date", "setTimeout"], now});
  try {
    const opening = engine.attachCustody(authority, {
      deadlineEpochMs: now + 1_000,
      signal: new AbortController().signal,
    });
    await reached;
    t.mock.timers.setTime(now + 1_001);
    releaseIdentity();
    await assert.rejects(opening, {code: "deadline-exceeded"});
    assert.equal(daemon.hijackCloseCount, 1);
  } finally {
    releaseIdentity();
    t.mock.timers.reset();
  }
});

test("hijack loss after start bytes is acknowledgement-unknown and removal retires the generation", async t => {
  const root = await disposable();
  t.after(async () => {await rm(root, { force: true, recursive: true });});
  const daemon = syntheticDaemon();
  const engine = new NodeUnixSocketDockerEngine({client: daemon.client, policy: policy(root)});
  const authority = await engine.create(createInput(root), call());
  const channel = await engine.attachCustody(authority, call());
  const barrier = daemon.pauseNextMutationWrite("after");
  const starting = engine.start(authority, call());
  await barrier.reached;
  await channel.close();
  barrier.release();
  await assert.rejects(starting, {code: "start-acknowledgement-unknown"});
  assert.equal(daemon.hijackCloseCount, 1);
  await engine.stop(authority, call());
  await engine.remove(authority, call());

  const replacement = await engine.create(createInput(root, "8".repeat(64)), call());
  const replacementChannel = await engine.attachCustody(replacement, call());
  await channel.close();
  await replacementChannel.write(Buffer.from("replacement-generation"));
  await replacementChannel.close();
  assert.equal(daemon.hijackCloseCount, 2);
});

test("error and abort after the start write never return clean started success", async t => {
  const root = await disposable();
  t.after(async () => {await rm(root, { force: true, recursive: true });});
  for (const mode of ["error", "abort"] as const) {
    await t.test(mode, async () => {
      const daemon = syntheticDaemon();
      const engine = new NodeUnixSocketDockerEngine({client: daemon.client, policy: policy(root)});
      const authority = await engine.create(createInput(
        root,
        createHash("sha256").update(`after-${mode}`).digest("hex"),
      ), call());
      const controller = new AbortController();
      await engine.attachCustody(authority, {deadlineEpochMs: Date.now() + 10_000, signal: controller.signal});
      const barrier = daemon.pauseNextMutationWrite("after");
      const starting = engine.start(authority, call());
      await barrier.reached;
      if (mode === "error") {daemon.failHijack();} else {controller.abort();}
      await new Promise<void>(resolve => {setImmediate(resolve);});
      barrier.release();
      await assert.rejects(starting, {code: "start-acknowledgement-unknown"});
      assert.equal(daemon.hijackCloseCount, 1);
    });
  }
});

test("production Engine attach transfers stage ownership to bounded observations", async t => {
  const root = await disposable();
  t.after(async () => {await rm(root, {force: true, recursive: true});});
  const daemon = syntheticDaemon();
  let raw: Awaited<ReturnType<typeof daemon.client.hijack>> | undefined;
  let retainedCall: DockerEngineCall | undefined;
  const client = {...daemon.client, async hijack(input: Parameters<typeof daemon.client.hijack>[0] & {observationCall?: DockerEngineCall}) {
    retainedCall = input.observationCall;
    raw = await daemon.client.hijack(input); return raw;
  }};
  const engine = new NodeUnixSocketDockerEngine({client, policy: policy(root)});
  const authority = await engine.create(createInput(root), call());
  const now = Date.now(); const stage = new AbortController(); const observations = new AbortController();
  t.mock.timers.enable({apis: ["Date", "setTimeout"], now});
  try {
    const observationCall = {signal: observations.signal, deadlineEpochMs: now + 10_000};
    const channel = await engine.attachCustody(authority, {signal: stage.signal, deadlineEpochMs: now + 1000}, observationCall);
    assert.equal(retainedCall?.deadlineEpochMs, observationCall.deadlineEpochMs);
    assert.equal(retainedCall?.signal.aborted, false);
    stage.abort(); t.mock.timers.tick(1001);
    await engine.start(authority, call());
    const reader = channel.output[Symbol.asyncIterator]();
    (raw!.output as PassThrough).write(multiplex(1, Buffer.from("tail")));
    assert.equal(Buffer.from((await reader.next()).value!).toString(), "tail");
    assert.equal(daemon.hijackCloseCount, 0);
    t.mock.timers.tick(9000);
    await new Promise<void>(resolve => {setImmediate(resolve);});
    assert.equal(daemon.hijackCloseCount, 1);
    await channel.close();
  } finally {t.mock.timers.reset();}
});
