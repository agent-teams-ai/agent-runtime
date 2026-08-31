import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFileSync } from "node:fs";
import type { Readable, Writable } from "node:stream";

import {
  DOCKER_CUSTODY_CHILD_SIGNALS,
  DOCKER_CUSTODY_HOST_SIGNALS,
  encodeDockerCustodyFrame,
  type DockerCustodyChildSignal,
  type DockerCustodyHostSignal,
  type DockerCustodyIdentity,
  type DockerCustodyInitMessage,
} from "./docker-custody-init-protocol.js";
import {
  DockerCustodyInitRuntime,
  type DockerCustodyInitRuntimeOptions,
  type DockerCustodyInitSyscalls,
  type DockerCustodyOutputStream,
  type DockerCustodyOutputWriteResult,
  type DockerCustodyProviderOutputHandle,
  type DockerCustodyProviderRootExit,
  type DockerCustodyProviderRootHandle,
  type DockerCustodyProviderSpawn,
} from "./docker-custody-init-runtime.js";

interface ProviderGeneration {
  readonly child: ChildProcessWithoutNullStreams;
  exit: DockerCustodyProviderRootExit | null;
  exitReported: boolean;
  readonly root: DockerCustodyProviderRootHandle;
  readonly stderr: DockerCustodyProviderOutputHandle;
  readonly stdout: DockerCustodyProviderOutputHandle;
}

export interface DockerCustodyTopologyFacts {
  readonly gid: number;
  readonly groups: readonly number[];
  readonly noNewPrivileges: boolean;
  readonly parentName: string;
  readonly parentPid: number;
  readonly pid: number;
  readonly uid: number;
}

export interface NodeDockerCustodyInitDriverOptions extends Omit<DockerCustodyInitRuntimeOptions, "syscalls" | "writeControl"> {
  readonly controlInput?: Readable;
  readonly controlOutput?: Writable;
  readonly tickIntervalMs?: number;
}

export interface NodeDockerCustodyInitDriverInternals {
  /** Synthetic process-fixture seam; production always observes fixed procfs paths. */
  readonly observeTopology?: () => DockerCustodyTopologyFacts;
  readonly observeRestrictedIdentity?: () => {readonly gid: number; readonly uid: number};
  readonly spawnProcess?: (specification: DockerCustodyProviderSpawn) => ChildProcessWithoutNullStreams;
}

const statusValue = (status: string, name: string): string => {
  const matches = status.match(new RegExp(`^${name}:\\s*(.+)$`, "mu"));
  if (matches?.[1] === undefined) {throw new Error(`required proc status field ${name} is absent`);}
  return matches[1].trim();
};

export const assertDockerCustodyTopologyFacts = (facts: DockerCustodyTopologyFacts): void => {
  if (facts.pid <= 1 || facts.parentPid !== 1 || facts.uid <= 0 || facts.gid <= 0 || !facts.noNewPrivileges ||
      !["docker-init", "tini"].includes(facts.parentName) || facts.groups.some(group => group !== facts.gid)) {
    throw new Error("custody init must be the restricted non-root direct child of Docker/tini PID1");
  }
};

const observeTopology = (): DockerCustodyTopologyFacts => {
  if (process.platform !== "linux" || process.getuid === undefined || process.getgid === undefined || process.getgroups === undefined) {
    throw new Error("Docker custody init is supported only on Linux");
  }
  const selfStatus = readFileSync("/proc/self/status", "utf8");
  const parentStatus = readFileSync("/proc/1/status", "utf8");
  return Object.freeze({
    gid: process.getgid(),
    groups: Object.freeze(process.getgroups()),
    noNewPrivileges: statusValue(selfStatus, "NoNewPrivs") === "1",
    parentName: statusValue(parentStatus, "Name"),
    parentPid: process.ppid,
    pid: process.pid,
    uid: process.getuid(),
  });
};

const childSignal = (signal: NodeJS.Signals | null): DockerCustodyChildSignal | null => {
  if (signal === null) {return null;}
  if (!DOCKER_CUSTODY_CHILD_SIGNALS.includes(signal as DockerCustodyChildSignal)) {
    throw new Error("provider exited with an unsupported signal observation");
  }
  return signal as DockerCustodyChildSignal;
};

class NodeInitSyscalls implements DockerCustodyInitSyscalls {
  #generation: ProviderGeneration | undefined;
  readonly #identity: DockerCustodyIdentity;
  readonly #observeTopology: () => DockerCustodyTopologyFacts;
  readonly #observeRestrictedIdentity: () => {readonly gid: number; readonly uid: number};
  readonly #spawnProcess: (specification: DockerCustodyProviderSpawn) => ChildProcessWithoutNullStreams;
  readonly #writeOutput: (message: DockerCustodyInitMessage) => "accepted" | "blocked";
  runtime: DockerCustodyInitRuntime | undefined;

  public constructor(
    identity: DockerCustodyIdentity,
    writeOutput: (message: DockerCustodyInitMessage) => "accepted" | "blocked",
    topologyObserver: () => DockerCustodyTopologyFacts,
    identityObserver: () => {readonly gid: number; readonly uid: number},
    spawnProcess: (specification: DockerCustodyProviderSpawn) => ChildProcessWithoutNullStreams,
  ) {
    this.#identity = identity; this.#observeRestrictedIdentity = identityObserver;
    this.#observeTopology = topologyObserver; this.#spawnProcess = spawnProcess; this.#writeOutput = writeOutput;
  }

  public assertDirectChildOfContainerInit(): void {assertDockerCustodyTopologyFacts(this.#observeTopology());}
  public assertNoNewPrivileges(): void {
    if (!this.#observeTopology().noNewPrivileges) {throw new Error("custody init requires no-new-privileges");}
  }
  public monotonicNowMs(): number {return Math.floor(performance.now());}
  public wallNowUnixMs(): number {return Date.now();}
  public observeIdentity(): DockerCustodyIdentity {return this.#identity;}
  public reapExitedDescendants(): readonly [] {return Object.freeze([]);}
  public requestContainerContainment(): "accepted" {return "accepted";}

  public spawnProvider(specification: DockerCustodyProviderSpawn): ReturnType<DockerCustodyInitSyscalls["spawnProvider"]> {
    const identity = this.#observeRestrictedIdentity();
    if (this.#generation !== undefined || identity.uid !== specification.uid || identity.gid !== specification.gid) {
      return {kind: "not-started"};
    }
    const child = this.#spawnProcess(specification);
    if (child.pid === undefined) {return {kind: "not-started"};}
    const generation: ProviderGeneration = {
      child, exit: null, exitReported: false,
      root: Object.freeze({}) as DockerCustodyProviderRootHandle,
      stderr: Object.freeze({}) as DockerCustodyProviderOutputHandle,
      stdout: Object.freeze({}) as DockerCustodyProviderOutputHandle,
    };
    this.#generation = generation;
    child.once("exit", (exitCode, signal) => {
      try {generation.exit = Object.freeze({exitCode, signal: childSignal(signal)});} catch {this.runtime?.failInit();}
    });
    child.once("error", () => {this.runtime?.failInit();});
    this.#bindOutput(generation, "stdout", generation.stdout, child.stdout);
    this.#bindOutput(generation, "stderr", generation.stderr, child.stderr);
    child.stdin.on("drain", () => {this.runtime?.stdinDrainReady();});
    child.stdin.once("error", () => {this.runtime?.failInit();});
    return {handle: generation.root, kind: "started", pid: child.pid, stderr: generation.stderr, stdout: generation.stdout};
  }

  #bindOutput(
    generation: ProviderGeneration,
    stream: DockerCustodyOutputStream,
    handle: DockerCustodyProviderOutputHandle,
    source: Readable,
  ): void {
    source.on("data", (chunk: Buffer) => {
      const result = this.runtime?.acceptProviderOutput(handle, chunk) ?? "closed";
      if (result === "blocked") {source.pause();}
    });
    source.once("end", () => {this.runtime?.closeProviderOutput(handle);});
    source.once("error", () => {this.runtime?.failInit();});
    generation.child.once("close", () => {this.runtime?.tick();});
    void stream;
  }

  public outputDrainReady(): void {
    const generation = this.#generation;
    if (generation === undefined || this.runtime === undefined) {return;}
    for (const [handle, source] of [[generation.stdout, generation.child.stdout], [generation.stderr, generation.child.stderr]] as const) {
      const result = this.runtime.outputDrainReady(handle);
      if (result !== "blocked" && source.isPaused()) {source.resume();}
    }
  }

  public writeProviderOutput(stream: DockerCustodyOutputStream, bytes: Uint8Array): DockerCustodyOutputWriteResult {
    const requestId = this.runtime?.snapshot().requestId;
    if (requestId === null || requestId === undefined) {throw new Error("provider output has no active request");}
    const status = this.#writeOutput({bytesBase64: Buffer.from(bytes).toString("base64"), kind: "provider-output", requestId, stream});
    return status === "accepted" ? {committedBytes: bytes.byteLength, status} : {committedBytes: 0, status};
  }

  public writeProviderInput(bytes: Uint8Array): "accepted" | "closed" {
    const child = this.#generation?.child;
    if (child === undefined || child.stdin.destroyed || child.stdin.writableEnded) {return "closed";}
    child.stdin.write(Uint8Array.from(bytes));
    return "accepted";
  }
  public closeProviderInput(): void {this.#generation?.child.stdin.end();}

  public observeProviderRootExit(handle: DockerCustodyProviderRootHandle): DockerCustodyProviderRootExit | null {
    const generation = this.#generation;
    if (generation === undefined || handle !== generation.root || generation.exit === null || generation.exitReported) {return null;}
    generation.exitReported = true; return generation.exit;
  }
  public signalProviderRoot(handle: DockerCustodyProviderRootHandle, signal: DockerCustodyHostSignal | "SIGKILL"): "absent" | "sent" {
    const generation = this.#generation;
    if (generation === undefined || handle !== generation.root || generation.exit !== null) {return "absent";}
    return generation.child.kill(signal) ? "sent" : "absent";
  }
}

export class NodeDockerCustodyInitDriver {
  readonly #input: Readable;
  readonly #output: Writable;
  readonly #runtime: DockerCustodyInitRuntime;
  readonly #syscalls: NodeInitSyscalls;
  #outputBlocked = false;
  readonly #tickIntervalMs: number;

  public constructor(options: NodeDockerCustodyInitDriverOptions, internals: NodeDockerCustodyInitDriverInternals = {}) {
    this.#input = options.controlInput ?? process.stdin;
    this.#output = options.controlOutput ?? process.stdout;
    this.#tickIntervalMs = options.tickIntervalMs ?? 10;
    if (!Number.isSafeInteger(this.#tickIntervalMs) || this.#tickIntervalMs <= 0 || this.#tickIntervalMs > 1_000) {
      throw new Error("tickIntervalMs must be between 1 and 1000");
    }
    const writeOutput = (message: DockerCustodyInitMessage): "accepted" | "blocked" => {
      if (this.#outputBlocked) {return "blocked";}
      this.#outputBlocked = !this.#output.write(encodeDockerCustodyFrame(message));
      return "accepted";
    };
    const identityObserver = internals.observeRestrictedIdentity ?? (() => ({gid: process.getgid?.() ?? 0, uid: process.getuid?.() ?? 0}));
    const spawnProcess = internals.spawnProcess ?? (specification => spawn(
      specification.executablePath,
      specification.argv.slice(1),
      {argv0: specification.argv[0], detached: false, env: {...specification.environment}, gid: specification.gid,
        shell: false, stdio: ["pipe", "pipe", "pipe"], uid: specification.uid},
    ));
    const syscalls = new NodeInitSyscalls(
      options.observedIdentity, writeOutput, internals.observeTopology ?? observeTopology, identityObserver, spawnProcess,
    );
    this.#syscalls = syscalls;
    this.#runtime = new DockerCustodyInitRuntime({...options, syscalls, writeControl: writeOutput});
    syscalls.runtime = this.#runtime;
  }

  public run(): Promise<0 | 1> {
    return new Promise(resolve => {
      let settled = false;
      const finish = (code: 0 | 1): void => {
        if (settled) {return;}
        settled = true; clearInterval(timer); this.#input.removeAllListeners(); this.#output.removeAllListeners("drain");
        this.#input.destroy();
        for (const signal of DOCKER_CUSTODY_HOST_SIGNALS) {process.removeListener(signal, handlers[signal]);}
        this.#output.end(() => {resolve(code);});
      };
      const inspect = (): void => {
        this.#runtime.tick();
        const phase = this.#runtime.snapshot().phase;
        if (phase === "drained") {finish(0);} else if (phase === "failed") {finish(1);}
      };
      const handlers = Object.fromEntries(DOCKER_CUSTODY_HOST_SIGNALS.map(signal => [signal, () => {
        this.#runtime.forwardHostSignal(signal); inspect();
      }])) as Record<DockerCustodyHostSignal, () => void>;
      for (const signal of DOCKER_CUSTODY_HOST_SIGNALS) {process.on(signal, handlers[signal]);}
      this.#input.on("data", (chunk: Buffer) => {
        try {this.#runtime.receiveControlBytes(chunk); inspect();} catch {finish(1);}
      });
      this.#input.once("end", () => {try {this.#runtime.controlChannelClosed();} catch {finish(1);} inspect();});
      this.#input.once("error", () => {this.#runtime.failInit(); finish(1);});
      this.#output.on("drain", () => {this.#outputBlocked = false; this.#syscalls.outputDrainReady(); inspect();});
      const timer = setInterval(inspect, this.#tickIntervalMs);
      timer.unref();
    });
  }
}
