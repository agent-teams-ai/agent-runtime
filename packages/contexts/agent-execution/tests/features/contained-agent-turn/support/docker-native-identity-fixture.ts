import assert from "node:assert/strict";
import {spawn, type ChildProcessWithoutNullStreams} from "node:child_process";
import {once} from "node:events";
import {chmodSync, copyFileSync, mkdtempSync, readFileSync, realpathSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {dirname, join} from "node:path";
import {PassThrough} from "node:stream";
import type {TestContext} from "node:test";
import {DockerCustodyInitHostSession, type DockerCustodyInitHostOptions} from "../../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/init/docker-custody-init-host-session.js";
import {NodeDockerCustodyInitDriver, type NodeDockerCustodyInitDriverInternals} from "../../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/init/node-docker-custody-init-driver.js";
import {DockerCustodyFrameDecoder, type DockerCustodyProtocolMessage} from "../../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/init/docker-custody-init-protocol.js";
import {handshake, identity} from "../docker-custody-init-test-fixture.ts";
import {hash, ObservationChannel, tick} from "./docker-provider-observation-fixture.ts";

export const linux = {skip: process.platform !== "linux", timeout: 10_000};
export const sandbox = (t: TestContext, source = "/bin/cat") => {
  const directory = mkdtempSync(join(tmpdir(), "ar69-r263-native-identity-"));
  t.after(() => {rmSync(directory, {force: true, recursive: true});});
  const executablePath = join(directory, "provider-entrypoint");
  copyFileSync(source, executablePath); chmodSync(executablePath, 0o555);
  return {directory, executablePath, executableSha256: hash(readFileSync(executablePath))};
};

export const disposeChild = async (child: ChildProcessWithoutNullStreams): Promise<void> => {
  if (child.exitCode === null && child.signalCode === null) {
    const closed = once(child, "close"); child.kill("SIGKILL"); await closed;
  }
  child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
};
export const fixedChild = (t: TestContext, path: string): ChildProcessWithoutNullStreams => {
  const child = spawn(path, [], {cwd: dirname(realpathSync(path)), env: {}, stdio: ["pipe", "pipe", "pipe"]});
  t.after(async () => {await disposeChild(child);});
  return child;
};

export const nativeDriver = async (t: TestContext, slot = sandbox(t),
  internals: NodeDockerCustodyInitDriverInternals = {}, hostOptions: Partial<DockerCustodyInitHostOptions> = {}) => {
  const uid = process.getuid!(); const gid = process.getgid!();
  assert.ok(uid > 0 && gid > 0, "disposable native fixture requires the installed non-root Linux worker");
  const channel = new ObservationChannel(); const output = new PassThrough();
  const messages: DockerCustodyProtocolMessage[] = []; const decoder = new DockerCustodyFrameDecoder();
  output.on("data", (chunk: Buffer) => {messages.push(...decoder.push(chunk)); channel.pushBytes(chunk);});
  output.on("end", () => {channel.end();});
  const session = new DockerCustodyInitHostSession({acknowledgementTimeoutMs: 1_000, readyTimeoutMs: 1_000,
    authority: {expectedIdentity: identity, generation: "native:g1", launchFingerprintSha256: handshake.launchFingerprintSha256,
      operationNonce: handshake.nonce}, channel, isCurrentGeneration: value => value === "native:g1",
    maximumStderrBytes: 65_536, maximumStdoutBytes: 65_536, ...hostOptions});
  const driver = new NodeDockerCustodyInitDriver({...slot, allowedEnvironmentNames: [], controlInput: channel.input,
    controlOutput: output, maximumProviderRuntimeMs: 3_000, maximumStderrBytes: 65_536, maximumStdinBytes: 65_536,
    maximumStdoutBytes: 65_536, observedIdentity: identity, shutdownGraceMs: 20, tickIntervalMs: 1}, {
    // Only Docker/tini topology is synthetic. UID, native spawn and procfs are real.
    observeTopology: () => ({uid, gid, groups: [gid], noNewPrivileges: true, parentName: "tini", parentPid: 1, pid: process.pid}),
    ...internals,
  });
  const completion = driver.run();
  t.after(async () => {channel.input.end(); await completion; await session.close(); output.destroy();});
  assert.equal((await session.ready()).kind, "ready");
  // Production inherits init's cwd. Put the test init in its new disposable sandbox for the sole launch.
  const previousDirectory = process.cwd();
  let started: Awaited<ReturnType<DockerCustodyInitHostSession["execute"]>>;
  try {
    process.chdir(slot.directory);
    started = await session.execute({argv: ["provider-entrypoint"], environment: [], executableSha256: slot.executableSha256,
      gid, uid, requestId: "native-request", wallDeadlineUnixMs: Date.now() + 2_000});
    await tick();
  } finally {process.chdir(previousDirectory);}
  const finish = async () => {
    await session.closeProviderInput();
    const code = await completion; const result = await session.completion;
    return {code, result};
  };
  return {channel, completion, finish, messages, session, slot, started};
};
