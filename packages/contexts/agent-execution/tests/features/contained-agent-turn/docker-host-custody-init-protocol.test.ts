import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DOCKER_CUSTODY_INIT_MAX_FRAME_BYTES,
  DockerCustodyFrameDecoder,
  DockerCustodyProtocolError,
  encodeDockerCustodyFrame,
  parseDockerCustodyProtocolMessage,
  type DockerCustodyHostHandshake,
  type DockerCustodyInitMessage,
} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/init/docker-custody-init-protocol.js";

import {
  FakeSyscalls,
  containmentReasons,
  fixture,
  framePayload,
  handshake,
  opaqueRootHandle,
  request,
} from "./docker-custody-init-test-fixture.ts";

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
    assert.deepEqual(containmentReasons(current.control), ["init-failure"]);
    assert.deepEqual(current.syscalls.signals.map(item => item.signal), ["SIGTERM"]);
  }
});

test("explicit init failure freezes authority and stream evidence except retryable containment cleanup", () => {
  const current = fixture(); current.runtime.receive(handshake); current.runtime.receive(request());
  current.syscalls.outputOutcomes.push({committedBytes: 2, status: "blocked"});
  current.runtime.acceptProviderOutput(current.syscalls.stdoutHandle, Buffer.from("abcd")); current.runtime.failInit();
  current.runtime.forwardHostSignal("SIGUSR1"); current.runtime.requestStop(); current.runtime.stdinDrainReady();
  current.runtime.outputDrainReady(current.syscalls.stdoutHandle); current.runtime.closeProviderOutput(current.syscalls.stdoutHandle);
  current.runtime.acceptProviderOutput(current.syscalls.stderrHandle, Buffer.from("late")); current.runtime.tick();
  assert.equal(current.runtime.snapshot().startFenced, true);
  assert.equal(current.runtime.snapshot().stdout.eof, true);
  assert.equal(current.runtime.snapshot().stderr.bytes, 4);
  assert.equal(current.runtime.snapshot().failureCleanupComplete, false);
  assert.deepEqual(current.syscalls.output.map(item => Buffer.from(item.bytes).toString()), ["ab"]);
  assert.deepEqual(current.syscalls.signals.map(item => item.signal), ["SIGTERM"]);
  assert.deepEqual(containmentReasons(current.control), ["init-failure"]);
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
  assert.deepEqual(containmentReasons(current.control), ["shutdown-timeout"]);
});

test("mismatched-generation exit evidence cannot revoke the stable root handle", () => {
  const current = fixture();
  current.runtime.receive(handshake);
  current.runtime.receive(request());
  const reusedPidHandle = opaqueRootHandle("pidfd:provider-root:reused");
  current.syscalls.rootExits.push({exitCode: 8, handle: reusedPidHandle, signal: null});
  current.runtime.tick();
  assert.equal(current.runtime.snapshot().providerRootTracked, true);
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
  assert.equal(fatal.runtime.snapshot().containmentRequested, true);
});

test("root exit settles stop escalation before a successful drain", () => {
  const current = fixture(); current.runtime.receive(handshake); current.runtime.receive(request()); current.runtime.requestStop("cancelled");
  current.runtime.closeProviderOutput(current.syscalls.stdoutHandle); current.runtime.closeProviderOutput(current.syscalls.stderrHandle);
  current.syscalls.rootExits.push({exitCode: 0, handle: current.syscalls.providerRootHandle, signal: null}); current.runtime.tick();
  assert.equal(current.runtime.snapshot().phase, "drained");
  current.syscalls.monotonic += 50; current.runtime.tick();
  assert.deepEqual(current.syscalls.signals.map(item => item.signal), ["SIGTERM"]);
  assert.deepEqual(containmentReasons(current.control), []);
});

test("fractional or unsafe root exits and PIDs fail closed", () => {
  const invalidRootPid = new FakeSyscalls(); invalidRootPid.rootPid = 41.5;
  const spawn = fixture({syscalls: invalidRootPid}); spawn.runtime.receive(handshake); spawn.runtime.receive(request());
  assert.equal(spawn.runtime.snapshot().phase, "failed"); assert.deepEqual(containmentReasons(spawn.control), ["init-failure"]);

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
