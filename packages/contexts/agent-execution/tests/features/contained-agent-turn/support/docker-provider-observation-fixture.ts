import assert from "node:assert/strict";
import {EventEmitter} from "node:events";
import type {ChildProcessWithoutNullStreams} from "node:child_process";
import {createHash} from "node:crypto";
import {chmod, mkdtemp, rm, writeFile} from "node:fs/promises";
import {join} from "node:path";
import {PassThrough} from "node:stream";
import type {TestContext} from "node:test";
import {DockerCustodyInitHostSession, type DockerCustodyInitHostOptions} from "../../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/init/docker-custody-init-host-session.js";
import {NodeDockerCustodyInitDriver} from "../../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/init/node-docker-custody-init-driver.js";
import {DockerCustodyFrameDecoder, encodeDockerCustodyFrame, type DockerCustodyProtocolMessage, type DockerCustodyProviderExecRequest} from "../../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/init/docker-custody-init-protocol.js";
import {handshake, identity, request} from "../docker-custody-init-test-fixture.ts";

export const hash = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");
export const tick = (): Promise<void> => new Promise(resolve => {setImmediate(resolve);});
export const root = {exitCode: 17, kind: "provider-observation", observation: "root-exited", requestId: request().requestId,
  signal: null, treeEmptyClaim: "not-claimed"} as const;
export const drain = {kind: "provider-drain-complete", outerContainmentClaim: "unproven", requestId: request().requestId,
  rootExit: "observed", stderr: "eof", stdout: "eof"} as const;
export const output = (bytes: Uint8Array, stream: "stderr" | "stdout" = "stdout"): DockerCustodyProtocolMessage =>
  ({bytesBase64: Buffer.from(bytes).toString("base64"), kind: "provider-output", requestId: request().requestId, stream});

export class ObservationChannel {
  readonly input = new PassThrough();
  readonly wire: DockerCustodyProtocolMessage[] = [];
  #pending: ((value: IteratorResult<Uint8Array>) => void) | undefined;
  readonly #values: Uint8Array[] = [];
  #ended = false;
  public readers = 0;
  public returns = 0;
  public closes = 0;
  public beforeWrite: (() => Promise<void>) | undefined;
  public readonly output: AsyncIterable<Uint8Array> = {[Symbol.asyncIterator]: () => {
    this.readers += 1;
    return {next: async () => {
      assert.equal(this.#pending, undefined, "only one pending read");
      const value = this.#values.shift();
      if (value !== undefined) {return {done: false, value};}
      if (this.#ended) {return {done: true, value: undefined};}
      return new Promise<IteratorResult<Uint8Array>>(resolve => {this.#pending = resolve;});
    }, return: async () => {this.returns += 1; return {done: true, value: undefined};}};
  }};
  public pushBytes(value: Uint8Array): void {
    const pending = this.#pending; this.#pending = undefined;
    if (pending !== undefined) {pending({done: false, value});} else {this.#values.push(value);}
  }
  public push(...messages: DockerCustodyProtocolMessage[]): void {
    this.pushBytes(Buffer.concat(messages.map(message => encodeDockerCustodyFrame(message))));
  }
  public end(): void {this.#ended = true; this.#pending?.({done: true, value: undefined}); this.#pending = undefined;}
  public async write(bytes: Uint8Array, beforeWrite?: () => void): Promise<void> {
    await this.beforeWrite?.(); beforeWrite?.();
    const decoder = new DockerCustodyFrameDecoder(); this.wire.push(...decoder.push(bytes)); decoder.finish();
    this.input.write(bytes);
  }
  public async close(): Promise<void> {this.closes += 1; this.end(); this.input.destroy();}
  public async closeInput(): Promise<void> {this.input.end();}
  public exec(): DockerCustodyProviderExecRequest {
    const exec = this.wire.find(message => message.kind === "provider-exec"); assert.ok(exec?.kind === "provider-exec"); return exec;
  }
}

export const host = (overrides: Partial<DockerCustodyInitHostOptions> = {}) => {
  const channel = new ObservationChannel();
  const session = new DockerCustodyInitHostSession({acknowledgementTimeoutMs: 80, readyTimeoutMs: 80,
    authority: {expectedIdentity: identity, generation: "engine:g1", launchFingerprintSha256: handshake.launchFingerprintSha256,
      operationNonce: handshake.nonce}, channel, isCurrentGeneration: generation => generation === "engine:g1",
    maximumStderrBytes: 100_000, maximumStdoutBytes: 100_000, ...overrides});
  return {channel, session};
};
export const start = async (f: ReturnType<typeof host>, executableSha256 = request().executableSha256, automatic = true) => {
  const ready = f.session.ready();
  if (automatic) {f.channel.push({kind: "init-ready", launchFingerprintSha256: handshake.launchFingerprintSha256,
    nonce: handshake.nonce, observedIdentity: identity, protocol: identity.protocol});}
  assert.equal((await ready).kind, "ready");
  const started = f.session.execute({argv: ["provider"], environment: [], executableSha256, gid: 10001,
    requestId: request().requestId, uid: 10001, wallDeadlineUnixMs: Date.now() + 5_000});
  await tick();
  if (automatic) {f.channel.push({kind: "provider-exec-ack", observation: "started", requestId: request().requestId});}
  assert.equal((await started).kind, "started");
};

export const instance = (exec: DockerCustodyProviderExecRequest): DockerCustodyProtocolMessage => ({
  binding: exec.observationBinding!, childInstanceId: "1".repeat(64), executableSha256: exec.executableSha256,
  handshakeNonce: exec.handshakeNonce, initInstanceId: "2".repeat(64), kind: "provider-instance",
  launchFingerprintSha256: exec.launchFingerprintSha256, pid: 41, requestId: exec.requestId,
});

export const driver = async (t: TestContext, options: Partial<DockerCustodyInitHostOptions> = {}) => {
  const directory = await mkdtemp("/tmp/ar69-r245-provider-observation-");
  t.after(async () => {await rm(directory, {recursive: true, force: true});});
  const executablePath = join(directory, "provider-entrypoint");
  const bytes = Buffer.from("synthetic held executable; never executed\n");
  await writeFile(executablePath, bytes); await chmod(executablePath, 0o555);
  const f = host(options); const controlOutput = new PassThrough(); const signals: string[] = [];
  const child = Object.assign(new EventEmitter(), {pid: 41, stdin: new PassThrough(), stdout: new PassThrough(),
    stderr: new PassThrough(), kill: (signal: string) => {signals.push(signal); return true;}});
  const messages: DockerCustodyProtocolMessage[] = []; const decoder = new DockerCustodyFrameDecoder();
  controlOutput.on("data", (chunk: Buffer) => {messages.push(...decoder.push(chunk)); f.channel.pushBytes(chunk);});
  controlOutput.on("end", () => {f.channel.end();});
  const runtime = new NodeDockerCustodyInitDriver({allowedEnvironmentNames: [], controlInput: f.channel.input,
    controlOutput, executablePath, executableSha256: hash(bytes), maximumProviderRuntimeMs: 2_000,
    maximumStderrBytes: 100_000, maximumStdinBytes: 1_000, maximumStdoutBytes: 100_000,
    observedIdentity: identity, shutdownGraceMs: 10, tickIntervalMs: 1}, {
    observeRestrictedIdentity: () => ({uid: 10001, gid: 10001}),
    observeTopology: () => ({uid: 10001, gid: 10001, groups: [10001], noNewPrivileges: true,
      parentName: "tini", parentPid: 1, pid: 2}),
    spawnProcess: () => child as unknown as ChildProcessWithoutNullStreams,
  });
  const completion = runtime.run();
  const exit = (): void => {child.emit("exit", 17, null); child.stdout.end(); child.stderr.end(); child.emit("close");};
  t.after(async () => {exit(); await f.session.cancel(); await completion; controlOutput.destroy(); child.stdin.destroy();});
  await start(f, hash(bytes), false);
  return {...f, child, completion, exit, messages, signals};
};
