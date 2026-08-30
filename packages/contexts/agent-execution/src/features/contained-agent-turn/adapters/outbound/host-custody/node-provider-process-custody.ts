import { createHash, randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, resolve as resolvePath } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { openStablePath } from "@agent-teams/filesystem-custody";

import type {
  ContainedTurnCustodyHandle,
  ProviderProcessCustodyPort,
} from "../legacy/legacy-contained-turn-ports.js";
import type { ContainedTurnKernelCustodyPort } from "../../../application/ports/outbound/contained-turn-ports.js";
import { digestContainedTurnCanonicalValue } from "../../../domain/contained-turn-codecs.js";
import { containedTurnIdentity } from "../../../domain/contained-turn-identities.js";
import {
  HostCustodyUnsupportedError,
  type CustodiedProviderProcess,
  type CustodiedProviderProcessExit,
  type CustodiedProviderProcessRegistry,
  type CustodiedSdkProcess,
  type CustodiedSdkProcessLauncher,
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
  readonly custodyRef: string;
  readonly operationId: string;
  readonly plan: HostCustodyLaunchPlan;
  readonly workspaceRef: string;
  readonly authorityVectorDigest?: Parameters<ContainedTurnKernelCustodyPort["open"]>[0]["authorityVectorDigest"];
  readonly effectId?: Parameters<ContainedTurnKernelCustodyPort["open"]>[0]["effectId"];
  readonly hostBootId?: Awaited<ReturnType<ContainedTurnKernelCustodyPort["open"]>>["hostBootId"];
  readonly hostInstanceId?: Awaited<ReturnType<ContainedTurnKernelCustodyPort["open"]>>["hostInstanceId"];
  child?: ChildProcessWithoutNullStreams;
  containment?: Promise<HostContainmentOutcome>;
  exit?: Promise<CustodiedProviderProcessExit>;
  process?: CustodiedProviderProcess;
  sealed?: boolean;
  sdkProcess?: CustodiedSdkProcess;
}

type HostContainmentOutcome =
  | { readonly kind: "contained"; readonly receiptRef: string }
  | { readonly evidenceRef: string; readonly kind: "unproven" };

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

const abortError = (): Error => {
  const error = new Error("Host Custody delegated process start was aborted");
  error.name = "AbortError";
  return error;
};

const compareRecordKeys = ([left]: [string, unknown], [right]: [string, unknown]): number =>
  left < right ? -1 : left > right ? 1 : 0;

const exactStringRecord = (
  actual: Readonly<Record<string, string | undefined>>,
  expected: Readonly<Record<string, string>>,
): actual is Readonly<Record<string, string>> => {
  const actualEntries = Object.entries(actual).toSorted(compareRecordKeys);
  const expectedEntries = Object.entries(expected).toSorted(compareRecordKeys);
  return actualEntries.length === expectedEntries.length && actualEntries.every(([key, value], index) => {
    const expectedEntry = expectedEntries[index];
    return value !== undefined && expectedEntry !== undefined && key === expectedEntry[0] && value === expectedEntry[1];
  });
};

class NodeCustodiedSdkProcess implements CustodiedSdkProcess {
  public constructor(private readonly child: ChildProcessWithoutNullStreams) {}

  public get exitCode(): number | null {return this.child.exitCode;}
  public get killed(): boolean {return this.child.killed;}
  public get signalCode(): NodeJS.Signals | null {return this.child.signalCode;}
  public get stdin() {return this.child.stdin;}
  public get stdout() {return this.child.stdout;}

  public kill(signal: NodeJS.Signals): boolean {
    const pid = this.child.pid;
    return pid === undefined ? false : signalProcessGroup(pid, signal);
  }

  public off(event: "error", listener: (error: Error) => void): void;
  public off(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  public off(event: "error" | "exit", listener: ((error: Error) => void) | ((code: number | null, signal: NodeJS.Signals | null) => void)): void {
    this.child.off(event, listener as never);
  }

  public on(event: "error", listener: (error: Error) => void): void;
  public on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  public on(event: "error" | "exit", listener: ((error: Error) => void) | ((code: number | null, signal: NodeJS.Signals | null) => void)): void {
    this.child.on(event, listener as never);
  }

  public once(event: "error", listener: (error: Error) => void): void;
  public once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  public once(event: "error" | "exit", listener: ((error: Error) => void) | ((code: number | null, signal: NodeJS.Signals | null) => void)): void {
    this.child.once(event, listener as never);
  }
}

export class NodeProviderProcessCustody implements ProviderProcessCustodyPort, CustodiedProviderProcessRegistry, CustodiedSdkProcessLauncher {
  readonly #byAttempt = new Map<string, LiveCustody>();
  readonly #byRef = new Map<string, LiveCustody>();
  readonly #forceKillAfterMs: number;
  readonly #launchPlans: HostCustodyLaunchPlanResolver;
  readonly #terminateAfterMs: number;
  readonly #hostBootId = containedTurnIdentity("host_boot", `host-boot:node:${randomUUID()}`);
  readonly #hostInstanceId = containedTurnIdentity("host_instance", `host-instance:node:${randomUUID()}`);

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

  #spawn(live: LiveCustody, input: {
    readonly arguments: readonly string[];
    readonly environment: Readonly<Record<string, string>>;
    readonly signal?: AbortSignal;
  }): CustodiedSdkProcess {
    if (live.child !== undefined) {throw new Error("Host Custody process was already started");}
    if (input.signal?.aborted === true) {throw abortError();}
    const child = spawn(live.plan.executablePath, [...input.arguments], {
      cwd: live.workspaceRef,
      detached: true,
      env: { ...input.environment },
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    if (child.pid === undefined) {throw new Error("Host Custody did not obtain a process identity");}
    const exit = processExit(child);
    const processAdapter: CustodiedProviderProcess = Object.freeze({
      closeInput: () => closeInput(child),
      custodyRef: live.custodyRef,
      stderr: child.stderr,
      stdout: child.stdout,
      waitForExit: () => exit,
      write: (bytes: Uint8Array) => writeBytes(child, bytes),
    });
    const sdkProcess = new NodeCustodiedSdkProcess(child);
    if (input.signal !== undefined) {
      const terminate = (): void => {
        void this.requestContainment({
          attemptId: live.attemptId,
          custodyRef: live.custodyRef,
          operationId: live.operationId,
        }).catch(() => {});
      };
      input.signal.addEventListener("abort", terminate, { once: true });
      void exit.finally(() => input.signal?.removeEventListener("abort", terminate)).catch(() => {});
    }
    live.child = child;
    live.exit = exit;
    live.process = processAdapter;
    live.sdkProcess = sdkProcess;
    return sdkProcess;
  }

  public start(custodyRef: string, input: {
    readonly arguments: readonly string[];
    readonly command: string;
    readonly cwd: string | undefined;
    readonly environment: Readonly<Record<string, string | undefined>>;
    readonly signal: AbortSignal;
  }): CustodiedSdkProcess {
    const live = this.#byRef.get(custodyRef);
    if (live === undefined) {throw new Error("Host Custody reservation does not exist");}
    if (live.sealed === true) {throw new Error("Host Custody reservation is sealed");}
    if ((live.plan.spawnMode ?? "eager") !== "sdk-delegated") {
      throw new Error("Host Custody reservation does not permit delegated SDK start");
    }
    if (input.command !== live.plan.executablePath || input.cwd !== live.workspaceRef) {
      throw new Error("Host Custody delegated command or workspace mismatch");
    }
    const argumentVariants = live.plan.delegatedArgumentVariants ?? [live.plan.arguments];
    if (!argumentVariants.some(variant => JSON.stringify(input.arguments) === JSON.stringify(variant))) {
      throw new Error("Host Custody delegated arguments mismatch");
    }
    if (!exactStringRecord(input.environment, live.plan.environment)) {
      throw new Error("Host Custody delegated environment mismatch");
    }
    return this.#spawn(live, { arguments: input.arguments, environment: input.environment, signal: input.signal });
  }

  #kernelHandle(
    live: LiveCustody,
    input: Parameters<ContainedTurnKernelCustodyPort["open"]>[0],
  ): Awaited<ReturnType<ContainedTurnKernelCustodyPort["open"]>> {
    if (live.effectId === undefined || live.authorityVectorDigest === undefined ||
        live.hostBootId === undefined || live.hostInstanceId === undefined) {
      throw new TypeError("legacy custody reservation cannot be promoted into kernel authority");
    }
    return Object.freeze({
      custodyId: input.custodyId,
      hostBootId: live.hostBootId,
      hostCustodyProof: Object.freeze({
        binding: Object.freeze({
          attemptId: input.attemptId,
          authorityVectorDigest: input.authorityVectorDigest,
          custodyId: input.custodyId,
          effectId: input.effectId,
          operationId: input.operationId,
        }),
        kind: "host_custody" as const,
        proofId: containedTurnIdentity("proof", `proof:host-custody:${digestContainedTurnCanonicalValue({ attemptId: input.attemptId, custodyId: input.custodyId, hostBootId: live.hostBootId, hostInstanceId: live.hostInstanceId })}`),
      }),
      hostInstanceId: live.hostInstanceId,
    });
  }

  public open(input: Parameters<ProviderProcessCustodyPort["open"]>[0]): Promise<ContainedTurnCustodyHandle>;
  public open(input: Parameters<ContainedTurnKernelCustodyPort["open"]>[0]): ReturnType<ContainedTurnKernelCustodyPort["open"]>;
  public async open(input: Parameters<ProviderProcessCustodyPort["open"]>[0] | Parameters<ContainedTurnKernelCustodyPort["open"]>[0]): Promise<ContainedTurnCustodyHandle | Awaited<ReturnType<ContainedTurnKernelCustodyPort["open"]>>> {
    const kernelInput = "adapterSnapshot" in input ? input : undefined;
    const legacyInput = kernelInput === undefined
      ? input as Parameters<ProviderProcessCustodyPort["open"]>[0]
      : undefined;
    const workspaceRef = kernelInput === undefined
      ? legacyInput!.workspaceRef
      : kernelInput.workspaceId.slice("workspace:".length);
    const providerBinding = kernelInput === undefined ? legacyInput!.providerBinding : {
      adapterRevision: kernelInput.adapterSnapshot.adapterRevision,
      binaryRevision: kernelInput.adapterSnapshot.binaryRevision,
      capabilityManifestRevision: kernelInput.adapterSnapshot.capabilityManifestRevision,
      credentialBindingDigest: kernelInput.providerAccessSnapshot.credentialBindingDigest,
      provider: kernelInput.adapterSnapshot.provider,
      providerRouteRef: kernelInput.providerAccessSnapshot.providerRouteRef,
    };
    const existing = this.#byAttempt.get(input.attemptId);
    if (existing !== undefined) {
      if (existing.operationId !== input.operationId || existing.workspaceRef !== workspaceRef) {
        throw new Error("Host Custody attempt identity conflict");
      }
      return kernelInput === undefined
        ? Object.freeze({ custodyRef: existing.custodyRef })
        : this.#kernelHandle(existing, kernelInput);
    }
    const plan = await this.#launchPlans.resolve({ providerBinding, workspaceRef });
    if (plan === undefined) {throw new HostCustodyUnsupportedError("no exact Host Custody launch plan exists");}
    if (plan.provider !== providerBinding.provider || plan.binaryRevision !== providerBinding.binaryRevision) {
      throw new Error("Host Custody launch plan does not match the provider binding");
    }
    const binaryDigest = await verifyExecutable(plan);
    const canonicalWorkspace = await realpath(workspaceRef);
    if (canonicalWorkspace !== workspaceRef) {throw new Error("Host Custody workspace is not canonical");}
    const custodyRef = kernelInput?.custodyId ?? `urn:agent-runtime:host-custody:${randomUUID()}`;
    const live: LiveCustody = {
      attemptId: input.attemptId,
      binaryDigest,
      custodyRef,
      operationId: input.operationId,
      plan,
      workspaceRef: canonicalWorkspace,
      ...(kernelInput === undefined ? {} : {
        authorityVectorDigest: kernelInput.authorityVectorDigest,
        effectId: kernelInput.effectId,
        hostBootId: this.#hostBootId,
        hostInstanceId: this.#hostInstanceId,
      }),
    };
    if ((plan.spawnMode ?? "eager") === "eager") {
      this.#spawn(live, { arguments: plan.arguments, environment: plan.environment });
    }
    this.#byAttempt.set(input.attemptId, live);
    this.#byRef.set(custodyRef, live);
    return kernelInput === undefined ? Object.freeze({ custodyRef }) : this.#kernelHandle(live, kernelInput);
  }

  public async requestContainment(input: {
    readonly attemptId: string;
    readonly custodyRef?: string;
    readonly operationId: string;
  }): Promise<HostContainmentOutcome> {
    const live = input.custodyRef === undefined ? this.#byAttempt.get(input.attemptId) : this.#byRef.get(input.custodyRef);
    if (live === undefined || live.attemptId !== input.attemptId || live.operationId !== input.operationId) {
      return { evidenceRef: `host-custody-missing:${input.attemptId}`, kind: "unproven" };
    }
    const containment = live.containment ?? this.#contain(live, input);
    live.containment = containment;
    try {
      const outcome = await containment;
      if (outcome.kind === "unproven" && live.containment === containment) {delete live.containment;}
      return outcome;
    } catch (error) {
      if (live.containment === containment) {delete live.containment;}
      throw error;
    }
  }

  async #contain(
    live: LiveCustody,
    input: Readonly<{ attemptId: string; custodyRef?: string; operationId: string }>,
  ): Promise<HostContainmentOutcome> {
    live.sealed = true;
    if (live.child === undefined || live.exit === undefined) {
      const receiptIdentity = JSON.stringify([
        input.operationId,
        input.attemptId,
        live.custodyRef,
        live.binaryDigest,
        live.plan.binaryRevision,
        live.plan.containmentProfile,
        live.plan.spawnMode,
        live.workspaceRef,
        "never-started",
      ]);
      return {
        kind: "contained",
        receiptRef: `urn:agent-runtime:host-never-started:${createHash("sha256").update(receiptIdentity).digest("hex")}`,
      };
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

  async #physicalClosure(
    input: Parameters<ContainedTurnKernelCustodyPort["ensurePhysicalContainment"]>[0],
    initiate: boolean,
  ): ReturnType<ContainedTurnKernelCustodyPort["ensurePhysicalContainment"]> {
    const live = this.#byRef.get(input.custodyId);
    if (live === undefined || live.attemptId !== input.attemptId || live.operationId !== input.operationId ||
        live.authorityVectorDigest !== input.authorityVectorDigest || live.effectId === undefined ||
        live.hostBootId === undefined || live.hostInstanceId === undefined) {
      return Object.freeze({
        evidenceId: containedTurnIdentity("evidence", `evidence:host-custody-identity:${digestContainedTurnCanonicalValue({ attemptId: input.attemptId, custodyId: input.custodyId, operationId: input.operationId })}`),
        kind: "identity_conflict" as const,
      });
    }
    if (!initiate && live.sealed !== true) {
      return Object.freeze({
        evidenceId: containedTurnIdentity("evidence", `evidence:host-custody-not-contained:${input.requestDigest}`),
        kind: "indeterminate" as const,
      });
    }
    const outcome = await this.requestContainment({ attemptId: input.attemptId, custodyRef: input.custodyId, operationId: input.operationId });
    if (outcome.kind !== "contained") {
      return Object.freeze({
        evidenceId: containedTurnIdentity("evidence", `evidence:host-custody-containment:${digestContainedTurnCanonicalValue({ evidenceRef: outcome.evidenceRef })}`),
        kind: "indeterminate" as const,
      });
    }
    return Object.freeze({
      kind: "proved" as const,
      proof: Object.freeze({
        binding: Object.freeze({
          attemptId: input.attemptId,
          authorityVectorDigest: input.authorityVectorDigest,
          custodyId: input.custodyId,
          effectId: live.effectId,
          hostBootId: live.hostBootId,
          hostInstanceId: live.hostInstanceId,
          operationId: input.operationId,
        }),
        kind: "physical_containment" as const,
        proofId: containedTurnIdentity("proof", `proof:physical-containment:${digestContainedTurnCanonicalValue({ receiptRef: outcome.receiptRef, requestDigest: input.requestDigest })}`),
      }),
      requestDigest: input.requestDigest,
      requestId: input.requestId,
    });
  }

  public ensurePhysicalContainment(input: Parameters<ContainedTurnKernelCustodyPort["ensurePhysicalContainment"]>[0]): ReturnType<ContainedTurnKernelCustodyPort["ensurePhysicalContainment"]> {
    return this.#physicalClosure(input, true);
  }

  public queryPhysicalContainment(input: Parameters<ContainedTurnKernelCustodyPort["queryPhysicalContainment"]>[0]): ReturnType<ContainedTurnKernelCustodyPort["queryPhysicalContainment"]> {
    return this.#physicalClosure(input, false);
  }

  async #compositeClosure(
    input: Parameters<ContainedTurnKernelCustodyPort["attestContainment"]>[0],
    initiate: boolean,
  ): ReturnType<ContainedTurnKernelCustodyPort["attestContainment"]> {
    const physical = await this.#physicalClosure(input, initiate);
    if (physical.kind !== "proved") {return physical;}
    if (input.binding.operationId !== input.operationId || input.binding.attemptId !== input.attemptId ||
        input.binding.custodyId !== input.custodyId || input.binding.authorityVectorDigest !== input.authorityVectorDigest ||
        input.binding.physicalContainmentProofId !== physical.proof.proofId) {
      return Object.freeze({
        evidenceId: containedTurnIdentity("evidence", `evidence:containment-binding-conflict:${input.requestDigest}`),
        kind: "identity_conflict" as const,
      });
    }
    return Object.freeze({
      kind: "proved" as const,
      proof: Object.freeze({
        binding: input.binding,
        kind: "containment" as const,
        proofId: containedTurnIdentity("proof", `proof:containment:${input.requestDigest}`),
      }),
      requestDigest: input.requestDigest,
      requestId: input.requestId,
    });
  }

  public attestContainment(input: Parameters<ContainedTurnKernelCustodyPort["attestContainment"]>[0]): ReturnType<ContainedTurnKernelCustodyPort["attestContainment"]> {
    return this.#compositeClosure(input, true);
  }

  public queryContainmentAttestation(input: Parameters<ContainedTurnKernelCustodyPort["queryContainmentAttestation"]>[0]): ReturnType<ContainedTurnKernelCustodyPort["queryContainmentAttestation"]> {
    return this.#compositeClosure(input, false);
  }

  public async releaseRetiredReservation(input: Parameters<ContainedTurnKernelCustodyPort["releaseRetiredReservation"]>[0]) {
    const live = this.#byRef.get(input.cleanupPermit.custodyId);
    if (live === undefined) {return Object.freeze({ kind: "already_released" as const });}
    const outcome = await this.requestContainment({
      attemptId: input.cleanupPermit.attemptId,
      custodyRef: input.cleanupPermit.custodyId,
      operationId: input.cleanupPermit.operationId,
    });
    return outcome.kind === "contained"
      ? Object.freeze({ kind: "released" as const })
      : Object.freeze({ evidenceId: containedTurnIdentity("evidence", `evidence:retired-custody:${digestContainedTurnCanonicalValue({ evidenceRef: outcome.evidenceRef })}`), kind: "indeterminate" as const });
  }
}
