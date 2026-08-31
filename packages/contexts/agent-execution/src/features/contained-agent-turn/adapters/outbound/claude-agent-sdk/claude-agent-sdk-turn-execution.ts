import { createHash } from "node:crypto";

import type {
  ContainedTurnProviderExecutionOutcome,
  ContainedTurnProviderPort,
} from "../legacy/legacy-contained-turn-ports.js";
import type { PrivateDirectoryCustodyPort } from "../host-custody/custodied-provider-process.js";
import {
  claudeResultDiagnostic,
  normalizeClaudeSdkMessage,
  type ClaudeSdkResultMessage,
} from "./claude-agent-sdk-messages.js";
import {
  isClaudeAgentSdkPrivateProjectionUsable,
  type ClaudeAgentSdkPrivateProjection,
} from "./claude-agent-sdk-launch-plan.js";
import type {
  ClaudeQueryFactory,
  ClaudeSdkQuery,
} from "./claude-agent-sdk-query-contracts.js";
export interface ClaudeAgentSdkControlClock {
  now(): number;
  wait(milliseconds: number, signal: AbortSignal): Promise<void>;
}
type ProviderInput = Parameters<ContainedTurnProviderPort["execute"]>[0];
type ObservedSettlement<T> =
  | { readonly kind: "fulfilled"; readonly value: T }
  | { readonly error: unknown; readonly kind: "rejected" };
type BoundedSettlement<T> =
  | ObservedSettlement<T>
  | { readonly kind: "abandoned" }
  | { readonly kind: "timed_out" };
type ControlOutcome =
  | { readonly kind: "dismissed" }
  | { readonly kind: "stop"; readonly reason: "cancellation" | "lookup_failed" | "turn_timeout" };
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
    if (signal.aborted) {
      return "abandoned";
    }
    try {
      await this.#waitUntil(deadline, signal);
    } catch {
      return signal.aborted ? "abandoned" : "elapsed";
    }
    return signal.aborted ? "abandoned" : "elapsed";
  }
  public async settle<T>(
    observed: Promise<ObservedSettlement<T>>,
    deadline: number,
    abandonSignal?: AbortSignal,
  ): Promise<BoundedSettlement<T>> {
    const abandoned = (): boolean => abandonSignal?.aborted === true;
    if (abandoned()) {
      return { kind: "abandoned" };
    }
    if (this.now() >= deadline) {
      return { kind: "timed_out" };
    }
    const timerAbort = new AbortController();
    const timeout = this.#timeout(deadline, timerAbort.signal);
    const abandonment = this.#abandonment(abandonSignal);
    const outcome = await Promise.race(abandonment === undefined
      ? [observed, timeout]
      : [observed, timeout, abandonment.promise]);
    timerAbort.abort();
    abandonment?.remove();
    if (abandoned()) {
      return { kind: "abandoned" };
    }
    if (outcome.kind === "fulfilled" && this.now() >= deadline) {
      return { kind: "timed_out" };
    }
    return outcome;
  }
  public settleCall<T>(
    call: () => T | PromiseLike<T>,
    deadline: number,
    abandonSignal?: AbortSignal,
  ): Promise<BoundedSettlement<T>> {
    if (abandonSignal?.aborted === true) {
      return Promise.resolve({ kind: "abandoned" });
    }
    if (this.now() >= deadline) {
      return Promise.resolve({ kind: "timed_out" });
    }
    return this.settle(observeCall(call), deadline, abandonSignal);
  }
  #abandonment(signal?: AbortSignal): { promise: Promise<BoundedSettlement<never>>; remove(): void } | undefined {
    if (signal === undefined) {
      return undefined;
    }
    let listener: (() => void) | undefined;
    const promise = new Promise<BoundedSettlement<never>>(resolve => {
      listener = () => resolve({ kind: "abandoned" });
      signal.addEventListener("abort", listener, { once: true });
    });
    return {
      promise,
      remove: () => {
        if (listener !== undefined) {
          signal.removeEventListener("abort", listener);
        }
      },
    };
  }
  readonly #read = (): number => {
    const observed = this.#clock.now();
    if (!Number.isFinite(observed)) {
      throw new TypeError("Claude control clock must return a finite value");
    }
    return observed;
  };
  async #timeout(deadline: number, signal: AbortSignal): Promise<BoundedSettlement<never>> {
    try {
      await this.#waitUntil(deadline, signal);
    } catch {
      if (signal.aborted) {
        return new Promise<BoundedSettlement<never>>(() => {});
      }
    }
    return { kind: "timed_out" };
  }
  async #waitUntil(deadline: number, signal: AbortSignal): Promise<void> {
    const started = this.now();
    const duration = Math.max(0, deadline - started);
    try {
      if (duration > 0) {
        await this.#clock.wait(duration, signal);
      }
    } catch (error) {
      if (!signal.aborted) {
        this.#latest = Math.max(this.#latest, deadline);
      }
      throw error;
    }
    if (!signal.aborted) {
      this.#latest = Math.max(this.#latest, started + duration, this.#read());
    }
  }
}
const receipt = (kind: string, values: readonly unknown[]): string =>
  `urn:agent-runtime:${kind}:${createHash("sha256").update(JSON.stringify(values)).digest("hex")}`;
export const claudeNotAccepted = (input: ProviderInput, reason: string): ContainedTurnProviderExecutionOutcome => {
  const identity = [input.operationId, input.effectId, input.attemptId, reason] as const;
  return {
    effectReceiptRef: receipt("claude-effect-not-committed", identity),
    executionReceiptRef: receipt("claude-execution-not-started", identity),
    kind: "not_accepted",
    outputDrainReceiptRef: receipt("claude-output-not-started", identity),
    providerReceiptRef: receipt("claude-provider-not-accepted", identity),
  };
};
const ambiguous = (input: ProviderInput, reason: string): ContainedTurnProviderExecutionOutcome => ({
  evidenceRef: receipt("claude-provider-ambiguous", [input.operationId, input.effectId, input.attemptId, reason]),
  kind: "ambiguous",
});
interface TurnExecutionOptions {
  readonly adapterRevision: string;
  readonly binaryRevision: string;
  readonly cancellationPollMs: number;
  readonly clock: ClaudeAgentSdkControlClock;
  readonly input: ProviderInput;
  readonly interruptGraceMs: number;
  readonly privateDirectoryCustody: PrivateDirectoryCustodyPort;
  readonly turnTimeoutMs: number;
}

interface QueryComposition {
  loadQueryFactory(): ClaudeQueryFactory | PromiseLike<ClaudeQueryFactory>;
  resolveProjection(): ClaudeAgentSdkPrivateProjection | undefined;
  startQuery(
    factory: ClaudeQueryFactory,
    abortController: AbortController,
    projection: ClaudeAgentSdkPrivateProjection,
  ): ClaudeSdkQuery;
}

export class ClaudeAgentSdkTurnExecution {
  readonly #clock: OperationDeadlineClock;
  readonly #control = { interruptionFailed: false, interruptObserved: false, timedOut: false };
  readonly #input: ProviderInput;
  readonly #options: TurnExecutionOptions;
  readonly #outputAbort = new AbortController();
  readonly #turnDeadline: number;
  #admissionOpen = true;
  #cursor = 0;
  #outputWaitFailed = false;
  #projectionRef = "";
  #result: ClaudeSdkResultMessage | undefined;
  #streamed = false;
  #streamFailure: unknown;
  #streamSettled = false;
  #streamSettledAt: number | undefined;

  public constructor(options: TurnExecutionOptions) {
    this.#options = options;
    this.#input = options.input;
    this.#clock = new OperationDeadlineClock(options.clock);
    this.#turnDeadline = this.#clock.deadlineAfter(options.turnTimeoutMs);
  }
  public async run(composition: QueryComposition): Promise<ContainedTurnProviderExecutionOutcome> {
    let projection: ClaudeAgentSdkPrivateProjection | undefined;
    try {
      projection = composition.resolveProjection();
    } catch {
      return claudeNotAccepted(this.#input, "private-projection-unavailable");
    }
    if (projection === undefined) {
      return claudeNotAccepted(this.#input, "private-projection-unavailable");
    }
    const usable = await this.#clock.settleCall(
      () => isClaudeAgentSdkPrivateProjectionUsable(
        projection,
        this.#input.workspaceRef,
        this.#options.privateDirectoryCustody,
      ),
      this.#turnDeadline,
    );
    if (usable.kind !== "fulfilled" || !usable.value) {
      return claudeNotAccepted(this.#input, "private-projection-unavailable");
    }
    this.#projectionRef = projection.projectionRef;
    const loaded = await this.#clock.settleCall(composition.loadQueryFactory, this.#turnDeadline);
    if (loaded.kind !== "fulfilled") {
      return claudeNotAccepted(this.#input, "sdk-query-unavailable");
    }
    const abortController = new AbortController();
    let query: ClaudeSdkQuery;
    try {
      query = composition.startQuery(loaded.value, abortController, projection);
    } catch {
      return ambiguous(this.#input, "sdk-query-start-ambiguous");
    }
    return this.#runQuery(query, abortController);
  }

  async #consume(query: ClaudeSdkQuery): Promise<void> {
    try {
      for await (const message of query) {
        if (this.#result !== undefined) {
          throw new Error("CLAUDE_POST_RESULT_MESSAGE");
        }
        const normalized = normalizeClaudeSdkMessage(message);
        if (normalized.kind === "malformed") {
          throw new Error("CLAUDE_MALFORMED_SDK_MESSAGE");
        }
        if (normalized.kind === "assistant_text" && normalized.text.length > 0) {
          await this.#emit("assistant", normalized.text);
          this.#streamed = true;
        }
        if (normalized.kind === "result") {
          this.#result = normalized.result;
        }
      }
    } catch (error) {
      this.#streamFailure = error;
    } finally {
      this.#streamSettled = true;
      this.#streamSettledAt = this.#clock.now();
    }
  }

  async #emit(kind: "assistant" | "diagnostic", text: string): Promise<void> {
    if (!this.#admissionOpen) {
      throw new Error("CLAUDE_OUTPUT_ADMISSION_CLOSED");
    }
    const admittedCursor = this.#cursor;
    const emitted = await this.#clock.settleCall(
      () => this.#input.emit({ cursor: admittedCursor, kind, text }),
      this.#turnDeadline,
      this.#outputAbort.signal,
    );
    if (emitted.kind !== "fulfilled" || !this.#admissionOpen || admittedCursor !== this.#cursor) {
      this.#outputWaitFailed = true;
      this.#control.timedOut ||= emitted.kind === "timed_out";
      this.#closeAdmission();
      throw new Error("CLAUDE_OUTPUT_ADMISSION_UNPROVEN");
    }
    this.#cursor += 1;
  }

  async #monitor(signal: AbortSignal): Promise<ControlOutcome> {
    while (!this.#streamSettled && !signal.aborted) {
      if (this.#clock.now() >= this.#turnDeadline) {
        return { kind: "stop", reason: "turn_timeout" };
      }
      const pollDeadline = Math.min(this.#turnDeadline, this.#clock.deadlineAfter(this.#options.cancellationPollMs));
      if (await this.#clock.pauseUntil(pollDeadline, signal) === "abandoned") {
        break;
      }
      const outcome = await this.#pollCancellation(signal);
      if (outcome !== undefined) {
        return outcome;
      }
    }
    return { kind: "dismissed" };
  }

  async #pollCancellation(signal: AbortSignal): Promise<ControlOutcome | undefined> {
    if (this.#streamSettled || signal.aborted) {
      return undefined;
    }
    if (this.#clock.now() >= this.#turnDeadline) {
      return { kind: "stop", reason: "turn_timeout" };
    }
    const requested = await this.#clock.settleCall(
      this.#input.isCancellationRequested,
      this.#turnDeadline,
      signal,
    );
    if (requested.kind === "abandoned") {
      return undefined;
    }
    if (requested.kind === "timed_out" || this.#clock.now() >= this.#turnDeadline) {
      return { kind: "stop", reason: "turn_timeout" };
    }
    if (requested.kind === "rejected") {
      return { kind: "stop", reason: "lookup_failed" };
    }
    return requested.value ? { kind: "stop", reason: "cancellation" } : undefined;
  }

  async #runQuery(
    query: ClaudeSdkQuery,
    abortController: AbortController,
  ): Promise<ContainedTurnProviderExecutionOutcome> {
    const consume = this.#consume(query);
    const controlAbort = new AbortController();
    const control = this.#monitor(controlAbort.signal);
    const first = await Promise.race([
      consume.then(() => ({ kind: "stream" as const })),
      control.then(outcome => ({ kind: "control" as const, outcome })),
    ]);
    const missedDeadline = this.#streamSettledAt === undefined || this.#streamSettledAt >= this.#turnDeadline;
    const stop = first.kind === "control" && first.outcome.kind === "stop" ? first.outcome : undefined;
    const shutdownFailed = stop !== undefined || missedDeadline
      ? await this.#stop({
        abortController,
        consume,
        control,
        controlAbort,
        query,
        reason: stop?.reason ?? "turn_timeout",
      })
      : await this.#close(query, control, controlAbort);
    return this.#finalize(shutdownFailed);
  }

  async #stop(input: {
    readonly abortController: AbortController;
    readonly consume: Promise<void>;
    readonly control: Promise<ControlOutcome>;
    readonly controlAbort: AbortController;
    readonly query: ClaudeSdkQuery;
    readonly reason: "cancellation" | "lookup_failed" | "turn_timeout";
  }): Promise<boolean> {
    const { abortController, consume, control, controlAbort, query, reason } = input;
    this.#control.timedOut ||= reason === "turn_timeout";
    this.#control.interruptionFailed ||= reason === "lookup_failed";
    this.#closeAdmission();
    const escalationDeadline = this.#clock.deadlineAfter(this.#options.interruptGraceMs);
    const stopDeadline = this.#clock.add(escalationDeadline, this.#options.interruptGraceMs);
    const interrupt = this.#clock.settleCall(() => query.interrupt(), escalationDeadline);
    const escalationAbort = new AbortController();
    const phase = await Promise.race([
      interrupt.then(observation => ({ kind: "interrupt" as const, observation })),
      consume.then(() => ({ kind: "stream" as const })),
      this.#clock.pauseUntil(escalationDeadline, escalationAbort.signal).then(() => ({ kind: "escalate" as const })),
    ]);
    escalationAbort.abort();
    await this.#observeInterruptPhase(phase, consume, escalationDeadline);
    if (!this.#streamSettled) {
      this.#control.interruptionFailed ||= phase.kind !== "stream" && !this.#control.interruptObserved;
      abortController.abort();
    }
    const close = this.#clock.settleCall(() => query.close(), stopDeadline);
    controlAbort.abort();
    const outcomes = await Promise.all([
      close,
      this.#streamSettled
        ? Promise.resolve<BoundedSettlement<void>>({ kind: "fulfilled", value: undefined })
        : this.#clock.settle(observeCall(() => consume), stopDeadline),
      this.#clock.settle(observeCall(() => control), stopDeadline),
    ]);
    return outcomes.some(outcome => outcome.kind !== "fulfilled");
  }

  async #observeInterruptPhase(
    phase: { readonly kind: "escalate" | "stream" } | { readonly kind: "interrupt"; readonly observation: BoundedSettlement<unknown> },
    consume: Promise<void>,
    deadline: number,
  ): Promise<void> {
    if (phase.kind !== "interrupt") {
      return;
    }
    if (phase.observation.kind !== "fulfilled") {
      this.#control.interruptionFailed = true;
      return;
    }
    this.#control.interruptObserved = true;
    if (!this.#streamSettled) {
      await this.#clock.settle(observeCall(() => consume), deadline);
    }
  }

  async #close(query: ClaudeSdkQuery, control: Promise<ControlOutcome>, controlAbort: AbortController): Promise<boolean> {
    const deadline = this.#clock.add(
      this.#clock.deadlineAfter(this.#options.interruptGraceMs),
      this.#options.interruptGraceMs,
    );
    const close = this.#clock.settleCall(() => query.close(), deadline);
    controlAbort.abort();
    const outcomes = await Promise.all([
      close,
      this.#clock.settle(observeCall(() => control), deadline),
    ]);
    return outcomes.some(outcome => outcome.kind !== "fulfilled");
  }

  async #finalize(shutdownFailed: boolean): Promise<ContainedTurnProviderExecutionOutcome> {
    if (this.#streamFailure !== undefined || this.#outputWaitFailed || this.#control.interruptionFailed
      || this.#control.timedOut || shutdownFailed) {
      this.#closeAdmission();
      return ambiguous(this.#input, "sdk-stream-or-shutdown-unproven");
    }
    if (this.#result === undefined) {
      this.#closeAdmission();
      return ambiguous(this.#input, "sdk-terminal-result-missing");
    }
    if (this.#admissionOpen && !this.#streamed && this.#result.subtype === "success"
      && !this.#result.is_error && this.#result.result.length > 0
      && !await this.#tryEmit("assistant", this.#result.result)) {
      return ambiguous(this.#input, "sdk-output-admission-unproven");
    }
    const diagnostic = claudeResultDiagnostic(this.#result);
    if (this.#admissionOpen && diagnostic !== undefined && !await this.#tryEmit("diagnostic", diagnostic)) {
      return ambiguous(this.#input, "sdk-output-admission-unproven");
    }
    this.#closeAdmission();
    return this.#completed(this.#result);
  }

  async #tryEmit(kind: "assistant" | "diagnostic", text: string): Promise<boolean> {
    try {
      await this.#emit(kind, text);
      return true;
    } catch {
      this.#closeAdmission();
      return false;
    }
  }

  #closeAdmission(): void {
    this.#admissionOpen = false;
    this.#outputAbort.abort();
  }

  #completed(result: ClaudeSdkResultMessage): ContainedTurnProviderExecutionOutcome {
    const outcome = result.subtype === "success" && !result.is_error ? "succeeded" : "failed";
    const identity = [
      this.#input.operationId, this.#input.effectId, this.#input.attemptId, result.session_id, result.uuid,
      result.subtype, result.is_error, this.#cursor, this.#control.interruptObserved,
      this.#control.timedOut, this.#options.adapterRevision, this.#options.binaryRevision,
      this.#projectionRef,
    ] as const;
    return {
      acceptanceReceiptRef: receipt("claude-provider-accepted", identity),
      effectDisposition: "committed",
      effectReceiptRef: receipt("claude-effect-resolved", identity),
      executionReceiptRef: receipt("claude-execution-closed", identity),
      kind: "completed",
      outcome,
      outputDrainReceiptRef: receipt("claude-sdk-iterator-drained", identity),
    };
  }
}
