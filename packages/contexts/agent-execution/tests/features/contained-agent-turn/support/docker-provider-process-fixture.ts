import assert from "node:assert/strict";
import type {DockerContainerAuthority, DockerContainerCreate, DockerContainerObservation, DockerCustodyDuplexChannel,
  DockerEngineIdentity, DockerEnginePort} from "../../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/engine/docker-engine-port.js";
import {createDockerHostCustodyLifecycle} from "../../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/docker-host-custody-lifecycle.js";
import {createDockerCustodiedProviderProcessRegistry} from "../../../../dist/features/contained-agent-turn/composition/docker-custodied-provider-process.js";
import {DockerCustodyFrameDecoder, encodeDockerCustodyFrame, type DockerCustodyProtocolMessage}
  from "../../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/init/docker-custody-init-protocol.js";
import {MemoryStorage, digest, engineCall, owner, createInput} from "./docker-host-custody-lifecycle-fixture.ts";
import {initOptions, providerExec} from "./docker-claim-init-fixture.ts";

export {engineCall, initOptions, providerExec};
export const tick = (): Promise<void> => new Promise(resolve => {setImmediate(resolve);});
export const deferred = <T = void>() => Promise.withResolvers<T>();

export class MemoryInitChannel implements DockerCustodyDuplexChannel {
  readonly messages: DockerCustodyProtocolMessage[] = [];
  readonly values: Uint8Array[] = [];
  readers = 0; reads = 0; closes = 0; returns = 0;
  pending: ReturnType<typeof deferred<IteratorResult<Uint8Array>>> | undefined;
  ended = false;
  closeGate: Promise<void> | undefined;
  onMessage: ((message: DockerCustodyProtocolMessage) => void | Promise<void>) | undefined;
  readonly events: string[];
  constructor(events: string[]) {this.events = events;}
  push(message: DockerCustodyProtocolMessage): void {this.pushRaw(encodeDockerCustodyFrame(message));}
  pushRaw(value: Uint8Array): void {
    assert.ok(this.values.length < 100, "synthetic fixture frame bound");
    if (this.pending === undefined) {this.values.push(value);}
    else {const pending = this.pending; this.pending = undefined; pending.resolve({done: false, value});}
  }
  end(): void {
    this.ended = true;
    if (this.values.length === 0) {this.pending?.resolve({done: true, value: undefined}); this.pending = undefined;}
  }
  async close(): Promise<void> {
    this.closes += 1; this.events.push("channel-close"); await this.closeGate; this.end();
  }
  async closeInput(): Promise<void> {throw new Error("raw input close is not provider EOF");}
  readonly output = {[Symbol.asyncIterator]: (): AsyncIterator<Uint8Array> => {
    this.readers += 1; assert.equal(this.readers, 1);
    return {
      next: () => {
        this.reads += 1;
        assert.equal(this.pending, undefined, "session owns exactly one channel read");
        const value = this.values.shift();
        if (value !== undefined) {return Promise.resolve({done: false, value});}
        if (this.ended) {return Promise.resolve({done: true, value: undefined});}
        this.pending = deferred<IteratorResult<Uint8Array>>(); return this.pending.promise;
      },
      return: async () => {this.returns += 1; return {done: true, value: undefined};},
    };
  }};
  async write(bytes: Uint8Array, assertAdmission?: () => void): Promise<void> {
    assertAdmission?.();
    for (const message of new DockerCustodyFrameDecoder().push(bytes)) {
      this.messages.push(message); this.events.push(message.kind);
      if (this.onMessage !== undefined) {await this.onMessage(message);}
      else {this.respond(message);}
    }
  }
  respond(message: DockerCustodyProtocolMessage): void {
    if (message.kind === "host-handshake") {
      this.push({kind: "init-ready", launchFingerprintSha256: message.launchFingerprintSha256,
        nonce: message.nonce, observedIdentity: message.expectedIdentity, protocol: message.protocol});
    }
    if (message.kind === "provider-exec") {
      this.push({kind: "provider-exec-ack", observation: "started", requestId: message.requestId});
    }
  }
  outputBytes(stream: "stdout" | "stderr", bytes: Uint8Array | string): void {
    this.push({kind: "provider-output", requestId: providerExec.requestId, stream, bytesBase64: Buffer.from(bytes).toString("base64")});
  }
  rootExit(exitCode = 0): void {
    this.push({kind: "provider-observation", observation: "root-exited", exitCode, signal: null,
      requestId: providerExec.requestId, treeEmptyClaim: "not-claimed"});
  }
  drain(): void {
    this.push({kind: "provider-drain-complete", requestId: providerExec.requestId, rootExit: "observed",
      stderr: "eof", stdout: "eof", outerContainmentClaim: "unproven"}); this.end();
  }
}

/** Entirely in-memory engine for lifecycle integration; no filesystem, socket,
 * process or container operations. Resource inspection is outside this IO test. */
class MemoryEngine implements DockerEnginePort {
  readonly identityValue: DockerEngineIdentity = Object.freeze({cgroupDriver: "systemd", cgroupVersion: "2",
    daemonIdentitySha256: digest("daemon"), daemonBootGenerationSha256: digest("daemon-boot"),
    hostIdentitySha256: digest("host"), hostBootGenerationSha256: digest("host-boot"),
    engineVersion: "synthetic", storageDriver: "synthetic"});
  authority: DockerContainerAuthority | undefined;
  running = false; removed = false; attached = false;
  readonly channel: MemoryInitChannel;
  readonly events: string[];
  constructor(channel: MemoryInitChannel, events: string[]) {this.channel = channel; this.events = events;}
  async identity(): Promise<DockerEngineIdentity> {return this.identityValue;}
  async create(input: DockerContainerCreate): Promise<DockerContainerAuthority> {
    assert.equal(this.authority, undefined); this.events.push("create");
    this.authority = Object.freeze({daemonIdentitySha256: this.identityValue.daemonIdentitySha256,
      daemonBootGenerationSha256: this.identityValue.daemonBootGenerationSha256, hostIdentitySha256: this.identityValue.hostIdentitySha256,
      hostBootGenerationSha256: this.identityValue.hostBootGenerationSha256, containerId: "a".repeat(64),
      imageDigest: input.imageDigest, launchFingerprintSha256: input.launchFingerprintSha256,
      operationNonceSha256: input.operationNonceSha256, ownerIdentitySha256: input.ownerIdentitySha256,
      createSpecificationSha256: digest(JSON.stringify(input))});
    return this.authority;
  }
  assert(authority: DockerContainerAuthority): void {assert.deepEqual(authority, this.authority);}
  async attachCustody(authority: DockerContainerAuthority): Promise<DockerCustodyDuplexChannel> {
    this.assert(authority); assert.equal(this.attached, false); assert.equal(this.running, false);
    this.attached = true; this.events.push("attach"); return this.channel;
  }
  async reconcileCreate(): Promise<DockerContainerAuthority> {assert.ok(this.authority); return this.authority;}
  async inspect(authority: DockerContainerAuthority): Promise<DockerContainerObservation> {
    this.assert(authority);
    const base = {authority, cgroupTree: "unobserved" as const, engine: this.identityValue};
    return this.removed ? {...base, existence: "absent"} : {...base, existence: "present",
      resources: {} as Extract<DockerContainerObservation, {existence: "present"}>["resources"],
      state: {dead: false, errorPresent: false, exitCode: 0, finishedAt: "", hostPid: this.running ? 42 : 0,
        oomKilled: false, paused: false, restarting: false, running: this.running, startedAt: "",
        status: this.running ? "running" : "exited"}};
  }
  async start(authority: DockerContainerAuthority): Promise<void> {this.assert(authority); this.events.push("start"); this.running = true;}
  async stop(authority: DockerContainerAuthority): Promise<void> {this.assert(authority); this.events.push("stop"); this.running = false;}
  async kill(authority: DockerContainerAuthority): Promise<void> {await this.stop(authority);}
  async remove(authority: DockerContainerAuthority): Promise<void> {this.assert(authority); this.events.push("remove"); this.removed = true;}
  async wait(): Promise<DockerContainerObservation> {throw new Error("no separate Docker root waiter");}
  logs(): AsyncIterable<never> {throw new Error("no second Docker output reader");}
}

export const fixture = () => {
  const events: string[] = [];
  const channel = new MemoryInitChannel(events); const engine = new MemoryEngine(channel, events);
  const storage = new MemoryStorage();
  const lifecycle = createDockerHostCustodyLifecycle({engine, journalStorage: storage, residue: {async proveEmpty() {return "empty";}}});
  const registry = createDockerCustodiedProviderProcessRegistry();
  const launchInput = {call: engineCall(), create: createInput("/synthetic/disposable"), owner};
  const launch = async (lifetime?: Parameters<typeof lifecycle.launch>[0]["lifetime"]) => {
    const launched = await lifecycle.launch({...launchInput, ...(lifetime === undefined ? {} : {lifetime})});
    const input = {launch: launched, call: engineCall(), exec: providerExec, init: {...initOptions(),
      acknowledgementTimeoutMs: 250, readyTimeoutMs: 250, maximumStderrBytes: 1_000_000, maximumStdoutBytes: 1_000_000},
      expected: {authority: launched.authority, custodyRef: launched.key.custodyId,
        generation: initOptions().authority.generation, workspaceAuthorityPath: launchInput.create.workspaceSource}};
    return {input, launched, contain: (call = engineCall()) => lifecycle.contain({authority: launched.authority, key: launched.key, call})};
  };
  return {events, channel, engine, storage, lifecycle, registry, launch, launchInput};
};
