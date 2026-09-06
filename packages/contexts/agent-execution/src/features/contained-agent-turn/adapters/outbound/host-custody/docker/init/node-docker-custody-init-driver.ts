import { ChildProcess, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readFileSync, readSync, realpathSync, statfsSync, type BigIntStats } from "node:fs";
import { basename, dirname, resolve as resolvePath } from "node:path";
import type { Readable, Writable } from "node:stream";

import {
  DOCKER_CUSTODY_CHILD_SIGNALS,
  DOCKER_CUSTODY_HOST_SIGNALS,
  DOCKER_CUSTODY_PROVIDER_IO_MAX_BYTES,
  encodeDockerCustodyFrame,
  type DockerCustodyChildSignal,
  type DockerCustodyHostSignal,
  type DockerCustodyIdentity,
  type DockerCustodyExecutableMapping,
  type DockerCustodyInitMessage,
  type DockerCustodyProviderInstanceFacts,
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
  instance: DockerCustodyProviderInstanceFacts | null;
  readonly root: DockerCustodyProviderRootHandle;
  readonly stderr: DockerCustodyProviderOutputHandle;
  readonly stdout: DockerCustodyProviderOutputHandle;
}

const MAX_EXECUTABLE_PATH_BYTES = 4_096;
const MAX_EXECUTABLE_BYTES = 256 * 1_024 * 1_024;
const PROVIDER_EXECUTABLE_SLOT = "provider-entrypoint";

export interface HeldDockerCustodyProviderExecutable {
  readonly descriptorPath: string;
  close(): void;
  observeMapping(child: ChildProcessWithoutNullStreams): DockerCustodyExecutableMapping | undefined;
}

const sameExecutable = (left: BigIntStats, right: BigIntStats): boolean =>
  left.dev === right.dev && left.ino === right.ino && left.mode === right.mode && left.nlink === right.nlink &&
  left.size === right.size && left.uid === right.uid && left.gid === right.gid &&
  left.ctimeNs === right.ctimeNs && left.mtimeNs === right.mtimeNs;

const liveChild = (child: ChildProcessWithoutNullStreams, pid: number): boolean =>
  child instanceof ChildProcess && child.pid === pid && child.exitCode === null && child.signalCode === null;

const childStartTime = (directory: string, pid: number): string => {
  const stat = readFileSync(`${directory}/stat`, "utf8");
  const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/u);
  if (!stat.startsWith(`${pid} (`) || !["R", "S", "D", "T", "t", "I"].includes(fields[0] ?? "") ||
      fields[1] !== String(process.pid) || !/^[1-9][0-9]*$/u.test(fields[19] ?? "")) {
    throw new Error("procfs does not identify a live direct child");
  }
  return fields[19]!;
};

const mappedExecutable = (directory: string): BigIntStats => {
  const descriptor = openSync(`${directory}/exe`, constants.O_RDONLY);
  try {return fstatSync(descriptor, {bigint: true});} finally {closeSync(descriptor);}
};

/** A synchronous observation in the native spawn callback, before this loop can reap the child.
 * Linux proc directory FDs retain the proc task identity across PID reuse; they are NOT pidfds.
 * There is no await/user callback in this interval. libuv owns waitpid on this same loop, and
 * exitCode/signalCode fence an already delivered native exit. An exited/zombie task is rejected.
 * Two exe opens compare actual kernel file objects, never readlink text or provider assertions.
 * This proves the sampled mapping only, not absence of later exec or whole-lifetime containment.
 */
const observeExecutableMapping = (child: ChildProcessWithoutNullStreams, descriptor: number,
  expected: BigIntStats): DockerCustodyExecutableMapping | undefined => {
  const pid = child.pid;
  if (process.platform !== "linux" || pid === undefined || !Number.isSafeInteger(pid) || pid < 2 || !liveChild(child, pid)) {return undefined;}
  let procDirectory: number | undefined;
  let observation: DockerCustodyExecutableMapping | undefined;
  try {
    if (statfsSync("/proc").type !== 0x9fa0) {return undefined;}
    procDirectory = openSync(`/proc/${pid}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const directory = `/proc/self/fd/${procDirectory}`;
    if (statfsSync(directory).type !== 0x9fa0) {return undefined;}
    const startTimeTicks = childStartTime(directory, pid);
    if (!sameExecutable(expected, fstatSync(descriptor, {bigint: true})) ||
        !sameExecutable(expected, mappedExecutable(directory)) ||
        !sameExecutable(expected, mappedExecutable(directory)) ||
        !sameExecutable(expected, fstatSync(descriptor, {bigint: true})) ||
        childStartTime(directory, pid) !== startTimeTicks || !liveChild(child, pid)) {return undefined;}
    observation = Object.freeze({device: expected.dev.toString(), inode: expected.ino.toString(),
      kind: "linux-procfs-exe-v1", scope: "spawn-observation", startTimeTicks});
  } catch {observation = undefined;} finally {
    if (procDirectory !== undefined) {try {closeSync(procDirectory);} catch {observation = undefined;}}
  }
  return observation;
};

const equalDigest = (left: string, right: string): boolean => {
  const leftBytes = Buffer.from(left, "ascii");
  const rightBytes = Buffer.from(right, "ascii");
  return leftBytes.byteLength === rightBytes.byteLength && timingSafeEqual(leftBytes, rightBytes);
};

export const holdDockerCustodyProviderExecutable = (
  configuredPath: string,
  expectedSha256: string,
): HeldDockerCustodyProviderExecutable => {
  if (process.platform !== "linux" || Buffer.byteLength(configuredPath) > MAX_EXECUTABLE_PATH_BYTES ||
      configuredPath !== resolvePath(configuredPath) || basename(configuredPath) !== PROVIDER_EXECUTABLE_SLOT) {
    throw new Error("provider executable slot is not the canonical bounded Linux slot");
  }
  const configuredRoot = dirname(configuredPath);
  if (realpathSync(configuredRoot) !== configuredRoot) {throw new Error("provider executable slot root is substituted");}
  const descriptor = openSync(configuredPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  let closed = false;
  const close = (): void => {if (!closed) {closed = true; closeSync(descriptor);}};
  try {
    const before = fstatSync(descriptor, {bigint: true});
    if (!before.isFile() || before.size > BigInt(MAX_EXECUTABLE_BYTES) || before.nlink !== 1n ||
      (before.mode & 0o111n) === 0n || (before.mode & 0o222n) !== 0n) {
      throw new Error("provider executable slot is not one private executable regular file");
    }
    const digest = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1_024);
    let position = 0;
    while (position < Number(before.size)) {
      const bytesRead = readSync(descriptor, buffer, 0, Math.min(buffer.byteLength, Number(before.size) - position), position);
      if (bytesRead === 0) {throw new Error("provider executable descriptor was truncated while hashing");}
      digest.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    const after = fstatSync(descriptor, {bigint: true});
    if (!sameExecutable(before, after) || !equalDigest(digest.digest("hex"), expectedSha256)) {
      throw new Error("provider executable descriptor identity does not match authority");
    }
    return Object.freeze({close, descriptorPath: `/proc/self/fd/${descriptor}`,
      observeMapping: (child: ChildProcessWithoutNullStreams) => closed ? undefined : observeExecutableMapping(child, descriptor, after)});
  } catch (error) {close(); throw error;}
};

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
  #executable: HeldDockerCustodyProviderExecutable | undefined;
  #observationClosed = false;
  #generation: ProviderGeneration | undefined;
  readonly #initInstanceId = randomBytes(32).toString("hex");
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
  public spawnProvider(specification: DockerCustodyProviderSpawn): ReturnType<DockerCustodyInitSyscalls["spawnProvider"]> {
    const identity = this.#observeRestrictedIdentity();
    if (this.#generation !== undefined || identity.uid !== specification.uid || identity.gid !== specification.gid) {
      return {kind: "not-started"};
    }
    let executable: HeldDockerCustodyProviderExecutable;
    try {executable = holdDockerCustodyProviderExecutable(specification.executablePath, specification.executableSha256);}
    catch {return {kind: "not-started"};}
    this.#executable = executable;
    let child: ChildProcessWithoutNullStreams;
    try {child = this.#spawnProcess({...specification, executablePath: executable.descriptorPath});}
    catch {executable.close(); return {kind: "not-started"};}
    let notStarted = false;
    const spawned = (): void => {
      const retained = this.#generation;
      // Only this retained ChildProcess's native spawn event issues an identity. Late/error events cannot.
      if (this.#observationClosed || retained === undefined || retained.child !== child || retained.exit !== null || notStarted ||
        child.pid === undefined || retained.instance !== null) {executable.close(); return;}
      try {
        const executableMapping = executable.observeMapping(child);
        executable.close();
        retained.instance = Object.freeze({childInstanceId: randomBytes(32).toString("hex"),
          ...(executableMapping === undefined ? {} : {executableMapping}),
          executableSha256: specification.executableSha256, initInstanceId: this.#initInstanceId, pid: child.pid});
      } catch {this.runtime?.failInit();} finally {executable.close();}
      this.runtime?.tick();
    };
    const spawnError = (): void => {
      child.removeListener("spawn", spawned); executable.close();
      if (!notStarted && !this.#observationClosed && this.#generation?.exit === null) {this.runtime?.failInit();}
    };
    // Retain a bounded error sink with this child; late errors must not escape or rewrite sealed evidence.
    child.on("error", spawnError);
    child.once("spawn", spawned);
    if (child.pid === undefined) {notStarted = true; executable.close(); return {kind: "not-started"};}
    const generation: ProviderGeneration = {
      child, exit: null, exitReported: false, instance: null,
      root: Object.freeze({}) as DockerCustodyProviderRootHandle,
      stderr: Object.freeze({}) as DockerCustodyProviderOutputHandle,
      stdout: Object.freeze({}) as DockerCustodyProviderOutputHandle,
    };
    this.#generation = generation;
    child.once("exit", (exitCode, signal) => {
      child.removeListener("spawn", spawned); executable.close();
      try {generation.exit = Object.freeze({exitCode, signal: childSignal(signal)});} catch {this.runtime?.failInit();}
    });
    this.#bindOutput(generation, "stdout", generation.stdout, child.stdout);
    this.#bindOutput(generation, "stderr", generation.stderr, child.stderr);
    child.stdin.on("drain", () => {this.runtime?.stdinDrainReady();});
    child.stdin.once("error", () => {this.runtime?.failInit();});
    child.stdin.once("close", () => {this.runtime?.tick(); this.runtime?.providerInputClosed();});
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
    source.once("error", () => {this.runtime?.failProviderOutput(handle);});
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
    return writeDockerCustodyProviderOutputFragments(this.#writeOutput, requestId, stream, bytes);
  }

  public writeProviderInput(bytes: Uint8Array): {readonly committedBytes: number; readonly status: "accepted" | "blocked" | "closed"} {
    const child = this.#generation?.child;
    if (child === undefined || child.stdin.destroyed || child.stdin.writableEnded) {return {committedBytes: 0, status: "closed"};}
    return writeDockerCustodyProviderInput(child.stdin, bytes);
  }
  public closeProviderInput(): void {this.#generation?.child.stdin.end();}
  public closeExecutableObservation(): void {this.#observationClosed = true; this.#executable?.close();}

  public observeProviderInstance(handle: DockerCustodyProviderRootHandle): DockerCustodyProviderInstanceFacts | null {
    const generation = this.#generation;
    return generation !== undefined && handle === generation.root ? generation.instance : null;
  }
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

export const writeDockerCustodyProviderOutputFragments = (
  writeOutput: (message: DockerCustodyInitMessage) => "accepted" | "blocked",
  requestId: string,
  stream: DockerCustodyOutputStream,
  bytes: Uint8Array,
): DockerCustodyOutputWriteResult => {
  let committedBytes = 0;
  while (committedBytes < bytes.byteLength) {
    const end = Math.min(bytes.byteLength, committedBytes + DOCKER_CUSTODY_PROVIDER_IO_MAX_BYTES);
    const fragment = bytes.subarray(committedBytes, end);
    const status = writeOutput({bytesBase64: Buffer.from(fragment).toString("base64"), kind: "provider-output", requestId, stream});
    if (status === "blocked") {return {committedBytes, status};}
    committedBytes = end;
  }
  return {committedBytes, status: "accepted"};
};

export const writeDockerCustodyProviderInput = (
  input: Writable,
  bytes: Uint8Array,
): {readonly committedBytes: number; readonly status: "accepted" | "blocked" | "closed"} => {
  if (input.destroyed || input.writableEnded) {return {committedBytes: 0, status: "closed"};}
  const accepted = input.write(Uint8Array.from(bytes));
  return {committedBytes: bytes.byteLength, status: accepted ? "accepted" : "blocked"};
};

export class NodeDockerCustodyInitDriver {
  readonly #input: Readable;
  readonly #output: Writable;
  readonly #runtime: DockerCustodyInitRuntime;
  readonly #syscalls: NodeInitSyscalls;
  #outputBlocked = false;
  #inputBlocked = false;
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
      const settle = (code: 0 | 1): void => {resolve(code);};
      const finish = (code: 0 | 1): void => {
        if (settled) {return;}
        this.#syscalls.closeExecutableObservation();
        settled = true; clearInterval(timer); this.#input.removeAllListeners(); this.#output.removeAllListeners("drain");
        this.#input.destroy();
        for (const signal of DOCKER_CUSTODY_HOST_SIGNALS) {process.removeListener(signal, handlers[signal]);}
        if (this.#output.destroyed) {settle(code);} else {this.#output.end(() => {settle(code);});}
      };
      const inspect = (): void => {
        this.#runtime.tick();
        const snapshot = this.#runtime.snapshot();
        const phase = snapshot.phase;
        if (snapshot.stdinStatus === "blocked" && !this.#inputBlocked) {this.#inputBlocked = true; this.#input.pause();}
        else if (snapshot.stdinStatus !== "blocked" && this.#inputBlocked) {this.#inputBlocked = false; this.#input.resume();}
        if (phase === "drained") {finish(0);} else if (phase === "failed" && snapshot.failureCleanupComplete) {finish(1);}
      };
      const handlers = Object.fromEntries(DOCKER_CUSTODY_HOST_SIGNALS.map(signal => [signal, () => {
        this.#runtime.forwardHostSignal(signal); inspect();
      }])) as Record<DockerCustodyHostSignal, () => void>;
      for (const signal of DOCKER_CUSTODY_HOST_SIGNALS) {process.on(signal, handlers[signal]);}
      this.#input.on("data", (chunk: Buffer) => {
        try {this.#runtime.receiveControlBytes(chunk);} catch {this.#runtime.failInit();} inspect();
      });
      this.#input.once("end", () => {try {this.#runtime.controlChannelClosed();} catch {this.#runtime.failInit();} inspect();});
      this.#input.once("error", () => {this.#runtime.failInit(); inspect();});
      this.#output.once("error", () => {this.#runtime.failInit(); inspect();});
      this.#output.on("drain", () => {this.#outputBlocked = false; this.#syscalls.outputDrainReady(); inspect();});
      const timer = setInterval(inspect, this.#tickIntervalMs);
    });
  }
}
