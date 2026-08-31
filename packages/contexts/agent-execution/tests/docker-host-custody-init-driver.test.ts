import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { chmod, copyFile, link, mkdir, mkdtemp, readFile, rename, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";

import {
  DOCKER_CUSTODY_INIT_PROTOCOL,
  DockerCustodyFrameDecoder,
  encodeDockerCustodyFrame,
  type DockerCustodyIdentity,
  type DockerCustodyProtocolMessage,
} from "../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/init/docker-custody-init-protocol.js";
import {
  assertDockerCustodyTopologyFacts,
  holdDockerCustodyProviderExecutable,
  NodeDockerCustodyInitDriver,
  writeDockerCustodyProviderInput,
  writeDockerCustodyProviderOutputFragments,
} from "../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/init/node-docker-custody-init-driver.js";

const digest = (value: string): string => value.repeat(64);
const identity: DockerCustodyIdentity = Object.freeze({
  containerImageSha256: digest("a"), initBinarySha256: digest("b"),
  privateRootIdentity: "private-root:driver", protocol: DOCKER_CUSTODY_INIT_PROTOCOL,
  securityProfileIdentity: "security-profile:driver", workspaceIdentity: "workspace:driver",
});
const handshake = Object.freeze({expectedIdentity: identity, kind: "host-handshake" as const,
  launchFingerprintSha256: digest("c"), nonce: "driver-nonce", protocol: DOCKER_CUSTODY_INIT_PROTOCOL});

test("Node custody init launches only after exec, frames both provider streams, and drains child exit", async t => {
  const uid = 65_534;
  const gid = 65_534;
  const fixturePath = join(import.meta.dirname, "fixtures", "docker-custody-init-process.mjs");
  const child = spawn(process.execPath, [fixturePath], {stdio: ["pipe", "pipe", "pipe"]});
  t.after(() => {if (child.exitCode === null && child.signalCode === null) {child.kill("SIGKILL");}});
  const decoder = new DockerCustodyFrameDecoder();
  const messages: DockerCustodyProtocolMessage[] = [];
  let stderr = "";
  child.stderr.on("data", chunk => {stderr += String(chunk);});
  child.stdout.on("data", chunk => {messages.push(...decoder.push(chunk));});

  const handshakeFrame = encodeDockerCustodyFrame(handshake);
  child.stdin.write(handshakeFrame.subarray(0, 3));
  child.stdin.write(handshakeFrame.subarray(3));
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {reject(new Error("init-ready timeout"));}, 2_000);
    const poll = setInterval(() => {
      if (messages.some(message => message.kind === "init-ready")) {clearInterval(poll); clearTimeout(timeout); resolve();}
    }, 2);
  });
  assert.equal(messages.some(message => message.kind === "provider-exec-ack"), false);

  const requestId = "driver-request:one";
  const executableSha256 = createHash("sha256").update(await readFile("/bin/cat")).digest("hex");
  const frames = [
    {argv: ["provider-entrypoint"], environment: [], executableSha256,
      executableSlot: "provider-entrypoint", gid, handshakeNonce: "driver-nonce", kind: "provider-exec",
      launchFingerprintSha256: digest("c"), requestId, uid, wallDeadlineUnixMs: Date.now() + 4_000},
    {bytesBase64: Buffer.from("hello").toString("base64"), kind: "provider-input", requestId},
    {kind: "provider-input-eof", requestId},
  ] as const;
  child.stdin.write(Buffer.concat(frames.map(frame => Buffer.from(encodeDockerCustodyFrame(frame)))));
  const [exitCode] = await Promise.race([
    once(child, "exit"),
    new Promise<never>((_resolve, reject) => {setTimeout(() => {
      reject(new Error(`driver exit timeout: ${messages.map(message => message.kind).join(",")}; stderr=${stderr}`));
    }, 5_000).unref();}),
  ]);
  decoder.finish();
  assert.equal(exitCode, 0, stderr);
  assert.equal(stderr, "");
  assert(messages.some(message => message.kind === "provider-exec-ack" && message.observation === "started"));
  const outputs = messages.filter(message => message.kind === "provider-output");
  assert.deepEqual(outputs.map(message => [message.stream, Buffer.from(message.bytesBase64, "base64").toString()]), [
    ["stdout", "hello"],
  ]);
  assert(messages.some(message => message.kind === "provider-observation" && message.observation === "root-exited" && message.exitCode === 0));
  assert.equal(messages.filter(message => message.kind === "provider-drain-complete").length, 1);
});

test("malformed control and EOF contain a live provider before init exits failed", async t => {
  for (const failure of ["malformed", "eof"] as const) {
    const fixturePath = join(import.meta.dirname, "fixtures", "docker-custody-init-process.mjs");
    const child = spawn(process.execPath, [fixturePath], {stdio: ["pipe", "pipe", "pipe"]});
    t.after(() => {if (child.exitCode === null && child.signalCode === null) {child.kill("SIGKILL");}});
    const decoder = new DockerCustodyFrameDecoder(); const messages: DockerCustodyProtocolMessage[] = [];
    let stderr = ""; child.stderr.on("data", chunk => {stderr += String(chunk);});
    child.stdout.on("data", chunk => {messages.push(...decoder.push(chunk));});
    child.stdin.write(encodeDockerCustodyFrame(handshake));
    const executableSha256 = createHash("sha256").update(await readFile("/bin/cat")).digest("hex");
    child.stdin.write(encodeDockerCustodyFrame({argv: ["provider-entrypoint"], environment: [], executableSha256,
      executableSlot: "provider-entrypoint", gid: 65_534, handshakeNonce: "driver-nonce", kind: "provider-exec",
      launchFingerprintSha256: digest("c"), requestId: `control-${failure}`, uid: 65_534, wallDeadlineUnixMs: Date.now() + 4_000}));
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {reject(new Error(`${failure} provider start timeout`));}, 2_000);
      const poll = setInterval(() => {
        if (messages.some(message => message.kind === "provider-exec-ack" && message.observation === "started")) {
          clearInterval(poll); clearTimeout(timeout); resolve();
        }
      }, 2);
    });
    if (failure === "malformed") {child.stdin.write(Uint8Array.of(0, 0, 0, 1, 123));} else {child.stdin.end();}
    const [exitCode] = await Promise.race([
      once(child, "exit"),
      new Promise<never>((_resolve, reject) => {setTimeout(() => {reject(new Error(`${failure} containment timeout`));}, 3_000).unref();}),
    ]);
    assert.equal(exitCode, 1, stderr);
    assert(messages.some(message => message.kind === "container-containment-request" && message.reason === "init-failure"));
    assert.equal(messages.some(message => message.kind === "provider-drain-complete"), false);
  }
});

test("PID topology rejects PID1, non-direct, root, privileged, grouped, and non-tini chains", () => {
  const valid = {gid: 10001, groups: [10001], noNewPrivileges: true, parentName: "docker-init",
    parentPid: 1, pid: 2, uid: 10001};
  assert.doesNotThrow(() => {assertDockerCustodyTopologyFacts(valid);});
  for (const invalid of [
    {...valid, pid: 1}, {...valid, parentPid: 9}, {...valid, uid: 0}, {...valid, gid: 0},
    {...valid, noNewPrivileges: false}, {...valid, groups: [10001, 10002]}, {...valid, parentName: "node"},
  ]) {assert.throws(() => {assertDockerCustodyTopologyFacts(invalid);}, /direct child/u);}
});

test("provider output chunks fragment without changing binary order, cursor, or aggregate accounting", () => {
  for (const size of [48_001, 65_536]) {
    const bytes = Uint8Array.from({length: size}, (_, index) => index % 251);
    const frames: Buffer[] = [];
    const result = writeDockerCustodyProviderOutputFragments(message => {
      if (message.kind === "provider-output") {frames.push(Buffer.from(message.bytesBase64, "base64"));}
      return "accepted";
    }, "fragment-request", "stdout", bytes);
    assert.deepEqual(frames.map(frame => frame.byteLength), size === 48_001 ? [48_000, 1] : [48_000, 17_536]);
    assert.deepEqual(Buffer.concat(frames), Buffer.from(bytes));
    assert.deepEqual(result, {committedBytes: size, status: "accepted"});
  }
  const unicodeAndBinary = Buffer.concat([Buffer.from("🙂漢字".repeat(8_001)), Buffer.from([0, 255, 128, 1])]);
  const frames: Buffer[] = [];
  let offers = 0;
  const first = writeDockerCustodyProviderOutputFragments(message => {
    offers += 1;
    if (offers === 2) {return "blocked";}
    if (message.kind === "provider-output") {frames.push(Buffer.from(message.bytesBase64, "base64"));}
    return "accepted";
  }, "cursor-request", "stderr", unicodeAndBinary);
  assert.deepEqual(first, {committedBytes: 48_000, status: "blocked"});
  const second = writeDockerCustodyProviderOutputFragments(message => {
    if (message.kind === "provider-output") {frames.push(Buffer.from(message.bytesBase64, "base64"));}
    return "accepted";
  }, "cursor-request", "stderr", unicodeAndBinary.subarray(first.committedBytes));
  assert.equal(first.committedBytes + second.committedBytes, unicodeAndBinary.byteLength);
  assert.deepEqual(Buffer.concat(frames), unicodeAndBinary);
});

test("Node writable false commits every offered stdin byte and reports backpressure", () => {
  const input = new PassThrough({highWaterMark: 1});
  const bytes = Buffer.from("committed");
  assert.deepEqual(writeDockerCustodyProviderInput(input, bytes), {committedBytes: bytes.byteLength, status: "blocked"});
  assert.deepEqual(input.read(), bytes);
  input.end();
  assert.deepEqual(writeDockerCustodyProviderInput(input, Buffer.from("late")), {committedBytes: 0, status: "closed"});
});

test("held executable authority rejects mismatch and substitutions and survives pathname replacement", async t => {
  const root = await mkdtemp(join(tmpdir(), "ar-provider-slot-"));
  t.after(async () => {await rm(root, {force: true, recursive: true});});
  const slot = join(root, "provider-entrypoint");
  await copyFile("/bin/true", slot); await chmod(slot, 0o555);
  const expected = createHash("sha256").update(await readFile(slot)).digest("hex");
  assert.throws(() => holdDockerCustodyProviderExecutable(slot, "0".repeat(64)), /identity/u);
  const held = holdDockerCustodyProviderExecutable(slot, expected);
  const original = join(root, "original"); const replacement = join(root, "replacement");
  await rename(slot, original); await copyFile("/bin/false", replacement); await chmod(replacement, 0o555); await rename(replacement, slot);
  const child = spawn(held.descriptorPath, [], {stdio: ["ignore", "ignore", "ignore"]});
  const [exitCode] = await once(child, "exit");
  assert.equal(exitCode, 0);
  held.close(); held.close();
  await assert.rejects(readFile(held.descriptorPath));

  await rm(slot); await symlink("/bin/true", slot);
  assert.throws(() => holdDockerCustodyProviderExecutable(slot, expected));
  await rm(slot); const hardlinkSource = join(root, "hardlink-source"); await copyFile("/bin/true", hardlinkSource);
  await chmod(hardlinkSource, 0o555); await link(hardlinkSource, slot);
  assert.throws(() => holdDockerCustodyProviderExecutable(slot, expected), /private executable/u);
  await rm(slot); await mkdir(slot);
  assert.throws(() => holdDockerCustodyProviderExecutable(slot, expected), /regular file|private executable/u);
  await rm(slot, {recursive: true});
  const realRoot = join(root, "real-root"); const aliasRoot = join(root, "alias-root");
  await mkdir(realRoot); await copyFile("/bin/true", join(realRoot, "provider-entrypoint")); await chmod(join(realRoot, "provider-entrypoint"), 0o555); await symlink(realRoot, aliasRoot, "dir");
  assert.throws(() => holdDockerCustodyProviderExecutable(join(aliasRoot, "provider-entrypoint"), expected), /root is substituted/u);
});

test("held executable hashing rejects an oversized sparse executable before scanning", async t => {
  const root = await mkdtemp(join(tmpdir(), "ar-provider-size-"));
  t.after(async () => {await rm(root, {force: true, recursive: true});});
  const slot = join(root, "provider-entrypoint");
  await writeFile(slot, "x"); await truncate(slot, 256 * 1_024 * 1_024 + 1); await chmod(slot, 0o555);
  assert.throws(() => holdDockerCustodyProviderExecutable(slot, createHash("sha256").update("x").digest("hex")), /private executable/u);
});

test("early spawn ENOENT settles once as not-started and closes the held descriptor", async t => {
  const root = await mkdtemp(join(tmpdir(), "ar-provider-spawn-failure-"));
  t.after(async () => {await rm(root, {force: true, recursive: true});});
  const executablePath = join(root, "provider-entrypoint");
  await copyFile("/bin/cat", executablePath); await chmod(executablePath, 0o555);
  const executableSha256 = createHash("sha256").update(await readFile(executablePath)).digest("hex");
  const input = new PassThrough(); const output = new PassThrough();
  const decoder = new DockerCustodyFrameDecoder(); const messages: DockerCustodyProtocolMessage[] = [];
  output.on("data", chunk => {messages.push(...decoder.push(chunk));});
  let descriptorPath = "";
  const driver = new NodeDockerCustodyInitDriver({
    allowedEnvironmentNames: [], controlInput: input, controlOutput: output, executablePath, executableSha256,
    maximumProviderRuntimeMs: 1_000, maximumStderrBytes: 65_536, maximumStdinBytes: 65_536,
    maximumStdoutBytes: 65_536, observedIdentity: identity, shutdownGraceMs: 10, tickIntervalMs: 1,
  }, {
    observeRestrictedIdentity: () => ({gid: 65_534, uid: 65_534}),
    observeTopology: () => ({gid: 65_534, groups: [65_534], noNewPrivileges: true,
      parentName: "docker-init", parentPid: 1, pid: 2, uid: 65_534}),
    spawnProcess: specification => {
      descriptorPath = specification.executablePath;
      return spawn("/ar-definitely-absent-provider", [], {stdio: ["pipe", "pipe", "pipe"]});
    },
  });
  const completion = driver.run();
  input.write(encodeDockerCustodyFrame(handshake));
  input.write(encodeDockerCustodyFrame({argv: ["provider-entrypoint"], environment: [], executableSha256,
    executableSlot: "provider-entrypoint", gid: 65_534, handshakeNonce: "driver-nonce", kind: "provider-exec",
    launchFingerprintSha256: digest("c"), requestId: "spawn-failure", uid: 65_534, wallDeadlineUnixMs: Date.now() + 500}));
  assert.equal(await completion, 1);
  decoder.finish();
  assert.equal(messages.filter(message => message.kind === "provider-exec-ack" && message.observation === "not-started").length, 1);
  assert.equal(messages.filter(message => message.kind === "provider-observation" && message.observation === "spawn-failed").length, 1);
  await assert.rejects(readFile(descriptorPath));
});
