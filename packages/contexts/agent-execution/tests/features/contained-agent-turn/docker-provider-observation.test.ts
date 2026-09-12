import assert from "node:assert/strict";
import {test} from "node:test";
import {encodeDockerCustodyFrame, parseDockerCustodyProtocolMessage, type DockerCustodyProviderInstance} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/init/docker-custody-init-protocol.js";
import {request} from "./docker-custody-init-test-fixture.ts";
import {driver, hash, host, instance, start, root, drain, output, tick} from "./support/docker-provider-observation-fixture.ts";

test("production driver observes the actual retained child spawn after acknowledgement", {skip: process.platform !== "linux"}, async t => {
  const f = await driver(t);
  assert.equal(f.session.observation.providerInstance.status, "missing");
  assert.equal(f.messages.some(message => message.kind === "provider-instance"), false);
  f.child.emit("spawn"); await tick();
  assert.equal(f.session.observation.providerInstance.status, "observed");
  f.child.stdout.write(Uint8Array.of(0, 255)); f.child.stderr.write(Uint8Array.of(128, 13));
  f.exit(); assert.equal(await f.completion, 0);
  const completed = await f.session.completion;
  assert.equal(completed.observation.status, "complete");
  assert.equal(completed.observation.supervisorFinality, "unproven");
  assert.equal(completed.observation.executableMapping, "unproven");
  assert.deepEqual(completed.observation.stdout, {bytes: 2, sha256: hash(Uint8Array.of(0, 255))});
  assert.deepEqual(completed.observation.stderr, {bytes: 2, sha256: hash(Uint8Array.of(128, 13))});
  const observed = completed.observation.providerInstance; assert.ok("identity" in observed);
  const exec = f.channel.exec();
  assert.equal(observed.identity.executableSha256, exec.executableSha256);
  assert.equal(observed.identity.requestId, exec.requestId);
  assert.equal(observed.identity.launchFingerprintSha256, exec.launchFingerprintSha256);
  assert.equal(observed.identity.handshakeNonce, exec.handshakeNonce);
  assert.deepEqual(observed.identity.binding, exec.observationBinding);
  assert.equal(f.channel.readers, 1);
});

test("legacy identity omission never becomes process proof", async () => {
  const f = host(); await start(f); f.channel.push(root, drain); f.channel.end();
  const completed = await f.session.completion;
  assert.equal(completed.kind, "closed");
  assert.equal(completed.observation.providerInstance.status, "missing");
  assert.equal(completed.observation.status, "incomplete");
});

test("Host retains binary SHA256 before a consumer mutates the decoded output", async () => {
  const bytes = Uint8Array.of(0, 255, 128, 10, 13, 1);
  const f = host({onOutput: chunk => {chunk.bytes.fill(42);}}); await start(f);
  f.channel.push(instance(f.channel.exec()), output(bytes), root, drain); f.channel.end();
  const completed = await f.session.completion;
  assert.equal(completed.observation.stdout.sha256, hash(bytes));
  assert.equal(completed.observation.stdout.bytes, bytes.length);
  assert.equal(completed.observation.status, "incomplete");
});

test("retained same-PID ChildProcess objects receive distinct native instance and init identities", {skip: process.platform !== "linux"}, async t => {
  const identities: DockerCustodyProviderInstance[] = [];
  for (let index = 0; index < 2; index += 1) {
    const f = await driver(t); f.child.emit("spawn"); f.child.emit("spawn"); await tick();
    f.exit(); assert.equal(await f.completion, 0);
    const observed = (await f.session.completion).observation.providerInstance;
    assert.equal(observed.status, "observed"); assert.ok("identity" in observed);
    assert.equal(observed.identity.pid, 41); identities.push(observed.identity);
    assert.equal(f.messages.filter(message => message.kind === "provider-instance").length, 1);
    assert.equal(f.signals.length, 0);
  }
  assert.notEqual(identities[0]?.childInstanceId, identities[1]?.childInstanceId);
  assert.notEqual(identities[0]?.initInstanceId, identities[1]?.initInstanceId);
  assert.notEqual(identities[0]?.binding.challenge, identities[1]?.binding.challenge);
});

for (const scenario of ["exit-before-spawn", "error-before-spawn", "no-spawn"] as const) {
  test(`production driver never invents native identity: ${scenario}`, {skip: process.platform !== "linux"}, async t => {
    const f = await driver(t);
    if (scenario === "error-before-spawn") {f.child.emit("error", new Error("synthetic spawn failure"));}
    if (scenario === "exit-before-spawn") {f.exit();}
    if (scenario !== "no-spawn") {f.child.emit("spawn");}
    f.exit(); await f.completion;
    const observation = (await f.session.completion).observation;
    assert.equal(observation.providerInstance.status, "missing");
    assert.equal(observation.status, "incomplete");
    assert.equal(f.messages.some(message => message.kind === "provider-instance"), false);
  });
}

test("copied identity replay fails even when request, launch, init configuration and Engine generation match", async () => {
  const old = host(); await start(old); const replay = instance(old.channel.exec()); await old.session.cancel();
  const current = host(); await start(current);
  assert.notDeepEqual(current.channel.exec().observationBinding, old.channel.exec().observationBinding);
  current.channel.push(replay, root, drain); current.channel.end();
  const result = await current.session.completion;
  assert.equal(result.kind, "failed"); assert.equal(result.observation.status, "incomplete");
  assert.equal(result.observation.providerInstance.status, "missing");
});

for (const scenario of ["duplicate", "wrong-request", "wrong-launch", "wrong-executable", "wrong-nonce", "wrong-generation", "after-exit"] as const) {
  test(`Host rejects contradictory native identity: ${scenario}`, async () => {
    const f = host(); await start(f); const observed = instance(f.channel.exec());
    assert.equal(observed.kind, "provider-instance");
    if (observed.kind !== "provider-instance") {throw new Error("instance fixture");}
    const changed = scenario === "wrong-request" ? {...observed, requestId: "stale-request"}
      : scenario === "wrong-launch" ? {...observed, launchFingerprintSha256: "e".repeat(64)}
      : scenario === "wrong-executable" ? {...observed, executableSha256: "e".repeat(64)}
      : scenario === "wrong-nonce" ? {...observed, handshakeNonce: "stale-nonce"}
      : scenario === "wrong-generation" ? {...observed, binding: {...observed.binding, generation: "engine:g2"}} : observed;
    if (scenario === "duplicate") {f.channel.push(observed);}
    if (scenario === "after-exit") {f.channel.push(root);}
    f.channel.push(changed, root, drain); f.channel.end();
    const result = await f.session.completion;
    assert.equal(result.kind, "failed"); assert.equal(result.observation.status, "incomplete");
    assert.notEqual(result.observation.providerInstance.status, "observed");
  });
}

test("exact binary digests span fragmented frames and immutable partial/final snapshots", async () => {
  const stdout = Uint8Array.from({length: 60_001}, (_, index) => index % 256);
  const stderr = Uint8Array.of(0, 255, 128, 240, 159, 153, 130);
  const f = host(); await start(f); const before = f.session.observation;
  f.channel.push(instance(f.channel.exec()));
  const frame = encodeDockerCustodyFrame(output(stdout.subarray(0, 48_000)));
  f.channel.pushBytes(frame.subarray(0, 3)); f.channel.pushBytes(frame.subarray(3, 30_000));
  f.channel.pushBytes(frame.subarray(30_000)); await tick();
  const partial = f.session.observation;
  assert.equal(partial.status, "partial"); assert.equal(partial.stdout.sha256, hash(stdout.subarray(0, 48_000)));
  f.channel.push(root, output(stderr, "stderr"), output(stdout.subarray(48_000)), drain); f.channel.end();
  const result = await f.session.completion; const after = result.observation;
  assert.equal(after.status, "complete"); assert.equal(after.channelEof, true);
  assert.deepEqual(after.stdout, {bytes: stdout.length, sha256: hash(stdout)});
  assert.deepEqual(after.stderr, {bytes: stderr.length, sha256: hash(stderr)});
  assert.deepEqual(before.stdout, {bytes: 0, sha256: hash("")});
  assert.equal(partial.stdout.bytes, 48_000); assert.equal(partial.channelEof, false);
  assert.ok(Object.isFrozen(after)); assert.ok(Object.isFrozen(after.stdout));
  assert.ok(Object.isFrozen(after.providerInstance)); assert.ok(Object.isFrozen(after.authority.expectedIdentity));
  assert.ok(Object.isFrozen(after.rootExit));
  assert.strictEqual(f.session.observation, after);
  await f.session.close(); assert.strictEqual(f.session.observation, after);
});

for (const scenario of ["missing-root", "missing-drain", "missing-eof", "duplicate-drain", "output-after-drain", "partial-after-drain"] as const) {
  test(`drain string cannot complete observation: ${scenario}`, async () => {
    const f = host(); await start(f); f.channel.push(instance(f.channel.exec()), output(Uint8Array.of(0, 255)));
    if (scenario !== "missing-root") {f.channel.push(root);}
    if (scenario !== "missing-drain") {f.channel.push(drain);}
    if (scenario === "duplicate-drain") {f.channel.push(drain);}
    if (scenario === "output-after-drain") {f.channel.push(output(Uint8Array.of(42)));}
    if (scenario === "partial-after-drain") {f.channel.pushBytes(Uint8Array.of(0, 0));}
    if (scenario !== "missing-eof") {f.channel.end();}
    const result = await f.session.completion;
    assert.equal(result.kind, "failed"); assert.equal(result.observation.status, "incomplete");
    assert.deepEqual(result.observation.stdout, {bytes: 2, sha256: hash(Uint8Array.of(0, 255))});
    assert.equal(f.channel.readers, 1);
    if (scenario === "missing-drain") {assert.equal(result.observation.channelEof, true);}
  });
}

const fail = (): never => {throw new Error("synthetic consumer failure");};
for (const callback of ["output", "root", "drain"] as const) {
  test(`callback failure preserves immutable incomplete evidence: ${callback}`, async () => {
    const f = host(callback === "output" ? {onOutput: fail} : callback === "root" ? {onRootExit: fail} : {onDrainComplete: fail});
    await start(f); f.channel.push(instance(f.channel.exec()), output(Uint8Array.of(255)), root, drain); f.channel.end();
    const result = await f.session.completion;
    assert.equal(result.kind, "failed"); assert.equal(result.observation.status, "incomplete");
    assert.equal(result.observation.stdout.sha256, hash(Uint8Array.of(255)));
    if (callback !== "output") {assert.deepEqual(result.observation.rootExit, {exitCode: 17, signal: null});}
    if (callback === "drain") {assert.equal(result.observation.channelEof, true);}
  });
}

test("output limit retains decoded bytes but never complete evidence or callback delivery", async () => {
  let delivered = 0; const f = host({maximumStdoutBytes: 1, onOutput: () => {delivered += 1;}});
  await start(f); const bytes = Uint8Array.of(0, 255); f.channel.push(instance(f.channel.exec()), output(bytes), root, drain); f.channel.end();
  const result = await f.session.completion;
  assert.equal(result.kind, "failed"); assert.equal(result.observation.status, "incomplete");
  assert.deepEqual(result.observation.stdout, {bytes: 2, sha256: hash(bytes)}); assert.equal(delivered, 0);
});

for (const boundary of ["abort", "generation", "observation-inactive"] as const) {
  test(`final observation remains unproved after ${boundary} during output callback`, async () => {
    const abort = new AbortController(); let current = true; let active = true;
    const f = host({signal: abort.signal, isCurrentGeneration: () => current, isObservationActive: () => active,
      onOutput: () => {if (boundary === "abort") {abort.abort();} else if (boundary === "generation") {current = false;} else {active = false;}}});
    await start(f); f.channel.push(instance(f.channel.exec()), output(Uint8Array.of(0, 255)), root, drain); f.channel.end();
    const result = await f.session.completion;
    assert.equal(result.kind, "failed"); assert.equal(result.observation.status, "incomplete");
    assert.equal(result.observation.stdout.bytes, 2); assert.equal(f.channel.readers, 1);
  });
}

test("admission cutoff rejects queued writes while the sole reader retains stop tail and EOF", {skip: process.platform !== "linux"}, async t => {
  const f = await driver(t); f.child.emit("spawn"); await tick();
  const entered = Promise.withResolvers<void>(); const gate = Promise.withResolvers<void>();
  t.after(() => {gate.resolve();});
  f.channel.beforeWrite = async () => {entered.resolve(); await gate.promise;};
  const pending = f.session.writeInput(Uint8Array.of(9)); await entered.promise;
  f.session.cutOffAdmission(); const joining = f.session.drain();
  gate.resolve(); assert.equal((await pending).kind, "closed");
  f.child.stdout.write(Uint8Array.of(0, 255)); f.exit();
  assert.equal(await f.completion, 0); await joining;
  const result = await f.session.completion; assert.equal(result.observation.status, "complete");
  assert.equal(result.observation.stdout.sha256, hash(Uint8Array.of(0, 255)));
  assert.equal(f.channel.wire.some(message => message.kind === "provider-input" || message.kind === "host-signal"), false);
  assert.equal(f.channel.readers, 1); assert.equal(f.channel.returns, 1); assert.equal(f.channel.closes, 1);
});

test("strict private observation extension rejects missing, malformed and extra identity fields", async () => {
  const f = host(); await start(f); const message = instance(f.channel.exec()); await f.session.cancel();
  assert.equal(message.kind, "provider-instance");
  if (message.kind !== "provider-instance") {throw new Error("instance fixture");}
  const missingIdentity: Record<string, unknown> = {...message}; delete missingIdentity.childInstanceId;
  const invalid = [missingIdentity, {...message, childInstanceId: "caller-pid:41"}, {...message, initInstanceId: ""},
    {...message, pid: 1}, {...message, pid: 41.5}, {...message, pid: 2_147_483_648}, {...message, executableSha256: "unknown"},
    {...message, binding: {...message.binding, challenge: "request-derived"}}, {...message, binding: {...message.binding, extra: true}},
    {...message, identityProof: true}, {...message, childInstanceId: undefined},
    {...message, binding: new Proxy(message.binding, {})}];
  for (const value of invalid) {assert.throws(() => parseDockerCustodyProtocolMessage(value));}
  let read = false;
  const accessor = {...message}; Object.defineProperty(accessor, "childInstanceId", {get: () => {read = true; return "1".repeat(64);}});
  assert.throws(() => parseDockerCustodyProtocolMessage(accessor)); assert.equal(read, false);
  const parsed = parseDockerCustodyProtocolMessage(message);
  assert.deepEqual(parsed, message); assert.ok(Object.isFrozen(parsed));
  assert.deepEqual(parseDockerCustodyProtocolMessage(request()), request(), "legacy exec has exactly the old shape");
  assert.throws(() => parseDockerCustodyProtocolMessage({...request(), observationBinding: undefined}));
});

test("malformed identity on the sole wire fails closed, not legacy missing proof", async () => {
  const f = host(); await start(f); const message = instance(f.channel.exec());
  const bytes = Buffer.from(JSON.stringify({...message, pid: 1})); const frame = Buffer.alloc(bytes.length + 4);
  frame.writeUInt32BE(bytes.length); bytes.copy(frame, 4); f.channel.pushBytes(frame); f.channel.end();
  const result = await f.session.completion;
  assert.equal(result.kind, "failed"); assert.equal(result.observation.providerInstance.status, "missing");
  assert.equal(result.observation.status, "incomplete");
});

test("identity before acknowledgement never implies started native execution", async () => {
  const f = host();
  // Drive readiness manually, retaining the same pre-exec reader as production.
  const ready = f.session.ready();
  const authority = f.session.observation.authority;
  f.channel.push({kind: "init-ready", launchFingerprintSha256: authority.launchFingerprintSha256,
    nonce: authority.operationNonce, observedIdentity: authority.expectedIdentity, protocol: authority.expectedIdentity.protocol});
  await ready;
  const started = f.session.execute({argv: ["provider"], environment: [], executableSha256: request().executableSha256,
    gid: 10001, requestId: request().requestId, uid: 10001, wallDeadlineUnixMs: Date.now() + 1_000});
  await tick(); f.channel.push(instance(f.channel.exec()));
  assert.equal((await started).kind, "unknown");
  const result = await f.session.completion;
  assert.equal(result.observation.providerInstance.status, "missing"); assert.equal(result.observation.status, "incomplete");
});

test("PID changed between retained handle creation and native spawn cannot issue matching proof", {skip: process.platform !== "linux"}, async t => {
  const f = await driver(t); f.child.pid = 42; f.child.emit("spawn"); f.exit();
  assert.equal(await f.completion, 1);
  const result = await f.session.completion;
  assert.equal(result.observation.providerInstance.status, "missing"); assert.equal(result.observation.status, "incomplete");
  assert.equal(f.messages.some(message => message.kind === "provider-instance"), false);
});
