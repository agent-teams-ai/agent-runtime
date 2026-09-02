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
  type DockerCustodyInitMessage,
} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/init/docker-custody-init-protocol.js";

import {
  FakeSyscalls,
  containmentReasons,
  digest,
  fixture,
  handshake,
  identity,
  opaqueOutputHandle,
  request,
} from "./docker-custody-init-test-fixture.ts";

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
  const messages: DockerCustodyInitMessage[] = []; let depth = 0; let maximumDepth = 0; let loseAck = true;
  const current = fixture({
    writeControl(message) {
      depth += 1; maximumDepth = Math.max(maximumDepth, depth);
      try {if (message.kind === "provider-exec-ack" && loseAck) {loseAck = false; throw new Error("synthetic lost ack");}
        messages.push(message); return "accepted";
      } finally {depth -= 1;}
    },
  });
  current.runtime.receive(handshake); current.runtime.receive(request());
  assert.equal(current.runtime.snapshot().acknowledgement, "lost");
  current.runtime.reportLostAcknowledgement(); current.runtime.reportLostAcknowledgement();
  assert.equal(current.syscalls.spawns.length, 1);
  assert.equal(messages.filter(message => message.kind === "provider-exec-ack").length, 0);
  assert.equal(messages.filter(message => message.kind === "provider-observation").length, 0);
  assert.equal(current.runtime.snapshot().phase, "failed"); current.runtime.tick();
  assert.deepEqual(containmentReasons(messages), ["init-failure"]); assert.equal(maximumDepth, 1);
});

test("init tracks only the exact provider root and never claims the descendant tree empty", () => {
  const current = fixture();
  current.runtime.receive(handshake);
  current.runtime.receive(request());
  current.syscalls.rootExits.push({exitCode: 7, handle: current.syscalls.providerRootHandle, signal: null});
  current.runtime.tick();
  const state = current.runtime.snapshot();
  assert.equal(state.phase, "provider-exited");
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

test("provider stdin accounts committed bytes exactly and fences a second frame while blocked", () => {
  const current = fixture(); current.runtime.receive(handshake); current.runtime.receive(request());
  current.syscalls.inputOutcomes.push(
    {committedBytes: 2, status: "blocked"},
    {committedBytes: 2, status: "accepted"},
  );
  const mutable = Buffer.from("abcd");
  assert.equal(current.runtime.writeProviderInput(mutable), "blocked");
  mutable.fill("z");
  assert.equal(current.runtime.snapshot().stdinBytes, 2);
  current.runtime.stdinDrainReady();
  assert.deepEqual(current.syscalls.input.map(bytes => Buffer.from(bytes).toString()), ["ab", "cd"]);
  assert.equal(current.runtime.snapshot().stdinBytes, 4);
  assert.equal(current.runtime.snapshot().stdinStatus, "open");

  current.syscalls.inputStatus = "blocked";
  const first = encodeDockerCustodyFrame({bytesBase64: Buffer.from("x").toString("base64"), kind: "provider-input", requestId: request().requestId});
  const second = encodeDockerCustodyFrame({bytesBase64: Buffer.from("y").toString("base64"), kind: "provider-input", requestId: request().requestId});
  assert.throws(() => current.runtime.receiveControlBytes(Buffer.concat([Buffer.from(first), Buffer.from(second)])), /backpressured/u);
  assert.equal(current.runtime.snapshot().stdinBytes, 5);
  assert.equal(current.runtime.snapshot().startFenced, true);
  assert.deepEqual(containmentReasons(current.control), ["init-failure"]);
});

test("provider stdin close while blocked fails through containment, but requested EOF close does not", () => {
  const blocked = fixture(); blocked.runtime.receive(handshake); blocked.runtime.receive(request());
  blocked.syscalls.inputStatus = "blocked"; assert.equal(blocked.runtime.writeProviderInput(Buffer.from("x")), "blocked");
  blocked.runtime.providerInputClosed();
  assert.equal(blocked.runtime.snapshot().phase, "failed"); assert.deepEqual(blocked.syscalls.signals.map(item => item.signal), ["SIGTERM"]);
  assert.deepEqual(containmentReasons(blocked.control), ["init-failure"]);

  const eof = fixture(); eof.runtime.receive(handshake); eof.runtime.receive(request());
  eof.runtime.receive({kind: "provider-input-eof", requestId: request().requestId}); eof.runtime.providerInputClosed();
  assert.equal(eof.runtime.snapshot().phase, "provider-running");
});

test("control corruption TERM/KILL containment waits for root exit and output terminalization", () => {
  const current = fixture(); current.runtime.receive(handshake); current.runtime.receive(request()); current.runtime.malformedControlFrame();
  assert.equal(current.runtime.snapshot().failureCleanupComplete, false);
  assert.deepEqual(current.syscalls.signals.map(item => item.signal), ["SIGTERM"]);
  assert.deepEqual(containmentReasons(current.control), ["init-failure"]);
  assert.equal(current.control.some(message => message.kind === "provider-drain-complete"), false);

  current.syscalls.monotonic += 50; current.runtime.tick(); assert.deepEqual(current.syscalls.signals.map(item => item.signal), ["SIGTERM", "SIGKILL"]);
  current.runtime.closeProviderOutput(current.syscalls.stdoutHandle); current.runtime.closeProviderOutput(current.syscalls.stderrHandle);
  assert.equal(current.runtime.snapshot().failureCleanupComplete, false);
  current.syscalls.rootExits.push({exitCode: null, handle: current.syscalls.providerRootHandle, signal: "SIGKILL"}); current.runtime.tick();
  assert.equal(current.runtime.snapshot().failureCleanupComplete, true);
  assert.equal(current.runtime.snapshot().providerRootTracked, false); assert.equal(current.control.some(message => message.kind === "provider-drain-complete"), false);
});

test("control failure in stopping and exited phases preserves exact cleanup ordering", () => {
  const stopping = fixture(); stopping.runtime.receive(handshake); stopping.runtime.receive(request()); stopping.runtime.requestStop(); stopping.runtime.controlChannelClosed();
  assert.deepEqual(stopping.syscalls.signals.map(item => item.signal), ["SIGTERM"]);
  stopping.syscalls.monotonic += 50; stopping.runtime.tick(); assert.deepEqual(stopping.syscalls.signals.map(item => item.signal), ["SIGTERM", "SIGKILL"]);
  assert.deepEqual(containmentReasons(stopping.control), ["init-failure"]);

  const exited = fixture(); exited.runtime.receive(handshake); exited.runtime.receive(request());
  exited.syscalls.rootExits.push({exitCode: 0, handle: exited.syscalls.providerRootHandle, signal: null}); exited.runtime.tick();
  exited.runtime.malformedControlFrame(); assert.deepEqual(exited.syscalls.signals, []);
  assert.equal(exited.runtime.snapshot().failureCleanupComplete, false);
  exited.runtime.closeProviderOutput(exited.syscalls.stdoutHandle); exited.runtime.closeProviderOutput(exited.syscalls.stderrHandle);
  assert.equal(exited.runtime.snapshot().failureCleanupComplete, true); assert.deepEqual(containmentReasons(exited.control), ["init-failure"]);
});

test("an explicit deadline stop enters failed cleanup rather than successful drain", () => {
  const current = fixture(); current.runtime.receive(handshake); current.runtime.receive(request()); current.runtime.requestStop("deadline");
  assert.equal(current.runtime.snapshot().phase, "failed"); assert.deepEqual(current.syscalls.signals.map(item => item.signal), ["SIGTERM"]);
  assert.deepEqual(containmentReasons(current.control), ["deadline"]);
});

test("failed cleanup has explicit TERM, KILL, and terminal observation bounds", () => {
  const current = fixture(); current.runtime.receive(handshake); current.runtime.receive(request()); current.runtime.failInit();
  current.syscalls.monotonic += 50; current.runtime.tick(); assert.deepEqual(current.syscalls.signals.map(item => item.signal), ["SIGTERM", "SIGKILL"]);
  assert.equal(current.runtime.snapshot().failureCleanupComplete, false);
  current.syscalls.monotonic += 50; current.runtime.tick(); assert.equal(current.runtime.snapshot().failureCleanupComplete, true);
  assert.equal(current.runtime.snapshot().providerRootTracked, true);
  assert.deepEqual(containmentReasons(current.control), ["init-failure"]);
  assert.equal(current.control.some(message => message.kind === "provider-drain-complete"), false);
});

test("provider output error is typed, unproven, and enters the same bounded cleanup", () => {
  const current = fixture(); current.runtime.receive(handshake); current.runtime.receive(request());
  current.runtime.failProviderOutput(current.syscalls.stderrHandle);
  const failure = current.control.find(message => message.kind === "provider-drain-failed");
  assert.deepEqual(failure, {kind: "provider-drain-failed", outerContainmentClaim: "unproven",
    reason: "stderr-error", requestId: request().requestId});
  assert.deepEqual(parseDockerCustodyProtocolMessage(failure), failure);
  assert.deepEqual(current.syscalls.signals.map(item => item.signal), ["SIGTERM"]);
  current.runtime.closeProviderOutput(current.syscalls.stdoutHandle);
  current.syscalls.rootExits.push({exitCode: 1, handle: current.syscalls.providerRootHandle, signal: null});
  current.runtime.tick();
  assert.equal(current.runtime.snapshot().failureCleanupComplete, true);
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
  assert.equal(stale.runtime.closeProviderOutput(stale.syscalls.stdoutHandle), "closed");
  assert.equal(stale.control.some(message => message.kind === "provider-drain-complete"), false);
  assert.deepEqual(containmentReasons(stale.control), ["init-failure"]);
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
  assert.equal(current.runtime.closeProviderOutput(current.syscalls.stderrHandle), "closed");
  assert.equal(current.runtime.closeProviderOutput(current.syscalls.stdoutHandle), "closed");
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
    assert.deepEqual(current.syscalls.signals.map(item => item.signal), ["SIGTERM", "SIGKILL"]);
    assert.deepEqual(containmentReasons(current.control), [cause === "deadline" ? "deadline" : "shutdown-timeout"]);
    assert(current.control.some(message => message.kind === "container-containment-request"));
    assert.equal(current.runtime.snapshot().phase, "failed");
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
  assert.deepEqual(containmentReasons(current.control), ["deadline"]);
  assert.equal(current.runtime.snapshot().failureCleanupComplete, true);
  assert.equal(current.runtime.snapshot().stdout.status, "failed");
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
  assert.deepEqual(containmentReasons(ambiguous.control), ["init-failure"]);

  const crashed = fixture();
  crashed.runtime.receive(handshake);
  crashed.runtime.receive(request());
  crashed.runtime.failInit();
  assert.deepEqual(containmentReasons(crashed.control), ["init-failure"]);
  assert.equal(crashed.runtime.snapshot().containmentRequested, true);
});

test("a blocked host containment request remains pending until the one writer commits it", () => {
  let blocked = true;
  const accepted: DockerCustodyInitMessage[] = [];
  const current = fixture({writeControl(message) {
    if (message.kind === "container-containment-request" && blocked) {blocked = false; return "blocked";}
    accepted.push(message); return "accepted";
  }});
  current.runtime.receive(handshake); current.runtime.receive(request()); current.runtime.requestStop();
  current.syscalls.monotonic += 50; current.runtime.tick();
  assert.equal(current.runtime.snapshot().containmentRequested, false);
  assert.equal(accepted.filter(message => message.kind === "container-containment-request").length, 0);

  current.runtime.tick();
  assert.equal(current.runtime.snapshot().containmentRequested, true);
  assert.deepEqual(containmentReasons(accepted), ["shutdown-timeout"]);
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
