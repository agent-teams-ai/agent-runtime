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
  readonly exec: DockerCustodyInitHostExec;
  readonly isCurrentGeneration: (generation: string) => boolean;
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

export type DockerCustodyInitHostWriteResult =
  | {readonly committedBytes: number; readonly kind: "committed"}
  | {readonly committedBytes: "unknown"; readonly kind: "unknown"}
  | {readonly committedBytes: 0; readonly kind: "closed"};

class HostSessionFailure extends Error {
  public constructor(public readonly result: Exclude<DockerCustodyInitHostResult, {kind: "closed"}>) {super(result.reason);}
}

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
  readonly #channel: DockerCustodyDuplexChannel;
  readonly #decoder = new DockerCustodyFrameDecoder();
  readonly #exec: DockerCustodyProviderExecRequest;
  readonly #isCurrentGeneration: (generation: string) => boolean;
  readonly #maximum: Record<"stderr" | "stdout", number>;
  readonly #monotonicNow: () => number;
  readonly #onDrainComplete: (drain: DockerCustodyInitHostClosedEvidence["drain"]) => void | Promise<void>;
  readonly #onOutput: (chunk: DockerCustodyInitHostOutput) => void | Promise<void>;
  readonly #onRootExit: (exit: DockerCustodyInitHostRootExit) => void | Promise<void>;
  readonly #outputIterator: AsyncIterator<Uint8Array>;
  readonly #signal: AbortSignal | undefined;
  readonly #timeouts: {readonly acknowledgement: number; readonly ready: number};
  readonly #queued: DockerCustodyInitMessage[] = [];
  readonly #bytes: Record<"stderr" | "stdout", number> = {stderr: 0, stdout: 0};
  readonly #decoderHeader = Buffer.alloc(4);
  readonly #wake: Promise<void>;
  #abort: (() => void) | undefined;
  #decoderBufferedBytes = 0;
  #decoderHeaderBytes = 0;
  #decoderPayloadRemaining = 0;
  #resolveWake!: () => void;
  #resolveCompletion!: (result: DockerCustodyInitHostResult) => void;
  #execWriteBegan = false;
  #started = false;
  #inputEof = false;
  #rootExit: DockerCustodyInitHostRootExit | undefined;
  #settled: DockerCustodyInitHostResult | undefined;
  #writeTail: Promise<unknown> = Promise.resolve(null);
  public readonly completion: Promise<DockerCustodyInitHostResult>;

  public constructor(options: DockerCustodyInitHostOptions) {
    const maximum = {stderr: boundedInteger(options.maximumStderrBytes, "maximumStderrBytes"),
      stdout: boundedInteger(options.maximumStdoutBytes, "maximumStdoutBytes")};
    const timeouts = {acknowledgement: boundedInteger(options.acknowledgementTimeoutMs, "acknowledgementTimeoutMs"),
      ready: boundedInteger(options.readyTimeoutMs, "readyTimeoutMs")};
    const identity = parseDockerCustodyIdentity(options.authority.expectedIdentity);
    const authority = Object.freeze({expectedIdentity: identity,
      generation: identityToken(options.authority.generation, "generation"),
      launchFingerprintSha256: options.authority.launchFingerprintSha256,
      operationNonce: options.authority.operationNonce});
    const exec = parseDockerCustodyProtocolMessage(Object.freeze({...options.exec, executableSlot: "provider-entrypoint",
      handshakeNonce: authority.operationNonce, kind: "provider-exec", launchFingerprintSha256: authority.launchFingerprintSha256})) as DockerCustodyProviderExecRequest;
    this.#channel = options.channel; this.#outputIterator = options.channel.output[Symbol.asyncIterator]();
    this.#isCurrentGeneration = options.isCurrentGeneration; this.#maximum = maximum; this.#timeouts = timeouts;
    this.#monotonicNow = options.monotonicNow ?? (() => performance.now());
    this.#onOutput = options.onOutput ?? (() => {}); this.#onRootExit = options.onRootExit ?? (() => {});
    this.#onDrainComplete = options.onDrainComplete ?? (() => {}); this.#signal = options.signal;
    this.#authority = authority; this.#exec = exec;
    this.completion = new Promise(resolve => {this.#resolveCompletion = resolve;});
    this.#wake = new Promise(resolve => {this.#resolveWake = resolve;});
    if (this.#signal !== undefined) {
      this.#abort = () => {void this.#settle(this.#cancellationResult());};
      this.#signal.addEventListener("abort", this.#abort, {once: true});
      if (this.#signal.aborted) {this.#abort();}
    }
    void this.#run();
  }

  public async writeInput(bytes: Uint8Array): Promise<DockerCustodyInitHostWriteResult> {
    if (this.#settled !== undefined || this.#inputEof || !this.#started) {return {committedBytes: 0, kind: "closed"};}
    if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > DOCKER_CUSTODY_PROVIDER_IO_MAX_BYTES) {
      await this.#settle(this.#failed("protocol-violation")); return {committedBytes: 0, kind: "closed"};
    }
    return this.#serializeWrite(async () => {
      if (this.#settled !== undefined || this.#inputEof || !this.#started) {return {committedBytes: 0, kind: "closed"};}
      if (await this.#rejectStaleWrite()) {return {committedBytes: 0, kind: "closed"};}
      try {
        await this.#channel.write(encodeDockerCustodyFrame({bytesBase64: Buffer.from(bytes).toString("base64"), kind: "provider-input", requestId: this.#exec.requestId}));
        return {committedBytes: bytes.byteLength, kind: "committed"};
      } catch {
        await this.#settle(this.#unknown("exec-write-unknown"));
        return {committedBytes: "unknown", kind: "unknown"};
      }
    });
  }

  public async closeProviderInput(): Promise<DockerCustodyInitHostWriteResult> {
    if (this.#settled !== undefined || this.#inputEof || !this.#started) {return {committedBytes: 0, kind: "closed"};}
    this.#inputEof = true;
    return this.#serializeWrite(async () => {
      if (this.#settled !== undefined) {return {committedBytes: 0, kind: "closed"};}
      if (await this.#rejectStaleWrite()) {return {committedBytes: 0, kind: "closed"};}
      try {
        await this.#channel.write(encodeDockerCustodyFrame({kind: "provider-input-eof", requestId: this.#exec.requestId}));
        return {committedBytes: 0, kind: "committed"};
      } catch {
        await this.#settle(this.#unknown("exec-write-unknown"));
        return {committedBytes: "unknown", kind: "unknown"};
      }
    });
  }

  public async signal(signal: DockerCustodyHostSignal): Promise<DockerCustodyInitHostWriteResult> {
    if (this.#settled !== undefined || !this.#started) {return {committedBytes: 0, kind: "closed"};}
    return this.#serializeWrite(async () => {
      if (this.#settled !== undefined) {return {committedBytes: 0, kind: "closed"};}
      if (await this.#rejectStaleWrite()) {return {committedBytes: 0, kind: "closed"};}
      try {
        await this.#channel.write(encodeDockerCustodyFrame({kind: "host-signal", requestId: this.#exec.requestId, signal}));
        return {committedBytes: 0, kind: "committed"};
      } catch {
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

  async #run(): Promise<DockerCustodyInitHostResult> {
    try {
      this.#assertGeneration();
      await this.#channel.write(encodeDockerCustodyFrame({expectedIdentity: this.#authority.expectedIdentity,
        kind: "host-handshake", launchFingerprintSha256: this.#authority.launchFingerprintSha256,
        nonce: this.#authority.operationNonce, protocol: DOCKER_CUSTODY_INIT_PROTOCOL}));
      this.#assertOpen();
      const ready = await this.#next(this.#timeouts.ready, "init-not-ready");
      this.#acceptReady(ready);
      if (this.#queued.length !== 0) {throw new DockerCustodyProtocolError("frames followed init ready before provider exec");}
      this.#assertGeneration(); this.#execWriteBegan = true;
      try {await this.#channel.write(encodeDockerCustodyFrame(this.#exec));}
      catch {throw new HostSessionFailure(this.#unknown("exec-write-unknown"));}
      if (this.#signal?.aborted === true) {throw new HostSessionFailure(this.#unknown("acknowledgement-lost"));}
      const acknowledgement = await this.#next(this.#timeouts.acknowledgement, "acknowledgement-lost");
      this.#acceptAcknowledgement(acknowledgement);
      while (true) {
        const message = await this.#next(undefined, "channel-ended");
        const closed = await this.#acceptRuntimeMessage(message);
        if (closed !== undefined) {
          await this.#drainBufferedInput();
          this.#assertGeneration();
          return this.#settle(closed);
        }
      }
    } catch (error) {
      const result = error instanceof HostSessionFailure ? error.result : this.#execWriteBegan && !this.#started
        ? this.#unknown(error instanceof DockerCustodyProtocolError ? "acknowledgement-conflict" : "acknowledgement-lost")
        : error instanceof DockerCustodyProtocolError ? this.#failed("protocol-violation") : this.#failed("transport-failed");
      return this.#settle(result);
    }
  }

  #acceptReady(message: DockerCustodyInitMessage): void {
    this.#assertGeneration();
    if (message.kind !== "init-ready" || message.protocol !== DOCKER_CUSTODY_INIT_PROTOCOL ||
      message.nonce !== this.#authority.operationNonce || message.launchFingerprintSha256 !== this.#authority.launchFingerprintSha256 ||
      !exactIdentity(message.observedIdentity, this.#authority.expectedIdentity)) {
      throw new DockerCustodyProtocolError("init ready does not match frozen authority");
    }
  }

  #acceptAcknowledgement(message: DockerCustodyInitMessage): void {
    this.#assertGeneration();
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
    this.#assertGeneration();
    if ("requestId" in message && message.requestId !== this.#exec.requestId) {
      throw new DockerCustodyProtocolError("init frame belongs to another provider request");
    }
    if (message.kind === "provider-output") {
      const bytes = decodeDockerCustodyProviderBytes(message.bytesBase64);
      if (this.#bytes[message.stream] + bytes.byteLength > this.#maximum[message.stream]) {
        throw new HostSessionFailure(this.#failed("output-limit"));
      }
      this.#bytes[message.stream] += bytes.byteLength;
      this.#assertGeneration();
      await this.#awaitRuntimeCallback(() => this.#onOutput(Object.freeze({bytes, stream: message.stream})));
      this.#assertGeneration(); return undefined;
    }
    if (message.kind === "provider-observation" && message.observation === "root-exited") {
      if (this.#rootExit !== undefined) {throw new DockerCustodyProtocolError("duplicate root exit");}
      this.#rootExit = Object.freeze({exitCode: message.exitCode, signal: message.signal});
      this.#assertGeneration();
      await this.#awaitRuntimeCallback(() => this.#onRootExit(this.#rootExit as DockerCustodyInitHostRootExit));
      this.#assertGeneration(); return undefined;
    }
    if (message.kind === "provider-drain-complete") {
      if (this.#rootExit === undefined) {throw new DockerCustodyProtocolError("drain completion is out of order");}
      const drain = Object.freeze({outerContainmentClaim: message.outerContainmentClaim, rootExit: message.rootExit,
        stderr: message.stderr, stdout: message.stdout});
      this.#assertGeneration();
      await this.#awaitRuntimeCallback(() => this.#onDrainComplete(drain));
      this.#assertGeneration();
      if (this.#queued.length !== 0) {throw new DockerCustodyProtocolError("frames followed drain completion");}
      return Object.freeze({acknowledgement: "started", drain, generation: this.#authority.generation,
        kind: "closed", rootExit: this.#rootExit, stderrBytes: this.#bytes.stderr, stdoutBytes: this.#bytes.stdout});
    }
    if (message.kind === "provider-exec-ack") {throw new HostSessionFailure(this.#unknown("acknowledgement-conflict"));}
    throw new DockerCustodyProtocolError("unexpected or contradictory init frame");
  }

  async #next(timeoutMs: number | undefined, timeoutReason: "acknowledgement-lost" | "channel-ended" | "init-not-ready"): Promise<DockerCustodyInitMessage> {
    this.#assertOpen();
    if (this.#queued.length !== 0) {return this.#queued.shift() as DockerCustodyInitMessage;}
    if (this.#signal?.aborted === true) {
      throw new HostSessionFailure(this.#cancellationResult());
    }
    const deadline = timeoutMs === undefined ? undefined : this.#monotonicNow() + timeoutMs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      while (this.#queued.length === 0) {
        const read = this.#outputIterator.next();
        const timeout = deadline === undefined ? undefined : new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {reject(new HostSessionFailure(timeoutReason === "acknowledgement-lost"
            ? this.#unknown(timeoutReason) : this.#failed(timeoutReason)));}, Math.max(0, deadline - this.#monotonicNow()));
        });
        const selected = await Promise.race([read, ...(timeout === undefined ? [] : [timeout]), this.#wake.then(() => {
          throw new HostSessionFailure(this.#settled?.kind === "failed" || this.#settled?.kind === "unknown"
            ? this.#settled : this.#cancellationResult());
        })]);
        if (timer !== undefined) {clearTimeout(timer); timer = undefined;}
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
    for (let count = 0; count < 4; count += 1) {
      if (this.#queued.length !== 0) {throw new DockerCustodyProtocolError("frames followed drain completion");}
      if (this.#decoderBufferedBytes !== 0) {throw new DockerCustodyProtocolError("partial frame followed drain completion");}
      const selected = await Promise.race([this.#outputIterator.next(), new Promise<void>(resolve => {setImmediate(resolve);})]);
      if (selected === undefined) {return;}
      if (selected.done) {this.#decoder.finish(); return;}
      this.#observeDecoderBytes(selected.value);
      const messages = this.#decoder.push(selected.value);
      if (messages.length !== 0) {throw new DockerCustodyProtocolError("frames followed drain completion");}
    }
    throw new DockerCustodyProtocolError("post-drain input exceeds the protocol bound");
  }

  #assertGeneration(): void {
    if (!this.#isCurrentGeneration(this.#authority.generation)) {throw new DockerCustodyProtocolError("stale Docker custody generation");}
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
    this.#decoder.finish();
    throw new HostSessionFailure(this.#execWriteBegan && !this.#started
      ? this.#unknown("acknowledgement-lost") : this.#failed("channel-ended"));
  }

  #assertOpen(): void {
    if (this.#settled !== undefined) {throw new DockerCustodyProtocolError("Docker custody session is terminal");}
  }

  async #rejectStaleWrite(): Promise<boolean> {
    try {this.#assertGeneration(); return false;} catch {await this.#settle(this.#failed("protocol-violation")); return true;}
  }

  async #serializeWrite<Result>(write: () => Promise<Result>): Promise<Result> {
    const current = this.#writeTail.then(write, write); this.#writeTail = current.then(() => null, () => null); return current;
  }

  async #settle(result: DockerCustodyInitHostResult): Promise<DockerCustodyInitHostResult> {
    if (this.#settled !== undefined) {return this.#settled;}
    if (result.kind === "closed") {this.#assertGeneration();}
    this.#settled = Object.freeze(result);
    this.#resolveCompletion(this.#settled);
    this.#resolveWake();
    if (this.#abort !== undefined) {
      this.#signal?.removeEventListener("abort", this.#abort); this.#abort = undefined;
    }
    try {await this.#channel.close();} catch {}
    try {await this.#outputIterator.return?.();} catch {}
    return this.#settled;
  }

  #failed(reason: Extract<DockerCustodyInitHostResult, {kind: "failed"}>["reason"]): Extract<DockerCustodyInitHostResult, {kind: "failed"}> {
    return Object.freeze({generation: this.#authority.generation, kind: "failed", reason});
  }
  #unknown(reason: Extract<DockerCustodyInitHostResult, {kind: "unknown"}>["reason"]): Extract<DockerCustodyInitHostResult, {kind: "unknown"}> {
    return Object.freeze({generation: this.#authority.generation, kind: "unknown", reason});
  }
}
