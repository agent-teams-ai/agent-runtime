import {DockerCustodyHostObservationWriter, type DockerCustodyHostObservation, type DockerCustodyInitHostCompletion} from "./docker-custody-init-observation.js";
import type {DockerCustodyDuplexChannel} from "../engine/docker-engine-port.js";
import {
  DOCKER_CUSTODY_INIT_PROTOCOL,
  DOCKER_CUSTODY_PROVIDER_IO_MAX_BYTES,
  DockerCustodyFrameDecoder,
  DockerCustodyProtocolError,
  decodeDockerCustodyProviderBytes,
  encodeDockerCustodyFrame,
  parseDockerCustodyIdentity,
  parseDockerCustodyProtocolMessage,
  type DockerCustodyChildSignal,
  type DockerCustodyHostSignal,
  type DockerCustodyIdentity,
  type DockerCustodyInitMessage,
  type DockerCustodyProviderExecRequest,
} from "./docker-custody-init-protocol.js";

export interface DockerCustodyInitHostAuthority {
  readonly expectedIdentity: DockerCustodyIdentity;
  readonly generation: string;
  readonly launchFingerprintSha256: string;
  readonly operationNonce: string;
}

export interface DockerCustodyInitHostExec {
  readonly argv: readonly string[];
  readonly environment: readonly {readonly name: string; readonly value: string}[];
  readonly executableSha256: string;
  readonly gid: number;
  readonly requestId: string;
  readonly uid: number;
  readonly wallDeadlineUnixMs: number;
}

export interface DockerCustodyInitHostOptions {
  readonly acknowledgementTimeoutMs: number;
  readonly authority: DockerCustodyInitHostAuthority;
  readonly channel: DockerCustodyDuplexChannel;
  readonly isCurrentGeneration: (generation: string) => boolean;
  readonly isObservationActive?: () => boolean;
  readonly maximumStderrBytes: number;
  readonly maximumStdoutBytes: number;
  readonly monotonicNow?: () => number;
  readonly onDrainComplete?: (drain: DockerCustodyInitHostClosedEvidence["drain"]) => void | Promise<void>;
  readonly onOutput?: (chunk: DockerCustodyInitHostOutput) => void | Promise<void>;
  readonly onRootExit?: (exit: DockerCustodyInitHostRootExit) => void | Promise<void>;
  readonly readyTimeoutMs: number;
  readonly signal?: AbortSignal;
}

export interface DockerCustodyInitHostOutput {
  readonly bytes: Uint8Array;
  readonly stream: "stderr" | "stdout";
}

export interface DockerCustodyInitHostRootExit {
  readonly exitCode: number | null;
  readonly signal: DockerCustodyChildSignal | null;
}

export interface DockerCustodyInitHostClosedEvidence {
  readonly acknowledgement: "started";
  readonly drain: {readonly outerContainmentClaim: "unproven"; readonly rootExit: "observed"; readonly stderr: "eof"; readonly stdout: "eof"};
  readonly generation: string;
  readonly kind: "closed";
  readonly rootExit: DockerCustodyInitHostRootExit;
  readonly stderrBytes: number;
  readonly stdoutBytes: number;
}

export type DockerCustodyInitHostResult = DockerCustodyInitHostClosedEvidence | {
  readonly generation: string;
  readonly kind: "failed";
  readonly reason: "cancelled" | "channel-ended" | "init-not-ready" | "not-started" | "output-limit" | "protocol-violation" | "transport-failed";
} | {
  readonly generation: string;
  readonly kind: "unknown";
  readonly reason: "acknowledgement-conflict" | "acknowledgement-lost" | "exec-write-unknown";
};

export type DockerCustodyInitHostReady =
  | {readonly generation: string; readonly kind: "ready"}
  | Exclude<DockerCustodyInitHostResult, {kind: "closed"}>;
export type DockerCustodyInitHostStart =
  | {readonly generation: string; readonly kind: "started"}
  | Exclude<DockerCustodyInitHostResult, {kind: "closed"}>;

export type DockerCustodyInitHostWriteResult =
  | {readonly committedBytes: number; readonly kind: "committed"}
  | {readonly committedBytes: "unknown"; readonly kind: "unknown"}
  | {readonly committedBytes: 0; readonly kind: "closed"};

class HostSessionFailure extends Error {
  public constructor(public readonly result: Exclude<DockerCustodyInitHostResult, {kind: "closed"}>) {super(result.reason);}
}
class HostAdmissionClosed extends Error {}

const exactIdentity = (left: DockerCustodyIdentity, right: DockerCustodyIdentity): boolean =>
  left.protocol === right.protocol && left.containerImageSha256 === right.containerImageSha256 &&
  left.initBinarySha256 === right.initBinarySha256 && left.privateRootIdentity === right.privateRootIdentity &&
  left.securityProfileIdentity === right.securityProfileIdentity && left.workspaceIdentity === right.workspaceIdentity;

const boundedInteger = (value: number, label: string): number => {
  if (!Number.isSafeInteger(value) || value < 0) {throw new TypeError(`${label} must be a non-negative safe integer`);}
  return value;
};
const identityToken = (value: string, label: string): string => {
  if (typeof value !== "string" || !/^[A-Za-z0-9._:@+-]{1,256}$/u.test(value)) {throw new TypeError(`${label} must be a bounded identity token`);}
  return value;
};

/** Private, in-memory bridge. Durable lifecycle authority remains the Docker journal. */
export class DockerCustodyInitHostSession {
  readonly #authority: DockerCustodyInitHostAuthority;
  readonly #observation: DockerCustodyHostObservationWriter;
  readonly #channel: DockerCustodyDuplexChannel;
  readonly #decoder = new DockerCustodyFrameDecoder();
  #exec!: DockerCustodyProviderExecRequest;
  readonly #isCurrentGeneration: (generation: string) => boolean;
  readonly #isObservationActive: () => boolean;
  readonly #maximum: Record<"stderr" | "stdout", number>;
  readonly #monotonicNow: () => number;
  readonly #onDrainComplete: (drain: DockerCustodyInitHostClosedEvidence["drain"]) => void | Promise<void>;
  readonly #onOutput: (chunk: DockerCustodyInitHostOutput) => void | Promise<void>;
  readonly #onRootExit: (exit: DockerCustodyInitHostRootExit) => void | Promise<void>;
  #outputIterator: AsyncIterator<Uint8Array> | undefined;
  #pendingRead: Promise<IteratorResult<Uint8Array>> | undefined;
  readonly #signal: AbortSignal | undefined;
  readonly #timeouts: {readonly acknowledgement: number; readonly drain: number; readonly ready: number};
  readonly #queued: DockerCustodyInitMessage[] = [];
  readonly #bytes: Record<"stderr" | "stdout", number> = {stderr: 0, stdout: 0};
  readonly #decoderHeader = Buffer.alloc(4);
  readonly #wake: Promise<void>;
  #abort: (() => void) | undefined;
  #decoderBufferedBytes = 0;
  #decoderHeaderBytes = 0;
  #decoderPayloadRemaining = 0;
  #resolveWake!: () => void;
  #resolveCompletion!: (result: DockerCustodyInitHostCompletion) => void;
  #ready: Promise<DockerCustodyInitHostReady> | undefined;
  #resolveReady!: (result: DockerCustodyInitHostReady) => void;
  #resolveStart!: (result: DockerCustodyInitHostStart) => void;
  #resolveExecute!: () => void;
  #executeGate: Promise<void> | undefined;
  #readyAccepted = false;
  #executeCalled = false;
  #execWriteBegan = false;
  #started = false;
  #inputEof = false;
  #admissionClosed = false;
  #draining: Promise<void> | undefined;
  #rootExit: DockerCustodyInitHostRootExit | undefined;
  #settled: DockerCustodyInitHostCompletion | undefined;
  #cleanup: Promise<void> | undefined;
  #cleanupComplete = false;
  #writeTail: Promise<unknown> = Promise.resolve(null);
  public readonly completion: Promise<DockerCustodyInitHostCompletion>;
  public get observation(): DockerCustodyHostObservation {return this.#observation.snapshot(this.#rootExit,
    this.#isCurrentGeneration(this.#authority.generation) && this.#isObservationActive() && !this.#signal?.aborted);}

  public get cleanupComplete(): boolean {return this.#cleanupComplete;}

  public constructor(options: DockerCustodyInitHostOptions) {
    const maximum = {stderr: boundedInteger(options.maximumStderrBytes, "maximumStderrBytes"),
      stdout: boundedInteger(options.maximumStdoutBytes, "maximumStdoutBytes")};
    const acknowledgementTimeout = boundedInteger(options.acknowledgementTimeoutMs, "acknowledgementTimeoutMs");
    const timeouts = {acknowledgement: acknowledgementTimeout, drain: acknowledgementTimeout,
      ready: boundedInteger(options.readyTimeoutMs, "readyTimeoutMs")};
    const identity = parseDockerCustodyIdentity(options.authority.expectedIdentity);
    const authority = Object.freeze({expectedIdentity: identity,
      generation: identityToken(options.authority.generation, "generation"),
      launchFingerprintSha256: options.authority.launchFingerprintSha256,
      operationNonce: options.authority.operationNonce});
    this.#channel = options.channel;
    this.#isCurrentGeneration = options.isCurrentGeneration; this.#maximum = maximum; this.#timeouts = timeouts;
    this.#isObservationActive = options.isObservationActive ?? (() => true);
    this.#monotonicNow = options.monotonicNow ?? (() => performance.now());
    this.#onOutput = options.onOutput ?? (() => {}); this.#onRootExit = options.onRootExit ?? (() => {});
    this.#onDrainComplete = options.onDrainComplete ?? (() => {}); this.#signal = options.signal;
    this.#authority = authority; this.#observation = new DockerCustodyHostObservationWriter(authority);
    this.completion = new Promise(resolve => {this.#resolveCompletion = resolve;});
    this.#wake = new Promise(resolve => {this.#resolveWake = resolve;});
  }

  /** Starts only the authenticated init handshake; it grants no provider execution. */
  public ready(): Promise<DockerCustodyInitHostReady> {
    if (this.#ready !== undefined) {return this.#ready;}
    if (this.#settled !== undefined) {return Promise.resolve(this.#unclosedResult());}
    this.#ready = new Promise(resolve => {this.#resolveReady = resolve;});
    this.#executeGate = new Promise(resolve => {this.#resolveExecute = resolve;});
    if (this.#signal !== undefined) {
      this.#abort = () => {void this.#settle(this.#cancellationResult());};
      this.#signal.addEventListener("abort", this.#abort, {once: true});
      if (this.#signal.aborted) {this.#abort();}
    }
    void this.#run();
    return this.#ready;
  }

  public assertReadyForExecution(): void {
    this.#assertAdmission();
    if (!this.#readyAccepted) {throw new DockerCustodyProtocolError("init readiness is required before execute");}
  }

  /** The Host calls this only after owner preparation and durable exec intent acknowledgement. */
  public async execute(exec: DockerCustodyInitHostExec): Promise<DockerCustodyInitHostStart> {
    if (this.#executeCalled) {throw new TypeError("Docker custody provider execute is one-use");}
    this.#executeCalled = true;
    try {
      this.assertReadyForExecution();
      this.#exec = parseDockerCustodyProtocolMessage({...exec, observationBinding: this.#observation.binding, executableSlot: "provider-entrypoint",
        handshakeNonce: this.#authority.operationNonce, kind: "provider-exec",
        launchFingerprintSha256: this.#authority.launchFingerprintSha256}) as DockerCustodyProviderExecRequest;
      this.#observation.bind(this.#exec);
      // Allow the retained pre-exec read to reject already-delivered surplus first.
      await Promise.resolve();
      this.#assertAdmission();
      const start = new Promise<DockerCustodyInitHostStart>(resolve => {this.#resolveStart = resolve;});
      this.#resolveExecute();
      return start;
    } catch (error) {
      await this.#settle(this.#failure(error)); return this.#unclosedResult();
    }
  }

  public async writeInput(bytes: Uint8Array): Promise<DockerCustodyInitHostWriteResult> {
    if (this.#admissionClosed || this.#settled !== undefined || this.#inputEof || !this.#started) {return {committedBytes: 0, kind: "closed"};}
    if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > DOCKER_CUSTODY_PROVIDER_IO_MAX_BYTES) {
      await this.#settle(this.#failed("protocol-violation")); return {committedBytes: 0, kind: "closed"};
    }
    return this.#writeCommand({bytesBase64: Buffer.from(bytes).toString("base64"), kind: "provider-input",
      requestId: this.#exec.requestId}, bytes.byteLength);
  }

  public async closeProviderInput(): Promise<DockerCustodyInitHostWriteResult> {
    if (this.#admissionClosed || this.#settled !== undefined || this.#inputEof || !this.#started) {return {committedBytes: 0, kind: "closed"};}
    this.#inputEof = true;
    return this.#writeCommand({kind: "provider-input-eof", requestId: this.#exec.requestId}, 0);
  }

  public async signal(signal: DockerCustodyHostSignal): Promise<DockerCustodyInitHostWriteResult> {
    if (this.#admissionClosed || this.#settled !== undefined || !this.#started) {return {committedBytes: 0, kind: "closed"};}
    return this.#writeCommand({kind: "host-signal", requestId: this.#exec.requestId, signal}, 0);
  }

  async #writeCommand(message: Parameters<typeof encodeDockerCustodyFrame>[0], committedBytes: number): Promise<DockerCustodyInitHostWriteResult> {
    return this.#serializeWrite(async () => {
      if (this.#admissionClosed || this.#settled !== undefined || message.kind === "provider-input" && this.#inputEof) {return {committedBytes: 0, kind: "closed"};}
      if (await this.#rejectStaleWrite()) {return {committedBytes: 0, kind: "closed"};}
      try {
        this.#assertAdmission();
        await this.#channel.write(encodeDockerCustodyFrame(message), () => this.#assertAdmission());
        return {committedBytes, kind: "committed"};
      } catch (error) {
        if (error instanceof HostAdmissionClosed) {return {committedBytes: 0, kind: "closed"};}
        await this.#settle(this.#unknown("exec-write-unknown"));
        return {committedBytes: "unknown", kind: "unknown"};
      }
    });
  }

  public async cancel(): Promise<DockerCustodyInitHostResult> {
    const result = this.#execWriteBegan && !this.#started && this.#settled === undefined
      ? this.#unknown("acknowledgement-lost") : this.#failed("cancelled");
    await this.#settle(result); return this.#settled ?? result;
  }

  public async close(): Promise<DockerCustodyInitHostResult> {return this.cancel();}

  public cutOffAdmission(): void {this.#admissionClosed = true;}

  /** Join the sole reader using the existing session drain bound; never send a stop command. */
  public drain(): Promise<void> {
    this.#draining ??= (async () => {
      if (!this.#execWriteBegan || this.#settled !== undefined) {return;}
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {await Promise.race([this.completion, new Promise<void>(resolve => {timer = setTimeout(resolve, this.#timeouts.drain);})]);}
      finally {if (timer !== undefined) {clearTimeout(timer);}}
    })();
    return this.#draining;
  }

  async #run(): Promise<DockerCustodyInitHostResult> {
    try {
      this.#assertAdmission();
      this.#outputIterator = this.#channel.output[Symbol.asyncIterator]();
      await this.#boundedWrite(encodeDockerCustodyFrame({expectedIdentity: this.#authority.expectedIdentity,
        kind: "host-handshake", launchFingerprintSha256: this.#authority.launchFingerprintSha256,
        nonce: this.#authority.operationNonce, protocol: DOCKER_CUSTODY_INIT_PROTOCOL}), this.#timeouts.ready, "init-not-ready");
      this.#assertOpen();
      const ready = await this.#next(this.#timeouts.ready, "init-not-ready");
      this.#acceptReady(ready);
      if (this.#queued.length !== 0 || this.#decoderBufferedBytes !== 0) {
        throw new DockerCustodyProtocolError("frames followed init ready before provider exec");
      }
      // One read remains owned across readiness/preparation/execute. No second attach or reader.
      this.#pendingRead = this.#outputIterator.next().then(value => {
        if (!this.#execWriteBegan && this.#settled === undefined) {
          throw new DockerCustodyProtocolError("init sent bytes or EOF before provider exec");
        }
        return value;
      });
      void this.#pendingRead.catch(error => {void this.#settle(this.#failure(error));});
      this.#readyAccepted = true;
      this.#resolveReady(Object.freeze({generation: this.#authority.generation, kind: "ready"}));
      await Promise.race([this.#executeGate, this.#wake]);
      this.#assertAdmission();
      if (Date.now() >= this.#exec.wallDeadlineUnixMs) {throw new HostSessionFailure(this.#failed("cancelled"));}
      this.#execWriteBegan = true;
      try {await this.#boundedWrite(encodeDockerCustodyFrame(this.#exec), this.#timeouts.acknowledgement, "exec-write-unknown");}
      catch (error) {throw new HostSessionFailure(error instanceof HostSessionFailure ? error.result : this.#unknown("exec-write-unknown"));}
      this.#assertActive();
      const acknowledgement = await this.#next(this.#timeouts.acknowledgement, "acknowledgement-lost");
      this.#assertActive();
      this.#acceptAcknowledgement(acknowledgement);
      this.#resolveStart(Object.freeze({generation: this.#authority.generation, kind: "started"}));
      while (true) {
        const message = await this.#next(undefined, "channel-ended");
        const closed = await this.#acceptRuntimeMessage(message);
        if (closed !== undefined) {
          await this.#drainBufferedInput();
          this.#assertActive();
          await this.#awaitRuntimeCallback(() => this.#onDrainComplete(closed.drain));
          this.#assertActive();
          return this.#settle(closed);
        }
      }
    } catch (error) {
      return this.#settle(this.#failure(error));
    }
  }

  #acceptReady(message: DockerCustodyInitMessage): void {
    this.#assertActive();
    if (message.kind !== "init-ready" || message.protocol !== DOCKER_CUSTODY_INIT_PROTOCOL ||
      message.nonce !== this.#authority.operationNonce || message.launchFingerprintSha256 !== this.#authority.launchFingerprintSha256 ||
      !exactIdentity(message.observedIdentity, this.#authority.expectedIdentity)) {
      throw new DockerCustodyProtocolError("init ready does not match frozen authority");
    }
  }

  #acceptAcknowledgement(message: DockerCustodyInitMessage): void {
    this.#assertActive();
    if (message.kind === "provider-observation" && message.requestId === this.#exec.requestId &&
      message.observation === "exec-acknowledgement-lost") {
      throw new HostSessionFailure(this.#unknown("acknowledgement-lost"));
    }
    if (message.kind !== "provider-exec-ack" || message.requestId !== this.#exec.requestId) {
      throw new HostSessionFailure(this.#unknown("acknowledgement-conflict"));
    }
    if (message.observation === "started") {this.#started = true; return;}
    if (message.observation === "not-started") {throw new HostSessionFailure(this.#failed("not-started"));}
    throw new HostSessionFailure(this.#unknown("acknowledgement-conflict"));
  }

  async #acceptRuntimeMessage(message: DockerCustodyInitMessage): Promise<DockerCustodyInitHostClosedEvidence | undefined> {
    this.#assertActive();
    if ("requestId" in message && message.requestId !== this.#exec.requestId) {
      throw new DockerCustodyProtocolError("init frame belongs to another provider request");
    }
    // Authenticated init reports OS-driven stop/escalation here as well as Host signals.
    // A signal outcome proves neither root exit, output drain nor physical containment.
    if (message.kind === "provider-signal-observation") {return undefined;}
    if (message.kind === "provider-instance") {
      this.#observation.acceptInstance(message, this.#rootExit !== undefined); return undefined;
    }
    if (message.kind === "provider-output") {
      const bytes = decodeDockerCustodyProviderBytes(message.bytesBase64);
      this.#bytes[message.stream] += bytes.byteLength;
      const digest = this.#observation.acceptOutput(message.stream, bytes);
      if (this.#bytes[message.stream] > this.#maximum[message.stream]) {
        throw new HostSessionFailure(this.#failed("output-limit"));
      }
      this.#assertActive();
      try {await this.#awaitRuntimeCallback(() => this.#onOutput(Object.freeze({bytes, stream: message.stream})));}
      finally {this.#observation.verifyConsumer(bytes, digest);}
      this.#assertActive(); return undefined;
    }
    if (message.kind === "provider-observation" && message.observation === "root-exited") {
      if (this.#rootExit !== undefined) {throw new DockerCustodyProtocolError("duplicate root exit");}
      this.#rootExit = Object.freeze({exitCode: message.exitCode, signal: message.signal});
      this.#assertActive();
      await this.#awaitRuntimeCallback(() => this.#onRootExit(this.#rootExit as DockerCustodyInitHostRootExit));
      this.#assertActive(); return undefined;
    }
    if (message.kind === "provider-drain-complete") {
      if (this.#rootExit === undefined) {throw new DockerCustodyProtocolError("drain completion is out of order");}
      const drain = Object.freeze({outerContainmentClaim: message.outerContainmentClaim, rootExit: message.rootExit,
        stderr: message.stderr, stdout: message.stdout});
      return Object.freeze({acknowledgement: "started", drain, generation: this.#authority.generation,
        kind: "closed", rootExit: this.#rootExit, stderrBytes: this.#bytes.stderr, stdoutBytes: this.#bytes.stdout});
    }
    if (message.kind === "provider-exec-ack") {throw new HostSessionFailure(this.#unknown("acknowledgement-conflict"));}
    throw new DockerCustodyProtocolError("unexpected or contradictory init frame");
  }

  async #next(timeoutMs: number | undefined, timeoutReason: "acknowledgement-lost" | "channel-ended" | "init-not-ready"): Promise<DockerCustodyInitMessage> {
    this.#assertActive(); this.#assertOpen();
    if (this.#queued.length !== 0) {return this.#queued.shift() as DockerCustodyInitMessage;}
    if (this.#signal?.aborted === true) {
      throw new HostSessionFailure(this.#cancellationResult());
    }
    const deadline = timeoutMs === undefined ? undefined : this.#monotonicNow() + timeoutMs;
    const failure = () => new HostSessionFailure(timeoutReason === "acknowledgement-lost"
      ? this.#unknown(timeoutReason) : this.#failed(timeoutReason));
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      while (this.#queued.length === 0) {
        const read = this.#pendingRead ?? this.#outputIterator!.next();
        this.#pendingRead = undefined;
        const timeout = deadline === undefined ? undefined : new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {reject(failure());}, Math.max(0, deadline - this.#monotonicNow()));
        });
        const selected = await Promise.race([read, ...(timeout === undefined ? [] : [timeout]), this.#wake.then(() => {
          throw new HostSessionFailure(this.#settled?.kind === "failed" || this.#settled?.kind === "unknown"
            ? this.#settled : this.#cancellationResult());
        })]);
        if (timer !== undefined) {clearTimeout(timer); timer = undefined;}
        this.#assertActive();
        if (deadline !== undefined && this.#monotonicNow() >= deadline) {
          throw failure();
        }
        if (selected.done) {this.#channelEnded();}
        this.#observeDecoderBytes(selected.value);
        const messages = this.#decoder.push(selected.value);
        for (const item of messages) {
          if (item.kind === "host-handshake" || item.kind === "host-signal" || item.kind === "provider-exec" ||
            item.kind === "provider-input" || item.kind === "provider-input-eof") {
            throw new DockerCustodyProtocolError("init sent a host-only frame");
          }
          this.#queued.push(item);
        }
      }
      return this.#queued.shift() as DockerCustodyInitMessage;
    } finally {
      if (timer !== undefined) {clearTimeout(timer);}
    }
  }

  async #drainBufferedInput(): Promise<void> {
    const deadline = this.#monotonicNow() + this.#timeouts.drain;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      for (let count = 0; count < 4; count += 1) {
        if (this.#queued.length !== 0) {throw new DockerCustodyProtocolError("frames followed drain completion");}
        if (this.#decoderBufferedBytes !== 0) {throw new DockerCustodyProtocolError("partial frame followed drain completion");}
        const timeout = new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {reject(new HostSessionFailure(this.#failed("transport-failed")));},
            Math.max(0, deadline - this.#monotonicNow()));
        });
        const selected = await Promise.race([this.#outputIterator!.next(), timeout, this.#wake.then(() => {
          throw new HostSessionFailure(this.#settled?.kind === "failed" || this.#settled?.kind === "unknown"
            ? this.#settled : this.#cancellationResult());
        })]);
        clearTimeout(timer); timer = undefined;
        this.#assertActive();
        if (selected.done) {this.#decoder.finish(); this.#observation.channelEnded(); return;}
        this.#observeDecoderBytes(selected.value);
        const messages = this.#decoder.push(selected.value);
        if (messages.length !== 0) {throw new DockerCustodyProtocolError("frames followed drain completion");}
      }
      throw new DockerCustodyProtocolError("post-drain input exceeds the protocol bound");
    } finally {
      if (timer !== undefined) {clearTimeout(timer);}
    }
  }

  #assertGeneration(): void {
    if (!this.#isCurrentGeneration(this.#authority.generation)) {throw new DockerCustodyProtocolError("stale Docker custody generation");}
  }

  #assertActive(): void {
    if (this.#settled?.kind === "failed" || this.#settled?.kind === "unknown") {
      throw new HostSessionFailure(this.#settled);
    }
    if (this.#signal?.aborted === true || !this.#isObservationActive()) {throw new HostSessionFailure(this.#cancellationResult());}
    this.#assertGeneration();
  }

  #cancellationResult(): Exclude<DockerCustodyInitHostResult, {kind: "closed"}> {
    return this.#execWriteBegan && !this.#started ? this.#unknown("acknowledgement-lost") : this.#failed("cancelled");
  }

  async #awaitRuntimeCallback(callback: () => void | Promise<void>): Promise<void> {
    const pending = callback();
    await Promise.race([pending, this.#wake.then(() => {
      throw new HostSessionFailure(this.#settled?.kind === "failed" || this.#settled?.kind === "unknown"
        ? this.#settled : this.#cancellationResult());
    })]);
  }

  #observeDecoderBytes(bytes: Uint8Array): void {
    let offset = 0;
    while (offset < bytes.byteLength) {
      if (this.#decoderHeaderBytes < 4) {
        const count = Math.min(4 - this.#decoderHeaderBytes, bytes.byteLength - offset);
        this.#decoderHeader.set(bytes.subarray(offset, offset + count), this.#decoderHeaderBytes);
        this.#decoderHeaderBytes += count; this.#decoderBufferedBytes += count; offset += count;
        if (this.#decoderHeaderBytes < 4) {continue;}
        this.#decoderPayloadRemaining = this.#decoderHeader.readUInt32BE(0);
      }
      const count = Math.min(this.#decoderPayloadRemaining, bytes.byteLength - offset);
      this.#decoderPayloadRemaining -= count; this.#decoderBufferedBytes += count; offset += count;
      if (this.#decoderPayloadRemaining === 0) {
        this.#decoderHeaderBytes = 0; this.#decoderBufferedBytes = 0;
      }
    }
  }

  #channelEnded(): never {
    this.#decoder.finish(); this.#observation.channelEnded();
    throw new HostSessionFailure(this.#execWriteBegan && !this.#started
      ? this.#unknown("acknowledgement-lost") : this.#failed("channel-ended"));
  }

  #assertOpen(): void {
    if (this.#settled !== undefined) {throw new DockerCustodyProtocolError("Docker custody session is terminal");}
  }

  #assertAdmission(): void {
    if (this.#admissionClosed) {throw new HostAdmissionClosed();}
    this.#assertActive(); this.#assertOpen();
  }

  async #rejectStaleWrite(): Promise<boolean> {
    try {this.#assertActive(); return false;} catch {await this.#settle(this.#failed("protocol-violation")); return true;}
  }

  async #serializeWrite<Result>(write: () => Promise<Result>): Promise<Result> {
    const current = this.#writeTail.then(write, write); this.#writeTail = current.then(() => null, () => null); return current;
  }

  async #settle(result: DockerCustodyInitHostResult): Promise<DockerCustodyInitHostResult> {
    if (this.#settled !== undefined) {await this.#cleanup; return this.#settled;}
    if (result.kind === "closed") {this.#assertActive();}
    this.#settled = this.#observation.finish(result, this.#rootExit);
    this.#resolveCompletion(this.#settled);
    if (this.#settled.kind !== "closed") {this.#resolveReady?.(this.#settled); this.#resolveStart?.(this.#settled);}
    this.#resolveWake();
    if (this.#abort !== undefined) {
      this.#signal?.removeEventListener("abort", this.#abort); this.#abort = undefined;
    }
    // Protocol completion is distinct from acknowledged resource cleanup. Repeated cancellation
    // joins this same work, even when completion was published by an earlier callback or failure.
    const cleanup = Promise.withResolvers<void>();
    this.#cleanup = cleanup.promise;
    void Promise.allSettled([
      (async () => this.#channel.close())(),
      (async () => this.#outputIterator?.return?.())(),
    ]).then(results => {
      this.#cleanupComplete = results.every(observation => observation.status === "fulfilled");
      return cleanup.resolve();
    });
    await this.#cleanup;
    return this.#settled;
  }

  #unclosedResult(): Exclude<DockerCustodyInitHostResult, {kind: "closed"}> {
    return this.#settled?.kind === "failed" || this.#settled?.kind === "unknown"
      ? this.#settled : this.#failed("protocol-violation");
  }

  #failure(error: unknown): Exclude<DockerCustodyInitHostResult, {kind: "closed"}> {
    return error instanceof HostAdmissionClosed ? this.#cancellationResult() : error instanceof HostSessionFailure ? error.result : this.#execWriteBegan && !this.#started
      ? this.#unknown(error instanceof DockerCustodyProtocolError ? "acknowledgement-conflict" : "acknowledgement-lost")
      : error instanceof DockerCustodyProtocolError ? this.#failed("protocol-violation") : this.#failed("transport-failed");
  }

  async #boundedWrite(bytes: Uint8Array, timeoutMs: number, reason: "init-not-ready" | "exec-write-unknown"): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = this.#monotonicNow() + timeoutMs;
    const failure = () => new HostSessionFailure(reason === "init-not-ready" ? this.#failed(reason) : this.#unknown(reason));
    try {
      this.#assertAdmission();
      await Promise.race([this.#channel.write(bytes, () => this.#assertAdmission()), this.#wake, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {reject(failure());}, timeoutMs);
      })]);
      this.#assertActive(); this.#assertOpen();
      if (this.#monotonicNow() >= deadline) {throw failure();}
    } finally {if (timer !== undefined) {clearTimeout(timer);}}
  }

  #failed(reason: Extract<DockerCustodyInitHostResult, {kind: "failed"}>["reason"]): Extract<DockerCustodyInitHostResult, {kind: "failed"}> {
    return Object.freeze({generation: this.#authority.generation, kind: "failed", reason});
  }
  #unknown(reason: Extract<DockerCustodyInitHostResult, {kind: "unknown"}>["reason"]): Extract<DockerCustodyInitHostResult, {kind: "unknown"}> {
    return Object.freeze({generation: this.#authority.generation, kind: "unknown", reason});
  }
}
