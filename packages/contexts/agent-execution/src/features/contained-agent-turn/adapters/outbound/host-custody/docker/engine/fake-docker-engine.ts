import { createHash } from "node:crypto";

import { containerName, encodeCreateRequest, validateAuthorityShape } from "./docker-engine-codec.js";
import { DockerEngineError } from "./docker-engine-error.js";
import type {
  DockerContainerAuthority,
  DockerContainerCreate,
  DockerContainerObservation,
  DockerContainerResourceFacts,
  DockerContainerStateFacts,
  DockerEngineCall,
  DockerEngineIdentity,
  DockerEnginePolicy,
  DockerEnginePort,
  DockerLogFrame,
} from "./docker-engine-port.js";
import { DOCKER_LOG_MAX_FRAME_BYTES, DOCKER_LOG_MAX_STREAM_BYTES } from "./docker-engine-port.js";

export type FakeCreateOutcome = "acknowledged" | "daemon-disconnect" | "lost-acknowledgement" | "malformed-response";
export type FakeDockerOperation = "create" | "inspect" | "kill" | "logs" | "remove" | "start" | "stop";

interface FakeContainer {
  readonly authority: DockerContainerAuthority;
  readonly input: DockerContainerCreate;
  removed: boolean;
  state: DockerContainerStateFacts;
}

interface FakeLogPlan {
  readonly delayed: boolean;
  readonly frames: readonly DockerLogFrame[];
}

const hash = (value: string): string => createHash("sha256").update(value).digest("hex");

const initialState = (): DockerContainerStateFacts => ({
  dead: false,
  errorPresent: false,
  exitCode: 0,
  finishedAt: "0001-01-01T00:00:00Z",
  hostPid: 0,
  oomKilled: false,
  running: false,
  startedAt: "0001-01-01T00:00:00Z",
  status: "created",
});

export class FakeDockerEngine implements DockerEnginePort {
  readonly #containers = new Map<string, FakeContainer>();
  readonly #createOutcomes: FakeCreateOutcome[] = [];
  readonly #events: string[] = [];
  readonly #logPlans = new Map<string, FakeLogPlan>();
  readonly #malformed = new Map<FakeDockerOperation, number>();
  readonly #names = new Map<string, string>();
  readonly #policy: DockerEnginePolicy;
  #counter = 0;
  #daemonGeneration = "initial";
  #disconnected = false;
  #replacementNameOnLostAcknowledgement: string | undefined;
  #releaseStreams: (() => void) | undefined;
  #streamsReleased = false;
  #streamGate = new Promise<void>(resolve => {this.#releaseStreams = resolve;});

  public constructor(policy: DockerEnginePolicy) {
    this.#policy = Object.freeze({
      ...policy,
      allowedEnvironmentKeys: Object.freeze([...policy.allowedEnvironmentKeys]),
    });
    encodeCreateRequest({
      arguments: [],
      entrypoint: "/bin/false",
      environment: {},
      imageDigest: `validation@sha256:${"0".repeat(64)}`,
      launchFingerprintSha256: "0".repeat(64),
      operationNonceSha256: "0".repeat(64),
      privateRootSource: `${policy.privateRootSourceRoot}/validation`,
      workspaceSource: `${policy.workspaceSourceRoot}/validation`,
      workspaceWritable: false,
    }, this.#policy);
  }

  public get events(): readonly string[] {return [...this.#events];}

  public enqueueCreateOutcome(outcome: FakeCreateOutcome): void {this.#createOutcomes.push(outcome);}

  public injectMalformedResponse(operation: FakeDockerOperation, count = 1): void {
    this.#malformed.set(operation, count);
  }

  public releaseDelayedStreams(): void {
    this.#releaseStreams?.();
    this.#streamsReleased = true;
    this.#streamGate = Promise.resolve();
  }

  public replaceId(id: string, replacement: DockerContainerAuthority): void {
    const existing = this.#containers.get(id);
    if (existing === undefined) {throw new DockerEngineError("resource-not-found");}
    this.#containers.set(id, { ...existing, authority: replacement });
  }

  public replaceName(operationNonceSha256: string, replacementContainerId: string): void {
    this.#names.set(containerName(operationNonceSha256), replacementContainerId);
  }

  public reuseNameOnNextLostAcknowledgement(replacementContainerId: string): void {
    this.#replacementNameOnLostAcknowledgement = replacementContainerId;
  }

  public restartDaemon(generation: string): void {
    this.#daemonGeneration = generation;
    this.#disconnected = false;
    this.#events.push("daemon:restart");
  }

  public setDisconnected(disconnected: boolean): void {
    this.#disconnected = disconnected;
    this.#events.push(disconnected ? "daemon:disconnect" : "daemon:reconnect");
  }

  public setLogs(
    authority: DockerContainerAuthority,
    frames: readonly DockerLogFrame[],
    options: { readonly delayed?: boolean } = {},
  ): void {
    if (options.delayed === true && this.#streamsReleased) {
      this.#streamsReleased = false;
      this.#streamGate = new Promise<void>(resolve => {this.#releaseStreams = resolve;});
    }
    this.#logPlans.set(authority.containerId, { delayed: options.delayed === true, frames: [...frames] });
  }

  public async create(input: DockerContainerCreate, call: DockerEngineCall): Promise<DockerContainerAuthority> {
    this.#check("create", call);
    encodeCreateRequest(input, this.#policy);
    const engine = this.#identity();
    const name = containerName(input.operationNonceSha256);
    const named = this.#names.get(name);
    if (named !== undefined && this.#containers.get(named)?.removed !== true) {
      throw new DockerEngineError("resource-already-exists", 409);
    }
    const outcome = this.#createOutcomes.shift() ?? "acknowledged";
    if (outcome === "malformed-response") {throw new DockerEngineError("malformed-response");}
    if (outcome === "daemon-disconnect") {
      this.#disconnected = true;
      throw new DockerEngineError("daemon-disconnected");
    }
    const authority = this.#newAuthority(input, engine);
    const record = { authority, input, removed: false, state: initialState() };
    this.#containers.set(authority.containerId, record);
    this.#names.set(name, authority.containerId);
    this.#events.push(`create:${outcome}`);
    if (outcome === "lost-acknowledgement") {
      if (this.#replacementNameOnLostAcknowledgement !== undefined) {
        this.#names.set(name, this.#replacementNameOnLostAcknowledgement);
        this.#replacementNameOnLostAcknowledgement = undefined;
      }
      const resolved = this.#names.get(name);
      const observed = resolved === undefined ? undefined : this.#containers.get(resolved);
      if (observed === undefined || observed.removed || !this.#sameAuthority(observed.authority, authority)) {
        throw new DockerEngineError("create-acknowledgement-unknown");
      }
      this.#events.push("create:resolved-by-name");
    }
    return authority;
  }

  public async inspect(
    authority: DockerContainerAuthority,
    call: DockerEngineCall,
  ): Promise<DockerContainerObservation> {
    this.#check("inspect", call);
    validateAuthorityShape(authority);
    const engine = this.#identity();
    this.#assertEngine(authority, engine);
    const record = this.#containers.get(authority.containerId);
    if (record === undefined || record.removed) {
      return { authority, cgroupTree: "unobserved", engine, existence: "absent" };
    }
    if (!this.#sameAuthority(record.authority, authority)) {throw new DockerEngineError("authority-conflict");}
    return {
      authority,
      cgroupTree: "unobserved",
      engine,
      existence: "present",
      resources: this.#resources(record),
      state: { ...record.state },
    };
  }

  public async start(authority: DockerContainerAuthority, call: DockerEngineCall): Promise<void> {
    const record = await this.#record("start", authority, call);
    record.state = {
      ...record.state,
      hostPid: 10_000 + this.#counter,
      running: true,
      startedAt: "2026-01-01T00:00:00Z",
      status: "running",
    };
    this.#events.push("start:id");
  }

  public logs(authority: DockerContainerAuthority, call: DockerEngineCall): AsyncIterable<DockerLogFrame> {
    return this.#logs(authority, call);
  }

  public async stop(authority: DockerContainerAuthority, call: DockerEngineCall): Promise<void> {
    const record = await this.#record("stop", authority, call);
    this.#exit(record, 0);
    this.#events.push("stop:id");
  }

  public async kill(authority: DockerContainerAuthority, call: DockerEngineCall): Promise<void> {
    const record = await this.#record("kill", authority, call);
    this.#exit(record, 137);
    this.#events.push("kill:id");
  }

  public async remove(authority: DockerContainerAuthority, call: DockerEngineCall): Promise<void> {
    const record = await this.#record("remove", authority, call);
    if (record.state.running) {throw new DockerEngineError("request-rejected", 409);}
    record.removed = true;
    this.#events.push("remove:id");
  }

  async *#logs(authority: DockerContainerAuthority, call: DockerEngineCall): AsyncIterable<DockerLogFrame> {
    await this.#record("logs", authority, call);
    const plan = this.#logPlans.get(authority.containerId) ?? { delayed: false, frames: [] };
    if (plan.delayed) {await this.#waitForStream(call);}
    let bytes = 0;
    for (const frame of plan.frames) {
      this.#checkContinuation(authority, call);
      if (frame.bytes.byteLength > DOCKER_LOG_MAX_FRAME_BYTES) {
        throw new DockerEngineError("stream-frame-too-large");
      }
      bytes += frame.bytes.byteLength;
      if (bytes > DOCKER_LOG_MAX_STREAM_BYTES) {throw new DockerEngineError("stream-too-large");}
      yield { bytes: frame.bytes.slice(), stream: frame.stream };
    }
  }

  async #record(
    operation: FakeDockerOperation,
    authority: DockerContainerAuthority,
    call: DockerEngineCall,
  ): Promise<FakeContainer> {
    this.#check(operation, call);
    const observation = await this.inspect(authority, call);
    if (observation.existence !== "present") {throw new DockerEngineError("resource-not-found");}
    const record = this.#containers.get(authority.containerId);
    if (record === undefined) {throw new DockerEngineError("resource-not-found");}
    return record;
  }

  #check(operation: FakeDockerOperation, call: DockerEngineCall): void {
    this.#checkCall(call);
    if (this.#disconnected) {throw new DockerEngineError("daemon-disconnected");}
    const malformed = this.#malformed.get(operation) ?? 0;
    if (malformed > 0) {
      this.#malformed.set(operation, malformed - 1);
      throw new DockerEngineError("malformed-response");
    }
  }

  #checkCall(call: DockerEngineCall): void {
    if (call.signal.aborted) {throw new DockerEngineError("aborted");}
    if (!Number.isSafeInteger(call.deadlineEpochMs) || call.deadlineEpochMs <= Date.now()) {
      throw new DockerEngineError("deadline-exceeded");
    }
  }

  #checkContinuation(authority: DockerContainerAuthority, call: DockerEngineCall): void {
    this.#checkCall(call);
    if (this.#disconnected) {throw new DockerEngineError("daemon-disconnected");}
    this.#assertEngine(authority, this.#identity());
  }

  #identity(): DockerEngineIdentity {
    return {
      cgroupDriver: "systemd",
      cgroupVersion: "2",
      daemonIdentitySha256: hash(`fake-daemon:${this.#daemonGeneration}`),
      engineVersion: "fake-1",
      hostIdentitySha256: this.#policy.hostIdentitySha256,
      storageDriver: "overlay2",
    };
  }

  #newAuthority(input: DockerContainerCreate, engine: DockerEngineIdentity): DockerContainerAuthority {
    this.#counter += 1;
    return {
      containerId: hash(`${engine.daemonIdentitySha256}:${this.#counter}:${input.operationNonceSha256}`),
      daemonIdentitySha256: engine.daemonIdentitySha256,
      hostIdentitySha256: engine.hostIdentitySha256,
      imageDigest: input.imageDigest,
      launchFingerprintSha256: input.launchFingerprintSha256,
      operationNonceSha256: input.operationNonceSha256,
    };
  }

  #resources(record: FakeContainer): DockerContainerResourceFacts {
    return {
      appArmorProfile: this.#policy.appArmorProfile,
      autoRemove: false,
      capabilitiesDropped: "all",
      cgroupNamespaceMode: "private",
      cgroupParent: "",
      containerId: record.authority.containerId,
      cpuNanoCpus: this.#policy.cpuNanoCpus,
      init: true,
      ipcNamespaceMode: "private",
      memoryBytes: this.#policy.memoryBytes,
      memorySwapBytes: this.#policy.memoryBytes,
      mountPropagation: "rprivate",
      networkName: this.#policy.allowedNetworkName,
      noNewPrivileges: true,
      pidNamespaceMode: "private",
      pidsLimit: this.#policy.pidsLimit,
      privateRootSourceSha256: hash(record.input.privateRootSource),
      readOnlyRoot: true,
      restart: "disabled",
      seccompProfileSha256: this.#policy.seccompProfileSha256,
      tmpfsBytes: this.#policy.tmpfsBytes,
      user: this.#policy.user,
      workspaceSourceSha256: hash(record.input.workspaceSource),
      workspaceWritable: record.input.workspaceWritable,
      writableLayerBytes: this.#policy.writableLayerBytes,
    };
  }

  #assertEngine(authority: DockerContainerAuthority, engine: DockerEngineIdentity): void {
    if (authority.daemonIdentitySha256 !== engine.daemonIdentitySha256 ||
        authority.hostIdentitySha256 !== engine.hostIdentitySha256) {
      throw new DockerEngineError("daemon-identity-changed");
    }
  }

  #sameAuthority(left: DockerContainerAuthority, right: DockerContainerAuthority): boolean {
    return left.containerId === right.containerId && left.daemonIdentitySha256 === right.daemonIdentitySha256 &&
      left.hostIdentitySha256 === right.hostIdentitySha256 && left.imageDigest === right.imageDigest &&
      left.launchFingerprintSha256 === right.launchFingerprintSha256 &&
      left.operationNonceSha256 === right.operationNonceSha256;
  }

  #exit(record: FakeContainer, exitCode: number): void {
    record.state = {
      ...record.state,
      exitCode,
      finishedAt: "2026-01-01T00:00:01Z",
      hostPid: 0,
      running: false,
      status: "exited",
    };
  }

  async #waitForStream(call: DockerEngineCall): Promise<void> {
    const remaining = Math.min(call.deadlineEpochMs - Date.now(), 120_000);
    if (remaining <= 0) {throw new DockerEngineError("deadline-exceeded");}
    await new Promise<void>((resolve, reject) => {
      const abort = (): void => {cleanup(); reject(new DockerEngineError("aborted"));};
      const timer = setTimeout(() => {cleanup(); reject(new DockerEngineError("deadline-exceeded"));}, remaining);
      const cleanup = (): void => {
        clearTimeout(timer);
        call.signal.removeEventListener("abort", abort);
      };
      call.signal.addEventListener("abort", abort, { once: true });
      const release = async (): Promise<void> => {
        await this.#streamGate;
        cleanup();
        resolve();
      };
      void release();
    });
  }
}
