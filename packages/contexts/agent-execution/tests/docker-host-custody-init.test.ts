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
  type DockerCustodyProviderRootHandle,
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
  public signalFailure = false;
  public signals: Array<{ readonly handle: DockerCustodyProviderRootHandle; readonly signal: "SIGHUP" | "SIGINT" | "SIGKILL" | "SIGQUIT" | "SIGTERM" | "SIGUSR1" | "SIGUSR2" }> = [];
  public spawnOutcome: "ambiguous-error" | "not-started" | "started" = "started";
  public spawns: DockerCustodyProviderSpawn[] = [];
  public wall = 10_000;

  public assertNoNewPrivileges(): void {}
  public assertPidOne(): void {}
  public monotonicNowMs(): number {return this.monotonic;}
  public observeIdentity(): DockerCustodyIdentity {return identity;}
  public reapExitedChildren(): readonly DockerCustodyReapedChild[] {return this.reaped.splice(0);}
  public requestContainerContainment(reason: string): void {this.containment.push(reason);}
  public signalProviderRoot(handle: DockerCustodyProviderRootHandle, signal: "SIGHUP" | "SIGINT" | "SIGKILL" | "SIGQUIT" | "SIGTERM" | "SIGUSR1" | "SIGUSR2"): "sent" {
    this.signals.push({ handle, signal });
    if (this.signalFailure) {throw new Error("synthetic signal failure");}
    return "sent";
  }
  public spawnProvider(spawn: DockerCustodyProviderSpawn): { readonly kind: "not-started" } | { readonly handle: DockerCustodyProviderRootHandle; readonly kind: "started" } {
    this.spawns.push(spawn);
    if (this.spawnOutcome === "ambiguous-error") {throw new Error("synthetic ambiguous spawn failure");}
    if (this.spawnOutcome === "not-started") {return { kind: "not-started" };}
    return { handle: Object.freeze({ pid: 41, stableIdentity: "provider-root:one" }), kind: "started" };
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
  assert.throws(() => runtime.receive(handshake), /duplicate/u);
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
  assert.deepEqual(current.syscalls.signals.map(item => ({ pid: item.handle.pid, signal: item.signal })), [{ pid: 41, signal: "SIGTERM" }]);
});

test("cancellation and absolute deadline TERM the root then request outer container containment", () => {
  for (const cause of ["cancelled", "deadline"] as const) {
    const current = fixture();
    current.runtime.receive(handshake);
    current.runtime.receive(request());
    if (cause === "deadline") {current.syscalls.wall = 20_000; current.runtime.tick();}
    else {current.runtime.requestStop();}
    assert.deepEqual(current.syscalls.signals.map(item => ({ pid: item.handle.pid, signal: item.signal })), [{ pid: 41, signal: "SIGTERM" }]);
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
  assert.deepEqual(current.syscalls.signals.map(item => ({ pid: item.handle.pid, signal: item.signal })), []);
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
    assert.throws(() => current.runtime.receive(request()), /fenced/u);
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

test("reaping revokes the stable root handle before observations and fences PID reuse", () => {
  const current = fixture();
  current.runtime.receive(handshake);
  current.runtime.receive(request());
  current.syscalls.reaped.push({exitCode: 0, pid: 41, signal: null});
  current.runtime.tick();
  assert.equal(current.runtime.snapshot().providerRootTracked, false);
  current.runtime.forwardHostSignal("SIGUSR2");
  assert.equal(current.syscalls.signals.length, 0);
  assert.deepEqual(current.runtime.snapshot().signalEvidence.at(-1), {
    action: "forward-host", kind: "provider-signal-observation", requestId: "exec-request:one", result: "absent", signal: "SIGUSR2",
  });
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
      if (event === "root") {current.syscalls.reaped.push({exitCode: null, pid: 41, signal: "SIGXCPU"}); current.runtime.tick();}
      else {current.runtime.closeProviderOutput(event);}
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
  current.runtime.closeProviderOutput("stdout"); current.runtime.closeProviderOutput("stderr");
  current.syscalls.reaped.push({exitCode: 0, pid: 41, signal: null}); current.runtime.tick();
  const closure = current.runtime.snapshot().closure;
  assert.equal(closure?.outerContainmentClaim, "unproven");
  assert.equal(closure?.providerDrain.outerContainmentClaim, "unproven");
  assert.equal(current.runtime.snapshot().containmentRequested, false);
  assert(!JSON.stringify(closure).includes("contained"));
});
