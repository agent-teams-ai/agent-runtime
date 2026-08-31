import {createHash} from "node:crypto";

import {
  DOCKER_CUSTODY_CHILD_SIGNALS,
  DOCKER_CUSTODY_HOST_SIGNALS,
  DOCKER_CUSTODY_INIT_PROTOCOL,
  DockerCustodyFrameDecoder,
  decodeDockerCustodyProviderBytes,
  type DockerCustodyChildSignal,
  type DockerCustodyContainmentRequest,
  type DockerCustodyHostMessage,
  type DockerCustodyHostSignal,
  type DockerCustodyIdentity,
  type DockerCustodyInitClosureSubresult,
  type DockerCustodyInitMessage,
  type DockerCustodyProviderExecRequest,
  type DockerCustodyProviderObservation,
  type DockerCustodySignalObservation,
  parseDockerCustodyIdentity,
  parseDockerCustodyProtocolMessage,
} from "./docker-custody-init-protocol.js";
import type {
  DockerCustodyInitRuntimeOptions, DockerCustodyInitSnapshot, DockerCustodyInitSyscalls, DockerCustodyOutputStream,
  DockerCustodyOutputWriteResult, DockerCustodyProviderOutputHandle, DockerCustodyProviderRootExit,
  DockerCustodyProviderRootHandle, DockerCustodyStreamEvidence,
} from "./docker-custody-init-runtime-types.js";
import {DockerCustodyControlWriter} from "./docker-custody-init-control-writer.js";
import {DockerCustodyProviderInputWriter} from "./docker-custody-init-input.js";
import {boundedInteger, identityEqual, monotonicNow, opaqueHandle, safeEqual, safeMonotonicDeadline} from "./docker-custody-init-guards.js";
export type * from "./docker-custody-init-runtime-types.js";
interface MutableStreamEvidence {
  bytes: number; eof: boolean; eofPending: boolean; hash: ReturnType<typeof createHash>; pendingBytes: Uint8Array | null;
  pendingCursor: number; status: DockerCustodyStreamEvidence["status"];
}
interface ProviderGeneration {
  readonly rootHandle: DockerCustodyProviderRootHandle; readonly stderr: DockerCustodyProviderOutputHandle; readonly stdout: DockerCustodyProviderOutputHandle;
}
const EMPTY_SHA256 = createHash("sha256").digest("hex");
const newStreamEvidence = (): MutableStreamEvidence => ({
  bytes: 0, eof: false, eofPending: false, hash: createHash("sha256"), pendingBytes: null, pendingCursor: 0, status: "open",
});
const streamTerminal = (stream: MutableStreamEvidence): boolean =>
  stream.eof || stream.status === "failed" || stream.status === "overflow";

export class DockerCustodyInitRuntime {
  readonly #allowedEnvironmentNames: ReadonlySet<string>;
  #acknowledgement: DockerCustodyInitSnapshot["acknowledgement"] = "not-applicable";
  #closure: DockerCustodyInitClosureSubresult | null = null; #closurePending = false;
  #containmentEvidence: DockerCustodyContainmentRequest | undefined; #containmentRequested = false;
  readonly #controlWriter: DockerCustodyControlWriter<ProviderGeneration>;
  readonly #decoder = new DockerCustodyFrameDecoder();
  readonly #executablePath: string;
  readonly #executableSha256: string;
  #generation: ProviderGeneration | undefined;
  #handshake?: {readonly fingerprint: string; readonly nonce: string}; #handshakePending = false;
  #integrityFailed = false;
  #failureKillDeadlineMonotonicMs: number | undefined; #failureCleanupComplete = false; #failureTerminalDeadlineMonotonicMs: number | undefined;
  #killEscalationCompleted = false;
  readonly #limits: Readonly<Record<DockerCustodyOutputStream, number>>;
  readonly #maximumProviderRuntimeMs: number;
  readonly #observedIdentity: DockerCustodyIdentity;
  #pendingContainmentReason: DockerCustodyContainmentRequest["reason"] | undefined;
  #phase: DockerCustodyInitSnapshot["phase"] = "awaiting-handshake";
  #providerDeadlineMonotonicMs: number | undefined;
  #providerRootTracked = false;
  #request?: DockerCustodyProviderExecRequest;
  #rootExitObserved = false; #rootObservationPending = false; #rootObservationWritten = false;
  readonly #shutdownGraceMs: number;
  readonly #signalEvidence: DockerCustodySignalObservation[] = [];
  #startFenced = false;
  #stderr = newStreamEvidence();
  readonly #stdin: DockerCustodyProviderInputWriter;
  #stopDeadlineMonotonicMs: number | undefined; #stopReason: DockerCustodyContainmentRequest["reason"] | undefined;
  #stdout = newStreamEvidence();
  readonly #syscalls: DockerCustodyInitSyscalls;
  readonly #writeControl: (message: DockerCustodyInitMessage) => "accepted" | "blocked";
  public readonly maximumStdinBytes: number;

  public constructor(options: DockerCustodyInitRuntimeOptions) {
    this.#allowedEnvironmentNames = new Set(options.allowedEnvironmentNames);
    if (this.#allowedEnvironmentNames.size !== options.allowedEnvironmentNames.length) {throw new Error("environment allowlist contains duplicates");}
    if (!options.executablePath.startsWith("/") || options.executablePath.includes("\0")) {throw new Error("provider entrypoint must be an absolute NUL-free container path");}
    if (!/^[a-f0-9]{64}$/u.test(options.executableSha256)) {throw new Error("provider entrypoint digest is invalid");}
    for (const name of options.allowedEnvironmentNames) {
      if (!/^[A-Z_][A-Z0-9_]{0,127}$/u.test(name)) {throw new Error("environment allowlist key is invalid");}
    }
    this.#executablePath = options.executablePath; this.#executableSha256 = options.executableSha256;
    this.#limits = Object.freeze({stderr: boundedInteger(options.maximumStderrBytes, "maximumStderrBytes"), stdout: boundedInteger(options.maximumStdoutBytes, "maximumStdoutBytes")});
    this.maximumStdinBytes = boundedInteger(options.maximumStdinBytes, "maximumStdinBytes");
    this.#stdin = new DockerCustodyProviderInputWriter(this.maximumStdinBytes, bytes => this.#syscalls.writeProviderInput(bytes));
    this.#maximumProviderRuntimeMs = boundedInteger(options.maximumProviderRuntimeMs, "maximumProviderRuntimeMs");
    this.#observedIdentity = parseDockerCustodyIdentity(options.observedIdentity);
    this.#shutdownGraceMs = boundedInteger(options.shutdownGraceMs, "shutdownGraceMs");
    this.#syscalls = options.syscalls; this.#writeControl = options.writeControl;
    this.#controlWriter = new DockerCustodyControlWriter(this.#writeControl, () => {this.#poison();});
    this.#syscalls.assertDirectChildOfContainerInit(); this.#syscalls.assertNoNewPrivileges();
    if (!identityEqual(this.#syscalls.observeIdentity(), this.#observedIdentity)) {throw new Error("custody-init configured identity does not match runtime identity");}
  }

  public receive(message: DockerCustodyHostMessage): void {
    try {
      if (this.#integrityFailed || this.#phase === "failed" || this.#phase === "drained") {throw new Error("init control generation is sealed");}
      const detached = parseDockerCustodyProtocolMessage(message);
      if (detached.kind === "host-handshake") {this.#receiveHandshake(detached); return;}
      if (detached.kind === "provider-exec") {this.#receiveExec(detached); return;}
      if (detached.kind === "provider-input") {this.#receiveProviderInput(detached.requestId, detached.bytesBase64); return;}
      if (detached.kind === "provider-input-eof") {this.#receiveProviderInputEof(detached.requestId); return;}
      if (detached.kind === "host-signal") {this.#assertCurrentRequest(detached.requestId); this.forwardHostSignal(detached.signal); return;}
      throw new Error("init received a message reserved for Host observation");
    } catch (error) {this.#poison(); throw error;}
  }

  public receiveControlBytes(bytes: Uint8Array): void {
    try {
      if (this.#integrityFailed) {throw new Error("init control generation is poisoned");}
      for (const message of this.#decoder.push(bytes)) {
        if (this.#stdin.status === "blocked") {throw new Error("control frame arrived while provider input was backpressured");}
        switch (message.kind) {
          case "host-handshake": case "host-signal": case "provider-exec": case "provider-input": case "provider-input-eof":
            this.receive(message); break;
          default: throw new Error("Host control channel carried an init-only message");
        }
      }
    } catch (error) {this.#poison(); throw error;}
  }

  public controlChannelClosed(): void {
    try {this.#decoder.finish();} catch (error) {this.#poison(); throw error;}
    if (this.#phase !== "drained") {this.#poison();}
  }
  public malformedControlFrame(): void {this.#poison();}

  #receiveHandshake(message: Extract<DockerCustodyHostMessage, {readonly kind: "host-handshake"}>): void {
    if (this.#startFenced || this.#phase !== "awaiting-handshake" || this.#handshake !== undefined || this.#handshakePending) {
      throw new Error("duplicate, fenced, or out-of-order Host handshake");
    }
    if (!identityEqual(message.expectedIdentity, this.#observedIdentity)) {throw new Error("Host expected custody identity does not match init attestation");}
    const handshake = Object.freeze({fingerprint: message.launchFingerprintSha256, nonce: message.nonce});
    this.#handshakePending = true;
    this.#enqueueControl(Object.freeze({kind: "init-ready", launchFingerprintSha256: message.launchFingerprintSha256,
      nonce: message.nonce, observedIdentity: this.#observedIdentity, protocol: DOCKER_CUSTODY_INIT_PROTOCOL}), null, () => {
      this.#handshake = handshake; this.#handshakePending = false; this.#phase = "awaiting-request";
    });
  }

  #receiveExec(message: DockerCustodyProviderExecRequest): void {
    if (this.#startFenced || this.#phase !== "awaiting-request" || this.#request !== undefined) {throw new Error("provider exec is duplicate, fenced, or out of order and will not be launched");}
    this.#request = message; this.#acknowledgement = "pending";
    const wallNow = this.#syscalls.wallNowUnixMs();
    if (this.#execRequestInvalid(message, wallNow)) {this.#rejectExec(); return;}
    const environment: Record<string, string> = {};
    for (const entry of message.environment) {if (!this.#allowedEnvironmentNames.has(entry.name)) {this.#rejectExec(); return;} environment[entry.name] = entry.value;}
    const remainingWallBudgetMs = message.wallDeadlineUnixMs - wallNow;
    const acceptedAtMonotonicMs = monotonicNow(this.#syscalls.monotonicNowMs());
    this.#providerDeadlineMonotonicMs = safeMonotonicDeadline(acceptedAtMonotonicMs, Math.min(remainingWallBudgetMs, this.#maximumProviderRuntimeMs));
    try {
      const child = this.#syscalls.spawnProvider(Object.freeze({argv: Object.freeze([...message.argv]), clearSupplementaryGroups: true,
        environment: Object.freeze(environment), executablePath: this.#executablePath, executableSha256: this.#executableSha256, gid: message.gid,
        inheritedDescriptors: Object.freeze([0, 1, 2]) as readonly [0, 1, 2], noNewPrivileges: true, shell: false, uid: message.uid}));
      if (child.kind === "not-started") {this.#rejectExec(); return;}
      const rootHandle = child.handle as object; const stderrHandle = child.stderr as object; const stdoutHandle = child.stdout as object;
      if (!Number.isSafeInteger(child.pid) || child.pid <= 1 || !opaqueHandle(child.handle) || !opaqueHandle(child.stderr) ||
        !opaqueHandle(child.stdout) || rootHandle === stderrHandle || rootHandle === stdoutHandle || stderrHandle === stdoutHandle) {
        throw new Error("spawn returned invalid or aliased provider generation capabilities");
      }
      this.#generation = Object.freeze({rootHandle: child.handle, stderr: child.stderr, stdout: child.stdout});
      this.#providerRootTracked = true; this.#phase = "provider-running"; this.#acknowledge("started", this.#generation);
    } catch {
      this.#acknowledge("acceptance-unknown", null);
      this.#writeProviderObservation("acceptance-unknown", null, null, null);
      this.#poison();
    }
  }
  #execRequestInvalid(message: DockerCustodyProviderExecRequest, wallNow: number): boolean {
    return this.#handshake === undefined ||
      !safeEqual(message.handshakeNonce, this.#handshake.nonce) ||
      !safeEqual(message.launchFingerprintSha256, this.#handshake.fingerprint) ||
      !safeEqual(message.executableSha256, this.#executableSha256) ||
      !Number.isSafeInteger(wallNow) || wallNow < 0 || message.wallDeadlineUnixMs <= wallNow;
  }
  #rejectExec(): void {
    this.#phase = "failed"; this.#failureCleanupComplete = true; this.#startFenced = true; this.#acknowledge("not-started", null);
    this.#writeProviderObservation("spawn-failed", null, null, null);
  }
  #assertCurrentRequest(requestId: string): void {
    if (this.#request === undefined || !safeEqual(requestId, this.#request.requestId)) {
      throw new Error("provider stream frame does not match the active request");
    }
  }
  #receiveProviderInput(requestId: string, bytesBase64: string): void {
    this.#assertCurrentRequest(requestId);
    if (this.#stdin.status === "blocked") {throw new Error("provider input frame arrived while provider input was backpressured");}
    const status = this.writeProviderInput(decodeDockerCustodyProviderBytes(bytesBase64));
    if (status === "closed") {
      throw new Error("provider input is closed");
    }
  }
  #receiveProviderInputEof(requestId: string): void {
    this.#assertCurrentRequest(requestId);
    if (this.#phase !== "provider-running" || this.#stdin.status === "blocked" || this.#stdin.status === "closed") {
      throw new Error("provider input EOF is out of order");
    }
    this.#syscalls.closeProviderInput(); this.#stdin.close();
  }
  #acknowledge(observation: "acceptance-unknown" | "not-started" | "started", generation: ProviderGeneration | null): void {
    if (this.#request === undefined || this.#acknowledgement !== "pending") {return;}
    this.#enqueueControl(Object.freeze({kind: "provider-exec-ack", observation, requestId: this.#request.requestId}), generation, () => {
      this.#acknowledgement = "delivered";
    });
  }
  public reportLostAcknowledgement(): void {
    if (this.#integrityFailed || this.#acknowledgement !== "lost" || this.#request === undefined) {return;}
    this.#writeProviderObservation("exec-acknowledgement-lost", null, null, this.#generation ?? null);
  }

  public writeProviderInput(bytes: Uint8Array): "accepted" | "blocked" | "closed" {
    if (this.#integrityFailed || this.#phase !== "provider-running") {return "closed";}
    try {const result = this.#stdin.offer(bytes); if (this.#stdin.status === "overflow") {this.#poison("input-limit");} return result;}
    catch {this.#poison(); return "closed";}
  }
  public stdinDrainReady(): void {
    if (!this.#integrityFailed && this.#phase === "provider-running") {try {this.#stdin.drain();} catch {this.#poison();}}
  }
  public providerInputClosed(): void {if (!this.#integrityFailed && this.#stdin.status !== "closed") {this.#poison();}}
  public acceptProviderOutput(handle: DockerCustodyProviderOutputHandle, bytes: Uint8Array): "accepted" | "blocked" | "closed" | "overflow" {
    if (this.#integrityFailed) {
      const cleanup = this.#resolveStreamForCleanup(handle);
      if (cleanup === undefined) {return "closed";}
      const [stream, accounting] = cleanup;
      if (accounting.eof || accounting.status === "failed" || accounting.status === "overflow") {return "closed";}
      if (accounting.bytes + bytes.byteLength > this.#limits[stream]) {accounting.status = "overflow"; this.#maybeFinishFailure(); return "overflow";}
      accounting.hash.update(bytes); accounting.bytes += bytes.byteLength; return "accepted";
    }
    const resolved = this.#resolveStream(handle);
    if (resolved === undefined) {return "closed";}
    const [stream, accounting] = resolved;
    if (accounting.eof) {this.#poison(); return "closed";}
    if (accounting.status === "overflow") {return "overflow";}
    if (accounting.status === "blocked") {return "blocked";}
    if (accounting.bytes + bytes.byteLength > this.#limits[stream]) {
      accounting.status = "overflow"; accounting.pendingBytes = null; accounting.pendingCursor = 0; accounting.eofPending = false;
      this.#writeDrainFailed(stream, "overflow"); this.#poison("output-limit"); return "overflow";
    }
    accounting.pendingBytes = Uint8Array.from(bytes); accounting.pendingCursor = 0;
    return this.#flushOutput(stream, accounting);
  }
  public outputDrainReady(handle: DockerCustodyProviderOutputHandle): "accepted" | "blocked" | "idle" {
    const resolved = this.#resolveStream(handle);
    if (resolved === undefined) {return "idle";}
    const [stream, accounting] = resolved;
    if (accounting.status !== "blocked" || accounting.pendingBytes === null) {return "idle";}
    return this.#flushOutput(stream, accounting);
  }
  #flushOutput(stream: DockerCustodyOutputStream, accounting: MutableStreamEvidence): "accepted" | "blocked" {
    const pending = accounting.pendingBytes;
    if (pending === null) {return "accepted";}
    const offered = pending.subarray(accounting.pendingCursor).slice();
    let result: DockerCustodyOutputWriteResult;
    try {
      result = this.#syscalls.writeProviderOutput(stream, offered);
      if ((result.status !== "accepted" && result.status !== "blocked") || !Number.isSafeInteger(result.committedBytes) ||
        result.committedBytes < 0 || result.committedBytes > offered.byteLength ||
        result.status === "accepted" && result.committedBytes !== offered.byteLength ||
        result.status === "blocked" && result.committedBytes === offered.byteLength) {
        throw new Error("provider output write returned an invalid cursor");
      }
    } catch {this.#poison(); return "blocked";}
    if (result.committedBytes > 0) {
      const start = accounting.pendingCursor; const end = start + result.committedBytes;
      accounting.hash.update(pending.subarray(start, end)); accounting.bytes += result.committedBytes; accounting.pendingCursor = end;
    }
    if (result.status === "blocked") {accounting.status = "blocked"; return "blocked";}
    accounting.pendingBytes = null; accounting.pendingCursor = 0; accounting.status = "open";
    if (accounting.eofPending) {accounting.eofPending = false; accounting.eof = true; this.#maybeWriteDrainComplete();}
    return "accepted";
  }
  public closeProviderOutput(handle: DockerCustodyProviderOutputHandle): "closed" | "deferred" | "failed" {
    if (this.#integrityFailed) {
      const cleanup = this.#resolveStreamForCleanup(handle);
      if (cleanup === undefined) {return "failed";}
      const [, accounting] = cleanup; accounting.pendingBytes = null; accounting.pendingCursor = 0; accounting.eofPending = false; accounting.eof = true;
      this.#maybeFinishFailure(); return "closed";
    }
    const resolved = this.#resolveStream(handle);
    if (resolved === undefined) {return "failed";}
    const [, accounting] = resolved;
    if (accounting.eof) {this.#poison(); return "failed";}
    if (accounting.status === "overflow" || this.#closurePending || this.#closure?.providerDrain.kind === "provider-drain-failed") {return "failed";}
    if (accounting.pendingBytes !== null) {accounting.eofPending = true; return "deferred";}
    accounting.eof = true; this.#maybeWriteDrainComplete(); return "closed";
  }
  public failProviderOutput(handle: DockerCustodyProviderOutputHandle): void {
    const resolved = this.#resolveStreamForCleanup(handle);
    if (resolved === undefined) {this.#poison(); return;}
    const [stream, accounting] = resolved; accounting.status = "failed"; accounting.pendingBytes = null;
    accounting.pendingCursor = 0; accounting.eofPending = false;
    this.#writeDrainFailed(stream, "error"); this.#poison(); this.#maybeFinishFailure();
  }
  #resolveStream(handle: DockerCustodyProviderOutputHandle): readonly [DockerCustodyOutputStream, MutableStreamEvidence] | undefined {
    if (this.#integrityFailed || this.#phase === "failed" || this.#phase === "drained") {return undefined;}
    const generation = this.#generation;
    const eventPhase = this.#phase === "provider-running" || this.#phase === "stopping" || this.#phase === "provider-exited";
    if (generation === undefined || !eventPhase) {this.#poison(); return undefined;}
    if (handle === generation.stdout) {return ["stdout", this.#stdout];}
    if (handle === generation.stderr) {return ["stderr", this.#stderr];}
    this.#poison(); return undefined;
  }
  #resolveStreamForCleanup(handle: DockerCustodyProviderOutputHandle): readonly [DockerCustodyOutputStream, MutableStreamEvidence] | undefined {
    const generation = this.#generation;
    if (generation === undefined) {return undefined;}
    if (handle === generation.stdout) {return ["stdout", this.#stdout];}
    if (handle === generation.stderr) {return ["stderr", this.#stderr];}
    return undefined;
  }

  public forwardHostSignal(signal: DockerCustodyHostSignal): void {
    if (!DOCKER_CUSTODY_HOST_SIGNALS.includes(signal)) {this.#poison(); throw new Error("host signal is not allowlisted");}
    if (this.#integrityFailed || this.#phase === "failed" || this.#phase === "drained") {return;}
    if (signal === "SIGTERM") {this.requestStop("cancelled"); return;}
    this.#performSignal("forward-host", signal);
  }
  public requestStop(reason: DockerCustodyContainmentRequest["reason"] = "cancelled"): void {
    if (this.#integrityFailed || this.#phase === "failed" || this.#phase === "drained") {return;}
    if (this.#request === undefined) {this.#poison(); return;}
    if (reason !== "cancelled") {this.#poison(reason); return;}
    if (this.#stopReason !== undefined) {return;}
    this.#stopReason = reason;
    if (!this.#providerRootTracked) {this.#requestContainment(reason); return;}
    this.#phase = "stopping";
    try {this.#stopDeadlineMonotonicMs = safeMonotonicDeadline(monotonicNow(this.#syscalls.monotonicNowMs()), this.#shutdownGraceMs);}
    catch {this.#poison(); return;}
    this.#performSignal("stop-term", "SIGTERM");
  }
  #performSignal(action: DockerCustodySignalObservation["action"], signal: DockerCustodyHostSignal | "SIGKILL"): void {
    if (this.#request === undefined) {return;}
    let result: DockerCustodySignalObservation["result"] = "absent";
    const generation = this.#generation;
    if (generation !== undefined && this.#providerRootTracked) {
      try {
        const observation = this.#syscalls.signalProviderRoot(generation.rootHandle, signal);
        if (observation !== "absent" && observation !== "sent") {this.#poison(); return;}
        result = observation;
      } catch {result = "failed";}
    }
    const evidence = Object.freeze({action, kind: "provider-signal-observation", requestId: this.#request.requestId, result, signal} as const);
    this.#signalEvidence.push(evidence);
    if (!this.#integrityFailed) {this.#enqueueControl(evidence, generation ?? null);}
  }

  public tick(): void {
    this.#retryContainment(); this.#flushControl();
    if (this.#phase === "failed" && this.#failureCleanupComplete) {return;}
    try {
      this.#observeRootExit();
      if (this.#integrityFailed) {this.#enforceFailureDeadlines(); this.#maybeFinishFailure();}
      else {this.#enforceDeadlines();}
    } catch {this.#poison();}
  }
  #observeRootExit(): void {
    const generation = this.#generation;
    if (generation === undefined || !this.#providerRootTracked || this.#rootExitObserved) {return;}
    const rootExit = this.#syscalls.observeProviderRootExit(generation.rootHandle);
    if (rootExit === null) {return;}
    if (!this.#validExit(rootExit)) {this.#poison(); return;}
    this.#providerRootTracked = false; this.#rootExitObserved = true; this.#rootObservationPending = true;
    this.#stopDeadlineMonotonicMs = undefined; this.#killEscalationCompleted = true;
    this.#phase = this.#integrityFailed ? "failed" : "provider-exited"; this.#stdin.close();
    if (this.#integrityFailed) {
      this.#rootObservationPending = false; this.#failureTerminalDeadlineMonotonicMs ??= safeMonotonicDeadline(
        monotonicNow(this.#syscalls.monotonicNowMs()), this.#shutdownGraceMs);
      this.#maybeFinishFailure(); return;
    }
    this.#writeProviderObservation("root-exited", rootExit.exitCode, rootExit.signal, generation, () => {
      this.#rootObservationPending = false; this.#rootObservationWritten = true; this.#maybeWriteDrainComplete();
    });
  }
  #enforceDeadlines(): void {
    const drainOpen = !this.#stdout.eof || !this.#stderr.eof;
    const deadlineActive = this.#request !== undefined &&
      (this.#phase === "provider-running" || this.#phase === "stopping" || this.#phase === "provider-exited" && drainOpen);
    if (!deadlineActive && this.#stopDeadlineMonotonicMs === undefined) {return;}
    const nowMonotonicMs = monotonicNow(this.#syscalls.monotonicNowMs());
    const wallNow = this.#syscalls.wallNowUnixMs();
    if (!Number.isSafeInteger(wallNow) || wallNow < 0) {this.#poison(); return;}
    if (this.#request !== undefined && deadlineActive && (wallNow >= this.#request.wallDeadlineUnixMs ||
      this.#providerDeadlineMonotonicMs !== undefined && nowMonotonicMs >= this.#providerDeadlineMonotonicMs)) {this.#poison("deadline"); return;}
    if (this.#providerRootTracked && this.#stopDeadlineMonotonicMs !== undefined && nowMonotonicMs >= this.#stopDeadlineMonotonicMs && !this.#killEscalationCompleted) {
      this.#poison("shutdown-timeout", false);
    }
  }
  #validExit(exit: DockerCustodyProviderRootExit): boolean {
    if ((exit.exitCode === null) === (exit.signal === null)) {return false;}
    if (exit.exitCode !== null) {return Number.isSafeInteger(exit.exitCode) && exit.exitCode >= 0 && exit.exitCode <= 255;}
    return exit.signal !== null && DOCKER_CUSTODY_CHILD_SIGNALS.includes(exit.signal);
  }
  #maybeWriteDrainComplete(): void {
    if (this.#integrityFailed || this.#phase === "failed" || this.#closure !== null || this.#closurePending || !this.#rootExitObserved ||
      this.#rootObservationPending || !this.#rootObservationWritten || !this.#stdout.eof || !this.#stderr.eof ||
      this.#stdout.pendingBytes !== null || this.#stderr.pendingBytes !== null || this.#request === undefined || this.#generation === undefined) {return;}
    const providerDrain = Object.freeze({kind: "provider-drain-complete", outerContainmentClaim: "unproven", requestId: this.#request.requestId,
      rootExit: "observed", stderr: "eof", stdout: "eof"} as const);
    this.#closurePending = true;
    this.#enqueueControl(providerDrain, this.#generation, () => {
      if (this.#integrityFailed) {return;}
      this.#closurePending = false; this.#closure = Object.freeze({outerContainmentClaim: "unproven", providerDrain});
      this.#phase = "drained"; this.#stopDeadlineMonotonicMs = undefined; this.#killEscalationCompleted = true;
    });
  }
  #writeDrainFailed(stream: DockerCustodyOutputStream, failure: "error" | "overflow" | "timeout"): void {
    if (this.#closure !== null || this.#closurePending || this.#request === undefined || this.#generation === undefined || this.#integrityFailed) {return;}
    const providerDrain = Object.freeze({kind: "provider-drain-failed", outerContainmentClaim: "unproven",
      reason: `${stream}-${failure}`, requestId: this.#request.requestId} as const);
    this.#closurePending = true;
    this.#enqueueControl(providerDrain, this.#generation, () => {if (!this.#integrityFailed) {
      this.#closurePending = false; this.#closure = Object.freeze({outerContainmentClaim: "unproven", providerDrain});}});
  }
  public failInit(): void {this.#poison();}
  #poison(reason: DockerCustodyContainmentRequest["reason"] = "init-failure", termFirst = true): void {
    if (this.#integrityFailed) {this.#retryContainment(); return;}
    const inheritedTermDeadline = this.#stopDeadlineMonotonicMs;
    this.#integrityFailed = true; this.#phase = "failed"; this.#startFenced = true; this.#stdin.close();
    try {this.#syscalls.closeProviderInput();} catch {/* containment still proceeds */}
    this.#stopDeadlineMonotonicMs = undefined; this.#providerDeadlineMonotonicMs = undefined; this.#closurePending = false;
    this.#rootObservationPending = false; this.#controlWriter.clear();
    if (this.#acknowledgement === "pending") {this.#acknowledgement = "lost";}
    if (this.#request !== undefined) {this.#pendingContainmentReason = reason; this.#retryContainment();
      if (this.#providerRootTracked) {
        const now = monotonicNow(this.#syscalls.monotonicNowMs());
        if (termFirst && inheritedTermDeadline !== undefined) {this.#failureKillDeadlineMonotonicMs = inheritedTermDeadline;}
        else if (termFirst) {this.#failureKillDeadlineMonotonicMs = safeMonotonicDeadline(now, this.#shutdownGraceMs);
          this.#performSignal("stop-term", "SIGTERM");}
        else {this.#killEscalationCompleted = true; this.#performSignal("stop-kill", "SIGKILL");
          this.#failureTerminalDeadlineMonotonicMs = safeMonotonicDeadline(now, this.#shutdownGraceMs);}
        return;
      }
      if (this.#generation !== undefined) {this.#failureTerminalDeadlineMonotonicMs = safeMonotonicDeadline(
        monotonicNow(this.#syscalls.monotonicNowMs()), this.#shutdownGraceMs); this.#maybeFinishFailure(); return;}
    }
    this.#failureCleanupComplete = true;
  }
  #enforceFailureDeadlines(): void {
    const now = monotonicNow(this.#syscalls.monotonicNowMs());
    if (this.#providerRootTracked && this.#failureKillDeadlineMonotonicMs !== undefined && now >= this.#failureKillDeadlineMonotonicMs &&
      !this.#killEscalationCompleted) {
      this.#killEscalationCompleted = true; this.#performSignal("stop-kill", "SIGKILL");
      this.#failureTerminalDeadlineMonotonicMs = safeMonotonicDeadline(now, this.#shutdownGraceMs);
    }
    if (this.#failureTerminalDeadlineMonotonicMs !== undefined && now >= this.#failureTerminalDeadlineMonotonicMs) {
      for (const [stream, accounting] of [["stdout", this.#stdout], ["stderr", this.#stderr]] as const) {if (!accounting.eof &&
        accounting.status !== "failed" && accounting.status !== "overflow") {accounting.status = "failed"; this.#writeDrainFailed(stream, "timeout");}}
      this.#failureCleanupComplete = true;
    }
  }
  #maybeFinishFailure(): void {
    if (!this.#integrityFailed || !this.#rootExitObserved) {return;}
    if (streamTerminal(this.#stdout) && streamTerminal(this.#stderr)) {this.#failureCleanupComplete = true;}
  }
  #enqueueControl(message: DockerCustodyInitMessage, generation: ProviderGeneration | null, onAccepted?: () => void): void {
    if (this.#integrityFailed) {return;}
    this.#controlWriter.enqueue(message, generation, this.#generation, onAccepted);
  }
  #flushControl(): void {if (!this.#integrityFailed) {this.#controlWriter.flush(this.#generation);}}
  #requestContainment(reason: DockerCustodyContainmentRequest["reason"]): void {
    if (this.#containmentRequested || this.#request === undefined) {return;}
    this.#pendingContainmentReason ??= reason; this.#retryContainment();
  }
  #retryContainment(): void {
    if (this.#containmentRequested || this.#request === undefined || this.#pendingContainmentReason === undefined) {return;}
    if (this.#containmentEvidence !== undefined) {
      if (this.#integrityFailed && !this.#controlWriter.busy) {this.#retryContainmentEvidence();} return;
    }
    const reason = this.#pendingContainmentReason;
    this.#containmentEvidence = Object.freeze({kind: "container-containment-request", reason, requestId: this.#request.requestId});
    if (this.#integrityFailed) {if (!this.#controlWriter.busy) {this.#retryContainmentEvidence();} return;}
    const evidence = this.#containmentEvidence;
    this.#enqueueControl(evidence, this.#generation ?? null, () => {if (this.#containmentEvidence === evidence) {
      this.#containmentEvidence = undefined; this.#containmentRequested = true; this.#pendingContainmentReason = undefined;}});
  }
  #retryContainmentEvidence(): void {
    const evidence = this.#containmentEvidence;
    if (evidence === undefined || !this.#integrityFailed) {return;}
    try {
      const result = this.#writeControl(evidence);
      if (result === "accepted") {this.#containmentEvidence = undefined; this.#containmentRequested = true;
        this.#pendingContainmentReason = undefined; return;}
      if (result === "blocked") {return;}
    } catch {this.#containmentEvidence = undefined; if (!this.#integrityFailed) {this.#poison();} return;}
    this.#containmentEvidence = undefined; if (!this.#integrityFailed) {this.#poison();}
  }
  #writeProviderObservation(
    observation: DockerCustodyProviderObservation["observation"], exitCode: number | null, signal: DockerCustodyChildSignal | null,
    generation: ProviderGeneration | null,
    onAccepted?: () => void,
  ): void {
    if (this.#request === undefined || this.#integrityFailed) {return;}
    this.#enqueueControl(Object.freeze({exitCode, kind: "provider-observation", observation, requestId: this.#request.requestId,
      signal, treeEmptyClaim: "not-claimed"}), generation, onAccepted);
  }
  public snapshot(): DockerCustodyInitSnapshot {
    const stream = (value: MutableStreamEvidence): DockerCustodyStreamEvidence => Object.freeze({bytes: value.bytes, eof: value.eof,
      sha256: value.bytes === 0 ? EMPTY_SHA256 : value.hash.copy().digest("hex"), status: value.status});
    return Object.freeze({acknowledgement: this.#acknowledgement, closure: this.#closure, containmentRequested: this.#containmentRequested,
      failureCleanupComplete: this.#failureCleanupComplete,
      phase: this.#phase, providerRootTracked: this.#providerRootTracked,
      requestId: this.#request?.requestId ?? null, signalEvidence: Object.freeze([...this.#signalEvidence]), startFenced: this.#startFenced,
      stderr: stream(this.#stderr), stdinBytes: this.#stdin.bytes, stdinStatus: this.#stdin.status, stdout: stream(this.#stdout)});
  }
}
