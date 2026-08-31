import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import {
  DOCKER_CUSTODY_INIT_MAX_FRAME_BYTES,
  DOCKER_CUSTODY_INIT_PROTOCOL,
  DockerCustodyFrameDecoder,
  DockerCustodyProtocolError,
  encodeDockerCustodyFrame,
  parseDockerCustodyProtocolMessage,
  type DockerCustodyChildSignal,
  type DockerCustodyHostHandshake,
  type DockerCustodyIdentity,
  type DockerCustodyInitMessage,
  type DockerCustodyProviderExecRequest,
} from "../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/init/docker-custody-init-protocol.js";
import {
  DockerCustodyInitRuntime,
  type DockerCustodyInitSyscalls,
  type DockerCustodyOutputWriteResult,
  type DockerCustodyProviderOutputHandle,
  type DockerCustodyProviderSpawn,
  type DockerCustodyProviderRootHandle,
  type DockerCustodyReapedDescendant,
} from "../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/init/docker-custody-init-runtime.js";

const digest = (digit: string): string => digit.repeat(64);
const framePayload = (payload: Buffer): Buffer => {
  const frame = Buffer.alloc(payload.byteLength + 4); frame.writeUInt32BE(payload.byteLength, 0); payload.copy(frame, 4); return frame;
};
const identity: DockerCustodyIdentity = Object.freeze({
  containerImageSha256: digest("a"),
  initBinarySha256: digest("b"),
  privateRootIdentity: "private-root:attempt-1",
  protocol: DOCKER_CUSTODY_INIT_PROTOCOL,
  securityProfileIdentity: "security-profile:strict-v1",
  workspaceIdentity: "workspace:attempt-1",
});
const handshake: DockerCustodyHostHandshake = Object.freeze({
  expectedIdentity: identity,
  kind: "host-handshake",
  launchFingerprintSha256: digest("c"),
  nonce: "host-nonce:one",
  protocol: DOCKER_CUSTODY_INIT_PROTOCOL,
});
const request = (overrides: Partial<DockerCustodyProviderExecRequest> = {}): DockerCustodyProviderExecRequest => Object.freeze({
  argv: Object.freeze(["provider", "serve"]),
  environment: Object.freeze([Object.freeze({ name: "HOME", value: "/private/home" })]),
  executableSha256: digest("d"),
  executableSlot: "provider-entrypoint",
  gid: 10001,
  handshakeNonce: "host-nonce:one",
  kind: "provider-exec",
  launchFingerprintSha256: digest("c"),
  requestId: "exec-request:one",
  uid: 10001,
  wallDeadlineUnixMs: 20_000,
  ...overrides,
});

const opaqueRootHandle = (kernelIdentity: string): DockerCustodyProviderRootHandle => {
  const handle = {};
  Object.defineProperty(handle, "kernelIdentity", {enumerable: false, value: kernelIdentity});
  return Object.freeze(handle) as unknown as DockerCustodyProviderRootHandle;
};
const opaqueOutputHandle = (kernelIdentity: string): DockerCustodyProviderOutputHandle => {
  const handle = {};
  Object.defineProperty(handle, "kernelIdentity", {enumerable: false, value: kernelIdentity});
  return Object.freeze(handle) as unknown as DockerCustodyProviderOutputHandle;
};

class FakeSyscalls implements DockerCustodyInitSyscalls {
  public containment: string[] = [];
  public containmentOutcomes: Array<"accepted" | "failed" | "throw"> = [];
  public input: Uint8Array[] = [];
  public inputStatus: "accepted" | "blocked" | "closed" = "accepted";
  public monotonic = 1_000;
  public output: Array<{ readonly bytes: Uint8Array; readonly stream: "stderr" | "stdout" }> = [];
  public outputOutcomes: DockerCustodyOutputWriteResult[] = [];
  public outputStatus: "accepted" | "blocked" = "accepted";
  public readonly providerRootHandle = opaqueRootHandle("pidfd:provider-root:one");
  public reaped: DockerCustodyReapedDescendant[] = [];
  public rootObservations: DockerCustodyProviderRootHandle[] = [];
  public rootExits: Array<{readonly exitCode: number | null; readonly handle: DockerCustodyProviderRootHandle; readonly signal: DockerCustodyChildSignal | null}> = [];
  public rootPid = 41;
  public signalFailure = false;
  public signals: Array<{ readonly handle: DockerCustodyProviderRootHandle; readonly signal: "SIGHUP" | "SIGINT" | "SIGKILL" | "SIGQUIT" | "SIGTERM" | "SIGUSR1" | "SIGUSR2" }> = [];
  public spawnOutcome: "ambiguous-error" | "not-started" | "started" = "started";
  public spawns: DockerCustodyProviderSpawn[] = [];
  public readonly stderrHandle = opaqueOutputHandle("pipe:provider-root:one:stderr");
  public readonly stdoutHandle = opaqueOutputHandle("pipe:provider-root:one:stdout");
  public wall = 10_000;

  public assertNoNewPrivileges(): void {}
  public assertDirectChildOfContainerInit(): void {}
  public closeProviderInput(): void {this.inputStatus = "closed";}
  public monotonicNowMs(): number {return this.monotonic;}
  public observeProviderRootExit(handle: DockerCustodyProviderRootHandle): {readonly exitCode: number | null; readonly signal: DockerCustodyChildSignal | null} | null {
    this.rootObservations.push(handle);
    const index = this.rootExits.findIndex(item => item.handle === handle);
    if (index < 0) {return null;}
    const [observed] = this.rootExits.splice(index, 1); return observed ?? null;
  }
  public observeIdentity(): DockerCustodyIdentity {return identity;}
  public reapExitedDescendants(): readonly DockerCustodyReapedDescendant[] {return this.reaped.splice(0);}
  public requestContainerContainment(reason: string): "accepted" | "failed" {
    this.containment.push(reason);
    const outcome = this.containmentOutcomes.shift() ?? "accepted";
    if (outcome === "throw") {throw new Error("synthetic containment syscall failure");}
    return outcome;
  }
  public signalProviderRoot(handle: DockerCustodyProviderRootHandle, signal: "SIGHUP" | "SIGINT" | "SIGKILL" | "SIGQUIT" | "SIGTERM" | "SIGUSR1" | "SIGUSR2"): "sent" {
    this.signals.push({ handle, signal });
    if (this.signalFailure) {throw new Error("synthetic signal failure");}
    return "sent";
  }
  public spawnProvider(spawn: DockerCustodyProviderSpawn): ReturnType<DockerCustodyInitSyscalls["spawnProvider"]> {
    this.spawns.push(spawn);
    if (this.spawnOutcome === "ambiguous-error") {throw new Error("synthetic ambiguous spawn failure");}
    if (this.spawnOutcome === "not-started") {return { kind: "not-started" };}
    return {handle: this.providerRootHandle, kind: "started", pid: this.rootPid, stderr: this.stderrHandle, stdout: this.stdoutHandle};
  }
  public wallNowUnixMs(): number {return this.wall;}
  public writeProviderInput(bytes: Uint8Array): "accepted" | "blocked" | "closed" {
    if (this.inputStatus === "accepted") {this.input.push(bytes.slice());}
    return this.inputStatus;
  }
  public writeProviderOutput(stream: "stderr" | "stdout", bytes: Uint8Array): DockerCustodyOutputWriteResult {
    const result = this.outputOutcomes.shift() ?? (this.outputStatus === "accepted"
      ? {committedBytes: bytes.byteLength, status: "accepted" as const}
      : {committedBytes: 0, status: "blocked" as const});
    if (Number.isSafeInteger(result.committedBytes) && result.committedBytes > 0 && result.committedBytes <= bytes.byteLength) {
      this.output.push({bytes: bytes.subarray(0, result.committedBytes).slice(), stream});
    }
    return result;
  }
}

const fixture = (changes: {
  readonly syscalls?: FakeSyscalls;
  readonly writeControl?: (message: DockerCustodyInitMessage) => "accepted" | "blocked";
} = {}) => {
  const syscalls = changes.syscalls ?? new FakeSyscalls();
  const control: DockerCustodyInitMessage[] = [];
  const runtime = new DockerCustodyInitRuntime({
    allowedEnvironmentNames: Object.freeze(["HOME", "LANG"]),
    executablePath: "/immutable/provider",
    executableSha256: digest("d"),
    maximumStderrBytes: 8,
    maximumStdinBytes: 8,
    maximumStdoutBytes: 8,
    maximumProviderRuntimeMs: 30_000,
    observedIdentity: identity,
    shutdownGraceMs: 50,
    syscalls,
    writeControl: changes.writeControl ?? (message => {control.push(message); return "accepted";}),
  });
  return { control, runtime, syscalls };
};

test("framing is canonical, bounded, exact-key validated, detached, and deeply frozen", () => {
  const mutable = {
    ...handshake,
    expectedIdentity: { ...identity },
  };
  const encoded = encodeDockerCustodyFrame(mutable);
  assert.equal(new DataView(encoded.buffer, encoded.byteOffset, 4).getUint32(0), encoded.byteLength - 4);
  const decoder = new DockerCustodyFrameDecoder();
  assert.deepEqual(decoder.push(encoded.subarray(0, 7)), []);
  const [decoded] = decoder.push(encoded.subarray(7));
  decoder.finish();
  assert.deepEqual(decoded, handshake);
  assert(Object.isFrozen(decoded));
  assert(decoded?.kind === "host-handshake" && Object.isFrozen(decoded.expectedIdentity));
  mutable.expectedIdentity.workspaceIdentity = "workspace:mutated";
  assert(decoded?.kind === "host-handshake" && decoded.expectedIdentity.workspaceIdentity === "workspace:attempt-1");

  assert.throws(() => parseDockerCustodyProtocolMessage({ ...handshake, credential: "forbidden" }), DockerCustodyProtocolError);
  assert.throws(() => parseDockerCustodyProtocolMessage({ ...handshake, expectedIdentity: { ...identity, workspaceIdentity: "/raw/host/path" } }), /token/u);
  assert.throws(() => parseDockerCustodyProtocolMessage({ ...request(), argv: [] }), /argv/u);
  assert.deepEqual(parseDockerCustodyProtocolMessage({ ...request(), argv: ["provider", ""], environment: [{ name: "EMPTY", value: "" }] }), {
    ...request(), argv: ["provider", ""], environment: [{ name: "EMPTY", value: "" }],
  });
  assert.throws(() => parseDockerCustodyProtocolMessage({ ...request(), environment: [{ name: "HOME", value: "x" }, { name: "HOME", value: "y" }] }), /unique/u);
  assert.throws(() => new DockerCustodyFrameDecoder().push(Uint8Array.of(0, 1, 0, 1)), /length/u);
  assert.throws(() => new DockerCustodyFrameDecoder().push(new Uint8Array(DOCKER_CUSTODY_INIT_MAX_FRAME_BYTES + 5)), /length|bound/u);
  assert.throws(() => new DockerCustodyFrameDecoder().push(Uint8Array.of(0, 0, 0, 1, 123)), /malformed/u);
  const canonicalPayload = Buffer.from(encoded).subarray(4);
  const noncanonicalPayload = Buffer.concat([Buffer.from(" "), canonicalPayload]);
  const noncanonical = Buffer.alloc(noncanonicalPayload.byteLength + 4);
  noncanonical.writeUInt32BE(noncanonicalPayload.byteLength, 0);
  noncanonicalPayload.copy(noncanonical, 4);
  assert.throws(() => new DockerCustodyFrameDecoder().push(noncanonical), /canonical/u);
  const partial = new DockerCustodyFrameDecoder();
  partial.push(encoded.subarray(0, 6));
  assert.throws(() => partial.finish(), /partial/u);
});

test("one attested handshake launches one exact non-root provider without custody descriptors", () => {
  const { control, runtime, syscalls } = fixture();
  runtime.receive(handshake);
  runtime.receive(request());
  assert.deepEqual(control.map(message => message.kind), ["init-ready", "provider-exec-ack"]);
  assert.deepEqual(control[0], {
    kind: "init-ready", launchFingerprintSha256: digest("c"), nonce: "host-nonce:one",
    observedIdentity: identity, protocol: DOCKER_CUSTODY_INIT_PROTOCOL,
  });
  assert.equal(syscalls.spawns.length, 1);
  assert.deepEqual(syscalls.spawns[0], {
    argv: ["provider", "serve"],
    clearSupplementaryGroups: true,
    environment: { HOME: "/private/home" },
    executablePath: "/immutable/provider",
    executableSha256: digest("d"),
    gid: 10001,
    inheritedDescriptors: [0, 1, 2],
    noNewPrivileges: true,
    shell: false,
    uid: 10001,
  });
  assert.throws(() => runtime.receive(handshake), /duplicate/u);
  assert.throws(() => runtime.receive(request({ requestId: "exec-request:two" })), /duplicate|sealed/u);
  assert.equal(syscalls.spawns.length, 1);
});

test("identity mismatch, wrong executable, disallowed environment, and expired request fail closed", () => {
  const mismatched = fixture();
  assert.throws(() => mismatched.runtime.receive({ ...handshake, expectedIdentity: { ...identity, workspaceIdentity: "workspace:other" } }), /identity/u);
  assert.equal(mismatched.syscalls.spawns.length, 0);

  for (const invalid of [
    request({ executableSha256: digest("e") }),
    request({ handshakeNonce: "host-nonce:other" }),
    request({ launchFingerprintSha256: digest("e") }),
    request({ environment: Object.freeze([{ name: "LD_PRELOAD", value: "payload" }]) }),
    request({ wallDeadlineUnixMs: 9_999 }),
  ]) {
    const current = fixture();
    current.runtime.receive(handshake);
    current.runtime.receive(invalid);
    assert.equal(current.syscalls.spawns.length, 0);
    assert.deepEqual(current.control.slice(1).map(message => message.kind), ["provider-exec-ack", "provider-observation"]);
    assert(current.control[1]?.kind === "provider-exec-ack" && current.control[1].observation === "not-started");
  }
});

test("a thrown provider-exec acknowledgement poisons the generation and cannot be followed by evidence", () => {
  const messages: DockerCustodyInitMessage[] = [];
  let loseAck = true;
  const current = fixture({
    writeControl(message) {
      if (message.kind === "provider-exec-ack" && loseAck) {loseAck = false; throw new Error("synthetic lost ack");}
      messages.push(message); return "accepted";
    },
  });
  current.runtime.receive(handshake);
  current.runtime.receive(request());
  assert.equal(current.runtime.snapshot().acknowledgement, "lost");
  current.runtime.reportLostAcknowledgement(); current.runtime.reportLostAcknowledgement();
  assert.equal(current.syscalls.spawns.length, 1);
  assert.equal(messages.filter(message => message.kind === "provider-exec-ack").length, 0);
  assert.equal(messages.filter(message => message.kind === "provider-observation").length, 0);
  assert.equal(current.runtime.snapshot().phase, "failed");
  assert.deepEqual(current.syscalls.containment, ["init-failure"]);
});

test("PID1 tracks only the provider root, reaps descendants and zombies, and never claims tree empty", () => {
  const current = fixture();
  current.runtime.receive(handshake);
  current.runtime.receive(request());
  current.syscalls.reaped.push(
    { exitCode: 0, pid: 90, signal: null },
    { exitCode: null, pid: 91, signal: "SIGKILL" },
    { exitCode: 0, pid: 92, signal: null },
  );
  current.syscalls.rootExits.push({exitCode: 7, handle: current.syscalls.providerRootHandle, signal: null});
  current.runtime.tick();
  const state = current.runtime.snapshot();
  assert.equal(state.phase, "provider-exited");
  assert.equal(state.descendantsReaped, 3);
  const observation = current.control.find(message => message.kind === "provider-observation");
  assert.deepEqual(observation, {
    exitCode: 7, kind: "provider-observation", observation: "root-exited",
    requestId: "exec-request:one", signal: null, treeEmptyClaim: "not-claimed",
  });
  assert.equal(state.stdout.status, "open");
  current.runtime.closeProviderOutput(current.syscalls.stdoutHandle);
  current.runtime.closeProviderOutput(current.syscalls.stderrHandle);
  assert.equal(current.runtime.acceptProviderOutput(current.syscalls.stdoutHandle, Buffer.from("late")), "closed");
});

test("an invalid descendant reap makes failure absorbing before a same-tick root exit", () => {
  const current = fixture();
  current.runtime.receive(handshake); current.runtime.receive(request());
  current.runtime.closeProviderOutput(current.syscalls.stdoutHandle); current.runtime.closeProviderOutput(current.syscalls.stderrHandle);
  current.syscalls.reaped.push({exitCode: null, pid: 90, signal: null});
  current.syscalls.rootExits.push({exitCode: 0, handle: current.syscalls.providerRootHandle, signal: null});
  current.runtime.tick(); current.runtime.tick();
  assert.equal(current.runtime.snapshot().phase, "failed");
  assert.equal(current.runtime.snapshot().providerRootTracked, true);
  assert.equal(current.control.some(message => message.kind === "provider-observation" && message.observation === "root-exited"), false);
  assert.equal(current.control.some(message => message.kind === "provider-drain-complete"), false);
  assert.deepEqual(current.syscalls.containment, ["init-failure"]);
});

test("output, input, and blocked-drain accounting is bounded and content-free", () => {
  const current = fixture();
  current.runtime.receive(handshake);
  current.runtime.receive(request());
  assert.equal(current.runtime.acceptProviderOutput(current.syscalls.stdoutHandle, Buffer.from("1234")), "accepted");
  current.syscalls.outputStatus = "blocked";
  assert.equal(current.runtime.acceptProviderOutput(current.syscalls.stderrHandle, Buffer.from("xx")), "blocked");
  assert.equal(current.runtime.acceptProviderOutput(current.syscalls.stderrHandle, Buffer.from("must-wait")), "blocked");
  assert.equal(current.syscalls.output.length, 1);
  assert.equal(current.runtime.snapshot().stderr.status, "blocked");
  current.syscalls.outputStatus = "accepted";
  assert.equal(current.runtime.outputDrainReady(current.syscalls.stderrHandle), "accepted");
  assert.equal(current.runtime.snapshot().stderr.status, "open");
  assert.equal(current.runtime.writeProviderInput(Buffer.from("1234")), "accepted");
  current.syscalls.inputStatus = "blocked";
  assert.equal(current.runtime.writeProviderInput(Buffer.from("x")), "blocked");
  current.syscalls.inputStatus = "accepted";
  assert.equal(current.runtime.writeProviderInput(Buffer.from("must-wait")), "blocked");
  current.runtime.stdinDrainReady();
  assert.equal(current.runtime.writeProviderInput(Buffer.from("56789")), "closed");
  assert.equal(current.runtime.acceptProviderOutput(current.syscalls.stdoutHandle, Buffer.from("56789")), "overflow");
  const snapshot = current.runtime.snapshot();
  assert.equal(snapshot.stdout.bytes, 4);
  assert.equal(snapshot.stdout.status, "overflow");
  assert(!JSON.stringify(snapshot).includes("1234"));
  assert.deepEqual(current.syscalls.signals.map(item => item.signal), ["SIGTERM"]);
});

test("partial writes retain an exact suffix cursor through blocking and EOF", () => {
  const current = fixture();
  current.runtime.receive(handshake); current.runtime.receive(request());
  current.syscalls.outputOutcomes.push(
    {committedBytes: 2, status: "blocked"},
    {committedBytes: 1, status: "blocked"},
    {committedBytes: 1, status: "accepted"},
  );
  const mutableChunk = Buffer.from("abcd");
  assert.equal(current.runtime.acceptProviderOutput(current.syscalls.stdoutHandle, mutableChunk), "blocked");
  mutableChunk.fill("z");
  assert.deepEqual(current.syscalls.output.map(item => Buffer.from(item.bytes).toString()), ["ab"]);
  assert.equal(current.runtime.snapshot().stdout.bytes, 2);
  assert.equal(current.runtime.snapshot().stdout.sha256, createHash("sha256").update("ab").digest("hex"));
  assert.equal(current.runtime.closeProviderOutput(current.syscalls.stdoutHandle), "deferred");
  assert.equal(current.runtime.outputDrainReady(current.syscalls.stdoutHandle), "blocked");
  assert.equal(current.runtime.snapshot().stdout.bytes, 3);
  assert.equal(current.runtime.outputDrainReady(current.syscalls.stdoutHandle), "accepted");
  assert.deepEqual(current.syscalls.output.map(item => Buffer.from(item.bytes).toString()), ["ab", "c", "d"]);
  assert.deepEqual(current.runtime.snapshot().stdout, {
    bytes: 4, eof: true, sha256: createHash("sha256").update("abcd").digest("hex"), status: "open",
  });
});

test("pre-spawn, stale-generation, and post-EOF stream events poison instead of contributing drain evidence", () => {
  for (const event of ["data", "eof"] as const) {
    const current = fixture();
    if (event === "data") {assert.equal(current.runtime.acceptProviderOutput(current.syscalls.stdoutHandle, Buffer.from("prelaunch")), "closed");}
    else {assert.equal(current.runtime.closeProviderOutput(current.syscalls.stdoutHandle), "failed");}
    assert.equal(current.runtime.snapshot().phase, "failed");
    assert.throws(() => current.runtime.receive(handshake), /sealed/u);
    assert.equal(current.syscalls.spawns.length, 0);
  }

  const stale = fixture();
  stale.runtime.receive(handshake); stale.runtime.receive(request());
  assert.equal(stale.runtime.acceptProviderOutput(opaqueOutputHandle("pipe:stale"), Buffer.from("stale")), "closed");
  stale.syscalls.rootExits.push({exitCode: 0, handle: stale.syscalls.providerRootHandle, signal: null}); stale.runtime.tick();
  assert.equal(stale.runtime.closeProviderOutput(stale.syscalls.stdoutHandle), "failed");
  assert.equal(stale.control.some(message => message.kind === "provider-drain-complete"), false);
  assert.deepEqual(stale.syscalls.containment, ["init-failure"]);
});

test("EOF remains deferred until a blocked output chunk is successfully retried", () => {
  const current = fixture();
  current.runtime.receive(handshake); current.runtime.receive(request());
  current.syscalls.outputStatus = "blocked";
  assert.equal(current.runtime.acceptProviderOutput(current.syscalls.stdoutHandle, Buffer.from("pending")), "blocked");
  assert.equal(current.runtime.closeProviderOutput(current.syscalls.stdoutHandle), "deferred");
  assert.equal(current.runtime.snapshot().stdout.eof, false);
  assert.equal(current.runtime.closeProviderOutput(current.syscalls.stderrHandle), "closed");
  current.syscalls.rootExits.push({exitCode: 0, handle: current.syscalls.providerRootHandle, signal: null}); current.runtime.tick();
  assert.equal(current.control.some(message => message.kind === "provider-drain-complete"), false);
  assert.equal(current.runtime.outputDrainReady(current.syscalls.stdoutHandle), "blocked");
  assert.equal(current.control.some(message => message.kind === "provider-drain-complete"), false);

  current.syscalls.outputStatus = "accepted";
  assert.equal(current.runtime.outputDrainReady(current.syscalls.stdoutHandle), "accepted");
  assert.equal(current.runtime.snapshot().stdout.eof, true);
  assert.equal(current.control.filter(message => message.kind === "provider-drain-complete").length, 1);
});

test("output overflow emits a typed failed drain and later EOF cannot look complete", () => {
  const current = fixture();
  current.runtime.receive(handshake); current.runtime.receive(request());
  assert.equal(current.runtime.acceptProviderOutput(current.syscalls.stderrHandle, Buffer.from("123456789")), "overflow");
  assert.equal(current.runtime.closeProviderOutput(current.syscalls.stderrHandle), "failed");
  assert.equal(current.runtime.closeProviderOutput(current.syscalls.stdoutHandle), "failed");
  current.syscalls.rootExits.push({exitCode: 0, handle: current.syscalls.providerRootHandle, signal: null}); current.runtime.tick();
  assert.deepEqual(current.runtime.snapshot().closure, {outerContainmentClaim: "unproven", providerDrain: {
    kind: "provider-drain-failed", outerContainmentClaim: "unproven", reason: "stderr-overflow", requestId: "exec-request:one",
  }});
  assert.equal(current.control.filter(message => message.kind === "provider-drain-failed").length, 1);
  assert.equal(current.control.some(message => message.kind === "provider-drain-complete"), false);
  const failure = current.control.find(message => message.kind === "provider-drain-failed");
  assert(failure !== undefined);
  assert.deepEqual(parseDockerCustodyProtocolMessage(failure), failure);
  assert.throws(() => parseDockerCustodyProtocolMessage({...failure, reason: "generic-overflow"}), /reason/u);
});

test("cancellation and a forward wall-clock jump TERM the root then request outer container containment", () => {
  for (const cause of ["cancelled", "deadline"] as const) {
    const current = fixture();
    current.runtime.receive(handshake);
    current.runtime.receive(request());
    if (cause === "deadline") {current.syscalls.wall = 20_000; current.runtime.tick();}
    else {current.runtime.requestStop();}
    assert.deepEqual(current.syscalls.signals.map(item => item.signal), ["SIGTERM"]);
    current.syscalls.monotonic += 50;
    current.runtime.tick();
    assert.deepEqual(current.syscalls.containment, ["shutdown-timeout"]);
    assert(current.control.some(message => message.kind === "container-containment-request"));
  }
});

test("wall-clock rollback cannot extend the frozen monotonic deadline or configured runtime cap", () => {
  const rollback = fixture();
  rollback.runtime.receive(handshake); rollback.runtime.receive(request());
  rollback.syscalls.wall = 1_000;
  rollback.syscalls.monotonic = 10_999; rollback.runtime.tick();
  assert.equal(rollback.syscalls.signals.length, 0);
  rollback.syscalls.monotonic = 11_000; rollback.runtime.tick();
  assert.deepEqual(rollback.syscalls.signals.map(item => item.signal), ["SIGTERM"]);

  const capped = fixture();
  capped.runtime.receive(handshake); capped.runtime.receive(request({wallDeadlineUnixMs: 1_000_000}));
  capped.syscalls.wall = 1;
  capped.syscalls.monotonic = 30_999; capped.runtime.tick();
  assert.equal(capped.syscalls.signals.length, 0);
  capped.syscalls.monotonic = 31_000; capped.runtime.tick();
  assert.deepEqual(capped.syscalls.signals.map(item => item.signal), ["SIGTERM"]);
});

test("root exit does not close a blocked drain or evade the absolute deadline", () => {
  const current = fixture();
  current.runtime.receive(handshake);
  current.runtime.receive(request());
  current.syscalls.outputStatus = "blocked";
  current.runtime.acceptProviderOutput(current.syscalls.stdoutHandle, Buffer.from("pending"));
  current.syscalls.rootExits.push({exitCode: 0, handle: current.syscalls.providerRootHandle, signal: null});
  current.runtime.tick();
  assert.equal(current.runtime.snapshot().stdout.status, "blocked");
  current.syscalls.wall = 20_000;
  current.runtime.tick();
  assert.deepEqual(current.syscalls.signals.map(item => item.signal), []);
  current.syscalls.monotonic += 50;
  current.runtime.tick();
  assert.deepEqual(current.syscalls.containment, ["deadline"]);
});

test("known no-start, ambiguous spawn failure, and init crash remain distinct", () => {
  const spawn = new FakeSyscalls();
  spawn.spawnOutcome = "not-started";
  const failed = fixture({ syscalls: spawn });
  failed.runtime.receive(handshake);
  failed.runtime.receive(request());
  assert.equal(failed.runtime.snapshot().phase, "failed");
  assert(failed.control.some(message => message.kind === "provider-observation" && message.observation === "spawn-failed"));

  const ambiguousSyscalls = new FakeSyscalls();
  ambiguousSyscalls.spawnOutcome = "ambiguous-error";
  const ambiguous = fixture({ syscalls: ambiguousSyscalls });
  ambiguous.runtime.receive(handshake);
  ambiguous.runtime.receive(request());
  assert(ambiguous.control.some(message => message.kind === "provider-exec-ack" && message.observation === "acceptance-unknown"));
  assert(ambiguous.control.some(message => message.kind === "provider-observation" && message.observation === "acceptance-unknown"));
  assert.deepEqual(ambiguousSyscalls.containment, ["init-failure"]);

  const crashed = fixture();
  crashed.runtime.receive(handshake);
  crashed.runtime.receive(request());
  crashed.runtime.failInit();
  assert.deepEqual(crashed.syscalls.containment, ["init-failure"]);
  assert.equal(crashed.runtime.snapshot().containmentRequested, true);
});

test("throwing and explicitly failed containment requests remain pending until acceptance", () => {
  for (const firstOutcome of ["throw", "failed"] as const) {
    const syscalls = new FakeSyscalls(); syscalls.containmentOutcomes.push(firstOutcome, "accepted");
    const current = fixture({syscalls});
    current.runtime.receive(handshake); current.runtime.receive(request()); current.runtime.requestStop();
    current.syscalls.monotonic += 50; current.runtime.tick();
    assert.equal(current.runtime.snapshot().containmentRequested, false);
    assert.deepEqual(current.syscalls.containment, ["shutdown-timeout"]);
    assert.equal(current.control.filter(message => message.kind === "container-containment-request").length, 0);

    current.runtime.tick();
    assert.equal(current.runtime.snapshot().containmentRequested, true);
    assert.deepEqual(current.syscalls.containment, ["shutdown-timeout", "shutdown-timeout"]);
    assert.equal(current.control.filter(message => message.kind === "container-containment-request").length, 1);
  }
});

test("canonical control evidence omits provider content, credentials, executable paths, and raw host paths", () => {
  const messages = [
    handshake,
    request({ environment: Object.freeze([{ name: "HOME", value: "secret-provider-content" }]) }),
    Object.freeze({ kind: "provider-exec-ack", observation: "started", requestId: "exec-request:one" } as const),
    Object.freeze({ exitCode: 0, kind: "provider-observation", observation: "root-exited", requestId: "exec-request:one", signal: null, treeEmptyClaim: "not-claimed" } as const),
  ];
  const evidence = messages.slice(2).map(message => Buffer.from(encodeDockerCustodyFrame(message)).toString("utf8")).join("\n");
  assert(!evidence.includes("secret-provider-content"));
  assert(!evidence.includes("/immutable/provider"));
  assert(!evidence.includes("/private/home"));
  assert(!evidence.toLowerCase().includes("credential"));
});

test("encoder rejects active or lossy JavaScript inputs before JSON encoding", () => {
  let getterCalled = false;
  const accessor = {...handshake};
  Object.defineProperty(accessor, "nonce", {enumerable: true, get() {getterCalled = true; return "host-nonce:one";}});
  assert.throws(() => encodeDockerCustodyFrame(accessor), /accessor/u);
  assert.equal(getterCalled, false);
  assert.throws(() => encodeDockerCustodyFrame(new Proxy({...handshake}, {})), /Proxy/u);
  assert.throws(() => encodeDockerCustodyFrame({...handshake, toJSON() {return handshake;}} as DockerCustodyHostHandshake), /unknown|non-JSON/u);
  const hiddenToJson = {...handshake};
  Object.defineProperty(hiddenToJson, "toJSON", {value: () => handshake});
  assert.throws(() => encodeDockerCustodyFrame(hiddenToJson as DockerCustodyHostHandshake), /unknown|non-JSON/u);
  const inheritedKind = Object.create({get kind() {getterCalled = true; return "host-handshake";}}) as Record<string, unknown>;
  const {kind: _kind, ...handshakeWithoutKind} = handshake;
  Object.defineProperties(inheritedKind, Object.getOwnPropertyDescriptors(handshakeWithoutKind));
  assert.throws(() => encodeDockerCustodyFrame(inheritedKind as unknown as DockerCustodyHostHandshake), /plain data object|own data property/u);
  assert.equal(getterCalled, false);
  for (const invalid of [
    {...handshake, nonce: undefined},
    {...handshake, nonce: () => "value"},
    {...handshake, nonce: Symbol("value")},
    {...handshake, extra: true},
  ]) {assert.throws(() => encodeDockerCustodyFrame(invalid as unknown as DockerCustodyHostHandshake), DockerCustodyProtocolError);}

  const sparse = ["provider"];
  sparse.length = 3;
  sparse[2] = "serve";
  assert.throws(() => parseDockerCustodyProtocolMessage({...request(), argv: sparse}), /sparse/u);
  const augmented = ["provider"] as string[] & {extra?: string};
  augmented.extra = "forbidden";
  assert.throws(() => parseDockerCustodyProtocolMessage({...request(), argv: augmented}), /augmented/u);
});

test("decoder EOF is permanent for clean and malformed channel endings", () => {
  const clean = new DockerCustodyFrameDecoder();
  clean.finish();
  clean.finish();
  assert.throws(() => clean.push(encodeDockerCustodyFrame(handshake)), /sealed|EOF/u);

  const partial = new DockerCustodyFrameDecoder();
  partial.push(encodeDockerCustodyFrame(handshake).subarray(0, 3));
  assert.throws(() => partial.finish(), /typed malformed partial/u);
  assert.throws(() => partial.push(encodeDockerCustodyFrame(handshake)), /sealed|EOF/u);
});

test("every decoder framing, JSON, schema, and canonicality failure permanently poisons the channel", () => {
  const validPayload = Buffer.from(encodeDockerCustodyFrame(handshake)).subarray(4);
  const failures = [
    new Uint8Array(4 * (DOCKER_CUSTODY_INIT_MAX_FRAME_BYTES + 4) + 1),
    Uint8Array.of(0, 0, 0, 0),
    framePayload(Buffer.from("{")),
    framePayload(Buffer.from('{"kind":"unsupported"}')),
    framePayload(Buffer.concat([Buffer.from(" "), validPayload])),
  ];
  for (const failure of failures) {
    const decoder = new DockerCustodyFrameDecoder();
    assert.throws(() => decoder.push(failure), DockerCustodyProtocolError);
    assert.throws(() => decoder.push(encodeDockerCustodyFrame(handshake)), /sealed|EOF/u);
  }
});

test("poisoned byte ingress permanently activates the runtime start fence", () => {
  const current = fixture();
  assert.throws(() => current.runtime.receiveControlBytes(Uint8Array.of(0, 0, 0, 1, 123)), /malformed/u);
  assert.equal(current.runtime.snapshot().startFenced, true);
  assert.throws(() => current.runtime.receiveControlBytes(encodeDockerCustodyFrame(handshake)), /poisoned|sealed|EOF/u);
  assert.equal(current.syscalls.spawns.length, 0);
});

test("every post-start decoder, semantic-control, and control-EOF failure is absorbing", () => {
  const actions: Array<(current: ReturnType<typeof fixture>) => void> = [
    current => {assert.throws(() => current.runtime.receiveControlBytes(Uint8Array.of(0, 0, 0, 1, 123)), /malformed/u);},
    current => {assert.throws(() => current.runtime.receive(handshake), /duplicate/u);},
    current => {current.runtime.controlChannelClosed();},
  ];
  for (const action of actions) {
    const current = fixture(); current.runtime.receive(handshake); current.runtime.receive(request()); action(current);
    const failed = current.runtime.snapshot();
    current.syscalls.rootExits.push({exitCode: 0, handle: current.syscalls.providerRootHandle, signal: null});
    current.runtime.closeProviderOutput(current.syscalls.stdoutHandle); current.runtime.closeProviderOutput(current.syscalls.stderrHandle);
    current.runtime.tick(); current.runtime.forwardHostSignal("SIGUSR1"); current.runtime.stdinDrainReady();
    assert.equal(current.runtime.snapshot().phase, "failed");
    assert.equal(current.runtime.snapshot().stdout.bytes, failed.stdout.bytes);
    assert.equal(current.control.some(message => message.kind === "provider-drain-complete"), false);
    assert.deepEqual(current.syscalls.containment, ["init-failure"]);
    assert.equal(current.syscalls.signals.length, 0);
  }
});

test("explicit init failure freezes authority and stream evidence except retryable containment cleanup", () => {
  const current = fixture(); current.runtime.receive(handshake); current.runtime.receive(request());
  current.syscalls.outputOutcomes.push({committedBytes: 2, status: "blocked"});
  current.runtime.acceptProviderOutput(current.syscalls.stdoutHandle, Buffer.from("abcd")); current.runtime.failInit();
  const poisoned = current.runtime.snapshot();
  current.runtime.forwardHostSignal("SIGUSR1"); current.runtime.requestStop(); current.runtime.stdinDrainReady();
  current.runtime.outputDrainReady(current.syscalls.stdoutHandle); current.runtime.closeProviderOutput(current.syscalls.stdoutHandle);
  current.runtime.acceptProviderOutput(current.syscalls.stderrHandle, Buffer.from("late")); current.runtime.tick();
  assert.deepEqual(current.runtime.snapshot(), poisoned);
  assert.deepEqual(current.syscalls.output.map(item => Buffer.from(item.bytes).toString()), ["ab"]);
  assert.equal(current.syscalls.signals.length, 0);
  assert.deepEqual(current.syscalls.containment, ["init-failure"]);
});

test("pre-start cancellation, disconnect, malformed input, and duplicates permanently fence exec", () => {
  const actions: Array<(current: ReturnType<typeof fixture>) => void> = [
    current => {current.runtime.receive(handshake); current.runtime.requestStop();},
    current => {current.runtime.receive(handshake); current.runtime.controlChannelClosed();},
    current => {current.runtime.receive(handshake); current.runtime.malformedControlFrame();},
    current => {current.runtime.receive(handshake); assert.throws(() => current.runtime.receive(handshake), /duplicate/u);},
  ];
  for (const act of actions) {
    const current = fixture();
    act(current);
    assert.equal(current.runtime.snapshot().startFenced, true);
    assert.throws(() => current.runtime.receive(request()), /fenced|sealed/u);
    assert.equal(current.syscalls.spawns.length, 0);
  }
});

test("allowed host signals use the stable handle while TERM failure still escalates to KILL", () => {
  const current = fixture();
  current.runtime.receive(handshake);
  current.runtime.receive(request());
  current.runtime.forwardHostSignal("SIGUSR1");
  current.syscalls.signalFailure = true;
  current.runtime.forwardHostSignal("SIGTERM");
  assert.deepEqual(current.runtime.snapshot().signalEvidence.map(item => [item.action, item.signal, item.result]), [
    ["forward-host", "SIGUSR1", "sent"],
    ["stop-term", "SIGTERM", "failed"],
  ]);
  current.syscalls.signalFailure = false;
  current.syscalls.monotonic += 50;
  current.runtime.tick();
  assert.deepEqual(current.runtime.snapshot().signalEvidence.map(item => [item.action, item.signal, item.result]), [
    ["forward-host", "SIGUSR1", "sent"],
    ["stop-term", "SIGTERM", "failed"],
    ["stop-kill", "SIGKILL", "sent"],
  ]);
  assert.deepEqual(current.syscalls.containment, ["shutdown-timeout"]);
});

test("same-PID descendant and mismatched-generation exit evidence cannot revoke the stable root handle", () => {
  const current = fixture();
  current.runtime.receive(handshake);
  current.runtime.receive(request());
  const reusedPidHandle = opaqueRootHandle("pidfd:provider-root:reused");
  current.syscalls.reaped.push({exitCode: 9, pid: 41, signal: null});
  current.syscalls.rootExits.push({exitCode: 8, handle: reusedPidHandle, signal: null});
  current.runtime.tick();
  assert.equal(current.runtime.snapshot().providerRootTracked, true);
  assert.equal(current.runtime.snapshot().descendantsReaped, 1);
  current.runtime.forwardHostSignal("SIGUSR1");
  assert.equal(current.syscalls.signals[0]?.handle, current.syscalls.providerRootHandle);
  assert.equal(current.syscalls.signals[0]?.signal, "SIGUSR1");

  current.syscalls.rootExits.push({exitCode: 0, handle: current.syscalls.providerRootHandle, signal: null});
  current.runtime.tick();
  assert.equal(current.runtime.snapshot().providerRootTracked, false);
  current.runtime.forwardHostSignal("SIGUSR2");
  assert.equal(current.syscalls.signals.length, 1);
  assert.deepEqual(current.runtime.snapshot().signalEvidence.at(-1), {
    action: "forward-host", kind: "provider-signal-observation", requestId: "exec-request:one", result: "absent", signal: "SIGUSR2",
  });
  assert.equal(current.syscalls.rootObservations.every(handle => handle === current.syscalls.providerRootHandle), true);
  assert.equal(Object.keys(current.syscalls.providerRootHandle).length, 0);
});

test("blocked evidence retries in order while thrown evidence poisons before successful closure", () => {
  let rootAttempts = 0;
  let drainAttempts = 0;
  const accepted: DockerCustodyInitMessage[] = [];
  const retryable = fixture({writeControl(message) {
    if (message.kind === "provider-observation" && message.observation === "root-exited" && rootAttempts++ === 0) {return "blocked";}
    if (message.kind === "provider-drain-complete" && drainAttempts++ === 0) {return "blocked";}
    accepted.push(message); return "accepted";
  }});
  retryable.runtime.receive(handshake); retryable.runtime.receive(request());
  retryable.runtime.closeProviderOutput(retryable.syscalls.stdoutHandle); retryable.runtime.closeProviderOutput(retryable.syscalls.stderrHandle);
  retryable.syscalls.rootExits.push({exitCode: 0, handle: retryable.syscalls.providerRootHandle, signal: null}); retryable.runtime.tick();
  assert.equal(retryable.runtime.snapshot().closure, null);
  assert.equal(accepted.some(message => message.kind === "provider-drain-complete"), false);
  retryable.runtime.tick();
  assert.equal(retryable.runtime.snapshot().closure, null);
  assert.equal(retryable.runtime.snapshot().phase, "provider-exited");
  retryable.runtime.tick();
  assert.deepEqual(accepted.slice(-2).map(message => message.kind), ["provider-observation", "provider-drain-complete"]);
  assert.equal(retryable.runtime.snapshot().phase, "drained");

  const fatal = fixture({writeControl(message) {
    if (message.kind === "provider-observation" && message.observation === "root-exited") {throw new Error("lost root evidence");}
    return "accepted";
  }});
  fatal.runtime.receive(handshake); fatal.runtime.receive(request());
  fatal.runtime.closeProviderOutput(fatal.syscalls.stdoutHandle); fatal.runtime.closeProviderOutput(fatal.syscalls.stderrHandle);
  fatal.syscalls.rootExits.push({exitCode: 0, handle: fatal.syscalls.providerRootHandle, signal: null}); fatal.runtime.tick(); fatal.runtime.tick();
  assert.equal(fatal.runtime.snapshot().phase, "failed");
  assert.equal(fatal.runtime.snapshot().closure, null);
  assert.deepEqual(fatal.syscalls.containment, ["init-failure"]);
});

test("root exit settles stop escalation before a successful drain", () => {
  const current = fixture(); current.runtime.receive(handshake); current.runtime.receive(request()); current.runtime.requestStop("cancelled");
  current.runtime.closeProviderOutput(current.syscalls.stdoutHandle); current.runtime.closeProviderOutput(current.syscalls.stderrHandle);
  current.syscalls.rootExits.push({exitCode: 0, handle: current.syscalls.providerRootHandle, signal: null}); current.runtime.tick();
  assert.equal(current.runtime.snapshot().phase, "drained");
  current.syscalls.monotonic += 50; current.runtime.tick();
  assert.deepEqual(current.syscalls.signals.map(item => item.signal), ["SIGTERM"]);
  assert.deepEqual(current.syscalls.containment, []);
});

test("fractional or unsafe root exits, descendant exits, and PIDs fail closed", () => {
  const invalidRootPid = new FakeSyscalls(); invalidRootPid.rootPid = 41.5;
  const spawn = fixture({syscalls: invalidRootPid}); spawn.runtime.receive(handshake); spawn.runtime.receive(request());
  assert.equal(spawn.runtime.snapshot().phase, "failed"); assert.deepEqual(spawn.syscalls.containment, ["init-failure"]);

  for (const invalid of [
    {exitCode: 0.5, pid: 90, signal: null},
    {exitCode: 0, pid: 90.5, signal: null},
    {exitCode: 0, pid: Number.MAX_SAFE_INTEGER + 1, signal: null},
  ] as const) {
    const current = fixture(); current.runtime.receive(handshake); current.runtime.receive(request());
    current.syscalls.reaped.push(invalid); current.runtime.tick();
    assert.equal(current.runtime.snapshot().phase, "failed"); assert.deepEqual(current.syscalls.containment, ["init-failure"]);
  }
  const root = fixture(); root.runtime.receive(handshake); root.runtime.receive(request());
  root.syscalls.rootExits.push({exitCode: 0.5, handle: root.syscalls.providerRootHandle, signal: null}); root.runtime.tick();
  assert.equal(root.runtime.snapshot().phase, "failed");
  assert.equal(root.control.some(message => message.kind === "provider-observation" && message.observation === "root-exited"), false);
});

test("provider drain completes once for every root/stdout/stderr EOF ordering", () => {
  const orders = [
    ["root", "stdout", "stderr"], ["root", "stderr", "stdout"],
    ["stdout", "root", "stderr"], ["stderr", "root", "stdout"],
    ["stdout", "stderr", "root"], ["stderr", "stdout", "root"],
  ] as const;
  for (const order of orders) {
    const current = fixture();
    current.runtime.receive(handshake); current.runtime.receive(request());
    for (const event of order) {
      if (event === "root") {current.syscalls.rootExits.push({exitCode: null, handle: current.syscalls.providerRootHandle, signal: "SIGXCPU"}); current.runtime.tick();}
      else {current.runtime.closeProviderOutput(event === "stdout" ? current.syscalls.stdoutHandle : current.syscalls.stderrHandle);}
    }
    const drains = current.control.filter(message => message.kind === "provider-drain-complete");
    assert.equal(drains.length, 1);
    assert.deepEqual(drains[0], {kind: "provider-drain-complete", outerContainmentClaim: "unproven", requestId: "exec-request:one",
      rootExit: "observed", stderr: "eof", stdout: "eof"});
    assert.equal(current.runtime.snapshot().phase, "drained");
  }
});

test("exit status schemas, POSIX child signals, NUL, and outer convergence boundary fail closed", () => {
  const root = {exitCode: 0, kind: "provider-observation", observation: "root-exited", requestId: "exec-request:one",
    signal: null, treeEmptyClaim: "not-claimed"} as const;
  assert.deepEqual(parseDockerCustodyProtocolMessage({...root, exitCode: null, signal: "SIGXFSZ"}), {...root, exitCode: null, signal: "SIGXFSZ"});
  assert.throws(() => parseDockerCustodyProtocolMessage({...root, exitCode: 0, signal: "SIGTERM"}), /do not match/u);
  assert.throws(() => parseDockerCustodyProtocolMessage({...root, exitCode: null, signal: null}), /do not match/u);
  assert.throws(() => parseDockerCustodyProtocolMessage({...root, observation: "spawn-failed", exitCode: 1}), /do not match/u);
  assert.throws(() => parseDockerCustodyProtocolMessage({...root, exitCode: null, signal: "SIGMADEUP"}), /unsupported/u);
  assert.throws(() => parseDockerCustodyProtocolMessage({...request(), argv: ["provider\0tail"]}), /NUL/u);
  assert.throws(() => parseDockerCustodyProtocolMessage({...request(), environment: [{name: "HOME", value: "value\0tail"}]}), /NUL/u);
  assert.throws(() => fixture({}).runtime.receive({...request(), argv: ["provider\0tail"]}), /NUL/u);

  const current = fixture();
  current.runtime.receive(handshake); current.runtime.receive(request());
  current.runtime.closeProviderOutput(current.syscalls.stdoutHandle); current.runtime.closeProviderOutput(current.syscalls.stderrHandle);
  current.syscalls.rootExits.push({exitCode: 0, handle: current.syscalls.providerRootHandle, signal: null}); current.runtime.tick();
  const closure = current.runtime.snapshot().closure;
  assert.equal(closure?.outerContainmentClaim, "unproven");
  assert.equal(closure?.providerDrain.outerContainmentClaim, "unproven");
  assert.equal(current.runtime.snapshot().containmentRequested, false);
  assert(!JSON.stringify(closure).includes("contained"));
});
