import assert from "node:assert/strict";
import {test} from "node:test";
import {DockerCustodyFrameDecoder, encodeDockerCustodyFrame, parseDockerCustodyProtocolMessage,
  type DockerCustodyProviderInstance} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/init/docker-custody-init-protocol.js";
import {request} from "./docker-custody-init-test-fixture.ts";
import {drain, hash, host, instance, output, root, start, tick} from "./support/docker-provider-observation-fixture.ts";
import {linux, nativeDriver} from "./support/docker-native-identity-fixture.ts";

// Synthetic wire-only sample: these facts never enter the production native observer.
const mapping = {device: "1048579", inode: "1001", kind: "linux-procfs-exe-v1", scope: "spawn-observation", startTimeTicks: "1234"} as const;
const boundInstance = async () => {
  const f = host(); await start(f); const legacy = instance(f.channel.exec()); await f.session.cancel();
  assert.equal(legacy.kind, "provider-instance");
  return legacy as DockerCustodyProviderInstance;
};

test("strict optional mapping roundtrips detached and legacy bytes are unchanged", async () => {
  const legacy = await boundInstance();
  const frame = encodeDockerCustodyFrame(legacy);
  const payload = JSON.stringify({binding: {challenge: legacy.binding.challenge, generation: legacy.binding.generation},
    childInstanceId: legacy.childInstanceId, executableSha256: legacy.executableSha256, handshakeNonce: legacy.handshakeNonce,
    initInstanceId: legacy.initInstanceId, kind: legacy.kind, launchFingerprintSha256: legacy.launchFingerprintSha256,
    pid: legacy.pid, requestId: legacy.requestId});
  assert.equal(Buffer.from(frame).subarray(4).toString(), payload);
  assert.equal(Buffer.from(frame).readUInt32BE(), Buffer.byteLength(payload));
  const mutable = {...legacy, executableMapping: {...mapping, inode: String(mapping.inode)}};
  const parsed = parseDockerCustodyProtocolMessage(mutable);
  assert.ok(parsed.kind === "provider-instance");
  mutable.executableMapping.inode = "1002";
  assert.equal(parsed.executableMapping!.inode, "1001");
  assert.ok(Object.isFrozen(parsed.executableMapping));
  const decoder = new DockerCustodyFrameDecoder();
  assert.deepEqual(decoder.push(encodeDockerCustodyFrame(parsed)), [parsed]); decoder.finish();
  assert.deepEqual(parseDockerCustodyProtocolMessage(request()), request());
  assert.throws(() => parseDockerCustodyProtocolMessage({...request(), executableMapping: mapping}));
});

test("strict optional mapping rejects missing, forged, unsafe, accessor and noncanonical fields", async () => {
  const legacy = await boundInstance();
  const incomplete = {...mapping} as Record<string, unknown>; delete incomplete.inode;
  const invalid = [undefined, null, true, "observed", [], {}, incomplete,
    {...mapping, device: "01"}, {...mapping, device: -1}, {...mapping, device: "-1"}, {...mapping, inode: "0"},
    {...mapping, inode: "18446744073709551616"}, {...mapping, startTimeTicks: "0"}, {...mapping, startTimeTicks: "1.5"},
    {...mapping, kind: "pidfd"}, {...mapping, scope: "whole-lifetime"}, {...mapping, executableSha256: legacy.executableSha256},
    new Proxy(mapping, {})];
  for (const executableMapping of invalid) {
    assert.throws(() => parseDockerCustodyProtocolMessage({...legacy, executableMapping}));
  }
  let accessed = false; const accessor = {...mapping};
  Object.defineProperty(accessor, "inode", {get: () => {accessed = true; return "1001";}});
  assert.throws(() => parseDockerCustodyProtocolMessage({...legacy, executableMapping: accessor}));
  assert.equal(accessed, false);
  const value = parseDockerCustodyProtocolMessage({...legacy, executableMapping: {...mapping, device: "0", inode: "18446744073709551615"}});
  assert.ok(value.kind === "provider-instance"); assert.equal(value.executableMapping!.inode, "18446744073709551615");
});

for (const mismatch of ["challenge", "generation", "request", "launch", "executable", "handshake", "duplicate", "after-root"] as const) {
  test(`mapped identity remains bound to strict Host authority: ${mismatch}`, async () => {
    const f = host(); await start(f); const base = instance(f.channel.exec()) as DockerCustodyProviderInstance;
    const message = {...base, executableMapping: mapping};
    const wrong = mismatch === "challenge" ? {...message, binding: {...message.binding, challenge: "9".repeat(64)}}
      : mismatch === "generation" ? {...message, binding: {...message.binding, generation: "engine:stale"}}
      : mismatch === "request" ? {...message, requestId: "stale"}
      : mismatch === "launch" ? {...message, launchFingerprintSha256: "9".repeat(64)}
      : mismatch === "executable" ? {...message, executableSha256: "9".repeat(64)}
      : mismatch === "handshake" ? {...message, handshakeNonce: "stale"} : message;
    if (mismatch === "duplicate") {f.channel.push(message);}
    if (mismatch === "after-root") {f.channel.push(root);}
    f.channel.push(wrong, root, drain); f.channel.end();
    const result = await f.session.completion;
    assert.equal(result.kind, "failed"); assert.equal(result.observation.status, "incomplete");
    assert.equal(result.observation.executableMapping, "unproven");
  });
}

for (const missing of ["root", "drain", "eof"] as const) {
  test(`mapped evidence is not sealed without real ${missing}`, async () => {
    const f = host(); await start(f);
    f.channel.push({...instance(f.channel.exec()) as DockerCustodyProviderInstance, executableMapping: mapping});
    if (missing !== "root") {f.channel.push(root);}
    if (missing !== "drain") {f.channel.push(drain);}
    if (missing !== "eof") {f.channel.end();}
    const result = await f.session.completion;
    assert.equal(result.observation.status, "incomplete");
    assert.equal(result.observation.executableMapping, "unproven");
  });
}

test("fresh native instances differ and an actual old mapping frame cannot replay into a matching new authority", linux, async t => {
  const old = await nativeDriver(t); const oldResult = (await old.finish()).result;
  const current = await nativeDriver(t); const currentResult = (await current.finish()).result;
  const first = oldResult.observation.providerInstance; const second = currentResult.observation.providerInstance;
  assert.ok("identity" in first && "identity" in second);
  assert.notEqual(first.identity.childInstanceId, second.identity.childInstanceId);
  assert.notEqual(first.identity.initInstanceId, second.identity.initInstanceId);
  assert.notEqual(first.identity.binding.challenge, second.identity.binding.challenge);
  assert.equal(oldResult.observation.executableMapping, "observed");
  assert.equal(currentResult.observation.executableMapping, "observed");

  const f = host({authority: oldResult.observation.authority, isCurrentGeneration: generation => generation === "native:g1"});
  const authority = oldResult.observation.authority;
  const ready = f.session.ready();
  f.channel.push({kind: "init-ready", launchFingerprintSha256: authority.launchFingerprintSha256,
    nonce: authority.operationNonce, observedIdentity: authority.expectedIdentity, protocol: authority.expectedIdentity.protocol});
  await ready;
  const original = old.channel.exec();
  const started = f.session.execute({argv: original.argv, environment: original.environment, executableSha256: original.executableSha256,
    uid: original.uid, gid: original.gid, requestId: original.requestId, wallDeadlineUnixMs: Date.now() + 1_000});
  await tick(); f.channel.push({kind: "provider-exec-ack", observation: "started", requestId: original.requestId});
  await started;
  assert.notEqual(f.channel.exec().observationBinding!.challenge, first.identity.binding.challenge);
  f.channel.push(first.identity); f.channel.end();
  const rejected = await f.session.completion;
  assert.equal(rejected.kind, "failed"); assert.equal(rejected.observation.executableMapping, "unproven");
  assert.equal(rejected.observation.providerInstance.status, "missing");
});

const fail = (): never => {throw new Error("synthetic callback failure");};

for (const failure of ["output", "root", "drain", "mutated-output"] as const) {
  test(`real mapped child callback failure preserves incomplete evidence: ${failure}`, linux, async t => {
    const f = await nativeDriver(t, undefined, {}, failure === "output" ? {onOutput: fail}
      : failure === "root" ? {onRootExit: fail} : failure === "drain" ? {onDrainComplete: fail}
      : {onOutput: chunk => {chunk.bytes.fill(0);}});
    assert.equal(f.session.observation.executableMapping, "observed");
    await f.session.writeInput(Buffer.from("sample"));
    const {result} = await f.finish();
    assert.equal(result.observation.status, "incomplete"); assert.equal(result.observation.executableMapping, "unproven");
    assert.equal(result.observation.stdout.sha256, hash("sample"));
    assert.ok(Object.isFrozen(result.observation));
  });
}

test("native observation stays immutable after retained callback bytes mutate, with no input or exec replay", linux, async t => {
  let retained: Uint8Array | undefined;
  const f = await nativeDriver(t, undefined, {}, {onOutput: chunk => {retained = chunk.bytes;}});
  const partial = f.session.observation;
  await f.session.writeInput(Buffer.from("once"));
  const {result} = await f.finish();
  retained!.fill(0);
  assert.equal(result.observation.executableMapping, "observed");
  assert.equal(result.observation.stdout.sha256, hash("once"));
  assert.equal(result.observation.stdout.bytes, 4); assert.equal(partial.stdout.bytes, 0);
  assert.equal(result.observation.status, "complete");
  assert.strictEqual(f.session.observation, result.observation);
  await assert.rejects(f.session.execute({argv: ["provider-entrypoint"], environment: [], executableSha256: f.slot.executableSha256,
    gid: process.getgid!(), uid: process.getuid!(), requestId: "replay", wallDeadlineUnixMs: Date.now() + 1_000}), /one-use/u);
  assert.equal(f.channel.wire.filter(message => message.kind === "provider-exec").length, 1);
  assert.equal(f.channel.wire.filter(message => message.kind === "provider-input").length, 1);
});

test("legacy instance plus provider-output pretending to carry mapping stays unproven", async () => {
  const f = host(); await start(f);
  f.channel.push(instance(f.channel.exec()), output(Buffer.from(JSON.stringify(mapping))), root, drain); f.channel.end();
  const result = await f.session.completion;
  assert.equal(result.observation.executableMapping, "unproven");
  assert.equal(result.observation.status, "complete");
});
