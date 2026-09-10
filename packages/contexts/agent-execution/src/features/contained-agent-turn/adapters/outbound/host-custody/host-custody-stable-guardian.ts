import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { constants as osConstants } from "node:os";

import {
  normalizeHostCustodyStartCode,
  type CustodiedProviderProcessExit,
  type HostCustodyStartCode,
} from "./custodied-provider-process.js";
import type { VerifiedLaunchDescriptors } from "./host-custody-launch.js";

import type { DarwinSeatbeltProjection } from "./darwin-seatbelt-launch-projection.js";

import { GUARDIAN_SOURCE } from "./host-custody-guardian-program.js";

export type GuardianProviderStream = "stderr" | "stdout";
export type GuardianProviderStreamFinal = "complete" | "error" | "incomplete";

type GuardianMessage =
  | { readonly type: "ready" }
  | { readonly pid: number; readonly type: "started"; readonly darwinImage?: unknown }
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
  readonly darwinRoute?: DarwinSeatbeltProjection;
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
  #startExpired = false;
  #shutdownTimer: ReturnType<typeof setTimeout> | undefined;
  #shutdownRequested = false;
  #darwinProviderImage: unknown;
  public get darwinProviderImage(): unknown {return this.#darwinProviderImage;}
  public stopDarwin(): void {if (this.#input.canonicalLaunch !== undefined) {this.#stopDarwinGuardian();}}
  #settleStart: ((observation: GuardianStartObservation) => void) | undefined;
  #settleStderrFinal: ((status: GuardianProviderStreamFinal) => void) | undefined;
  #settleStdoutFinal: ((status: GuardianProviderStreamFinal) => void) | undefined;

  public constructor(input: GuardianLaunchInput, startAfterMs: number) {
    if (input.canonicalLaunch !== undefined &&
        (!Number.isSafeInteger(startAfterMs) || startAfterMs < 1 || startAfterMs > 2_147_483_647)) {
      throw new TypeError("Darwin guardian admission deadline is invalid");
    }
    const inherited = [
      input.descriptors.workspaceDescriptor,
      input.descriptors.executableDescriptor,
      ...Object.values(input.descriptors.privatePathDescriptors),
    ].toSorted((left, right) => left.childDescriptor - right.childDescriptor);
    const child = spawn(input.canonicalLaunch === undefined ? "/proc/self/exe" : process.execPath,
      ["-e", GUARDIAN_SOURCE, ...(input.canonicalLaunch === undefined ? [] : [String(startAfterMs)])], {
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
        if (this.#shutdownTimer !== undefined) {clearTimeout(this.#shutdownTimer);}
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
      this.#startExpired = true;
      this.#launchOpen = false;
      if (this.#launchDispatched) {this.#finishStart({ status: "ambiguous" });}
      else {this.#finishNoLaunch();}
      if (input.canonicalLaunch === undefined) {child.kill("SIGKILL");}
      else {this.#stopDarwinGuardian();}
    }, startAfterMs);
  }

  public get exitCode(): number | null {return this.#exitCode;}

  #stopDarwinGuardian(): void {
    if (this.#shutdownRequested || this.#guardianExitObservation !== undefined) {return;}
    this.#shutdownRequested = true;
    this.#launchOpen = false;
    const disconnect = () => {try {if (this.child.connected) {this.child.disconnect();}} catch {}};
    // Healthy IPC survives until real exit + stream finals are acknowledged.
    // The guardian has its own shorter local deadline; no finality is invented.
    this.#shutdownTimer = setTimeout(disconnect, 1500);
    try {if (this.child.connected) {this.child.send({type: "shutdown"}, error => {if (error) {disconnect();}});}}
    catch {disconnect();}
  }
  #acknowledgeDarwinFinality(): void {
    if (this.#input.canonicalLaunch === undefined || this.#providerExit === undefined ||
        this.#settleStdoutFinal !== undefined || this.#settleStderrFinal !== undefined) {return;}
    try {if (this.child.connected) {this.child.send({type: "finality-ack"});}} catch {this.#stopDarwinGuardian();}
  }

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
      if (!attached || (this.#input.canonicalLaunch !== undefined && this.#startExpired) ||
          !this.#input.launchPermitted() || !this.child.connected) {
        this.#finishNoLaunch();
        this.child.kill("SIGKILL");
        return;
      }
      // A Darwin send failure after entry cannot establish that the other
      // process did not receive the launch. Keep shutdown with that guardian.
      if (this.#input.canonicalLaunch !== undefined) {this.#launchDispatched = true;}
      this.child.send({
        ...(this.#input.darwinRoute === undefined ? {} : {darwinRoute: this.#input.darwinRoute}),
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
          if (this.#input.canonicalLaunch === undefined) {
            this.#finishStart({ status: "error-before-start" });
            this.child.kill("SIGKILL");
          } else {
            this.#finishStart({ status: "ambiguous" });
            this.#stopDarwinGuardian();
          }
        }
      });
      this.#launchDispatched = true;
    } catch {
      if (this.#input.canonicalLaunch !== undefined && this.#launchDispatched) {
        this.#finishStart({status: "ambiguous"}); this.#stopDarwinGuardian();
      } else {
        this.#finishNoLaunch(); this.child.kill("SIGKILL");
      }
    }
  }

  #handleStarted(message: Extract<GuardianMessage, { readonly type: "started" }>): void {
    if (Number.isSafeInteger(message.pid) && message.pid > 0) {
      if (this.#input.darwinRoute !== undefined) {
        if (this.#startExpired || message.darwinImage === undefined) {
          this.#finishStart({status: "ambiguous"}); this.#stopDarwinGuardian(); return;
        }
        this.#darwinProviderImage = message.darwinImage;
      }
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
    this.#acknowledgeDarwinFinality();
  }

  #handleStreamFinal(message: Extract<GuardianMessage, { readonly type: "stream-final" }>): void {
    if (
      (message.stream === "stdout" || message.stream === "stderr") &&
      (message.status === "complete" || message.status === "error")
    ) {
      this.#finishStream(message.stream, message.status);
      this.#acknowledgeDarwinFinality();
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
