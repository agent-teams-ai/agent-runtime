import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { constants as osConstants } from "node:os";

import {
  normalizeHostCustodyStartCode,
  type CustodiedProviderProcessExit,
  type HostCustodyStartCode,
} from "./custodied-provider-process.js";
import type { VerifiedLaunchDescriptors } from "./host-custody-launch.js";

const GUARDIAN_SOURCE = String.raw`
const { spawn } = require("node:child_process");
const { createHash } = require("node:crypto");
const { fstatSync, lstatSync, readFileSync } = require("node:fs");
const { pipeline } = require("node:stream");
let provider;
let launchReceived = false;
let startState = "pending";
const streamReports = new Set();
const streamSettlements = new Map();
process.on("SIGTERM", () => {});
const send = (message, callback) => {
  if (typeof process.send !== "function") { process.exit(70); return; }
  process.send(message, callback);
};
const startCode = code => {
  if (code === "EACCES" || code === "EPERM") { return "access-denied"; }
  if (code === "ENOENT") { return "executable-not-found"; }
  if (code === "EAGAIN" || code === "EMFILE" || code === "ENFILE" || code === "ENOMEM") { return "resource-unavailable"; }
  return "unknown-start-failure";
};
const reportStream = (stream, status, stopGroup) => {
  if (streamReports.has(stream)) { return; }
  streamReports.add(stream);
  send({ status, stream, type: "stream-final" }, error => {
    if (error || stopGroup) { process.kill(0, "SIGKILL"); }
  });
};
const publishStream = stream => {
  if (startState === "pending" || streamReports.has(stream)) { return; }
  if (startState === "failed") {
    reportStream(stream, "complete", false);
    return;
  }
  const status = streamSettlements.get(stream);
  if (status !== undefined) { reportStream(stream, status, status === "error"); }
};
const handoff = (stream, source, destination) => {
  pipeline(source, destination, error => {
    streamSettlements.set(stream, error ? "error" : "complete");
    publishStream(stream);
  });
};
const exactCanonicalAuthority = message => {
  if (message.canonicalAuthority === undefined) { return true; }
  try {
    const executablePath = lstatSync(message.command, { bigint: true });
    const executableHeld = fstatSync(message.canonicalAuthority.executableDescriptor, { bigint: true });
    const workspacePath = lstatSync(message.cwd, { bigint: true });
    const workspaceHeld = fstatSync(message.canonicalAuthority.workspaceDescriptor, { bigint: true });
    const executableSha256 = createHash("sha256").update(readFileSync(message.command)).digest("hex");
    return executablePath.isFile() && workspacePath.isDirectory() && workspaceHeld.isDirectory() &&
      String(executablePath.dev) === message.canonicalAuthority.executableDev &&
      String(executablePath.ino) === message.canonicalAuthority.executableIno &&
      executableSha256 === message.canonicalAuthority.executableSha256 &&
      executablePath.dev === executableHeld.dev && executablePath.ino === executableHeld.ino &&
      String(workspacePath.dev) === message.canonicalAuthority.workspaceDev &&
      String(workspacePath.ino) === message.canonicalAuthority.workspaceIno &&
      workspacePath.dev === workspaceHeld.dev && workspacePath.ino === workspaceHeld.ino;
  } catch { return false; }
};
const signalGroup = signal => {
  if (signal === "SIGTERM") {
    process.kill(0, signal);
    send({ type: "signal-issued", signal });
    return;
  }
  send({ type: "signal-issued", signal }, error => {
    if (error) { process.exit(71); return; }
    process.kill(0, "SIGKILL");
  });
};
process.on("message", message => {
  if (message === null || typeof message !== "object") { return; }
  if (message.type === "provider-signal" && message.signal === "SIGKILL") {
    let sent = false;
    try {
      sent = provider !== undefined && provider.exitCode === null && provider.signalCode === null && provider.kill(message.signal);
    } catch {}
    send({ sent, signal: message.signal, type: "provider-signal-issued" });
    return;
  }
  if (message.type === "signal" && (message.signal === "SIGTERM" || message.signal === "SIGKILL")) {
    signalGroup(message.signal);
    return;
  }
  if (message.type !== "launch" || launchReceived) { return; }
  launchReceived = true;
  if (!exactCanonicalAuthority(message)) {
    startState = "failed";
    send({ type: "start-error" });
    publishStream("stdout");
    publishStream("stderr");
    return;
  }
  const maximumDescriptor = Math.max(2, ...message.inheritedDescriptors);
  const stdio = Array.from({ length: maximumDescriptor + 1 }, () => "ignore");
  stdio[0] = "pipe";
  stdio[1] = "pipe";
  stdio[2] = "pipe";
  for (const descriptor of message.inheritedDescriptors) { stdio[descriptor] = descriptor; }
  try {
    provider = spawn(message.command, message.arguments, {
      cwd: message.cwd,
      detached: false,
      env: message.environment,
      shell: false,
      stdio,
      windowsHide: true,
    });
  } catch {
    startState = "failed";
    send({ type: "start-error" });
    publishStream("stdout");
    publishStream("stderr");
    return;
  }
  process.stdin.pipe(provider.stdin);
  handoff("stdout", provider.stdout, process.stdout);
  handoff("stderr", provider.stderr, process.stderr);
  provider.once("spawn", () => {
    startState = "started";
    send({ type: "started", pid: provider.pid });
    publishStream("stdout");
    publishStream("stderr");
  });
  provider.once("error", error => {
    if (startState === "pending") {
      startState = "failed";
      send({ code: startCode(error.code), type: "start-error" });
      publishStream("stdout");
      publishStream("stderr");
      return;
    }
    streamSettlements.set("stdout", "error");
    streamSettlements.set("stderr", "error");
    publishStream("stdout");
    publishStream("stderr");
  });
  provider.once("exit", (code, signal) => {
    send({ code, signal, type: "provider-exit" });
  });
});
send({ type: "ready" });
`;

export type GuardianProviderStream = "stderr" | "stdout";
export type GuardianProviderStreamFinal = "complete" | "error" | "incomplete";

type GuardianMessage =
  | { readonly type: "ready" }
  | { readonly pid: number; readonly type: "started" }
  | { readonly code?: unknown; readonly type: "start-error" }
  | { readonly code: number | null; readonly signal: NodeJS.Signals | null; readonly type: "provider-exit" }
  | { readonly status: GuardianProviderStreamFinal; readonly stream: GuardianProviderStream; readonly type: "stream-final" }
  | { readonly sent: boolean; readonly signal: "SIGKILL"; readonly type: "provider-signal-issued" }
  | { readonly signal: NodeJS.Signals; readonly type: "signal-issued" };

export type GuardianStartObservation =
  | { readonly providerPid: number; readonly status: "acknowledged" }
  | { readonly code?: HostCustodyStartCode; readonly status: "error-before-start" }
  | { readonly status: "ambiguous" };

export interface GuardianExitObservation extends CustodiedProviderProcessExit {
  readonly status: "observed";
}

interface GuardianLaunchInput {
  readonly arguments: readonly string[];
  readonly descriptors: VerifiedLaunchDescriptors;
  readonly environment: Readonly<Record<string, string>>;
  readonly beforeLaunch: (guardianPid: number) => Promise<boolean>;
  readonly canonicalLaunch?: Readonly<{
    readonly command: string;
    readonly cwd: string;
    readonly executableDev: string;
    readonly executableIno: string;
    readonly executableSha256: string;
    readonly workspaceDev: string;
    readonly workspaceIno: string;
  }>;
  readonly launchPermitted: () => boolean;
}

const isGuardianMessage = (message: unknown): message is GuardianMessage =>
  typeof message === "object" && message !== null && "type" in message && typeof message.type === "string";

const HOST_SIGNALS = new Set(Object.keys(osConstants.signals));
const isHostSignal = (value: unknown): value is NodeJS.Signals =>
  value === null || (typeof value === "string" && HOST_SIGNALS.has(value));

const PROVIDER_ERROR_EVENT = "host-custody-provider-error";
const PROVIDER_EXIT_EVENT = "host-custody-provider-exit";
type ProviderEventListener = ((error: Error) => void) |
  ((code: number | null, signal: NodeJS.Signals | null) => void);

export class StableProcessGroupGuardian {
  public readonly child: ChildProcessWithoutNullStreams;
  readonly #guardianExit: Promise<GuardianExitObservation>;
  #guardianExitObservation: GuardianExitObservation | undefined;
  readonly #inherited: readonly { readonly childDescriptor: number }[];
  readonly #input: GuardianLaunchInput;
  #launchDispatched = false;
  #launchOpen = true;
  #exitCode: number | null = null;
  #providerExit: CustodiedProviderProcessExit | undefined;
  readonly #providerSignalWaiters = new Map<NodeJS.Signals, (sent: boolean) => void>();
  #signalCode: NodeJS.Signals | null = null;
  readonly #signalWaiters = new Map<NodeJS.Signals, (sent: boolean) => void>();
  readonly #start: Promise<GuardianStartObservation>;
  readonly #stderrFinal: Promise<GuardianProviderStreamFinal>;
  readonly #stdoutFinal: Promise<GuardianProviderStreamFinal>;
  #startTimer: ReturnType<typeof setTimeout> | undefined;
  #settleStart: ((observation: GuardianStartObservation) => void) | undefined;
  #settleStderrFinal: ((status: GuardianProviderStreamFinal) => void) | undefined;
  #settleStdoutFinal: ((status: GuardianProviderStreamFinal) => void) | undefined;

  public constructor(input: GuardianLaunchInput, startAfterMs: number) {
    const inherited = [
      input.descriptors.workspaceDescriptor,
      input.descriptors.executableDescriptor,
      ...Object.values(input.descriptors.privatePathDescriptors),
    ].toSorted((left, right) => left.childDescriptor - right.childDescriptor);
    const child = spawn(input.canonicalLaunch === undefined ? "/proc/self/exe" : process.execPath, ["-e", GUARDIAN_SOURCE], {
      detached: true,
      env: Object.freeze({ LANG: "C.UTF-8" }),
      shell: false,
      stdio: [
        "pipe",
        "pipe",
        "pipe",
        "ipc",
        ...inherited.map(descriptor => descriptor.parentDescriptor),
      ],
      windowsHide: true,
    }) as ChildProcessWithoutNullStreams;
    this.child = child;
    this.#input = input;
    this.#inherited = inherited;
    this.#start = new Promise(resolve => {this.#settleStart = resolve;});
    this.#stderrFinal = new Promise(resolve => {this.#settleStderrFinal = resolve;});
    this.#stdoutFinal = new Promise(resolve => {this.#settleStdoutFinal = resolve;});
    child.on("message", message => {this.#onMessage(message);});
    child.once("close", () => {
      this.#finishStream("stdout", "incomplete");
      this.#finishStream("stderr", "incomplete");
    });
    this.#guardianExit = new Promise(resolve => {
      child.once("exit", (code, signal) => {
        const guardianExit = Object.freeze({ code, signal, status: "observed" as const });
        this.#guardianExitObservation = guardianExit;
        this.#launchOpen = false;
        if (this.#launchDispatched) {this.#finishStart({ status: "ambiguous" });}
        else {this.#finishNoLaunch();}
        for (const settle of this.#providerSignalWaiters.values()) {settle(false);}
        this.#providerSignalWaiters.clear();
        for (const settle of this.#signalWaiters.values()) {settle(false);}
        this.#signalWaiters.clear();
        resolve(guardianExit);
      });
    });
    child.once("error", error => {
      this.#launchOpen = false;
      if (this.#launchDispatched) {
        this.#finishStart({ status: "error-before-start" });
        this.#finishStream("stdout", "incomplete");
        this.#finishStream("stderr", "incomplete");
      } else {this.#finishNoLaunch();}
      if (this.child.listenerCount(PROVIDER_ERROR_EVENT) > 0) {this.child.emit(PROVIDER_ERROR_EVENT, error);}
    });
    this.#startTimer = setTimeout(() => {
      this.#launchOpen = false;
      if (this.#launchDispatched) {this.#finishStart({ status: "ambiguous" });}
      else {this.#finishNoLaunch();}
      child.kill("SIGKILL");
    }, startAfterMs);
  }

  public get exitCode(): number | null {return this.#exitCode;}
  public get guardianExit(): Promise<GuardianExitObservation> {return this.#guardianExit;}
  public get guardianExitObservation(): GuardianExitObservation | undefined {return this.#guardianExitObservation;}
  public get providerExit(): CustodiedProviderProcessExit | undefined {return this.#providerExit;}
  public get signalCode(): NodeJS.Signals | null {return this.#signalCode;}
  public get start(): Promise<GuardianStartObservation> {return this.#start;}

  public streamFinal(stream: GuardianProviderStream): Promise<GuardianProviderStreamFinal> {
    return stream === "stdout" ? this.#stdoutFinal : this.#stderrFinal;
  }

  public off(event: "error" | "exit", listener: ProviderEventListener): void {
    this.child.off(event === "error" ? PROVIDER_ERROR_EVENT : PROVIDER_EXIT_EVENT, listener as never);
  }

  public on(event: "error" | "exit", listener: ProviderEventListener): void {
    this.child.on(event === "error" ? PROVIDER_ERROR_EVENT : PROVIDER_EXIT_EVENT, listener as never);
  }

  public once(event: "error" | "exit", listener: ProviderEventListener): void {
    this.child.once(event === "error" ? PROVIDER_ERROR_EVENT : PROVIDER_EXIT_EVENT, listener as never);
  }

  public async signalProvider(signal: "SIGKILL"): Promise<"sent" | "unproven"> {
    if (!this.child.connected || this.child.exitCode !== null || this.child.signalCode !== null) {return "unproven";}
    const sent = new Promise<boolean>(resolve => {this.#providerSignalWaiters.set(signal, resolve);});
    try {this.child.send({ signal, type: "provider-signal" });}
    catch {this.#providerSignalWaiters.delete(signal); return "unproven";}
    return await sent ? "sent" : "unproven";
  }

  public async signalGroup(signal: "SIGKILL" | "SIGTERM"): Promise<"sent" | "unproven"> {
    if (!this.child.connected || this.child.exitCode !== null || this.child.signalCode !== null) {return "unproven";}
    const sent = new Promise<boolean>(resolve => {this.#signalWaiters.set(signal, resolve);});
    try {this.child.send({ signal, type: "signal" });}
    catch {this.#signalWaiters.delete(signal); return "unproven";}
    return await sent ? "sent" : "unproven";
  }

  #finishStart(observation: GuardianStartObservation): void {
    const settle = this.#settleStart;
    if (settle === undefined) {return;}
    this.#settleStart = undefined;
    if (this.#startTimer !== undefined) {clearTimeout(this.#startTimer); this.#startTimer = undefined;}
    settle(observation);
  }

  #finishNoLaunch(): void {
    this.#finishStart({ status: "error-before-start" });
    this.#finishStream("stdout", "complete");
    this.#finishStream("stderr", "complete");
  }

  #finishStream(stream: GuardianProviderStream, status: GuardianProviderStreamFinal): void {
    const settle = stream === "stdout" ? this.#settleStdoutFinal : this.#settleStderrFinal;
    if (settle === undefined) {return;}
    if (stream === "stdout") {this.#settleStdoutFinal = undefined;}
    else {this.#settleStderrFinal = undefined;}
    settle(status);
  }

  #guardianBound(value: string, guardianPid: number): string {
    if (this.#input.canonicalLaunch !== undefined) {return value;}
    return this.#inherited.reduce(
      (bound, descriptor) => bound.replaceAll(
        `/proc/self/fd/${descriptor.childDescriptor}`,
        `/proc/${guardianPid}/fd/${descriptor.childDescriptor}`,
      ),
      value,
    );
  }

  async #launchAfterReady(): Promise<void> {
    if (!this.#launchOpen) {return;}
    this.#launchOpen = false;
    try {
      const guardianPid = this.child.pid;
      const attached = guardianPid !== undefined && await this.#input.beforeLaunch(guardianPid);
      if (!attached || !this.#input.launchPermitted() || !this.child.connected) {
        this.#finishNoLaunch();
        this.child.kill("SIGKILL");
        return;
      }
      this.child.send({
        arguments: this.#input.arguments.map(argument => this.#guardianBound(argument, guardianPid)),
        command: this.#input.canonicalLaunch?.command ??
          `/proc/${guardianPid}/fd/${this.#input.descriptors.executableDescriptor.childDescriptor}`,
        cwd: this.#input.canonicalLaunch?.cwd ??
          `/proc/${guardianPid}/fd/${this.#input.descriptors.workspaceDescriptor.childDescriptor}`,
        environment: Object.fromEntries(Object.entries(this.#input.environment).map(([key, value]) => [
          key,
          this.#guardianBound(value, guardianPid),
        ])),
        ...(this.#input.canonicalLaunch === undefined ? {} : { canonicalAuthority: {
          executableDescriptor: this.#input.descriptors.executableDescriptor.childDescriptor,
          executableDev: this.#input.canonicalLaunch.executableDev,
          executableIno: this.#input.canonicalLaunch.executableIno,
          executableSha256: this.#input.canonicalLaunch.executableSha256,
          workspaceDescriptor: this.#input.descriptors.workspaceDescriptor.childDescriptor,
          workspaceDev: this.#input.canonicalLaunch.workspaceDev,
          workspaceIno: this.#input.canonicalLaunch.workspaceIno,
        } }),
        inheritedDescriptors: this.#inherited.map(descriptor => descriptor.childDescriptor),
        type: "launch",
      }, error => {
        if (error !== null) {
          this.#finishStart({ status: "error-before-start" });
          this.child.kill("SIGKILL");
        }
      });
      this.#launchDispatched = true;
    } catch {
      this.#finishNoLaunch();
      this.child.kill("SIGKILL");
    }
  }

  #handleStarted(message: Extract<GuardianMessage, { readonly type: "started" }>): void {
    if (Number.isSafeInteger(message.pid) && message.pid > 0) {
      this.#finishStart({ providerPid: message.pid, status: "acknowledged" });
    }
  }

  #handleStartError(message: Extract<GuardianMessage, { readonly type: "start-error" }>): void {
    const code = normalizeHostCustodyStartCode(message.code);
    this.#finishStart({ ...(code === undefined ? {} : { code }), status: "error-before-start" });
    if (this.child.listenerCount(PROVIDER_ERROR_EVENT) > 0) {
      const error = new Error("Host Custody provider failed before start acknowledgement");
      error.name = "HostCustodyProviderStartError";
      setTimeout(() => {this.child.emit(PROVIDER_ERROR_EVENT, error);}, 0);
    }
  }

  #handleProviderExit(message: Extract<GuardianMessage, { readonly type: "provider-exit" }>): void {
    if ((message.code !== null && !Number.isSafeInteger(message.code)) || !isHostSignal(message.signal)) {return;}
    if (this.#providerExit !== undefined) {return;}
    this.#exitCode = message.code;
    this.#signalCode = message.signal;
    this.#providerExit = Object.freeze({ code: message.code, signal: message.signal });
    this.child.emit(PROVIDER_EXIT_EVENT, message.code, message.signal);
  }

  #handleStreamFinal(message: Extract<GuardianMessage, { readonly type: "stream-final" }>): void {
    if (
      (message.stream === "stdout" || message.stream === "stderr") &&
      (message.status === "complete" || message.status === "error")
    ) {
      this.#finishStream(message.stream, message.status);
    }
  }

  #handleProviderSignalIssued(message: Extract<GuardianMessage, { readonly type: "provider-signal-issued" }>): void {
    if (message.signal !== "SIGKILL") {return;}
    const settle = this.#providerSignalWaiters.get(message.signal);
    this.#providerSignalWaiters.delete(message.signal);
    settle?.(message.sent === true);
  }

  #handleSignalIssued(message: Extract<GuardianMessage, { readonly type: "signal-issued" }>): void {
    const settle = this.#signalWaiters.get(message.signal);
    this.#signalWaiters.delete(message.signal);
    settle?.(true);
  }

  #onMessage(message: unknown): void {
    if (!isGuardianMessage(message)) {return;}
    switch (message.type) {
      case "ready": void this.#launchAfterReady(); return;
      case "started": this.#handleStarted(message); return;
      case "start-error": this.#handleStartError(message); return;
      case "provider-exit": this.#handleProviderExit(message); return;
      case "stream-final": this.#handleStreamFinal(message); return;
      case "provider-signal-issued": this.#handleProviderSignalIssued(message); return;
      case "signal-issued": this.#handleSignalIssued(message); return;
      default: return;
    }
  }
}
