import { createHash, randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, resolve as resolvePath } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { openStablePath } from "@agent-teams/filesystem-custody";

import type {
  ContainedTurnCustodyHandle,
  ProviderProcessCustodyPort,
} from "../../../application/ports/outbound/contained-turn-ports.js";
import {
  HostCustodyUnsupportedError,
  type CustodiedProviderProcess,
  type CustodiedProviderProcessExit,
  type CustodiedProviderProcessRegistry,
  type HostCustodyLaunchPlan,
  type HostCustodyLaunchPlanResolver,
} from "./custodied-provider-process.js";

export interface NodeProviderProcessCustodyOptions {
  readonly forceKillAfterMs?: number;
  readonly launchPlans: HostCustodyLaunchPlanResolver;
  readonly terminateAfterMs?: number;
}

interface LiveCustody {
  readonly attemptId: string;
  readonly binaryDigest: string;
  readonly child: ChildProcessWithoutNullStreams;
  readonly custodyRef: string;
  readonly exit: Promise<CustodiedProviderProcessExit>;
  readonly operationId: string;
  readonly plan: HostCustodyLaunchPlan;
  readonly process: CustodiedProviderProcess;
  readonly workspaceRef: string;
}

const processExit = (child: ChildProcessWithoutNullStreams): Promise<CustodiedProviderProcessExit> =>
  new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve(Object.freeze({ code, signal })));
  });

const writeBytes = (child: ChildProcessWithoutNullStreams, bytes: Uint8Array): Promise<void> =>
  new Promise((resolve, reject) => {
    child.stdin.write(bytes, error => {
      if (error) {reject(error);} else {resolve();}
    });
  });

const closeInput = (child: ChildProcessWithoutNullStreams): Promise<void> =>
  new Promise((resolve, reject) => {
    child.stdin.end((error?: Error | null) => {
      if (error) {reject(error);} else {resolve();}
    });
  });

const verifyExecutable = async (plan: HostCustodyLaunchPlan): Promise<string> => {
  if (!isAbsolute(plan.executablePath) || resolvePath(plan.executablePath) !== plan.executablePath) {
    throw new Error("Host Custody executable must be a normalized absolute path");
  }
  const canonicalPath = await realpath(plan.executablePath);
  if (canonicalPath !== plan.executablePath) {throw new Error("Host Custody executable path must be canonical");}
  const observation = await lstat(canonicalPath, { bigint: true });
  if (!observation.isFile() || observation.nlink !== 1n || (observation.mode & 0o111n) === 0n) {
    throw new Error("Host Custody executable is not a single-link executable file");
  }
  const digest = await openStablePath(
    canonicalPath,
    canonicalPath,
    async opened => createHash("sha256").update(await opened.handle.readFile()).digest("hex"),
  );
  if (digest !== plan.executableSha256) {throw new Error("Host Custody executable digest mismatch");}
  return digest;
};

const signalProcessGroup = (pid: number, signal: NodeJS.Signals): boolean => {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") {return false;}
    throw error;
  }
};

const processGroupExists = (pid: number): boolean => {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") {return false;}
    throw error;
  }
};

const boundedExit = async (
  exit: Promise<CustodiedProviderProcessExit>,
  milliseconds: number,
): Promise<CustodiedProviderProcessExit | void> => Promise.race([
  exit,
  delay(milliseconds),
]);

export class NodeProviderProcessCustody implements ProviderProcessCustodyPort, CustodiedProviderProcessRegistry {
  readonly #byAttempt = new Map<string, LiveCustody>();
  readonly #byRef = new Map<string, LiveCustody>();
  readonly #forceKillAfterMs: number;
  readonly #launchPlans: HostCustodyLaunchPlanResolver;
  readonly #terminateAfterMs: number;

  public constructor(options: NodeProviderProcessCustodyOptions) {
    if (process.platform === "win32") {
      throw new HostCustodyUnsupportedError("Windows provider execution requires a qualified Job Object adapter");
    }
    this.#launchPlans = options.launchPlans;
    this.#terminateAfterMs = options.terminateAfterMs ?? 2_000;
    this.#forceKillAfterMs = options.forceKillAfterMs ?? 2_000;
  }

  public get(custodyRef: string): CustodiedProviderProcess | undefined {
    return this.#byRef.get(custodyRef)?.process;
  }

  public async open(input: {
    readonly attemptId: string;
    readonly operationId: string;
    readonly providerBinding: Parameters<ProviderProcessCustodyPort["open"]>[0]["providerBinding"];
    readonly workspaceRef: string;
  }): Promise<ContainedTurnCustodyHandle> {
    const existing = this.#byAttempt.get(input.attemptId);
    if (existing !== undefined) {
      if (existing.operationId !== input.operationId || existing.workspaceRef !== input.workspaceRef) {
        throw new Error("Host Custody attempt identity conflict");
      }
      return Object.freeze({ custodyRef: existing.custodyRef });
    }
    const plan = await this.#launchPlans.resolve({ providerBinding: input.providerBinding, workspaceRef: input.workspaceRef });
    if (plan === undefined) {throw new HostCustodyUnsupportedError("no exact Host Custody launch plan exists");}
    if (plan.provider !== input.providerBinding.provider || plan.binaryRevision !== input.providerBinding.binaryRevision) {
      throw new Error("Host Custody launch plan does not match the provider binding");
    }
    const binaryDigest = await verifyExecutable(plan);
    const canonicalWorkspace = await realpath(input.workspaceRef);
    if (canonicalWorkspace !== input.workspaceRef) {throw new Error("Host Custody workspace is not canonical");}
    const custodyRef = `urn:agent-runtime:host-custody:${randomUUID()}`;
    const child = spawn(plan.executablePath, [...plan.arguments], {
      cwd: canonicalWorkspace,
      detached: true,
      env: { ...plan.environment },
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    if (child.pid === undefined) {throw new Error("Host Custody did not obtain a process identity");}
    const exit = processExit(child);
    const processAdapter: CustodiedProviderProcess = {
      closeInput: () => closeInput(child),
      custodyRef,
      stderr: child.stderr,
      stdout: child.stdout,
      waitForExit: () => exit,
      write: bytes => writeBytes(child, bytes),
    };
    const custodiedProcess = Object.freeze(processAdapter);
    const live = Object.freeze({
      attemptId: input.attemptId,
      binaryDigest,
      child,
      custodyRef,
      exit,
      operationId: input.operationId,
      plan,
      process: custodiedProcess,
      workspaceRef: canonicalWorkspace,
    });
    this.#byAttempt.set(input.attemptId, live);
    this.#byRef.set(custodyRef, live);
    return Object.freeze({ custodyRef });
  }

  public async requestContainment(input: {
    readonly attemptId: string;
    readonly custodyRef?: string;
    readonly operationId: string;
  }): Promise<
    | { readonly kind: "contained"; readonly receiptRef: string }
    | { readonly evidenceRef: string; readonly kind: "unproven" }
  > {
    const live = input.custodyRef === undefined ? this.#byAttempt.get(input.attemptId) : this.#byRef.get(input.custodyRef);
    if (live === undefined || live.attemptId !== input.attemptId || live.operationId !== input.operationId) {
      return { evidenceRef: `host-custody-missing:${input.attemptId}`, kind: "unproven" };
    }
    const pid = live.child.pid;
    if (pid === undefined) {return { evidenceRef: `host-custody-pid-missing:${input.attemptId}`, kind: "unproven" };}
    try {
      signalProcessGroup(pid, "SIGTERM");
      let exit = await boundedExit(live.exit, this.#terminateAfterMs);
      if (exit === undefined || processGroupExists(pid)) {
        signalProcessGroup(pid, "SIGKILL");
        exit = await boundedExit(live.exit, this.#forceKillAfterMs);
      }
      if (exit === undefined || processGroupExists(pid)) {
        return { evidenceRef: `host-custody-termination-unproven:${input.attemptId}`, kind: "unproven" };
      }
      const receiptIdentity = JSON.stringify([
        input.operationId,
        input.attemptId,
        live.custodyRef,
        live.binaryDigest,
        live.plan.binaryRevision,
        live.plan.containmentProfile,
        live.workspaceRef,
        exit.code,
        exit.signal,
      ]);
      return {
        kind: "contained",
        receiptRef: `urn:agent-runtime:host-contained:${createHash("sha256").update(receiptIdentity).digest("hex")}`,
      };
    } catch {
      return { evidenceRef: `host-custody-signal-failed:${input.attemptId}`, kind: "unproven" };
    }
  }
}
