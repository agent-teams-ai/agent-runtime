/* oxlint-disable max-lines -- the fake mirrors the complete strict Docker Engine state surface. */
import { createHash } from "node:crypto";

import { validateAuthorityShape } from "./docker-engine-codec.js";
import { canonicalizeCreateMounts, containerName, encodeCreateRequest } from "./docker-create-request.js";
import { createSpecificationSha256 } from "./docker-create-specification.js";
import { snapshotDockerContainerCreate, snapshotDockerEngineCall, snapshotDockerEnginePolicy } from "./docker-boundary-snapshot.js";
import { DockerEngineError } from "./docker-engine-error.js";
import { isTerminalObservation, mutationPostconditionSatisfied } from "./docker-engine-semantics.js";
import { authorityBelongsToFakeEngine, exitedFakeContainerState, initialFakeContainerState, sameFakeAuthority,
  sameFakeEngine, startedFakeContainerState } from "./fake-docker-engine-state.js";
import type {
  DockerContainerAuthority,
  DockerContainerCreate,
  DockerContainerObservation,
  DockerContainerResourceFacts,
  DockerContainerStateFacts,
  DockerEngineCall,
  DockerCustodyDuplexChannel,
  DockerEngineIdentity,
  DockerEnginePolicy,
  DockerEnginePort,
  DockerLogFrame,
} from "./docker-engine-port.js";
import { DOCKER_LOG_MAX_FRAME_BYTES, DOCKER_LOG_MAX_FRAMES, DOCKER_LOG_MAX_STREAM_BYTES } from "./docker-engine-port.js";

export type FakeCreateOutcome = "acknowledged" | "daemon-disconnect" | "lost-acknowledgement" | "malformed-response";
export type FakeDockerOperation = "attach" | "create" | "inspect" | "kill" | "logs" | "remove" | "start" | "stop" | "wait";
export type FakeMutationOperation = "kill" | "remove" | "start" | "stop";

interface FakeContainer {
  readonly authority: DockerContainerAuthority;
  input: DockerContainerCreate;
  removed: boolean;
  state: DockerContainerStateFacts;
}

interface FakeLogPlan {
  readonly delayed: boolean;
  readonly frames: readonly DockerLogFrame[];
}

const hash = (value: string): string => createHash("sha256").update(value).digest("hex");

export class FakeDockerEngine implements DockerEnginePort {
  readonly #attachState = new Map<string, "invalid" | "open" | "started">();
  readonly #attachCleanup = new Map<string, () => void>();
  readonly #custodyInput = new Map<string, Uint8Array[]>();
  readonly #containers = new Map<string, FakeContainer>();
  readonly #createOutcomes: FakeCreateOutcome[] = [];
  readonly #events: string[] = [];
  readonly #logPlans = new Map<string, FakeLogPlan>();
  readonly #malformed = new Map<FakeDockerOperation, number>();
  readonly #names = new Map<string, string>();
  readonly #mutationOutcomes = new Map<FakeMutationOperation, Array<{ acknowledgement: "304" | "lost"; effect: boolean }>>();
  readonly #policy: DockerEnginePolicy;
  #counter = 0;
  #daemonGeneration = "initial";
  #hostGeneration = "initial";
  #disconnected = false;
  #endpointCustodyLost = false;
  #replacementNameOnLostAcknowledgement: string | undefined;
  #releaseStreams: (() => void) | undefined;
  #streamsReleased = false;
  #streamGate = new Promise<void>(resolve => {this.#releaseStreams = resolve;});
  #stateRevision = 0;
  #releaseStateTransition: (() => void) | undefined;
  #stateTransition = new Promise<void>(resolve => {this.#releaseStateTransition = resolve;});

  public constructor(policy: DockerEnginePolicy) {
    this.#policy = snapshotDockerEnginePolicy(policy);
    encodeCreateRequest({
      arguments: [],
      entrypoint: "/bin/false",
      environment: {},
      imageDigest: `validation@sha256:${"0".repeat(64)}`,
      launchFingerprintSha256: "0".repeat(64),
      operationNonceSha256: "0".repeat(64),
      ownerIdentitySha256: "0".repeat(64),
      privateRootSource: `${this.#policy.privateRootSourceRoot}/validation`,
      workspaceSource: `${this.#policy.workspaceSourceRoot}/validation`,
      workspaceWritable: false,
    }, this.#policy);
  }

  public get events(): readonly string[] {return [...this.#events];}
  public custodyInput(authority: DockerContainerAuthority): Uint8Array {
    return Uint8Array.from(Buffer.concat((this.#custodyInput.get(authority.containerId) ?? []).map(bytes => Buffer.from(bytes))));
  }

  public enqueueCreateOutcome(outcome: FakeCreateOutcome): void {this.#createOutcomes.push(outcome);}

  public injectMalformedResponse(operation: FakeDockerOperation, count = 1): void {
    this.#malformed.set(operation, count);
  }

  public enqueueMutationOutcome(operation: FakeMutationOperation,
    outcome: { readonly acknowledgement: "304" | "lost"; readonly effect: "applied" | "not-applied" }): void {
    const outcomes = this.#mutationOutcomes.get(operation) ?? [];
    outcomes.push({ acknowledgement: outcome.acknowledgement, effect: outcome.effect === "applied" });
    this.#mutationOutcomes.set(operation, outcomes);
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

  public replaceCreateInput(id: string, replacement: DockerContainerCreate): void {
    const existing = this.#containers.get(id);
    if (existing === undefined) {throw new DockerEngineError("resource-not-found");}
    existing.input = replacement;
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

  public restartHost(generation: string): void {
    this.#hostGeneration = generation;
    this.#events.push("host:restart");
  }

  public loseEndpointCustody(): void {this.#endpointCustodyLost = true;}

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

  public async identity(call: DockerEngineCall): Promise<DockerEngineIdentity> {
    const callSnapshot = snapshotDockerEngineCall(call);
    this.#check("inspect", callSnapshot);
    return Object.freeze({ ...this.#identity() });
  }

  public async create(
    input: DockerContainerCreate,
    call: DockerEngineCall,
    expectedIdentity?: DockerEngineIdentity,
  ): Promise<DockerContainerAuthority> {
    const callSnapshot = snapshotDockerEngineCall(call);
    const inputSnapshot = snapshotDockerContainerCreate(input);
    this.#check("create", callSnapshot);
    const canonicalInput = await canonicalizeCreateMounts(inputSnapshot, this.#policy);
    encodeCreateRequest(canonicalInput, this.#policy);
    const engine = this.#identity();
    if (expectedIdentity !== undefined) {this.#assertSameEngine(expectedIdentity, engine);}
    const name = containerName(canonicalInput.operationNonceSha256);
    const named = this.#names.get(name);
    if (named !== undefined && this.#containers.get(named)?.removed !== true) {
      throw new DockerEngineError("resource-already-exists", 409);
    }
    const outcome = this.#createOutcomes.shift() ?? "acknowledged";
    if (outcome === "daemon-disconnect") {
      throw new DockerEngineError("create-acknowledgement-unknown");
    }
    const authority = this.#newAuthority(canonicalInput, engine);
    const record = { authority, input: canonicalInput, removed: false, state: initialFakeContainerState() };
    this.#containers.set(authority.containerId, record);
    this.#names.set(name, authority.containerId);
    this.#events.push(`create:${outcome}`);
    if (outcome === "lost-acknowledgement" || outcome === "malformed-response") {
      if (this.#replacementNameOnLostAcknowledgement !== undefined) {
        this.#names.set(name, this.#replacementNameOnLostAcknowledgement);
        this.#replacementNameOnLostAcknowledgement = undefined;
      }
      const resolved = this.#names.get(name);
      const observed = resolved === undefined ? undefined : this.#containers.get(resolved);
      if (observed === undefined || observed.removed || !sameFakeAuthority(observed.authority, authority)) {
        throw new DockerEngineError("create-acknowledgement-unknown");
      }
      this.#events.push(`create:${outcome}:resolved-by-name`);
    }
    return authority;
  }

  public async reconcileCreate(input: DockerContainerCreate, call: DockerEngineCall): Promise<DockerContainerAuthority> {
    const callSnapshot = snapshotDockerEngineCall(call);
    const inputSnapshot = snapshotDockerContainerCreate(input);
    this.#check("inspect", callSnapshot);
    const canonicalInput = await canonicalizeCreateMounts(inputSnapshot, this.#policy);
    encodeCreateRequest(canonicalInput, this.#policy);
    const id = this.#names.get(containerName(canonicalInput.operationNonceSha256));
    const record = id === undefined ? undefined : this.#containers.get(id);
    if (record === undefined || record.removed || !sameFakeAuthority(
      record.authority,
      this.#newAuthorityForReconciliation(canonicalInput, this.#identity(), record.authority.containerId),
    )) {
      throw new DockerEngineError("create-acknowledgement-unknown");
    }
    return { ...record.authority };
  }

  public async inspect(authority: DockerContainerAuthority, call: DockerEngineCall): Promise<DockerContainerObservation> {
    const callSnapshot = snapshotDockerEngineCall(call);
    const authoritySnapshot = validateAuthorityShape(authority);
    this.#check("inspect", callSnapshot);
    const engine = this.#identity();
    this.#assertEngine(authoritySnapshot, engine);
    const record = this.#containers.get(authoritySnapshot.containerId);
    if (record === undefined || record.removed) {
      return { authority: authoritySnapshot, cgroupTree: "unobserved", engine, existence: "absent" };
    }
    if (!sameFakeAuthority(record.authority, authoritySnapshot) ||
        createSpecificationSha256(record.input, this.#policy) !== authoritySnapshot.createSpecificationSha256) {
      throw new DockerEngineError("authority-conflict");
    }
    return {
      authority: authoritySnapshot,
      cgroupTree: "unobserved",
      engine,
      existence: "present",
      resources: this.#resources(record),
      state: { ...record.state },
    };
  }

  public async start(authority: DockerContainerAuthority, call: DockerEngineCall): Promise<void> {
    const record = await this.#record("start", authority, call);
    if (this.#attachState.get(record.authority.containerId) !== "open") {throw new DockerEngineError("protocol-violation");}
    this.#attachCleanup.get(record.authority.containerId)?.();
    this.#attachCleanup.delete(record.authority.containerId);
    this.#attachState.set(record.authority.containerId, "started");
    const outcome = this.#mutationOutcome("start");
    if (outcome?.effect !== false) {this.#start(record);} else {this.#attachState.set(record.authority.containerId, "invalid");}
    this.#events.push("start:id");
    this.#assertMutationPostcondition("start", record, outcome);
  }

  public async attachCustody(authority: DockerContainerAuthority, call: DockerEngineCall): Promise<DockerCustodyDuplexChannel> {
    const callSnapshot = snapshotDockerEngineCall(call);
    const record = await this.#record("attach", authority, callSnapshot);
    if (record.state.status !== "created" || record.state.running || this.#attachState.has(record.authority.containerId)) {
      throw new DockerEngineError("protocol-violation");
    }
    const id = record.authority.containerId;
    this.#attachState.set(id, "open");
    this.#custodyInput.set(id, []);
    this.#events.push("attach:id");
    let closed = false;
    let valid = true;
    const cleanup = (): void => {clearTimeout(timer); callSnapshot.signal.removeEventListener("abort", invalidate);};
    const invalidate = (): void => {
      if (!valid) {return;}
      valid = false; cleanup();
      if (this.#attachState.get(id) !== "started") {this.#attachState.set(id, "invalid");}
    };
    const timer = setTimeout(invalidate, Math.max(0, callSnapshot.deadlineEpochMs - Date.now()));
    timer.unref();
    callSnapshot.signal.addEventListener("abort", invalidate, {once: true});
    this.#attachCleanup.set(id, cleanup);
    return Object.freeze({
      close: async () => {closed = true; invalidate();},
      closeInput: async () => {closed = true; invalidate();},
      output: (async function* () {try {yield* [];} finally {invalidate();}})(),
      write: async (bytes: Uint8Array) => {
        if (closed || bytes.byteLength === 0 || this.#attachState.get(id) === "invalid") {
          this.#attachState.set(id, "invalid"); throw new DockerEngineError("protocol-violation");
        }
        this.#custodyInput.get(id)?.push(bytes.slice());
      },
    });
  }

  public logs(authority: DockerContainerAuthority, call: DockerEngineCall): AsyncIterable<DockerLogFrame> {
    return this.#logs(validateAuthorityShape(authority), snapshotDockerEngineCall(call));
  }

  public async stop(authority: DockerContainerAuthority, call: DockerEngineCall): Promise<void> {
    const record = await this.#record("stop", authority, call);
    const outcome = this.#mutationOutcome("stop");
    if (outcome?.effect !== false) {this.#exit(record, 0);}
    this.#events.push("stop:id");
    this.#assertMutationPostcondition("stop", record, outcome);
  }

  public async kill(authority: DockerContainerAuthority, call: DockerEngineCall): Promise<void> {
    const record = await this.#record("kill", authority, call);
    const outcome = this.#mutationOutcome("kill");
    if (outcome?.effect !== false) {this.#exit(record, 137);}
    this.#events.push("kill:id");
    this.#assertMutationPostcondition("kill", record, outcome);
  }

  public async remove(authority: DockerContainerAuthority, call: DockerEngineCall): Promise<void> {
    const record = await this.#record("remove", authority, call);
    if (record.state.running) {throw new DockerEngineError("request-rejected", 409);}
    const outcome = this.#mutationOutcome("remove");
    if (outcome?.effect !== false) {record.removed = true; this.#signalStateTransition();}
    this.#events.push("remove:id");
    this.#assertMutationPostcondition("remove", record, outcome);
  }

  public async wait(
    authority: DockerContainerAuthority,
    call: DockerEngineCall,
  ): Promise<DockerContainerObservation> {
    const authoritySnapshot = validateAuthorityShape(authority);
    const callSnapshot = snapshotDockerEngineCall(call);
    for (;;) {
      this.#check("wait", callSnapshot);
      const revision = this.#stateRevision;
      const observation = await this.inspect(authoritySnapshot, callSnapshot);
      if (observation.existence !== "present") {throw new DockerEngineError("resource-not-found", 404);}
      if (isTerminalObservation(observation)) {return observation;}
      await this.#waitForStateTransition(revision, callSnapshot);
    }
  }

  async *#logs(authority: DockerContainerAuthority, call: DockerEngineCall): AsyncIterable<DockerLogFrame> {
    await this.#record("logs", authority, call);
    const plan = this.#logPlans.get(authority.containerId) ?? { delayed: false, frames: [] };
    if (plan.delayed) {await this.#waitForStream(call);}
    let bytes = 0;
    let frames = 0;
    for (const frame of plan.frames) {
      this.#checkContinuation(authority, call);
      if (frame.bytes.byteLength > DOCKER_LOG_MAX_FRAME_BYTES) {
        throw new DockerEngineError("stream-frame-too-large");
      }
      frames += 1;
      bytes += 8 + frame.bytes.byteLength;
      if (frames > DOCKER_LOG_MAX_FRAMES) {throw new DockerEngineError("stream-too-large");}
      if (bytes > DOCKER_LOG_MAX_STREAM_BYTES) {throw new DockerEngineError("stream-too-large");}
      yield { bytes: frame.bytes.slice(), stream: frame.stream };
    }
    const after = await this.inspect(authority, call);
    if (!isTerminalObservation(after)) {
      throw new DockerEngineError("terminal-observation-unknown");
    }
  }

  async #record(
    operation: FakeDockerOperation,
    authority: DockerContainerAuthority,
    call: DockerEngineCall,
  ): Promise<FakeContainer> {
    const authoritySnapshot = validateAuthorityShape(authority);
    const callSnapshot = snapshotDockerEngineCall(call);
    this.#check(operation, callSnapshot);
    const observation = await this.inspect(authoritySnapshot, callSnapshot);
    if (observation.existence !== "present") {throw new DockerEngineError("resource-not-found");}
    const record = this.#containers.get(authoritySnapshot.containerId);
    if (record === undefined) {throw new DockerEngineError("resource-not-found");}
    return record;
  }

  #check(operation: FakeDockerOperation, call: DockerEngineCall): void {
    this.#checkCall(call);
    if (this.#disconnected) {throw new DockerEngineError("daemon-disconnected");}
    if (this.#endpointCustodyLost) {throw new DockerEngineError("endpoint-custody-lost");}
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
      daemonBootGenerationSha256: hash(`fake-daemon-boot:${this.#daemonGeneration}`),
      daemonIdentitySha256: hash("fake-daemon-persistent-identity"),
      engineVersion: "fake-1",
      hostIdentitySha256: this.#policy.hostIdentitySha256,
      hostBootGenerationSha256: hash(`fake-host-boot:${this.#hostGeneration}`),
      storageDriver: "overlay2",
    };
  }

  #newAuthority(input: DockerContainerCreate, engine: DockerEngineIdentity): DockerContainerAuthority {
    this.#counter += 1;
    return validateAuthorityShape({
      containerId: hash(`${engine.daemonIdentitySha256}:${this.#counter}:${input.operationNonceSha256}`),
      createSpecificationSha256: createSpecificationSha256(input, this.#policy),
      daemonBootGenerationSha256: engine.daemonBootGenerationSha256,
      daemonIdentitySha256: engine.daemonIdentitySha256,
      hostBootGenerationSha256: engine.hostBootGenerationSha256,
      hostIdentitySha256: engine.hostIdentitySha256,
      imageDigest: input.imageDigest,
      launchFingerprintSha256: input.launchFingerprintSha256,
      operationNonceSha256: input.operationNonceSha256,
      ownerIdentitySha256: input.ownerIdentitySha256,
    });
  }

  #newAuthorityForReconciliation(
    input: DockerContainerCreate,
    engine: DockerEngineIdentity,
    containerId: string,
  ): DockerContainerAuthority {
    return validateAuthorityShape({
      containerId,
      createSpecificationSha256: createSpecificationSha256(input, this.#policy),
      daemonBootGenerationSha256: engine.daemonBootGenerationSha256,
      daemonIdentitySha256: engine.daemonIdentitySha256,
      hostBootGenerationSha256: engine.hostBootGenerationSha256,
      hostIdentitySha256: engine.hostIdentitySha256,
      imageDigest: input.imageDigest,
      launchFingerprintSha256: input.launchFingerprintSha256,
      operationNonceSha256: input.operationNonceSha256,
      ownerIdentitySha256: input.ownerIdentitySha256,
    });
  }

  #resources(record: FakeContainer): DockerContainerResourceFacts {
    return {
      appArmorProfile: this.#policy.appArmorProfile,
      autoRemove: false,
      capabilitiesDropped: "all",
      cgroupNamespaceMode: "private",
      cgroupParent: this.#policy.cgroupParent,
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
    if (!authorityBelongsToFakeEngine(authority, engine)) {
      throw new DockerEngineError("daemon-identity-changed");
    }
  }

  #assertSameEngine(left: DockerEngineIdentity, right: DockerEngineIdentity): void {
    if (!sameFakeEngine(left, right)) {
      throw new DockerEngineError("daemon-identity-changed");
    }
  }

  #mutationOutcome(operation: FakeMutationOperation): { acknowledgement: "304" | "lost"; effect: boolean } | undefined {
    return this.#mutationOutcomes.get(operation)?.shift();
  }

  #assertMutationPostcondition(
    operation: FakeMutationOperation,
    record: FakeContainer,
    outcome: { acknowledgement: "304" | "lost"; effect: boolean } | undefined,
  ): void {
    if (outcome === undefined) {return;}
    this.#events.push(`${operation}:${outcome.acknowledgement}`);
    const satisfied = mutationPostconditionSatisfied(operation, record.removed ? {
      authority: record.authority,
      cgroupTree: "unobserved",
      engine: this.#identity(),
      existence: "absent",
    } : {
      authority: record.authority,
      cgroupTree: "unobserved",
      engine: this.#identity(),
      existence: "present",
      resources: this.#resources(record),
      state: record.state,
    });
    if (!satisfied) {throw new DockerEngineError("mutation-acknowledgement-unknown");}
  }

  #start(record: FakeContainer): void {
    record.state = startedFakeContainerState(record.state, 10_000 + this.#counter);
    this.#signalStateTransition();
  }

  #exit(record: FakeContainer, exitCode: number): void {
    record.state = exitedFakeContainerState(record.state, exitCode);
    this.#signalStateTransition();
  }

  #signalStateTransition(): void {
    this.#stateRevision += 1;
    const release = this.#releaseStateTransition;
    this.#stateTransition = new Promise<void>(resolve => {this.#releaseStateTransition = resolve;});
    release?.();
  }

  async #waitForStateTransition(revision: number, call: DockerEngineCall): Promise<void> {
    if (revision !== this.#stateRevision) {return;}
    const gate = this.#stateTransition;
    const remaining = Math.min(call.deadlineEpochMs - Date.now(), 120_000);
    if (remaining <= 0) {throw new DockerEngineError("deadline-exceeded");}
    await new Promise<void>((resolve, reject) => {
      const abort = (): void => {cleanup(); reject(new DockerEngineError("aborted"));};
      const timer = setTimeout(() => {cleanup(); reject(new DockerEngineError("deadline-exceeded"));}, remaining);
      const cleanup = (): void => {clearTimeout(timer); call.signal.removeEventListener("abort", abort);};
      call.signal.addEventListener("abort", abort, { once: true });
      void gate.then(() => {cleanup(); resolve(); return null;});
    });
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
