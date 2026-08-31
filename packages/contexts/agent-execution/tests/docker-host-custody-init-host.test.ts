import assert from "node:assert/strict";
import {test} from "node:test";

import type {DockerCustodyDuplexChannel} from "../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/engine/docker-engine-port.js";
import {
  DockerCustodyInitHostSession,
  type DockerCustodyInitHostOptions,
} from "../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/init/docker-custody-init-host-session.js";
import {
  DOCKER_CUSTODY_INIT_PROTOCOL,
  DockerCustodyFrameDecoder,
  encodeDockerCustodyFrame,
  type DockerCustodyIdentity,
  type DockerCustodyProtocolMessage,
} from "../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/init/docker-custody-init-protocol.js";

const digest = (character: string): string => character.repeat(64);
const identity: DockerCustodyIdentity = Object.freeze({containerImageSha256: digest("a"), initBinarySha256: digest("b"),
  privateRootIdentity: "private-root:g1", protocol: DOCKER_CUSTODY_INIT_PROTOCOL,
  securityProfileIdentity: "security:g1", workspaceIdentity: "workspace:g1"});
const ready = Object.freeze({kind: "init-ready" as const, launchFingerprintSha256: digest("c"), nonce: "nonce:g1",
  observedIdentity: identity, protocol: DOCKER_CUSTODY_INIT_PROTOCOL});
const ack = Object.freeze({kind: "provider-exec-ack" as const, observation: "started" as const, requestId: "request:g1"});
const root = Object.freeze({exitCode: 17, kind: "provider-observation" as const, observation: "root-exited" as const,
  requestId: "request:g1", signal: null, treeEmptyClaim: "not-claimed" as const});
const drain = Object.freeze({kind: "provider-drain-complete" as const, outerContainmentClaim: "unproven" as const,
  requestId: "request:g1", rootExit: "observed" as const, stderr: "eof" as const, stdout: "eof" as const});

class FakeChannel implements DockerCustodyDuplexChannel {
  readonly #pending: Array<(value: IteratorResult<Uint8Array>) => void> = [];
  readonly #values: Uint8Array[] = [];
  public closeCalls = 0;
  public closeInputCalls = 0;
  public writeGate: Promise<void> | undefined;
  public readonly writes: DockerCustodyProtocolMessage[] = [];
  public readonly output: AsyncIterable<Uint8Array> = {[Symbol.asyncIterator]: () => ({
    next: () => {
      const value = this.#values.shift();
      if (value !== undefined) {return Promise.resolve({done: false, value});}
      return new Promise(resolve => {this.#pending.push(resolve);});
    },
    return: async () => ({done: true, value: undefined}),
  })};

  public async close(): Promise<void> {
    this.closeCalls += 1;
    for (const resolve of this.#pending.splice(0)) {resolve({done: true, value: undefined});}
  }
  public async closeInput(): Promise<void> {this.closeInputCalls += 1;}
  public async write(bytes: Uint8Array): Promise<void> {
    if (this.writeGate !== undefined) {await this.writeGate;}
    const decoder = new DockerCustodyFrameDecoder();
    this.writes.push(...decoder.push(bytes)); decoder.finish();
  }
  public pushBytes(bytes: Uint8Array): void {
    const resolve = this.#pending.shift();
    if (resolve === undefined) {this.#values.push(bytes);} else {resolve({done: false, value: bytes});}
  }
  public push(...messages: readonly DockerCustodyProtocolMessage[]): void {
    this.pushBytes(Buffer.concat(messages.map(message => Buffer.from(encodeDockerCustodyFrame(message)))));
  }
}

const create = (channel = new FakeChannel(), overrides: Partial<DockerCustodyInitHostOptions> = {}) => {
  const options: DockerCustodyInitHostOptions = {acknowledgementTimeoutMs: 50,
    authority: {expectedIdentity: identity, generation: "generation:g1", launchFingerprintSha256: digest("c"), operationNonce: "nonce:g1"},
    channel, exec: {argv: ["provider-entrypoint"], environment: [], executableSha256: digest("d"), gid: 1000,
      requestId: "request:g1", uid: 1000, wallDeadlineUnixMs: 9_999_999_999_999}, isCurrentGeneration: value => value === "generation:g1",
    maximumStderrBytes: 100, maximumStdoutBytes: 100, readyTimeoutMs: 50, ...overrides};
  return {channel, session: new DockerCustodyInitHostSession(options)};
};
const tick = (): Promise<void> => new Promise(resolve => {setImmediate(resolve);});

test("fragmented ready and coalesced acknowledgement/output/exit/drain produce exact closed evidence", async () => {
  const chunks: string[] = []; const observations: unknown[] = []; const {channel, session} = create(new FakeChannel(),
    {onDrainComplete: value => {observations.push(value);}, onOutput: chunk => {
    chunks.push(`${chunk.stream}:${Buffer.from(chunk.bytes).toString()}`);
  }, onRootExit: value => {observations.push(value);}});
  const frame = encodeDockerCustodyFrame(ready); channel.pushBytes(frame.subarray(0, 3)); channel.pushBytes(frame.subarray(3));
  channel.push(ack, {bytesBase64: Buffer.from("out").toString("base64"), kind: "provider-output", requestId: "request:g1", stream: "stdout"}, root, drain);
  assert.deepEqual(await session.completion, {acknowledgement: "started", drain: {outerContainmentClaim: "unproven", rootExit: "observed", stderr: "eof", stdout: "eof"},
    generation: "generation:g1", kind: "closed", rootExit: {exitCode: 17, signal: null}, stderrBytes: 0, stdoutBytes: 3});
  assert.deepEqual(chunks, ["stdout:out"]);
  assert.deepEqual(observations, [{exitCode: 17, signal: null},
    {outerContainmentClaim: "unproven", rootExit: "observed", stderr: "eof", stdout: "eof"}]);
  assert.deepEqual(channel.writes.map(message => message.kind), ["host-handshake", "provider-exec"]);
  assert.deepEqual(Object.keys(channel.writes[0] ?? {}).toSorted(), ["expectedIdentity", "kind", "launchFingerprintSha256", "nonce", "protocol"]);
});

test("late frames are rejected independently of transport chunking", async () => {
  const {channel, session} = create();
  channel.pushBytes(encodeDockerCustodyFrame(ready)); await tick();
  channel.pushBytes(encodeDockerCustodyFrame(ack));
  channel.pushBytes(encodeDockerCustodyFrame(root));
  channel.pushBytes(encodeDockerCustodyFrame(drain));
  channel.pushBytes(encodeDockerCustodyFrame({bytesBase64: Buffer.from("late").toString("base64"),
    kind: "provider-output", requestId: "request:g1", stream: "stdout"}));
  assert.deepEqual(await session.completion, {generation: "generation:g1", kind: "failed", reason: "protocol-violation"});
});

test("fragmented input retains one acknowledgement deadline and cancellation wakes the read loop", async t => {
  await t.test("deadline", async () => {
    const {channel, session} = create(new FakeChannel(), {acknowledgementTimeoutMs: 15});
    channel.push(ready); await tick();
    const frame = encodeDockerCustodyFrame(ack);
    channel.pushBytes(frame.subarray(0, 2));
    setTimeout(() => {channel.pushBytes(frame.subarray(2, 4));}, 10);
    setTimeout(() => {channel.pushBytes(frame.subarray(4));}, 20);
    assert.deepEqual(await session.completion, {generation: "generation:g1", kind: "unknown", reason: "acknowledgement-lost"});
  });
  await t.test("cancel", async () => {
    const {channel, session} = create();
    const frame = encodeDockerCustodyFrame(ready); channel.pushBytes(frame.subarray(0, 2)); await tick();
    const cancelled = await session.cancel();
    assert.strictEqual(await session.completion, cancelled);
    assert.deepEqual(cancelled, {generation: "generation:g1", kind: "failed", reason: "cancelled"});
  });
});

test("wrong identity and a stale generation poison before provider exec", async t => {
  for (const variant of ["identity", "generation"] as const) {await t.test(variant, async () => {
    let current = true; const channel = new FakeChannel(); const {session} = create(channel,
      {isCurrentGeneration: () => current});
    if (variant === "generation") {current = false; channel.push(ready);} else {
      channel.push({...ready, observedIdentity: {...identity, workspaceIdentity: "workspace:wrong"}});
    }
    assert.deepEqual(await session.completion, {generation: "generation:g1", kind: "failed", reason: "protocol-violation"});
    assert.equal(channel.writes.some(message => message.kind === "provider-exec"), false);
  });}
});

test("generation drift fences runtime callbacks and closed evidence", async t => {
  for (const event of ["output", "root", "drain"] as const) {await t.test(event, async () => {
    let current = true; const callbacks: string[] = [];
    const {channel, session} = create(new FakeChannel(), {isCurrentGeneration: () => current,
      onDrainComplete: () => {callbacks.push("drain"); if (event === "drain") {current = false;}},
      onOutput: () => {callbacks.push("output"); if (event === "output") {current = false;}},
      onRootExit: () => {callbacks.push("root"); if (event === "root") {current = false;}}});
    channel.push(ready); await tick();
    channel.push(ack, {bytesBase64: Buffer.from("out").toString("base64"), kind: "provider-output",
      requestId: "request:g1", stream: "stdout"}, root, drain);
    assert.deepEqual(await session.completion, {generation: "generation:g1", kind: "failed", reason: "protocol-violation"});
    assert.deepEqual(callbacks, event === "output" ? ["output"] : event === "root" ? ["output", "root"] : ["output", "root", "drain"]);
  });}
  await t.test("before event", async () => {
    let current = true; let outputCalls = 0; const {channel, session} = create(new FakeChannel(),
      {isCurrentGeneration: () => current, onOutput: () => {outputCalls += 1;}});
    channel.push(ready); await tick(); channel.push(ack); await tick(); current = false;
    channel.push({bytesBase64: Buffer.from("stale").toString("base64"), kind: "provider-output",
      requestId: "request:g1", stream: "stdout"});
    assert.deepEqual(await session.completion, {generation: "generation:g1", kind: "failed", reason: "protocol-violation"});
    assert.equal(outputCalls, 0);
  });
});

test("duplicate and out-of-order ready or acknowledgement frames poison permanently", async t => {
  for (const [messages, kind] of [[[ready, ready], "failed"], [[ack], "failed"]] as const) {await t.test(messages.map(item => item.kind).join(","), async () => {
    const {channel, session} = create(); channel.push(...messages);
    assert.equal((await session.completion).kind, kind);
    assert.equal((await session.close()).kind, kind);
  });}
  await t.test("duplicate acknowledgement", async () => {
    const {channel, session} = create(); channel.push(ready); await tick(); channel.push(ack, ack);
    assert.equal((await session.completion).kind, "unknown");
    assert.equal((await session.close()).kind, "unknown");
  });
});

test("unknown-key, malformed, and oversized frames are rejected and release the channel", async t => {
  for (const variant of ["unknown", "malformed", "oversized"] as const) {await t.test(variant, async () => {
    const {channel, session} = create();
    if (variant === "unknown") {
      const payload = Buffer.from(JSON.stringify({...ready, surprise: true})); const bytes = Buffer.alloc(payload.length + 4);
      bytes.writeUInt32BE(payload.length); payload.copy(bytes, 4); channel.pushBytes(bytes);
    } else if (variant === "malformed") {channel.pushBytes(Uint8Array.of(0, 0, 0, 1, 123));}
    else {channel.pushBytes(Uint8Array.of(0, 1, 0, 1));}
    assert.deepEqual(await session.completion, {generation: "generation:g1", kind: "failed", reason: "protocol-violation"});
    assert.equal(channel.closeCalls, 1);
  });}
});

test("abort before exec is failed while abort after exec write is typed unknown and never retried", async t => {
  await t.test("before", async () => {
    const abort = new AbortController(); const {channel, session} = create(new FakeChannel(), {signal: abort.signal});
    abort.abort();
    assert.deepEqual(await session.completion, {generation: "generation:g1", kind: "failed", reason: "cancelled"});
    assert.equal(channel.writes.filter(message => message.kind === "provider-exec").length, 0);
  });
  await t.test("after", async () => {
    const abort = new AbortController(); const {channel, session} = create(new FakeChannel(), {signal: abort.signal});
    channel.push(ready); await tick(); abort.abort();
    assert.deepEqual(await session.completion, {generation: "generation:g1", kind: "unknown", reason: "acknowledgement-lost"});
    assert.equal(channel.writes.filter(message => message.kind === "provider-exec").length, 1);
  });
});

test("acknowledgement loss settles unknown without a retry", async () => {
  const {channel, session} = create(new FakeChannel(), {acknowledgementTimeoutMs: 5}); channel.push(ready);
  assert.deepEqual(await session.completion, {generation: "generation:g1", kind: "unknown", reason: "acknowledgement-lost"});
  assert.equal(channel.writes.filter(message => message.kind === "provider-exec").length, 1);
});

test("provider input, EOF, signal and callback backpressure use the retained channel commits", async () => {
  let release!: () => void; const observed = new Promise<void>(resolve => {release = resolve;});
  const {channel, session} = create(new FakeChannel(), {onOutput: () => observed});
  channel.push(ready); await tick(); channel.push(ack); await tick();
  let unblockWrite!: () => void; channel.writeGate = new Promise(resolve => {unblockWrite = resolve;});
  const inputWrite = session.writeInput(Buffer.from("input")); let committed = false;
  void inputWrite.then(() => {committed = true; return null;}); await tick(); assert.equal(committed, false);
  unblockWrite(); channel.writeGate = undefined;
  assert.deepEqual(await inputWrite, {committedBytes: 5, kind: "committed"});
  assert.deepEqual(await session.closeProviderInput(), {committedBytes: 0, kind: "committed"});
  assert.deepEqual(await session.closeProviderInput(), {committedBytes: 0, kind: "closed"});
  assert.deepEqual(await session.signal("SIGTERM"), {committedBytes: 0, kind: "committed"});
  channel.push({bytesBase64: Buffer.from("held").toString("base64"), kind: "provider-output", requestId: "request:g1", stream: "stderr"}, root, drain);
  await tick(); assert.equal(channel.closeCalls, 0); release(); assert.equal((await session.completion).kind, "closed");
  assert.deepEqual(channel.writes.slice(2).map(message => message.kind), ["provider-input", "provider-input-eof", "host-signal"]);
  assert.equal(channel.closeInputCalls, 0);
});

test("output overflow and output after drain cannot become closed success", async t => {
  await t.test("overflow", async () => {
    const {channel, session} = create(new FakeChannel(), {maximumStdoutBytes: 2});
    channel.push(ready); await tick(); channel.push(ack,
      {bytesBase64: Buffer.from("too big").toString("base64"), kind: "provider-output", requestId: "request:g1", stream: "stdout"});
    assert.deepEqual(await session.completion, {generation: "generation:g1", kind: "failed", reason: "output-limit"});
  });
  await t.test("late coalesced", async () => {
    const {channel, session} = create(); channel.push(ready); await tick(); channel.push(ack, root, drain,
      {bytesBase64: Buffer.from("late").toString("base64"), kind: "provider-output", requestId: "request:g1", stream: "stdout"});
    assert.deepEqual(await session.completion, {generation: "generation:g1", kind: "failed", reason: "protocol-violation"});
  });
});

test("drain before exact root exit is rejected and root exit alone does not close", async t => {
  await t.test("out of order", async () => {
    const {channel, session} = create(); channel.push(ready); await tick(); channel.push(ack, drain);
    assert.deepEqual(await session.completion, {generation: "generation:g1", kind: "failed", reason: "protocol-violation"});
  });
  await t.test("root only", async () => {
    const {channel, session} = create(); channel.push(ready); await tick(); channel.push(ack, root); await tick();
    assert.equal(channel.closeCalls, 0); await session.cancel();
    assert.equal((await session.completion).kind, "failed");
  });
});

test("cancel and close are idempotent, terminal, and clean abort listeners/channel authority", async () => {
  const abort = new AbortController(); const {channel, session} = create(new FakeChannel(), {signal: abort.signal});
  const first = await session.cancel(); abort.abort(); const second = await session.close();
  assert.strictEqual(first, second); assert.deepEqual(first, {generation: "generation:g1", kind: "failed", reason: "cancelled"});
  assert.equal(channel.closeCalls, 1); assert.deepEqual(await session.writeInput(Buffer.from("late")), {committedBytes: 0, kind: "closed"});
});

test("cancel settles completion while a runtime callback remains backpressured", async () => {
  const blocked = new Promise<void>(() => {}); const {channel, session} = create(new FakeChannel(), {onOutput: () => blocked});
  channel.push(ready); await tick(); channel.push(ack); await tick();
  channel.push({bytesBase64: Buffer.from("held").toString("base64"), kind: "provider-output",
    requestId: "request:g1", stream: "stdout"}); await tick();
  const cancelled = await session.cancel();
  assert.strictEqual(await session.completion, cancelled);
  assert.deepEqual(cancelled, {generation: "generation:g1", kind: "failed", reason: "cancelled"});
});
