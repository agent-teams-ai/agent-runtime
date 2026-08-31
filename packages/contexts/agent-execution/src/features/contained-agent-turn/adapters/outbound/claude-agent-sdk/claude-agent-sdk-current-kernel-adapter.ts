import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";

import type {
  ContainedTurnKernelProviderObservation,
  ContainedTurnKernelProviderPort,
} from "../../../application/ports/outbound/contained-turn-ports.js";
import type {
  ContainedTurnCapabilityManifest,
  ContainedTurnProviderAdapterSnapshot,
} from "../../../domain/contained-turn-authority.js";
import type { ContainedTurnCanonicalDigest } from "../../../domain/contained-turn-codecs.js";
import {
  containedTurnIdentity,
  type ContainedTurnAttemptId,
  type ContainedTurnCustodyId,
  type ContainedTurnEffectId,
  type ContainedTurnOperationId,
  type ContainedTurnWorkspaceId,
} from "../../../domain/contained-turn-identities.js";
import type {
  ContainedTurnProviderExecutionOutcome,
} from "../legacy/legacy-contained-turn-ports.js";
import type {
  CustodiedProviderProcessRegistry,
  CustodiedSdkProcessLauncher,
} from "../host-custody/custodied-provider-process.js";
import {
  ClaudeAgentSdkContainedTurnProvider,
  type ClaudeAgentSdkContainedTurnProviderOptions,
} from "./claude-agent-sdk-contained-turn-provider.js";
import type {
  ClaudeAgentSdkPrivateProjection,
} from "./claude-agent-sdk-launch-plan.js";

export interface ClaudeAgentSdkKernelPrivateExecution {
  readonly privateProjection: ClaudeAgentSdkPrivateProjection;
  readonly workspaceRef: string;
}

/**
 * Owner-private projection seam. WorkspaceId remains opaque: only the
 * workspace/Host composition owner can supply the raw canonical path and
 * private Claude configuration projection.
 */
export interface ClaudeAgentSdkKernelPrivateExecutionResolver {
  consume<Result>(input: Readonly<{
    attemptId: ContainedTurnAttemptId;
    authorityVectorDigest: ContainedTurnCanonicalDigest;
    custodyId: ContainedTurnCustodyId;
    effectId: ContainedTurnEffectId;
    operationId: ContainedTurnOperationId;
    workspaceId: ContainedTurnWorkspaceId;
  }>, execute: (execution: ClaudeAgentSdkKernelPrivateExecution) => Promise<Result>): Promise<Result | undefined>;
}

export interface ClaudeAgentSdkCurrentKernelAdapterOptions {
  readonly adapterSnapshot: ContainedTurnProviderAdapterSnapshot;
  readonly cancellationPollMs?: number;
  readonly clock?: ClaudeAgentSdkContainedTurnProviderOptions["clock"];
  readonly executablePath: string;
  readonly interruptGraceMs?: number;
  readonly manifest: ContainedTurnCapabilityManifest;
  readonly privateExecutions: ClaudeAgentSdkKernelPrivateExecutionResolver;
  /** The accepted Guardian-backed launcher; it performs the sole physical spawn. */
  readonly processes: CustodiedProviderProcessRegistry & CustodiedSdkProcessLauncher;
  readonly queryFactory?: ClaudeAgentSdkContainedTurnProviderOptions["queryFactory"];
  readonly turnTimeoutMs?: number;
}

const DEFAULT_TURN_TIMEOUT_MS = 1_200_000;
const defaultClock: NonNullable<ClaudeAgentSdkContainedTurnProviderOptions["clock"]> = Object.freeze({
  now: () => performance.now(),
  async wait(milliseconds: number, signal: AbortSignal) {
    await delay(milliseconds, undefined, { signal });
  },
});

const positiveTurnTimeout = (value: number | undefined): number => {
  const selected = value ?? DEFAULT_TURN_TIMEOUT_MS;
  if (!Number.isSafeInteger(selected) || selected <= 0) {
    throw new TypeError("turnTimeoutMs must be a positive integer");
  }
  return selected;
};

type StartObservationSettlement =
  | { readonly kind: "observed"; readonly value: Awaited<Parameters<ContainedTurnKernelProviderPort["execute"]>[0]["start"]["observation"]> }
  | { readonly kind: "rejected" }
  | { readonly kind: "timed_out" };

class CurrentKernelTurnDeadline {
  readonly #clock: NonNullable<ClaudeAgentSdkContainedTurnProviderOptions["clock"]>;
  readonly #deadline: number;
  #latest: number;

  public constructor(
    clock: NonNullable<ClaudeAgentSdkContainedTurnProviderOptions["clock"]>,
    timeoutMs: number,
  ) {
    this.#clock = clock;
    this.#latest = this.#read();
    this.#deadline = Math.min(Number.MAX_SAFE_INTEGER, this.#latest + timeoutMs);
  }

  public async observe(
    observation: Promise<StartObservationSettlement>,
  ): Promise<StartObservationSettlement> {
    if (this.#now() >= this.#deadline) {return { kind: "timed_out" };}
    const timerAbort = new AbortController();
    const timeout = this.#clock.wait(this.#deadline - this.#now(), timerAbort.signal).then<
      StartObservationSettlement,
      StartObservationSettlement
    >(
      () => ({ kind: "timed_out" }),
      () => timerAbort.signal.aborted
        ? new Promise<StartObservationSettlement>(() => {})
        : { kind: "timed_out" },
    );
    const settlement = await Promise.race([observation, timeout]);
    timerAbort.abort();
    if (settlement.kind === "observed" && this.#now() >= this.#deadline) {
      return { kind: "timed_out" };
    }
    return settlement;
  }

  #now(): number {
    this.#latest = Math.max(this.#latest, this.#read());
    return this.#latest;
  }

  #read(): number {
    const value = this.#clock.now();
    if (!Number.isFinite(value)) {throw new TypeError("Claude control clock must return a finite value");}
    return value;
  }
}

const indeterminate = (
  input: Parameters<ContainedTurnKernelProviderPort["execute"]>[0],
  reason: string,
): ContainedTurnKernelProviderObservation => {
  const digest = createHash("sha256").update(JSON.stringify([
    input.operationId,
    input.effectId,
    input.attemptId,
    input.custodyId,
    input.workspaceId,
    reason,
  ])).digest("hex");
  return Object.freeze({
    evidenceId: containedTurnIdentity("evidence", `evidence:claude-current-kernel:${digest}`),
    kind: "indeterminate" as const,
  });
};

/** Legacy receipt strings are intentionally discarded; they are not Host proofs. */
export const mapClaudeAgentSdkKernelObservation = (
  input: Parameters<ContainedTurnKernelProviderPort["execute"]>[0],
  outcome: ContainedTurnProviderExecutionOutcome,
): ContainedTurnKernelProviderObservation =>
  outcome.kind === "completed"
    ? Object.freeze({ kind: "completed" as const, outcome: outcome.outcome })
    : indeterminate(input, outcome.kind === "ambiguous" ? "sdk-ambiguous" : "sdk-not-accepted");

const sameAdapterSnapshot = (
  left: ContainedTurnProviderAdapterSnapshot,
  right: ContainedTurnProviderAdapterSnapshot,
): boolean =>
  left.adapterRevision === right.adapterRevision &&
  left.binaryRevision === right.binaryRevision &&
  left.capabilityManifestRevision === right.capabilityManifestRevision &&
  left.provider === right.provider;

export class ClaudeAgentSdkCurrentKernelAdapter implements ContainedTurnKernelProviderPort {
  public readonly adapterSnapshot: ContainedTurnProviderAdapterSnapshot;
  public readonly manifest: ContainedTurnCapabilityManifest;
  readonly #options: ClaudeAgentSdkCurrentKernelAdapterOptions;

  public constructor(options: ClaudeAgentSdkCurrentKernelAdapterOptions) {
    if (
      options.adapterSnapshot.provider !== "claude" ||
      options.manifest.provider !== "claude" ||
      options.manifest.manifestRevision !== options.adapterSnapshot.capabilityManifestRevision
    ) {
      throw new TypeError("Claude current-kernel adapter requires one exact Claude snapshot and manifest");
    }
    this.adapterSnapshot = Object.freeze({ ...options.adapterSnapshot });
    this.manifest = Object.freeze({
      ...options.manifest,
      requiredProofKinds: Object.freeze([...options.manifest.requiredProofKinds]) as typeof options.manifest.requiredProofKinds,
      supportedModes: Object.freeze([...options.manifest.supportedModes]),
    });
    positiveTurnTimeout(options.turnTimeoutMs);
    this.#options = Object.freeze({ ...options });
  }

  public async execute(
    input: Parameters<ContainedTurnKernelProviderPort["execute"]>[0],
  ): Promise<ContainedTurnKernelProviderObservation> {
    if (
      !sameAdapterSnapshot(input.adapterSnapshot, this.adapterSnapshot) ||
      input.providerAccessSnapshot.provider !== "claude" ||
      !this.manifest.supportedModes.includes(input.intent.mode)
    ) {
      return indeterminate(input, "authority-conflict");
    }

    let callbackCount = 0;
    let callbackResultPromise: Promise<ContainedTurnKernelProviderObservation> | undefined;
    let consumeSettled = false;
    try {
      const resolverResult = await this.#options.privateExecutions.consume({
        attemptId: input.attemptId,
        authorityVectorDigest: input.authorityVectorDigest,
        custodyId: input.custodyId,
        effectId: input.effectId,
        operationId: input.operationId,
        workspaceId: input.workspaceId,
      }, execution => {
        callbackCount += 1;
        if (consumeSettled || callbackCount !== 1) {
          throw new TypeError("Claude private execution callback must be consumed exactly once");
        }
        callbackResultPromise = this.#executeWithPrivateProjection(input, execution);
        return callbackResultPromise;
      });
      consumeSettled = true;
      if (callbackCount !== 1 || callbackResultPromise === undefined) {
        return indeterminate(input, "private-projection-absent");
      }
      const callbackResult = await callbackResultPromise;
      return resolverResult === callbackResult
        ? callbackResult
        : indeterminate(input, "private-projection-result-conflict");
    } catch {
      consumeSettled = true;
      return indeterminate(input, "private-projection-unknown");
    }
  }

  async #executeWithPrivateProjection(
    input: Parameters<ContainedTurnKernelProviderPort["execute"]>[0],
    execution: ClaudeAgentSdkKernelPrivateExecution,
  ): Promise<ContainedTurnKernelProviderObservation> {
    const clock = this.#options.clock ?? defaultClock;
    const turnTimeoutMs = positiveTurnTimeout(this.#options.turnTimeoutMs);
    const turnDeadline = new CurrentKernelTurnDeadline(clock, turnTimeoutMs);
    const pendingStartObservation = input.start.observation.then<
      StartObservationSettlement,
      StartObservationSettlement
    >(
      value => ({ kind: "observed", value }),
      () => ({ kind: "rejected" }),
    );
    let delegatedSpawns = 0;
    const processes: CustodiedProviderProcessRegistry & CustodiedSdkProcessLauncher = {
      get: custodyRef => this.#options.processes.get(custodyRef),
      start: (custodyRef, launch) => {
        delegatedSpawns += 1;
        if (delegatedSpawns !== 1) {
          throw new TypeError("Claude SDK may request exactly one Host-delegated spawn");
        }
        return input.start.createProcess(() => this.#options.processes.start(custodyRef, launch));
      },
    };
    const provider = new ClaudeAgentSdkContainedTurnProvider({
      ...(this.#options.cancellationPollMs === undefined ? {} : { cancellationPollMs: this.#options.cancellationPollMs }),
      clock,
      executablePath: this.#options.executablePath,
      ...(this.#options.interruptGraceMs === undefined ? {} : { interruptGraceMs: this.#options.interruptGraceMs }),
      manifest: {
        effectClass: this.manifest.effectClass,
        providerBinding: {
          ...this.adapterSnapshot,
          credentialBindingDigest: input.providerAccessSnapshot.credentialBindingDigest,
          providerRouteRef: input.providerAccessSnapshot.providerRouteRef,
        },
        supportedModes: this.manifest.supportedModes,
      },
      privateProjections: {
        resolve: () => execution.privateProjection,
      },
      processes,
      ...(this.#options.queryFactory === undefined ? {} : { queryFactory: this.#options.queryFactory }),
      turnTimeoutMs,
    });
    const outcome = await provider.execute({
      attemptId: input.attemptId,
      custody: { custodyRef: input.custodyId },
      effectId: input.effectId,
      emit: input.emit,
      intent: input.intent,
      isCancellationRequested: input.isCancellationRequested,
      operationId: input.operationId,
      workspaceRef: execution.workspaceRef,
    });
    if (delegatedSpawns !== 1) {
      return indeterminate(input, delegatedSpawns === 0 ? "sdk-spawn-absent" : "sdk-spawn-conflict");
    }
    const startSettlement = await turnDeadline.observe(pendingStartObservation);
    if (startSettlement.kind !== "observed") {
      return indeterminate(input, `host-start-${startSettlement.kind}`);
    }
    const startObservation = startSettlement.value;
    if (startObservation.kind !== "execution_started") {
      return indeterminate(input, `host-start-${startObservation.kind}`);
    }
    if (startObservation.proof.kind !== "provider_process_start") {
      return indeterminate(input, "host-start-proof-conflict");
    }
    const binding = startObservation.proof.binding;
    if (
      binding.operationId !== input.operationId ||
      binding.attemptId !== input.attemptId ||
      binding.effectId !== input.effectId ||
      binding.custodyId !== input.custodyId ||
      binding.authorityVectorDigest !== input.authorityVectorDigest
    ) {
      return indeterminate(input, "host-start-identity-conflict");
    }
    return mapClaudeAgentSdkKernelObservation(input, outcome);
  }
}
