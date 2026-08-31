import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";

import type {
  ContainedTurnAdapterCapabilityManifest,
  ContainedTurnProviderExecutionOutcome,
  ContainedTurnProviderPort,
} from "../legacy/legacy-contained-turn-ports.js";
import {
  claudeAgentSdkTools,
  isClaudeAgentSdkPrivateProjectionUsable,
  type ClaudeAgentSdkPrivateProjection,
  type ClaudeAgentSdkPrivateProjectionResolver,
} from "./claude-agent-sdk-launch-plan.js";
import {
  claudeResultDiagnostic,
  normalizeClaudeSdkMessage,
  type ClaudeSdkResultMessage,
} from "./claude-agent-sdk-messages.js";
import type {
  CustodiedProviderProcessRegistry,
  CustodiedSdkProcessLauncher,
} from "../host-custody/custodied-provider-process.js";

const DEFAULT_CANCELLATION_POLL_MS = 100;
const DEFAULT_INTERRUPT_GRACE_MS = 5_000;
const DEFAULT_TURN_TIMEOUT_MS = 1_200_000;
const CLAUDE_AGENT_SDK_PACKAGE: string = "@anthropic-ai/claude-agent-sdk";

interface ClaudeSdkSpawnOptions {
  readonly args: string[];
  readonly command: string;
  readonly cwd?: string;
  readonly env: Record<string, string | undefined>;
  readonly signal: AbortSignal;
}

interface ClaudeSdkQuery extends AsyncIterable<unknown> {
  close(): void;
  interrupt(): Promise<unknown>;
}

interface ClaudeSdkQueryInput {
  readonly options: {
    readonly abortController: AbortController;
    readonly allowedTools: string[];
    readonly cwd: string;
    readonly disallowedTools: string[];
    readonly env: Readonly<Record<string, string>>;
    readonly includePartialMessages: boolean;
    readonly maxTurns: number;
    readonly mcpServers: Record<string, never>;
    readonly pathToClaudeCodeExecutable: string;
    readonly permissionMode: "dontAsk";
    readonly persistSession: false;
    readonly plugins: readonly never[];
    readonly sandbox: {
      readonly allowUnsandboxedCommands: false;
      readonly enabled: true;
      readonly failIfUnavailable: true;
      readonly filesystem: { readonly allowRead: string[]; readonly allowWrite: string[] };
    };
    readonly settingSources: readonly never[];
    readonly spawnClaudeCodeProcess: (options: ClaudeSdkSpawnOptions) => unknown;
    readonly strictMcpConfig: true;
    readonly tools: string[];
  };
  readonly prompt: string;
}

type ClaudeQueryFactory = (input: ClaudeSdkQueryInput) => ClaudeSdkQuery;

export interface ClaudeAgentSdkControlClock {
  now(): number;
  wait(milliseconds: number, signal: AbortSignal): Promise<void>;
}

const defaultClock: ClaudeAgentSdkControlClock = Object.freeze({
  now: () => performance.now(),
  async wait(milliseconds: number, signal: AbortSignal) {
    await delay(milliseconds, undefined, { signal });
  },
});

type ObservedSettlement<T> =
  | { readonly kind: "fulfilled"; readonly value: T }
  | { readonly error: unknown; readonly kind: "rejected" };

type BoundedSettlement<T> =
  | ObservedSettlement<T>
  | { readonly kind: "abandoned" }
  | { readonly kind: "timed_out" };

const observeCall = <T>(call: () => T | PromiseLike<T>): Promise<ObservedSettlement<T>> => {
  let started: T | PromiseLike<T>;
  try {
    started = call();
  } catch (error) {
    return Promise.resolve({ error, kind: "rejected" });
  }
  return Promise.resolve(started).then<ObservedSettlement<T>, ObservedSettlement<T>>(
    value => ({ kind: "fulfilled", value }),
    error => ({ error, kind: "rejected" }),
  );
};

class OperationDeadlineClock {
  readonly #clock: ClaudeAgentSdkControlClock;
  #latest: number;

  public constructor(clock: ClaudeAgentSdkControlClock) {
    this.#clock = clock;
    this.#latest = this.#read();
  }

  public add(deadline: number, milliseconds: number): number {
    return Math.min(Number.MAX_SAFE_INTEGER, deadline + milliseconds);
  }

  public deadlineAfter(milliseconds: number): number {
    return this.add(this.now(), milliseconds);
  }

  public now(): number {
    this.#latest = Math.max(this.#latest, this.#read());
    return this.#latest;
  }

  public async pauseUntil(deadline: number, signal: AbortSignal): Promise<"abandoned" | "elapsed"> {
    if (signal.aborted) {return "abandoned";}
    try {
      await this.#waitUntil(deadline, signal);
      return signal.aborted ? "abandoned" : "elapsed";
    } catch {
      return signal.aborted ? "abandoned" : "elapsed";
    }
  }

  public async settle<T>(
    observed: Promise<ObservedSettlement<T>>,
    deadline: number,
    abandonSignal?: AbortSignal,
  ): Promise<BoundedSettlement<T>> {
    const abandoned = (): boolean => abandonSignal?.aborted === true;
    if (abandoned()) {return { kind: "abandoned" };}
    if (this.now() >= deadline) {return { kind: "timed_out" };}
    const timerAbort = new AbortController();
    const timeout = this.#waitUntil(deadline, timerAbort.signal).then<BoundedSettlement<T>, BoundedSettlement<T>>(
      () => ({ kind: "timed_out" }),
      () => timerAbort.signal.aborted
        ? new Promise<BoundedSettlement<T>>(() => {})
        : { kind: "timed_out" },
    );
    let abandonListener: (() => void) | undefined;
    const candidates: Promise<BoundedSettlement<T>>[] = [observed, timeout];
    if (abandonSignal !== undefined) {
      candidates.push(new Promise(resolve => {
        abandonListener = () => resolve({ kind: "abandoned" });
        abandonSignal.addEventListener("abort", abandonListener, { once: true });
      }));
    }
    const outcome = await Promise.race(candidates);
    timerAbort.abort();
    if (abandonSignal !== undefined && abandonListener !== undefined) {
      abandonSignal.removeEventListener("abort", abandonListener);
    }
    if (abandoned()) {return { kind: "abandoned" };}
    if (outcome.kind === "fulfilled" && this.now() >= deadline) {return { kind: "timed_out" };}
    return outcome;
  }

  public settleCall<T>(
    call: () => T | PromiseLike<T>,
    deadline: number,
    abandonSignal?: AbortSignal,
  ): Promise<BoundedSettlement<T>> {
    if (abandonSignal?.aborted === true) {return Promise.resolve<BoundedSettlement<T>>({ kind: "abandoned" });}
    if (this.now() >= deadline) {return Promise.resolve<BoundedSettlement<T>>({ kind: "timed_out" });}
    return this.settle(observeCall(call), deadline, abandonSignal);
  }

  readonly #read = (): number => {
    const observed = this.#clock.now();
    if (!Number.isFinite(observed)) {throw new TypeError("Claude control clock must return a finite value");}
    return observed;
  };

  async #waitUntil(deadline: number, signal: AbortSignal): Promise<void> {
    const started = this.now();
    const duration = Math.max(0, deadline - started);
    try {
      if (duration > 0) {await this.#clock.wait(duration, signal);}
    } catch (error) {
      if (!signal.aborted) {this.#latest = Math.max(this.#latest, deadline);}
      throw error;
    }
    if (!signal.aborted) {
      this.#latest = Math.max(this.#latest, started + duration, this.#read());
    }
  }
}

const loadClaudeQueryFactory = async (): Promise<ClaudeQueryFactory> => {
  const loaded: unknown = await import(CLAUDE_AGENT_SDK_PACKAGE);
  if (typeof loaded !== "object" || loaded === null || !("query" in loaded) || typeof loaded.query !== "function") {
    throw new Error("Claude Agent SDK query export is unavailable");
  }
  return loaded.query as ClaudeQueryFactory;
};

export interface ClaudeAgentSdkContainedTurnProviderOptions {
  readonly cancellationPollMs?: number;
  readonly clock?: ClaudeAgentSdkControlClock;
  readonly executablePath: string;
  readonly interruptGraceMs?: number;
  readonly manifest: ContainedTurnAdapterCapabilityManifest;
  readonly privateProjections: ClaudeAgentSdkPrivateProjectionResolver;
  readonly processes: CustodiedProviderProcessRegistry & CustodiedSdkProcessLauncher;
  readonly queryFactory?: ClaudeQueryFactory;
  readonly turnTimeoutMs?: number;
}

interface ControlState {
  interruptionFailed: boolean;
  interruptObserved: boolean;
  timedOut: boolean;
}

const positiveInteger = (name: string, value: number | undefined, fallback: number): number => {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected <= 0) {throw new TypeError(`${name} must be a positive integer`);}
  return selected;
};

const receipt = (kind: string, values: readonly unknown[]): string =>
  `urn:agent-runtime:${kind}:${createHash("sha256").update(JSON.stringify(values)).digest("hex")}`;

const notAccepted = (input: Parameters<ContainedTurnProviderPort["execute"]>[0], reason: string): ContainedTurnProviderExecutionOutcome => {
  const identity = [input.operationId, input.effectId, input.attemptId, reason] as const;
  return {
    effectReceiptRef: receipt("claude-effect-not-committed", identity),
    executionReceiptRef: receipt("claude-execution-not-started", identity),
    kind: "not_accepted",
    outputDrainReceiptRef: receipt("claude-output-not-started", identity),
    providerReceiptRef: receipt("claude-provider-not-accepted", identity),
  };
};

const ambiguous = (input: Parameters<ContainedTurnProviderPort["execute"]>[0], reason: string): ContainedTurnProviderExecutionOutcome => ({
  evidenceRef: receipt("claude-provider-ambiguous", [input.operationId, input.effectId, input.attemptId, reason]),
  kind: "ambiguous",
});

const completed = (input: {
  readonly adapterRevision: string;
  readonly attemptId: string;
  readonly binaryRevision: string;
  readonly control: ControlState;
  readonly cursor: number;
  readonly effectId: string;
  readonly operationId: string;
  readonly projectionRef: string;
  readonly result: ClaudeSdkResultMessage;
}): ContainedTurnProviderExecutionOutcome => {
  const outcome = input.result.subtype === "success" && !input.result.is_error ? "succeeded" : "failed";
  const identity = [
    input.operationId, input.effectId, input.attemptId, input.result.session_id, input.result.uuid,
    input.result.subtype, input.result.is_error, input.cursor, input.control.interruptObserved,
    input.control.timedOut, input.adapterRevision, input.binaryRevision, input.projectionRef,
  ] as const;
  return {
    acceptanceReceiptRef: receipt("claude-provider-accepted", identity),
    effectDisposition: "committed",
    effectReceiptRef: receipt("claude-effect-resolved", identity),
    executionReceiptRef: receipt("claude-execution-closed", identity),
    kind: "completed",
    outcome,
    // This evidence is deliberately limited to the SDK iterator. Host Custody
    // must replace it with its provider-neutral stdout/stderr closure receipt.
    outputDrainReceiptRef: receipt("claude-sdk-iterator-drained", identity),
  };
};

const disallowedTools = (mode: "analysis" | "workspace-write"): readonly string[] =>
  mode === "analysis"
    ? ["Task", "Bash", "Edit", "Write", "NotebookEdit", "WebFetch", "WebSearch"]
    : ["Task", "Bash", "NotebookEdit", "WebFetch", "WebSearch"];

const sdkSandbox = (mode: "analysis" | "workspace-write", workspaceRef: string): ClaudeSdkQueryInput["options"]["sandbox"] => ({
  enabled: true,
  failIfUnavailable: true,
  allowUnsandboxedCommands: false,
  filesystem: { allowRead: [workspaceRef], allowWrite: mode === "analysis" ? [] : [workspaceRef] },
});

export class ClaudeAgentSdkContainedTurnProvider implements ContainedTurnProviderPort {
  public readonly manifest: ContainedTurnAdapterCapabilityManifest;
  readonly #cancellationPollMs: number;
  readonly #clock: ClaudeAgentSdkControlClock;
  readonly #executablePath: string;
  readonly #interruptGraceMs: number;
  readonly #privateProjections: ClaudeAgentSdkPrivateProjectionResolver;
  readonly #processes: CustodiedProviderProcessRegistry & CustodiedSdkProcessLauncher;
  readonly #queryFactory: ClaudeQueryFactory | undefined;
  readonly #turnTimeoutMs: number;

  public constructor(options: ClaudeAgentSdkContainedTurnProviderOptions) {
    if (options.manifest.providerBinding.provider !== "claude") {
      throw new Error("Claude Agent SDK adapter requires a Claude provider binding");
    }
    this.manifest = Object.freeze({
      effectClass: options.manifest.effectClass,
      providerBinding: Object.freeze({ ...options.manifest.providerBinding }),
      supportedModes: Object.freeze([...options.manifest.supportedModes]),
    });
    this.#cancellationPollMs = positiveInteger("cancellationPollMs", options.cancellationPollMs, DEFAULT_CANCELLATION_POLL_MS);
    this.#clock = options.clock ?? defaultClock;
    this.#executablePath = options.executablePath;
    this.#interruptGraceMs = positiveInteger("interruptGraceMs", options.interruptGraceMs, DEFAULT_INTERRUPT_GRACE_MS);
    this.#privateProjections = options.privateProjections;
    this.#processes = options.processes;
    this.#queryFactory = options.queryFactory;
    this.#turnTimeoutMs = positiveInteger("turnTimeoutMs", options.turnTimeoutMs, DEFAULT_TURN_TIMEOUT_MS);
  }

  public async execute(input: Parameters<ContainedTurnProviderPort["execute"]>[0]): Promise<ContainedTurnProviderExecutionOutcome> {
    if (!this.manifest.supportedModes.includes(input.intent.mode)) {return notAccepted(input, "mode-unsupported");}
    const deadlineClock = new OperationDeadlineClock(this.#clock);
    const turnDeadline = deadlineClock.deadlineAfter(this.#turnTimeoutMs);
    let resolvedPrivateProjection: ClaudeAgentSdkPrivateProjection | undefined;
    try {
      resolvedPrivateProjection = this.#privateProjections.resolve({
        custodyRef: input.custody.custodyRef,
        workspaceRef: input.workspaceRef,
      });
    } catch {
      return notAccepted(input, "private-projection-unavailable");
    }
    if (resolvedPrivateProjection === undefined) {return notAccepted(input, "private-projection-unavailable");}
    const privateProjection = resolvedPrivateProjection;
    const projectionUsable = await deadlineClock.settleCall(
      () => isClaudeAgentSdkPrivateProjectionUsable(privateProjection, input.workspaceRef),
      turnDeadline,
    );
    if (projectionUsable.kind !== "fulfilled" || !projectionUsable.value) {
      return notAccepted(input, "private-projection-unavailable");
    }
    const abortController = new AbortController();
    const control: ControlState = { interruptionFailed: false, interruptObserved: false, timedOut: false };
    const tools = [...claudeAgentSdkTools(input.intent.mode)];
    let queryHandle: ClaudeSdkQuery;
    try {
      let queryFactory = this.#queryFactory;
      if (queryFactory === undefined) {
        const loaded = await deadlineClock.settleCall(loadClaudeQueryFactory, turnDeadline);
        if (loaded.kind !== "fulfilled") {return notAccepted(input, "sdk-query-unavailable");}
        queryFactory = loaded.value;
      }
      queryHandle = queryFactory({
        prompt: input.intent.prompt,
        options: {
          abortController,
          allowedTools: tools,
          cwd: input.workspaceRef,
          disallowedTools: [...disallowedTools(input.intent.mode)],
          env: privateProjection.environment,
          includePartialMessages: true,
          maxTurns: 1,
          mcpServers: {},
          pathToClaudeCodeExecutable: this.#executablePath,
          permissionMode: "dontAsk",
          persistSession: false,
          plugins: [],
          sandbox: sdkSandbox(input.intent.mode, input.workspaceRef),
          settingSources: [],
          spawnClaudeCodeProcess: options => this.#processes.start(input.custody.custodyRef, {
            arguments: options.args, command: options.command, cwd: options.cwd,
            environment: options.env, signal: options.signal,
          }),
          strictMcpConfig: true,
          tools,
        },
      });
    } catch {
      // A missing registry entry is not exact proof that delegated spawn did
      // not race. The provider-neutral observed-start seam belongs to custody.
      return ambiguous(input, "sdk-query-start-ambiguous");
    }

    let cursor = 0;
    let result: ClaudeSdkResultMessage | undefined;
    let streamed = false;
    let streamSettled = false;
    let streamSettledAt: number | undefined;
    let streamFailure: unknown;
    let admissionOpen = true;
    let outputWaitFailed = false;
    const outputAbort = new AbortController();
    const closeAdmission = (): void => {
      admissionOpen = false;
      outputAbort.abort();
    };
    const emit = async (kind: "assistant" | "diagnostic", text: string): Promise<void> => {
      if (!admissionOpen) {throw new Error("CLAUDE_OUTPUT_ADMISSION_CLOSED");}
      const admittedCursor = cursor;
      const emitted = await deadlineClock.settleCall(
        () => input.emit({ cursor: admittedCursor, kind, text }),
        turnDeadline,
        outputAbort.signal,
      );
      if (emitted.kind !== "fulfilled" || !admissionOpen || admittedCursor !== cursor) {
        outputWaitFailed = true;
        if (emitted.kind === "timed_out") {control.timedOut = true;}
        closeAdmission();
        throw new Error("CLAUDE_OUTPUT_ADMISSION_UNPROVEN");
      }
      cursor += 1;
    };
    const consumePromise = (async () => {
      try {
        for await (const message of queryHandle) {
          if (result !== undefined) {throw new Error("CLAUDE_POST_RESULT_MESSAGE");}
          const normalized = normalizeClaudeSdkMessage(message);
          if (normalized.kind === "malformed") {throw new Error("CLAUDE_MALFORMED_SDK_MESSAGE");}
          if (normalized.kind === "assistant_text" && normalized.text.length > 0) {
            if (!admissionOpen) {throw new Error("CLAUDE_OUTPUT_ADMISSION_CLOSED");}
            await emit("assistant", normalized.text);
            streamed = true;
          }
          if (normalized.kind === "result") {result = normalized.result;}
        }
      } catch (error) {
        streamFailure = error;
      } finally {
        streamSettled = true;
        streamSettledAt = deadlineClock.now();
      }
    })();

    const controlAbort = new AbortController();
    type ControlOutcome =
      | { readonly kind: "dismissed" }
      | { readonly kind: "stop"; readonly reason: "cancellation" | "lookup_failed" | "turn_timeout" };
    const controlPromise = (async (): Promise<ControlOutcome> => {
      for (;;) {
        if (streamSettled || controlAbort.signal.aborted) {return { kind: "dismissed" };}
        if (deadlineClock.now() >= turnDeadline) {return { kind: "stop", reason: "turn_timeout" };}
        const pollDeadline = Math.min(turnDeadline, deadlineClock.deadlineAfter(this.#cancellationPollMs));
        if (await deadlineClock.pauseUntil(pollDeadline, controlAbort.signal) === "abandoned") {
          return { kind: "dismissed" };
        }
        if (streamSettled || controlAbort.signal.aborted) {return { kind: "dismissed" };}
        if (deadlineClock.now() >= turnDeadline) {return { kind: "stop", reason: "turn_timeout" };}
        const cancellationRequested = await deadlineClock.settleCall(
          input.isCancellationRequested,
          turnDeadline,
          controlAbort.signal,
        );
        if (cancellationRequested.kind === "abandoned") {return { kind: "dismissed" };}
        if (cancellationRequested.kind === "timed_out" || deadlineClock.now() >= turnDeadline) {
          return { kind: "stop", reason: "turn_timeout" };
        }
        if (cancellationRequested.kind === "rejected") {return { kind: "stop", reason: "lookup_failed" };}
        if (cancellationRequested.value) {return { kind: "stop", reason: "cancellation" };}
      }
    })();

    const first = await Promise.race([
      consumePromise.then(() => ({ kind: "stream" as const })),
      controlPromise.then(outcome => ({ kind: "control" as const, outcome })),
    ]);
    const streamMissedTurnDeadline = streamSettledAt === undefined || streamSettledAt >= turnDeadline;
    const stopRequested = first.kind === "control" && first.outcome.kind === "stop";
    let shutdownFailure = false;
    if (stopRequested || streamMissedTurnDeadline) {
      const stopReason = first.kind === "control" && first.outcome.kind === "stop"
        ? first.outcome.reason
        : "turn_timeout";
      control.timedOut = stopReason === "turn_timeout" || control.timedOut;
      control.interruptionFailed = stopReason === "lookup_failed" || control.interruptionFailed;
      closeAdmission();
      const escalationDeadline = deadlineClock.deadlineAfter(this.#interruptGraceMs);
      const stopDeadline = deadlineClock.add(escalationDeadline, this.#interruptGraceMs);
      const interruptObservation = deadlineClock.settleCall(
        () => queryHandle.interrupt(),
        escalationDeadline,
      );
      const stopPhaseAbort = new AbortController();
      const stopPhase = await Promise.race([
        interruptObservation.then(observation => ({ kind: "interrupt" as const, observation })),
        consumePromise.then(() => ({ kind: "stream" as const })),
        deadlineClock.pauseUntil(escalationDeadline, stopPhaseAbort.signal).then(() => ({ kind: "escalate" as const })),
      ]);
      stopPhaseAbort.abort();
      if (stopPhase.kind === "interrupt") {
        if (stopPhase.observation.kind === "fulfilled") {
          control.interruptObserved = true;
          if (!streamSettled) {await deadlineClock.settle(observeCall(() => consumePromise), escalationDeadline);}
        } else {
          control.interruptionFailed = true;
        }
      }
      if (!streamSettled) {
        if (stopPhase.kind !== "stream" && !control.interruptObserved) {control.interruptionFailed = true;}
        abortController.abort();
      }
      const closeOutcomePromise = deadlineClock.settleCall(() => queryHandle.close(), stopDeadline);
      controlAbort.abort();
      const [closeOutcome, consumeOutcome, controlOutcome] = await Promise.all([
        closeOutcomePromise,
        streamSettled
          ? Promise.resolve<BoundedSettlement<void>>({ kind: "fulfilled", value: undefined })
          : deadlineClock.settle(observeCall(() => consumePromise), stopDeadline),
        deadlineClock.settle(observeCall(() => controlPromise), stopDeadline),
      ]);
      shutdownFailure = closeOutcome.kind !== "fulfilled" || consumeOutcome.kind !== "fulfilled" || controlOutcome.kind !== "fulfilled";
    } else {
      const closeDeadline = deadlineClock.add(
        deadlineClock.deadlineAfter(this.#interruptGraceMs),
        this.#interruptGraceMs,
      );
      const closeOutcomePromise = deadlineClock.settleCall(() => queryHandle.close(), closeDeadline);
      controlAbort.abort();
      const [closeOutcome, controlOutcome] = await Promise.all([
        closeOutcomePromise,
        deadlineClock.settle(observeCall(() => controlPromise), closeDeadline),
      ]);
      shutdownFailure = closeOutcome.kind !== "fulfilled" || controlOutcome.kind !== "fulfilled";
    }

    if (streamFailure !== undefined || outputWaitFailed || control.interruptionFailed || control.timedOut || shutdownFailure) {
      closeAdmission();
      return ambiguous(input, "sdk-stream-or-shutdown-unproven");
    }
    if (result === undefined) {
      closeAdmission();
      return ambiguous(input, "sdk-terminal-result-missing");
    }
    if (admissionOpen && !streamed && result.subtype === "success" && !result.is_error && result.result.length > 0) {
      try {
        await emit("assistant", result.result);
      } catch {
        closeAdmission();
        return ambiguous(input, "sdk-output-admission-unproven");
      }
    }
    const diagnostic = claudeResultDiagnostic(result);
    if (admissionOpen && diagnostic !== undefined) {
      try {
        await emit("diagnostic", diagnostic);
      } catch {
        closeAdmission();
        return ambiguous(input, "sdk-output-admission-unproven");
      }
    }
    closeAdmission();
    return completed({
      adapterRevision: this.manifest.providerBinding.adapterRevision,
      attemptId: input.attemptId,
      binaryRevision: this.manifest.providerBinding.binaryRevision,
      control,
      cursor,
      effectId: input.effectId,
      operationId: input.operationId,
      projectionRef: privateProjection.projectionRef,
      result,
    });
  }
}
