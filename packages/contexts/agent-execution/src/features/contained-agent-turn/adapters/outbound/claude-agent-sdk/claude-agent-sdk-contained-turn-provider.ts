import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import type {
  ContainedTurnAdapterCapabilityManifest,
  ContainedTurnProviderExecutionOutcome,
  ContainedTurnProviderPort,
} from "../legacy/legacy-contained-turn-ports.js";
import {
  claudeAgentSdkTools,
  createClaudeAgentSdkEnvironment,
} from "./claude-agent-sdk-launch-plan.js";
import type {
  CustodiedProviderProcessRegistry,
  CustodiedSdkProcessLauncher,
} from "../host-custody/custodied-provider-process.js";

const DEFAULT_CANCELLATION_POLL_MS = 100;
const DEFAULT_INTERRUPT_GRACE_MS = 5_000;
const DEFAULT_TURN_TIMEOUT_MS = 1_200_000;
const MAX_DIAGNOSTIC_BYTES = 2_000;

interface ClaudeSdkSpawnOptions {
  readonly args: string[];
  readonly command: string;
  readonly cwd?: string;
  readonly env: Record<string, string | undefined>;
  readonly signal: AbortSignal;
}

interface ClaudeSdkStreamMessage {
  readonly event: {
    readonly delta?: { readonly text?: string; readonly type?: string };
    readonly type: string;
  };
  readonly parent_tool_use_id: string | null;
  readonly type: "stream_event";
}

interface ClaudeSdkResultBase {
  readonly is_error: boolean;
  readonly session_id: string;
  readonly type: "result";
  readonly uuid: string;
}

interface ClaudeSdkResultSuccess extends ClaudeSdkResultBase {
  readonly result: string;
  readonly subtype: "success";
}

interface ClaudeSdkResultError extends ClaudeSdkResultBase {
  readonly errors: string[];
  readonly subtype: "error_during_execution" | "error_max_turns" | "error_max_budget_usd" | "error_max_structured_output_retries";
}

type ClaudeSdkResultMessage = ClaudeSdkResultSuccess | ClaudeSdkResultError;
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

const loadClaudeQueryFactory = async (): Promise<ClaudeQueryFactory> => {
  const loaded: unknown = await import("@anthropic-ai/claude-agent-sdk");
  if (typeof loaded !== "object" || loaded === null || !("query" in loaded) || typeof loaded.query !== "function") {
    throw new Error("Claude Agent SDK query export is unavailable");
  }
  return loaded.query as ClaudeQueryFactory;
};

export interface ClaudeAgentSdkContainedTurnProviderOptions {
  readonly cancellationPollMs?: number;
  readonly executablePath: string;
  readonly interruptGraceMs?: number;
  readonly manifest: ContainedTurnAdapterCapabilityManifest;
  readonly processes: CustodiedProviderProcessRegistry & CustodiedSdkProcessLauncher;
  readonly queryFactory?: ClaudeQueryFactory;
  readonly turnTimeoutMs?: number;
}

interface ControlState {
  interrupted: boolean;
  interruptionFailed: boolean;
  timedOut: boolean;
}

const positiveInteger = (name: string, value: number | undefined, fallback: number): number => {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected <= 0) {throw new TypeError(`${name} must be a positive integer`);}
  return selected;
};

const receipt = (kind: string, values: readonly unknown[]): string =>
  `urn:agent-runtime:${kind}:${createHash("sha256").update(JSON.stringify(values)).digest("hex")}`;

const notAccepted = (input: {
  readonly attemptId: string;
  readonly effectId: string;
  readonly operationId: string;
  readonly reason: string;
}): ContainedTurnProviderExecutionOutcome => {
  const identity = [input.operationId, input.effectId, input.attemptId, input.reason] as const;
  return {
    effectReceiptRef: receipt("claude-effect-not-committed", identity),
    executionReceiptRef: receipt("claude-execution-not-started", identity),
    kind: "not_accepted",
    outputDrainReceiptRef: receipt("claude-output-not-started", identity),
    providerReceiptRef: receipt("claude-provider-not-accepted", identity),
  };
};

const ambiguous = (input: {
  readonly attemptId: string;
  readonly effectId: string;
  readonly operationId: string;
  readonly reason: string;
}): ContainedTurnProviderExecutionOutcome => ({
  evidenceRef: receipt("claude-provider-ambiguous", [input.operationId, input.effectId, input.attemptId, input.reason]),
  kind: "ambiguous",
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isClaudeResult = (message: unknown): message is ClaudeSdkResultMessage => {
  if (!isRecord(message) || message.type !== "result" || typeof message.subtype !== "string" ||
      typeof message.is_error !== "boolean" || typeof message.session_id !== "string" || typeof message.uuid !== "string") {
    return false;
  }
  return message.subtype === "success"
    ? typeof message.result === "string"
    : ["error_during_execution", "error_max_turns", "error_max_budget_usd", "error_max_structured_output_retries"].includes(message.subtype) &&
      Array.isArray(message.errors) && message.errors.every(error => typeof error === "string");
};

const isClaudeStreamMessage = (message: unknown): message is ClaudeSdkStreamMessage =>
  isRecord(message) && message.type === "stream_event" && "event" in message && isRecord(message.event) &&
  typeof message.event.type === "string" && (message.parent_tool_use_id === null || typeof message.parent_tool_use_id === "string");

const textDelta = (message: unknown): string | undefined => {
  if (!isClaudeStreamMessage(message) || message.parent_tool_use_id !== null) {return undefined;}
  const event = message.event;
  return event.type === "content_block_delta" && event.delta?.type === "text_delta"
    ? event.delta.text
    : undefined;
};

const boundedDiagnostic = (result: ClaudeSdkResultMessage): string | undefined => {
  const detail = result.subtype === "success"
    ? result.is_error ? result.result : undefined
    : result.errors.join("; ");
  if (detail === undefined || detail.length === 0) {return undefined;}
  return Buffer.from(detail, "utf8").subarray(0, MAX_DIAGNOSTIC_BYTES).toString("utf8");
};

const completed = (input: {
  readonly adapterRevision: string;
  readonly attemptId: string;
  readonly binaryRevision: string;
  readonly control: ControlState;
  readonly cursor: number;
  readonly effectId: string;
  readonly operationId: string;
  readonly result: ClaudeSdkResultMessage;
}): ContainedTurnProviderExecutionOutcome => {
  const outcome = input.result.subtype === "success" && !input.result.is_error
    ? "succeeded"
    : input.control.interrupted && !input.control.timedOut ? "cancelled" : "failed";
  const identity = [
    input.operationId,
    input.effectId,
    input.attemptId,
    input.result.session_id,
    input.result.uuid,
    input.result.subtype,
    input.result.is_error,
    input.cursor,
    input.control.interrupted,
    input.control.timedOut,
    input.adapterRevision,
    input.binaryRevision,
  ] as const;
  return {
    acceptanceReceiptRef: receipt("claude-provider-accepted", identity),
    effectDisposition: "committed",
    effectReceiptRef: receipt("claude-effect-resolved", identity),
    executionReceiptRef: receipt("claude-execution-closed", identity),
    kind: "completed",
    outcome,
    outputDrainReceiptRef: receipt("claude-output-drained", identity),
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
  filesystem: {
    allowRead: [workspaceRef],
    allowWrite: mode === "analysis" ? [] : [workspaceRef],
  },
});

export class ClaudeAgentSdkContainedTurnProvider implements ContainedTurnProviderPort {
  public readonly manifest: ContainedTurnAdapterCapabilityManifest;
  readonly #cancellationPollMs: number;
  readonly #executablePath: string;
  readonly #interruptGraceMs: number;
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
    this.#executablePath = options.executablePath;
    this.#interruptGraceMs = positiveInteger("interruptGraceMs", options.interruptGraceMs, DEFAULT_INTERRUPT_GRACE_MS);
    this.#processes = options.processes;
    this.#queryFactory = options.queryFactory;
    this.#turnTimeoutMs = positiveInteger("turnTimeoutMs", options.turnTimeoutMs, DEFAULT_TURN_TIMEOUT_MS);
  }

  public async execute(input: Parameters<ContainedTurnProviderPort["execute"]>[0]): Promise<ContainedTurnProviderExecutionOutcome> {
    if (!this.manifest.supportedModes.includes(input.intent.mode)) {
      return notAccepted({ ...input, reason: "mode-unsupported" });
    }
    const environment = createClaudeAgentSdkEnvironment(input.workspaceRef);
    const abortController = new AbortController();
    const control: ControlState = { interrupted: false, interruptionFailed: false, timedOut: false };
    const tools = [...claudeAgentSdkTools(input.intent.mode)];
    let queryHandle: ClaudeSdkQuery;
    try {
      const queryFactory = this.#queryFactory ?? await loadClaudeQueryFactory();
      queryHandle = queryFactory({
        prompt: input.intent.prompt,
        options: {
          abortController,
          allowedTools: tools,
          cwd: input.workspaceRef,
          disallowedTools: [...disallowedTools(input.intent.mode)],
          env: environment,
          includePartialMessages: true,
          maxTurns: 1,
          mcpServers: {},
          pathToClaudeCodeExecutable: this.#executablePath,
          permissionMode: "dontAsk",
          persistSession: false,
          plugins: [],
          sandbox: sdkSandbox(input.intent.mode, input.workspaceRef),
          settingSources: [],
          spawnClaudeCodeProcess: (options: ClaudeSdkSpawnOptions) => this.#processes.start(input.custody.custodyRef, {
            arguments: options.args,
            command: options.command,
            cwd: options.cwd,
            environment: options.env,
            signal: options.signal,
          }),
          strictMcpConfig: true,
          tools,
        },
      });
    } catch {
      return this.#processes.get(input.custody.custodyRef) === undefined
        ? notAccepted({ ...input, reason: "sdk-query-not-started" })
        : ambiguous({ ...input, reason: "sdk-query-start-ambiguous" });
    }

    let cursor = 0;
    let result: ClaudeSdkResultMessage | undefined;
    let streamed = false;
    let streamSettled = false;
    let streamFailure: unknown;
    const consume = async (): Promise<void> => {
      try {
        for await (const message of queryHandle) {
          const delta = textDelta(message);
          if (delta !== undefined && delta.length > 0) {
            streamed = true;
            cursor += 1;
            await input.emit({ cursor, kind: "assistant", text: delta });
          }
          if (isClaudeResult(message)) {
            if (result !== undefined) {throw new Error("Claude SDK emitted more than one terminal result");}
            result = message;
          }
        }
      } catch (error) {
        streamFailure = error;
      } finally {
        streamSettled = true;
      }
    };

    const startedAt = Date.now();
    const controlLoop = async (): Promise<"forced" | "settled"> => {
      for (;;) {
        if (streamSettled) {return "settled";}
        await delay(this.#cancellationPollMs);
        if (streamSettled) {return "settled";}
        let cancellationRequested = false;
        try {
          cancellationRequested = await input.isCancellationRequested();
        } catch {
          control.interruptionFailed = true;
          abortController.abort();
          await delay(this.#interruptGraceMs);
          return streamSettled ? "settled" : "forced";
        }
        const timedOut = Date.now() - startedAt >= this.#turnTimeoutMs;
        if (!cancellationRequested && !timedOut) {continue;}
        control.timedOut = timedOut;
        try {
          await Promise.race([
            queryHandle.interrupt(),
            delay(this.#interruptGraceMs).then(() => {throw new Error("Claude SDK interrupt timed out");}),
          ]);
          control.interrupted = true;
        } catch {
          control.interruptionFailed = true;
          abortController.abort();
        }
        await delay(this.#interruptGraceMs);
        if (!streamSettled) {abortController.abort();}
        await delay(this.#interruptGraceMs);
        return streamSettled ? "settled" : "forced";
      }
    };

    const consumePromise = consume();
    const controlPromise = controlLoop();
    const first = await Promise.race([
      consumePromise.then(() => "settled" as const),
      controlPromise,
    ]);
    if (first === "forced") {
      queryHandle.close();
      void consumePromise.catch(() => {});
      return ambiguous({ ...input, reason: "sdk-stream-did-not-close" });
    }
    await consumePromise;
    queryHandle.close();
    if (streamFailure !== undefined || control.interruptionFailed) {
      return ambiguous({ ...input, reason: "sdk-stream-failed" });
    }
    if (result === undefined) {
      return ambiguous({ ...input, reason: "sdk-terminal-result-missing" });
    }
    if (!streamed && result.subtype === "success" && result.result.length > 0) {
      cursor += 1;
      await input.emit({ cursor, kind: "assistant", text: result.result });
    }
    const diagnostic = boundedDiagnostic(result);
    if (diagnostic !== undefined) {
      cursor += 1;
      await input.emit({ cursor, kind: "diagnostic", text: diagnostic });
    }
    return completed({
      adapterRevision: this.manifest.providerBinding.adapterRevision,
      attemptId: input.attemptId,
      binaryRevision: this.manifest.providerBinding.binaryRevision,
      control,
      cursor,
      effectId: input.effectId,
      operationId: input.operationId,
      result,
    });
  }

}
