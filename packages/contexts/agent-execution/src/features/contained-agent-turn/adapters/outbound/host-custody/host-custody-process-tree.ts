import { type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFile, stat } from "node:fs/promises";

import type {
  CustodiedSdkProcess,
  HostCustodyLaunchFingerprintEvidence,
  HostCustodyProcessIdentityEvidence,
  HostCustodyProcessIdentityObserver,
  HostCustodyProcessIdentityProof,
} from "./custodied-provider-process.js";
import { sha256, type ExecutableObservation } from "./host-custody-launch.js";
import type { HostStdinEgress, HostStdoutIngress } from "./host-custody-stdio.js";
import type { StableProcessGroupGuardian } from "./host-custody-stable-guardian.js";

export type SpawnStatus = "acknowledged" | "ambiguous" | "error-before-start" | "never-started";

export const delegatedStartAbortError = (): Error => {
  const error = new Error("Host Custody delegated process start was aborted");
  error.name = "AbortError";
  return error;
};

export class NodeCustodiedSdkProcess implements CustodiedSdkProcess {
  readonly #guardian: StableProcessGroupGuardian;
  readonly #stdin: HostStdinEgress;
  #containmentRequested = false;
  readonly #trackedStdout: HostStdoutIngress;
  readonly #requestContainment: () => boolean;

  public constructor(
    guardian: StableProcessGroupGuardian,
    stdin: HostStdinEgress,
    trackedStdout: HostStdoutIngress,
    requestContainment: () => boolean,
  ) {
    this.#guardian = guardian;
    this.#stdin = stdin;
    this.#trackedStdout = trackedStdout;
    this.#requestContainment = requestContainment;
  }

  public get exitCode(): number | null {return this.#guardian.exitCode;}
  public get killed(): boolean {return this.#containmentRequested;}
  public get signalCode(): NodeJS.Signals | null {return this.#guardian.signalCode;}
  public get stdin() {return this.#stdin;}
  public get stdout() {return this.#trackedStdout;}

  public kill(signal: NodeJS.Signals): boolean {
    if (
      signal !== "SIGTERM" && signal !== "SIGKILL" ||
      this.#guardian.exitCode !== null ||
      this.#guardian.signalCode !== null
    ) {return false;}
    this.#containmentRequested ||= this.#requestContainment();
    return false;
  }

  public off(event: "error", listener: (error: Error) => void): void;
  public off(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  public off(event: "error" | "exit", listener: ((error: Error) => void) | ((code: number | null, signal: NodeJS.Signals | null) => void)): void {
    this.#guardian.off(event, listener as never);
  }

  public on(event: "error", listener: (error: Error) => void): void;
  public on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  public on(event: "error" | "exit", listener: ((error: Error) => void) | ((code: number | null, signal: NodeJS.Signals | null) => void)): void {
    this.#guardian.on(event, listener as never);
  }

  public once(event: "error", listener: (error: Error) => void): void;
  public once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  public once(event: "error" | "exit", listener: ((error: Error) => void) | ((code: number | null, signal: NodeJS.Signals | null) => void)): void {
    this.#guardian.once(event, listener as never);
  }
}

export const createPosixProcessIdentityObserver = (): HostCustodyProcessIdentityObserver => Object.freeze({
  async observe(input: Parameters<HostCustodyProcessIdentityObserver["observe"]>[0]) {
    if (process.platform !== "linux") {return { status: "unproven" as const };}
    const statText = await readFile(`/proc/${input.pid}/stat`, "utf8");
    const close = statText.lastIndexOf(")");
    if (close < 0) {return { status: "ambiguous" as const };}
    const fields = statText.slice(close + 2).trim().split(/\s+/u);
    const pgid = Number(fields[2]);
    const startTime = fields[19];
    if (pgid !== input.pgid || startTime === undefined) {
      return { status: "ambiguous" as const };
    }
    return Object.freeze({
      child: input.child,
      childProcessInstanceSha256: input.childProcessInstanceSha256,
      pgid,
      pid: input.pid,
      proofRef: `linux-proc-identity:${sha256(JSON.stringify([
        input.pid,
        pgid,
        startTime,
        input.binarySha256,
        input.planSha256,
        input.hostLifecycleGenerationSha256,
      ]))}`,
      status: "proved" as const,
    });
  },
});

const boundedObservation = async <Value>(
  promise: Promise<Value>,
  deadline: number,
  monotonicNow: () => number,
): Promise<Value | null> => {
  const remaining = deadline - monotonicNow();
  if (remaining <= 0) {return null;}
  return new Promise<Value | null>(resolve => {
    const timer = setTimeout(() => {resolve(null);}, remaining);
    void promise.then(
      value => {
        clearTimeout(timer);
        return resolve(monotonicNow() < deadline ? value : null);
      },
      () => {clearTimeout(timer); return resolve(null);},
    );
  });
};

interface ObserveProcessIdentityInput {
  readonly child: ChildProcessWithoutNullStreams;
  readonly childProcessInstanceSha256: string;
  readonly executable: ExecutableObservation;
  readonly fingerprint: HostCustodyLaunchFingerprintEvidence;
  readonly hostLifecycleGenerationSha256: string;
  readonly monotonicNow: () => number;
  readonly observer: HostCustodyProcessIdentityObserver | undefined;
  readonly observationTimeoutMs: number;
  readonly providerPid: number;
}

export interface ProcessIdentityObservation {
  readonly evidence: HostCustodyProcessIdentityEvidence;
  readonly proof?: HostCustodyProcessIdentityProof;
}

export const observeProcessIdentity = async (
  input: ObserveProcessIdentityInput,
): Promise<ProcessIdentityObservation> => {
  const base = {
    binarySha256: input.executable.digest,
    childProcessInstanceSha256: input.childProcessInstanceSha256,
    hostLifecycleGenerationSha256: input.hostLifecycleGenerationSha256,
    planSha256: input.fingerprint.planSha256,
  } as const;
  const pgid = input.child.pid;
  const pid = input.providerPid;
  if (pgid === undefined) {return { evidence: Object.freeze({ ...base, status: "ambiguous" }) };}
  const observationDeadline = input.monotonicNow() + input.observationTimeoutMs;
  if (process.platform === "linux") {
    try {
      const procPath = `/proc/${pid}/exe`;
      const procStats = await boundedObservation(
        stat(procPath, { bigint: true }),
        observationDeadline,
        input.monotonicNow,
      );
      if (procStats === null) {
        return { evidence: Object.freeze({ ...base, pgid, pid, status: "unproven" }) };
      }
      if (
        procStats.dev !== input.executable.dev ||
        procStats.ino !== input.executable.ino
      ) {
        return { evidence: Object.freeze({ ...base, pgid, pid, status: "ambiguous" }) };
      }
    } catch {
      return { evidence: Object.freeze({ ...base, pgid, pid, status: "unproven" }) };
    }
  }
  if (input.observer === undefined) {
    return { evidence: Object.freeze({
      ...base,
      pgid,
      pid,
      status: "unproven",
    }) };
  }
  try {
    const proof = await boundedObservation(input.observer.observe({
      binarySha256: input.executable.digest,
      child: input.child,
      childProcessInstanceSha256: input.childProcessInstanceSha256,
      hostLifecycleGenerationSha256: input.hostLifecycleGenerationSha256,
      pgid,
      pid,
      planSha256: input.fingerprint.planSha256,
    }), observationDeadline, input.monotonicNow);
    if (
      proof === null ||
      proof.status !== "proved" ||
      proof.child !== input.child ||
      proof.childProcessInstanceSha256 !== input.childProcessInstanceSha256 ||
      proof.pid !== pid ||
      proof.pgid !== pgid ||
      proof.proofRef.length === 0
    ) {
      return { evidence: Object.freeze({ ...base, pgid, pid, status: "ambiguous" }) };
    }
    return {
      evidence: Object.freeze({
        ...base,
        pgid,
        pid,
        proofRef: sha256(proof.proofRef),
        status: "proved",
      }),
      proof,
    };
  } catch {
    return { evidence: Object.freeze({ ...base, pgid, pid, status: "ambiguous" }) };
  }
};
