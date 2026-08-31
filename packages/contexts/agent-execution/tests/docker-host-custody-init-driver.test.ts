import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
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

  const providerCode = "process.stdin.on('data',b=>{process.stdout.write(Buffer.from(b).toString().toUpperCase());process.stderr.write('warn')});process.stdin.on('end',()=>process.exit(7))";
  const requestId = "driver-request:one";
  const frames = [
    {argv: [process.execPath, "-e", providerCode], environment: [], executableSha256: digest("d"),
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
  assert.deepEqual(outputs.map(message => [message.stream, Buffer.from(message.bytesBase64, "base64").toString()]).toSorted(), [
    ["stderr", "warn"], ["stdout", "HELLO"],
  ]);
  assert(messages.some(message => message.kind === "provider-observation" && message.observation === "root-exited" && message.exitCode === 7));
  assert.equal(messages.filter(message => message.kind === "provider-drain-complete").length, 1);
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
