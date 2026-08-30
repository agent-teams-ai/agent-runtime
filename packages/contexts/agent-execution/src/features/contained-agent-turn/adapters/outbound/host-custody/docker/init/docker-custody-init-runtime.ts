import { createHash, timingSafeEqual } from "node:crypto";

import {
  DOCKER_CUSTODY_CHILD_SIGNALS,
  DOCKER_CUSTODY_HOST_SIGNALS,
  DOCKER_CUSTODY_INIT_PROTOCOL,
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

export type DockerCustodyOutputStream = "stderr" | "stdout";
export interface DockerCustodyProviderRootHandle {readonly pid: number; readonly stableIdentity: string;}
export interface DockerCustodyProviderSpawn {
  readonly argv: readonly string[];
  readonly clearSupplementaryGroups: true;
  readonly environment: Readonly<Record<string, string>>;
  readonly executablePath: string;
  readonly gid: number;
  readonly inheritedDescriptors: readonly [0, 1, 2];
  readonly noNewPrivileges: true;
  readonly shell: false;
  readonly uid: number;
}
export interface DockerCustodyReapedChild {readonly exitCode: number | null; readonly pid: number; readonly signal: DockerCustodyChildSignal | null;}
export interface DockerCustodyInitSyscalls {
  readonly assertNoNewPrivileges: () => void;
  readonly assertPidOne: () => void;
  readonly monotonicNowMs: () => number;
  readonly observeIdentity: () => DockerCustodyIdentity;
  readonly reapExitedChildren: () => readonly DockerCustodyReapedChild[];
  readonly requestContainerContainment: (reason: DockerCustodyContainmentRequest["reason"]) => void;
  readonly signalProviderRoot: (handle: DockerCustodyProviderRootHandle, signal: DockerCustodyHostSignal | "SIGKILL") => "absent" | "sent";
  readonly spawnProvider: (spawn: DockerCustodyProviderSpawn) =>
    | {readonly kind: "not-started"}
    | {readonly handle: DockerCustodyProviderRootHandle; readonly kind: "started"};
  readonly wallNowUnixMs: () => number;
  readonly writeProviderInput: (bytes: Uint8Array) => "accepted" | "blocked" | "closed";
  readonly writeProviderOutput: (stream: DockerCustodyOutputStream, bytes: Uint8Array) => "accepted" | "blocked";
}
export interface DockerCustodyInitRuntimeOptions {
  readonly allowedEnvironmentNames: readonly string[];
  readonly executablePath: string;
  readonly executableSha256: string;
  readonly maximumStderrBytes: number;
  readonly maximumStdinBytes: number;
  readonly maximumStdoutBytes: number;
  readonly observedIdentity: DockerCustodyIdentity;
  readonly shutdownGraceMs: number;
  readonly syscalls: DockerCustodyInitSyscalls;
  readonly writeControl: (message: DockerCustodyInitMessage) => void;
}
export interface DockerCustodyStreamEvidence {
  readonly bytes: number;
  readonly eof: boolean;
  readonly sha256: string;
  readonly status: "blocked" | "open" | "overflow";
}
export interface DockerCustodyInitSnapshot {
  readonly acknowledgement: "delivered" | "lost" | "not-applicable" | "pending";
  readonly closure: DockerCustodyInitClosureSubresult | null;
  readonly containmentRequested: boolean;
  readonly descendantsReaped: number;
  readonly phase: "awaiting-handshake" | "awaiting-request" | "drained" | "failed" | "provider-exited" | "provider-running" | "stopping";
  readonly providerRootTracked: boolean;
  readonly requestId: string | null;
  readonly signalEvidence: readonly DockerCustodySignalObservation[];
  readonly startFenced: boolean;
  readonly stderr: DockerCustodyStreamEvidence;
  readonly stdinBytes: number;
  readonly stdinStatus: "blocked" | "closed" | "open" | "overflow";
  readonly stdout: DockerCustodyStreamEvidence;
}
interface MutableStreamEvidence {bytes: number; eof: boolean; hash: ReturnType<typeof createHash>; status: DockerCustodyStreamEvidence["status"];}

const EMPTY_SHA256 = createHash("sha256").digest("hex");
const safeEqual = (left: string, right: string): boolean => {
  const leftBytes = Buffer.from(left, "utf8"); const rightBytes = Buffer.from(right, "utf8");
  return leftBytes.byteLength === rightBytes.byteLength && timingSafeEqual(leftBytes, rightBytes);
};
const identityEqual = (left: DockerCustodyIdentity, right: DockerCustodyIdentity): boolean =>
  left.protocol === right.protocol && safeEqual(left.containerImageSha256, right.containerImageSha256) &&
  safeEqual(left.initBinarySha256, right.initBinarySha256) && safeEqual(left.privateRootIdentity, right.privateRootIdentity) &&
  safeEqual(left.securityProfileIdentity, right.securityProfileIdentity) && safeEqual(left.workspaceIdentity, right.workspaceIdentity);
const boundedInteger = (value: number, label: string): number => {
  if (!Number.isSafeInteger(value) || value <= 0) {throw new Error(`${label} must be a positive safe integer`);} return value;
};

export class DockerCustodyInitRuntime {
  readonly #allowedEnvironmentNames: ReadonlySet<string>;
  #acknowledgement: DockerCustodyInitSnapshot["acknowledgement"] = "not-applicable";
  #closure: DockerCustodyInitClosureSubresult | null = null;
  #containmentRequested = false;
  #descendantsReaped = 0;
  readonly #executablePath: string;
  readonly #executableSha256: string;
  #handshake?: {readonly fingerprint: string; readonly nonce: string};
  #killEscalationCompleted = false;
  #lostAcknowledgementReported = false;
  readonly #limits: Readonly<Record<DockerCustodyOutputStream, number>>;
  readonly #observedIdentity: DockerCustodyIdentity;
  #phase: DockerCustodyInitSnapshot["phase"] = "awaiting-handshake";
  #providerRoot: DockerCustodyProviderRootHandle | undefined;
  #request?: DockerCustodyProviderExecRequest;
  #rootExitObserved = false;
  #rootObservationWritten = false;
  readonly #shutdownGraceMs: number;
  readonly #signalEvidence: DockerCustodySignalObservation[] = [];
  #startFenced = false;
  #stopDeadlineMonotonicMs?: number;
  #stderr: MutableStreamEvidence = {bytes: 0, eof: false, hash: createHash("sha256"), status: "open"};
  #stdinBytes = 0;
  #stdinStatus: DockerCustodyInitSnapshot["stdinStatus"] = "open";
  #stdout: MutableStreamEvidence = {bytes: 0, eof: false, hash: createHash("sha256"), status: "open"};
  readonly #syscalls: DockerCustodyInitSyscalls;
  readonly #writeControl: (message: DockerCustodyInitMessage) => void;
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
    this.#observedIdentity = parseDockerCustodyIdentity(options.observedIdentity);
    this.#shutdownGraceMs = boundedInteger(options.shutdownGraceMs, "shutdownGraceMs");
    this.#syscalls = options.syscalls; this.#writeControl = options.writeControl;
    this.#syscalls.assertPidOne(); this.#syscalls.assertNoNewPrivileges();
    if (!identityEqual(this.#syscalls.observeIdentity(), this.#observedIdentity)) {throw new Error("custody-init configured identity does not match runtime identity");}
  }

  public receive(message: DockerCustodyHostMessage): void {
    try {
      const detached = parseDockerCustodyProtocolMessage(message);
      if (detached.kind === "host-handshake") {this.#receiveHandshake(detached); return;}
      if (detached.kind === "provider-exec") {this.#receiveExec(detached); return;}
      throw new Error("init received a message reserved for Host observation");
    } catch (error) {this.#fenceStart(); throw error;}
  }

  public controlChannelClosed(): void {this.#fenceStart();}
  public malformedControlFrame(): void {this.#fenceStart();}
  #fenceStart(): void {
    if (this.#providerRoot === undefined) {this.#startFenced = true; this.#phase = "failed";}
  }

  #receiveHandshake(message: Extract<DockerCustodyHostMessage, {readonly kind: "host-handshake"}>): void {
    if (this.#startFenced || this.#phase !== "awaiting-handshake" || this.#handshake !== undefined) {throw new Error("duplicate, fenced, or out-of-order Host handshake");}
    if (!identityEqual(message.expectedIdentity, this.#observedIdentity)) {throw new Error("Host expected custody identity does not match init attestation");}
    this.#handshake = Object.freeze({fingerprint: message.launchFingerprintSha256, nonce: message.nonce}); this.#phase = "awaiting-request";
    try {this.#writeControl(Object.freeze({kind: "init-ready", launchFingerprintSha256: message.launchFingerprintSha256,
      nonce: message.nonce, observedIdentity: this.#observedIdentity, protocol: DOCKER_CUSTODY_INIT_PROTOCOL}));}
    catch (error) {this.#fenceStart(); throw error;}
  }

  #receiveExec(message: DockerCustodyProviderExecRequest): void {
    if (this.#startFenced || this.#phase !== "awaiting-request" || this.#request !== undefined) {throw new Error("provider exec is duplicate, fenced, or out of order and will not be launched");}
    this.#request = message; this.#acknowledgement = "pending";
    if (this.#handshake === undefined || !safeEqual(message.handshakeNonce, this.#handshake.nonce) ||
      !safeEqual(message.launchFingerprintSha256, this.#handshake.fingerprint) || !safeEqual(message.executableSha256, this.#executableSha256) ||
      message.wallDeadlineUnixMs <= this.#syscalls.wallNowUnixMs()) {this.#rejectExec(); return;}
    const environment: Record<string, string> = {};
    for (const entry of message.environment) {if (!this.#allowedEnvironmentNames.has(entry.name)) {this.#rejectExec(); return;} environment[entry.name] = entry.value;}
    try {
      const child = this.#syscalls.spawnProvider(Object.freeze({argv: Object.freeze([...message.argv]), clearSupplementaryGroups: true,
        environment: Object.freeze(environment), executablePath: this.#executablePath, gid: message.gid,
        inheritedDescriptors: Object.freeze([0, 1, 2]) as readonly [0, 1, 2], noNewPrivileges: true, shell: false, uid: message.uid}));
      if (child.kind === "not-started") {this.#rejectExec(); return;}
      if (!Number.isSafeInteger(child.handle.pid) || child.handle.pid <= 1 || child.handle.stableIdentity.length === 0) {throw new Error("spawn returned an invalid stable provider root handle");}
      this.#providerRoot = Object.freeze({...child.handle}); this.#phase = "provider-running"; this.#acknowledge("started");
    } catch {this.#phase = "failed"; this.#startFenced = true; this.#acknowledge("acceptance-unknown");
      this.#writeProviderObservation("acceptance-unknown", null, null); this.#requestContainment("init-failure");}
  }
  #rejectExec(): void {this.#phase = "failed"; this.#startFenced = true; this.#acknowledge("not-started"); this.#writeProviderObservation("spawn-failed", null, null);}
  #acknowledge(observation: "acceptance-unknown" | "not-started" | "started"): void {
    if (this.#request === undefined || this.#acknowledgement !== "pending") {return;}
    try {this.#writeControl(Object.freeze({kind: "provider-exec-ack", observation, requestId: this.#request.requestId})); this.#acknowledgement = "delivered";}
    catch {this.#acknowledgement = "lost";}
  }
  public reportLostAcknowledgement(): void {
    if (this.#acknowledgement !== "lost" || this.#request === undefined || this.#lostAcknowledgementReported) {return;}
    this.#lostAcknowledgementReported = this.#writeProviderObservation("exec-acknowledgement-lost", null, null);
  }

  public writeProviderInput(bytes: Uint8Array): "accepted" | "blocked" | "closed" {
    if (this.#phase !== "provider-running" || this.#stdinStatus === "closed" || this.#stdinStatus === "overflow") {return "closed";}
    if (this.#stdinStatus === "blocked") {return "blocked";}
    if (this.#stdinBytes + bytes.byteLength > this.maximumStdinBytes) {this.#stdinStatus = "overflow"; this.requestStop("input-limit"); return "closed";}
    const status = this.#syscalls.writeProviderInput(bytes); if (status === "accepted") {this.#stdinBytes += bytes.byteLength;}
    this.#stdinStatus = status === "blocked" ? "blocked" : status === "closed" ? "closed" : "open"; return status;
  }
  public stdinDrainReady(): void {if (this.#stdinStatus === "blocked") {this.#stdinStatus = "open";}}
  public acceptProviderOutput(stream: DockerCustodyOutputStream, bytes: Uint8Array): "accepted" | "blocked" | "closed" | "overflow" {
    const accounting = stream === "stdout" ? this.#stdout : this.#stderr;
    if (accounting.eof) {return "closed";} if (accounting.status === "overflow") {return "overflow";} if (accounting.status === "blocked") {return "blocked";}
    if (accounting.bytes + bytes.byteLength > this.#limits[stream]) {accounting.status = "overflow"; this.requestStop("output-limit"); return "overflow";}
    const status = this.#syscalls.writeProviderOutput(stream, bytes); if (status === "blocked") {accounting.status = "blocked"; return "blocked";}
    accounting.hash.update(bytes); accounting.bytes += bytes.byteLength; accounting.status = "open"; return "accepted";
  }
  public outputDrainReady(stream: DockerCustodyOutputStream): void {const value = stream === "stdout" ? this.#stdout : this.#stderr; if (value.status === "blocked") {value.status = "open";}}
  public closeProviderOutput(stream: DockerCustodyOutputStream): void {const value = stream === "stdout" ? this.#stdout : this.#stderr; value.eof = true; this.#maybeWriteDrainComplete();}

  public forwardHostSignal(signal: DockerCustodyHostSignal): void {
    if (!DOCKER_CUSTODY_HOST_SIGNALS.includes(signal)) {throw new Error("host signal is not allowlisted");}
    if (signal === "SIGTERM") {this.requestStop("cancelled"); return;}
    this.#performSignal("forward-host", signal);
  }
  public requestStop(reason: DockerCustodyContainmentRequest["reason"] = "cancelled"): void {
    if (this.#request === undefined) {this.#fenceStart(); return;}
    if (this.#stopDeadlineMonotonicMs !== undefined) {return;}
    this.#phase = "stopping";
    this.#stopDeadlineMonotonicMs = this.#syscalls.monotonicNowMs() + this.#shutdownGraceMs;
    this.#performSignal("stop-term", "SIGTERM");
    if (this.#providerRoot === undefined) {this.#requestContainment(reason);}
  }
  #performSignal(action: DockerCustodySignalObservation["action"], signal: DockerCustodyHostSignal | "SIGKILL"): void {
    if (this.#request === undefined) {return;}
    let result: DockerCustodySignalObservation["result"] = "absent";
    const handle = this.#providerRoot;
    if (handle !== undefined) {try {result = this.#syscalls.signalProviderRoot(handle, signal);} catch {result = "failed";}}
    const evidence = Object.freeze({action, kind: "provider-signal-observation", requestId: this.#request.requestId, result, signal} as const);
    this.#signalEvidence.push(evidence);
    try {this.#writeControl(evidence);} catch {this.#requestContainment("init-failure");}
  }

  public tick(): void {
    const reaped = this.#syscalls.reapExitedChildren();
    for (const child of reaped) {
      if (!this.#validReapedChild(child)) {this.failInit(); continue;}
      if (child.pid === this.#providerRoot?.pid && !this.#rootObservationWritten) {
        this.#providerRoot = undefined;
        this.#rootExitObserved = true; this.#rootObservationWritten = true; this.#phase = "provider-exited"; this.#stdinStatus = "closed";
        this.#writeProviderObservation("root-exited", child.exitCode, child.signal); this.#maybeWriteDrainComplete();
      } else {this.#descendantsReaped += 1;}
    }
    const drainOpen = !this.#stdout.eof || !this.#stderr.eof;
    if (this.#request !== undefined && (this.#phase === "provider-running" || this.#phase === "stopping" || this.#phase === "provider-exited" && drainOpen) &&
      this.#syscalls.wallNowUnixMs() >= this.#request.wallDeadlineUnixMs) {this.requestStop("deadline");}
    if (this.#stopDeadlineMonotonicMs !== undefined && this.#syscalls.monotonicNowMs() >= this.#stopDeadlineMonotonicMs && !this.#killEscalationCompleted) {
      this.#performSignal("stop-kill", "SIGKILL"); this.#killEscalationCompleted = true; this.#requestContainment("shutdown-timeout");
    }
  }
  #validReapedChild(child: DockerCustodyReapedChild): boolean {
    if ((child.exitCode === null) === (child.signal === null)) {return false;}
    if (child.exitCode !== null) {return child.exitCode >= 0 && child.exitCode <= 255;}
    return child.signal !== null && DOCKER_CUSTODY_CHILD_SIGNALS.includes(child.signal);
  }
  #maybeWriteDrainComplete(): void {
    if (this.#closure !== null || !this.#rootExitObserved || !this.#stdout.eof || !this.#stderr.eof || this.#request === undefined) {return;}
    const providerDrain = Object.freeze({kind: "provider-drain-complete", outerContainmentClaim: "unproven", requestId: this.#request.requestId,
      rootExit: "observed", stderr: "eof", stdout: "eof"} as const);
    this.#closure = Object.freeze({outerContainmentClaim: "unproven", providerDrain}); this.#phase = "drained";
    try {this.#writeControl(providerDrain);} catch {this.#requestContainment("init-failure");}
  }
  public failInit(): void {this.#phase = "failed"; this.#startFenced = true; if (this.#request !== undefined) {this.#requestContainment("init-failure");}}
  #requestContainment(reason: DockerCustodyContainmentRequest["reason"]): void {
    if (this.#containmentRequested || this.#request === undefined) {return;}
    this.#containmentRequested = true; this.#syscalls.requestContainerContainment(reason);
    try {this.#writeControl(Object.freeze({kind: "container-containment-request", reason, requestId: this.#request.requestId}));} catch {/* syscall evidence remains authoritative */}
  }
  #writeProviderObservation(observation: DockerCustodyProviderObservation["observation"], exitCode: number | null, signal: DockerCustodyChildSignal | null): boolean {
    if (this.#request === undefined) {return false;}
    try {this.#writeControl(Object.freeze({exitCode, kind: "provider-observation", observation, requestId: this.#request.requestId, signal, treeEmptyClaim: "not-claimed"})); return true;}
    catch {this.#requestContainment("init-failure"); return false;}
  }
  public snapshot(): DockerCustodyInitSnapshot {
    const stream = (value: MutableStreamEvidence): DockerCustodyStreamEvidence => Object.freeze({bytes: value.bytes, eof: value.eof,
      sha256: value.bytes === 0 ? EMPTY_SHA256 : value.hash.copy().digest("hex"), status: value.status});
    return Object.freeze({acknowledgement: this.#acknowledgement, closure: this.#closure, containmentRequested: this.#containmentRequested,
      descendantsReaped: this.#descendantsReaped, phase: this.#phase, providerRootTracked: this.#providerRoot !== undefined,
      requestId: this.#request?.requestId ?? null, signalEvidence: Object.freeze([...this.#signalEvidence]), startFenced: this.#startFenced,
      stderr: stream(this.#stderr), stdinBytes: this.#stdinBytes, stdinStatus: this.#stdinStatus, stdout: stream(this.#stdout)});
  }
}
