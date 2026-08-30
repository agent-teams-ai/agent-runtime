import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DOCKER_CUSTODY_INIT_MAX_FRAME_BYTES,
  DOCKER_CUSTODY_INIT_PROTOCOL,
  DockerCustodyFrameDecoder,
  DockerCustodyProtocolError,
  encodeDockerCustodyFrame,
  parseDockerCustodyProtocolMessage,
  type DockerCustodyHostHandshake,
  type DockerCustodyIdentity,
  type DockerCustodyInitMessage,
  type DockerCustodyProviderExecRequest,
} from "../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/init/docker-custody-init-protocol.js";
import {
  DockerCustodyInitRuntime,
  type DockerCustodyInitSyscalls,
  type DockerCustodyProviderSpawn,
  type DockerCustodyReapedChild,
} from "../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/init/docker-custody-init-runtime.js";

const digest = (digit: string): string => digit.repeat(64);
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

class FakeSyscalls implements DockerCustodyInitSyscalls {
  public containment: string[] = [];
  public input: Uint8Array[] = [];
  public inputStatus: "accepted" | "blocked" | "closed" = "accepted";
  public monotonic = 1_000;
  public output: Array<{ readonly bytes: Uint8Array; readonly stream: "stderr" | "stdout" }> = [];
  public outputStatus: "accepted" | "blocked" = "accepted";
  public reaped: DockerCustodyReapedChild[] = [];
  public signals: Array<{ readonly pid: number; readonly signal: "SIGTERM" }> = [];
  public spawnOutcome: "ambiguous-error" | "not-started" | "started" = "started";
  public spawns: DockerCustodyProviderSpawn[] = [];
  public wall = 10_000;

  public assertNoNewPrivileges(): void {}
  public assertPidOne(): void {}
  public monotonicNowMs(): number {return this.monotonic;}
  public observeIdentity(): DockerCustodyIdentity {return identity;}
  public reapExitedChildren(): readonly DockerCustodyReapedChild[] {return this.reaped.splice(0);}
  public requestContainerContainment(reason: string): void {this.containment.push(reason);}
  public signalProviderRoot(pid: number, signal: "SIGTERM"): "sent" {this.signals.push({ pid, signal }); return "sent";}
  public spawnProvider(spawn: DockerCustodyProviderSpawn): { readonly kind: "not-started" } | { readonly kind: "started"; readonly pid: number } {
    this.spawns.push(spawn);
    if (this.spawnOutcome === "ambiguous-error") {throw new Error("synthetic ambiguous spawn failure");}
    if (this.spawnOutcome === "not-started") {return { kind: "not-started" };}
    return { kind: "started", pid: 41 };
  }
  public wallNowUnixMs(): number {return this.wall;}
  public writeProviderInput(bytes: Uint8Array): "accepted" | "blocked" | "closed" {
    if (this.inputStatus === "accepted") {this.input.push(bytes.slice());}
    return this.inputStatus;
  }
  public writeProviderOutput(stream: "stderr" | "stdout", bytes: Uint8Array): "accepted" | "blocked" {
    if (this.outputStatus === "accepted") {this.output.push({ bytes: bytes.slice(), stream });}
    return this.outputStatus;
  }
}

const fixture = (changes: {
  readonly syscalls?: FakeSyscalls;
  readonly writeControl?: (message: DockerCustodyInitMessage) => void;
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
    observedIdentity: identity,
    shutdownGraceMs: 50,
    syscalls,
    writeControl: changes.writeControl ?? (message => {control.push(message);}),
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
  assert.throws(() => runtime.receive(handshake), /duplicate/u);
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
    gid: 10001,
    inheritedDescriptors: [0, 1, 2],
    noNewPrivileges: true,
    shell: false,
    uid: 10001,
  });
  assert.throws(() => runtime.receive(request({ requestId: "exec-request:two" })), /duplicate/u);
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

test("lost provider-exec acknowledgement is observed but never resent or relaunched", () => {
  const messages: DockerCustodyInitMessage[] = [];
  let loseAck = true;
  const current = fixture({
    writeControl(message) {
      if (message.kind === "provider-exec-ack" && loseAck) {loseAck = false; throw new Error("synthetic lost ack");}
      messages.push(message);
    },
  });
  current.runtime.receive(handshake);
  current.runtime.receive(request());
  assert.equal(current.runtime.snapshot().acknowledgement, "lost");
  current.runtime.reportLostAcknowledgement();
  current.runtime.reportLostAcknowledgement();
  assert.equal(current.syscalls.spawns.length, 1);
  assert.equal(messages.filter(message => message.kind === "provider-exec-ack").length, 0);
  const observations = messages.filter(message => message.kind === "provider-observation");
  assert.equal(observations.length, 1);
  assert(observations.every(message => message.kind === "provider-observation" && message.observation === "exec-acknowledgement-lost"));
});

test("PID1 tracks only the provider root, reaps descendants and zombies, and never claims tree empty", () => {
  const current = fixture();
  current.runtime.receive(handshake);
  current.runtime.receive(request());
  current.syscalls.reaped.push(
    { exitCode: 0, pid: 90, signal: null },
    { exitCode: null, pid: 91, signal: "SIGKILL" },
    { exitCode: 7, pid: 41, signal: null },
    { exitCode: 0, pid: 92, signal: null },
  );
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
  current.runtime.closeProviderOutput("stdout");
  current.runtime.closeProviderOutput("stderr");
  assert.equal(current.runtime.acceptProviderOutput("stdout", Buffer.from("late")), "closed");
});

test("output, input, and blocked-drain accounting is bounded and content-free", () => {
  const current = fixture();
  current.runtime.receive(handshake);
  current.runtime.receive(request());
  assert.equal(current.runtime.acceptProviderOutput("stdout", Buffer.from("1234")), "accepted");
  current.syscalls.outputStatus = "blocked";
  assert.equal(current.runtime.acceptProviderOutput("stderr", Buffer.from("xx")), "blocked");
  assert.equal(current.runtime.acceptProviderOutput("stderr", Buffer.from("must-wait")), "blocked");
  assert.equal(current.syscalls.output.length, 1);
  assert.equal(current.runtime.snapshot().stderr.status, "blocked");
  current.runtime.outputDrainReady("stderr");
  assert.equal(current.runtime.snapshot().stderr.status, "open");
  assert.equal(current.runtime.writeProviderInput(Buffer.from("1234")), "accepted");
  current.syscalls.inputStatus = "blocked";
  assert.equal(current.runtime.writeProviderInput(Buffer.from("x")), "blocked");
  current.syscalls.inputStatus = "accepted";
  assert.equal(current.runtime.writeProviderInput(Buffer.from("must-wait")), "blocked");
  current.runtime.stdinDrainReady();
  assert.equal(current.runtime.writeProviderInput(Buffer.from("56789")), "closed");
  assert.equal(current.runtime.acceptProviderOutput("stdout", Buffer.from("56789")), "overflow");
  const snapshot = current.runtime.snapshot();
  assert.equal(snapshot.stdout.bytes, 4);
  assert.equal(snapshot.stdout.status, "overflow");
  assert(!JSON.stringify(snapshot).includes("1234"));
  assert.deepEqual(current.syscalls.signals, [{ pid: 41, signal: "SIGTERM" }]);
});

test("cancellation and absolute deadline TERM the root then request outer container containment", () => {
  for (const cause of ["cancelled", "deadline"] as const) {
    const current = fixture();
    current.runtime.receive(handshake);
    current.runtime.receive(request());
    if (cause === "deadline") {current.syscalls.wall = 20_000; current.runtime.tick();}
    else {current.runtime.requestStop();}
    assert.deepEqual(current.syscalls.signals, [{ pid: 41, signal: "SIGTERM" }]);
    current.syscalls.monotonic += 50;
    current.runtime.tick();
    assert.deepEqual(current.syscalls.containment, ["shutdown-timeout"]);
    assert(current.control.some(message => message.kind === "container-containment-request"));
  }
});

test("root exit does not close a blocked drain or evade the absolute deadline", () => {
  const current = fixture();
  current.runtime.receive(handshake);
  current.runtime.receive(request());
  current.syscalls.outputStatus = "blocked";
  current.runtime.acceptProviderOutput("stdout", Buffer.from("pending"));
  current.syscalls.reaped.push({ exitCode: 0, pid: 41, signal: null });
  current.runtime.tick();
  assert.equal(current.runtime.snapshot().stdout.status, "blocked");
  current.syscalls.wall = 20_000;
  current.runtime.tick();
  assert.deepEqual(current.syscalls.signals, [{ pid: 41, signal: "SIGTERM" }]);
  current.syscalls.monotonic += 50;
  current.runtime.tick();
  assert.deepEqual(current.syscalls.containment, ["shutdown-timeout"]);
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
