import { createHash } from "node:crypto";

import type {
  ContainedTurnAdapterCapabilityManifest,
  ContainedTurnProviderExecutionOutcome,
  ContainedTurnProviderPort,
} from "../legacy/legacy-contained-turn-ports.js";
import type {
  CustodiedProviderProcess,
  CustodiedProviderProcessRegistry,
} from "../host-custody/custodied-provider-process.js";

const DEFAULT_MAX_LINE_BYTES = 1_048_576;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_TURN_TIMEOUT_MS = 1_200_000;
const DEFAULT_CANCELLATION_POLL_MS = 100;
const MAX_STDERR_BYTES = 65_536;
const TIMEOUT = Symbol("codex-app-server-timeout");

type JsonRecord = Record<string, unknown>;
type ReadOutcome = JsonRecord | typeof TIMEOUT | undefined;

interface ActiveTurnProgress {
  cursor: number;
  interruptAcknowledged: boolean;
  interruptDeadline: number | undefined;
  interruptRequestId?: string;
}

interface ActiveTurnCompletion extends ActiveTurnProgress {
  readonly status: "completed" | "failed" | "interrupted";
}

export interface CodexAppServerContainedTurnProviderOptions {
  readonly cancellationPollMs?: number;
  readonly manifest: ContainedTurnAdapterCapabilityManifest;
  readonly maxLineBytes?: number;
  readonly processes: CustodiedProviderProcessRegistry;
  readonly requestTimeoutMs?: number;
  readonly turnTimeoutMs?: number;
}

class CodexAppServerProtocolError extends Error {
  public constructor(
    message: string,
    public readonly afterTurnRequest: boolean,
    public readonly explicitlyRejected = false,
  ) {
    super(message);
    this.name = "CodexAppServerProtocolError";
  }
}

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const stringField = (record: JsonRecord, name: string): string | undefined =>
  typeof record[name] === "string" ? record[name] : undefined;

const positiveInteger = (name: string, value: number | undefined, fallback: number): number => {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected <= 0) {throw new TypeError(`${name} must be a positive integer`);}
  return selected;
};

const receipt = (kind: string, values: readonly unknown[]): string =>
  `urn:agent-runtime:${kind}:${createHash("sha256").update(JSON.stringify(values)).digest("hex")}`;

const encode = (message: JsonRecord): Uint8Array => Buffer.from(`${JSON.stringify(message)}\n`, "utf8");

class BoundedJsonLineReader {
  readonly #iterator: AsyncIterator<Uint8Array>;
  readonly #maxLineBytes: number;
  #buffer = Buffer.alloc(0);
  #ended = false;
  #pending: Promise<IteratorResult<Uint8Array>> | undefined;

  public constructor(source: AsyncIterable<Uint8Array>, maxLineBytes: number) {
    this.#iterator = source[Symbol.asyncIterator]();
    this.#maxLineBytes = maxLineBytes;
  }

  async #nextChunk(deadline: number): Promise<IteratorResult<Uint8Array> | typeof TIMEOUT> {
    this.#pending ??= this.#iterator.next();
    const remaining = deadline - Date.now();
    if (remaining <= 0) {return TIMEOUT;}
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<typeof TIMEOUT>(resolve => {
      timer = setTimeout(() => resolve(TIMEOUT), remaining);
    });
    const result = await Promise.race([this.#pending, timeout]);
    if (timer !== undefined) {clearTimeout(timer);}
    if (result !== TIMEOUT) {this.#pending = undefined;}
    return result;
  }

  public async read(deadline: number): Promise<ReadOutcome> {
    while (true) {
      const newline = this.#buffer.indexOf(0x0a);
      if (newline >= 0) {
        if (newline > this.#maxLineBytes) {throw new Error("Codex App Server line exceeds the configured bound");}
        const line = this.#buffer.subarray(0, newline);
        this.#buffer = this.#buffer.subarray(newline + 1);
        const normalized = line.length > 0 && line.at(-1) === 0x0d ? line.subarray(0, -1) : line;
        if (normalized.length === 0) {continue;}
        let decoded: unknown;
        try {
          decoded = JSON.parse(normalized.toString("utf8"));
        } catch {
          throw new Error("Codex App Server emitted malformed JSON");
        }
        if (!isRecord(decoded)) {throw new Error("Codex App Server message must be an object");}
        return decoded;
      }
      if (this.#buffer.length > this.#maxLineBytes) {throw new Error("Codex App Server line exceeds the configured bound");}
      if (this.#ended) {
        if (this.#buffer.length !== 0) {throw new Error("Codex App Server closed with an unterminated message");}
        return undefined;
      }
      const next = await this.#nextChunk(deadline);
      if (next === TIMEOUT) {return TIMEOUT;}
      if (next.done) {
        this.#ended = true;
      } else {
        const bytes = Buffer.from(next.value);
        if (this.#buffer.length + bytes.length > this.#maxLineBytes + 1) {
          throw new Error("Codex App Server input buffer exceeds the configured bound");
        }
        this.#buffer = Buffer.concat([this.#buffer, bytes]);
      }
    }
  }
}

const responseResult = (message: JsonRecord, requestId: string): unknown | typeof TIMEOUT => {
  if (message.id !== requestId) {return TIMEOUT;}
  if (isRecord(message.error)) {
    const detail = stringField(message.error, "message") ?? "unknown JSON-RPC error";
    throw new CodexAppServerProtocolError(`Codex App Server rejected a request: ${detail}`, false, true);
  }
  if (!("result" in message)) {throw new Error("Codex App Server response has no result");}
  return message.result;
};

const serverRequestMethod = (message: JsonRecord): string | undefined =>
  "id" in message ? stringField(message, "method") : undefined;

const notificationMethod = (message: JsonRecord): string | undefined =>
  !("id" in message) ? stringField(message, "method") : undefined;

const drainStderr = async (process: CustodiedProviderProcess): Promise<string> => {
  const digest = createHash("sha256");
  let observed = 0;
  try {
    for await (const bytes of process.stderr) {
      const remaining = Math.max(0, MAX_STDERR_BYTES - observed);
      if (remaining > 0) {digest.update(Buffer.from(bytes).subarray(0, remaining));}
      observed += bytes.length;
    }
  } catch {
    digest.update("stderr-read-failed");
  }
  return digest.digest("hex");
};

const notAccepted = (input: {
  readonly attemptId: string;
  readonly effectId: string;
  readonly operationId: string;
  readonly reason: string;
}): ContainedTurnProviderExecutionOutcome => {
  const identity = [input.operationId, input.effectId, input.attemptId, input.reason] as const;
  return {
    effectReceiptRef: receipt("codex-effect-not-committed", identity),
    executionReceiptRef: receipt("codex-execution-not-started", identity),
    kind: "not_accepted",
    outputDrainReceiptRef: receipt("codex-output-not-started", identity),
    providerReceiptRef: receipt("codex-provider-not-accepted", identity),
  };
};

const completedOutcome = (input: {
  readonly attemptId: string;
  readonly binaryRevision: string;
  readonly effectId: string;
  readonly operationId: string;
  readonly adapterRevision: string;
  readonly completion: ActiveTurnCompletion;
  readonly threadId: string;
  readonly turnId: string;
}): ContainedTurnProviderExecutionOutcome => {
  const identity = [
    input.operationId,
    input.effectId,
    input.attemptId,
    input.threadId,
    input.turnId,
    input.completion.status,
    input.completion.cursor,
    input.completion.interruptRequestId,
    input.completion.interruptAcknowledged,
    input.adapterRevision,
    input.binaryRevision,
  ] as const;
  return {
    acceptanceReceiptRef: receipt("codex-provider-accepted", identity),
    effectDisposition: "committed",
    effectReceiptRef: receipt("codex-effect-resolved", identity),
    executionReceiptRef: receipt("codex-execution-closed", identity),
    kind: "completed",
    outcome: input.completion.status === "completed"
      ? "succeeded"
      : input.completion.status === "interrupted" ? "cancelled" : "failed",
    outputDrainReceiptRef: receipt("codex-output-drained", identity),
  };
};

const parseThreadId = (result: unknown): string => {
  if (!isRecord(result) || !isRecord(result.thread)) {throw new Error("Codex thread/start result is invalid");}
  const threadId = stringField(result.thread, "id");
  if (threadId === undefined || threadId.length === 0) {throw new Error("Codex thread/start returned no thread identity");}
  return threadId;
};

const parseTurn = (result: unknown): { readonly id: string; readonly status: string } => {
  if (!isRecord(result) || !isRecord(result.turn)) {throw new Error("Codex turn result is invalid");}
  const id = stringField(result.turn, "id");
  const status = stringField(result.turn, "status");
  if (id === undefined || status === undefined) {throw new Error("Codex turn result lacks identity or status");}
  return { id, status };
};

const turnSandboxPolicy = (mode: "analysis" | "workspace-write", workspaceRef: string): JsonRecord =>
  mode === "analysis"
    ? { networkAccess: false, type: "readOnly" }
    : {
        excludeSlashTmp: true,
        excludeTmpdirEnvVar: true,
        networkAccess: false,
        type: "workspaceWrite",
        writableRoots: [workspaceRef],
      };

const threadConfig = (): JsonRecord => ({
  features: {
    apps: false,
    browser_use: false,
    computer_use: false,
    image_generation: false,
    multi_agent: false,
    multi_agent_v2: false,
    plugins: false,
    remote_plugin: false,
  },
});

const emitCodexError = async (
  params: JsonRecord,
  input: Parameters<ContainedTurnProviderPort["execute"]>[0],
  threadId: string,
  turnId: string,
  progress: ActiveTurnProgress,
): Promise<void> => {
  if (params.threadId !== threadId || params.turnId !== turnId || !isRecord(params.error)) {
    throw new CodexAppServerProtocolError("Codex error notification identity is invalid", true);
  }
  const errorMessage = stringField(params.error, "message");
  if (errorMessage === undefined) {return;}
  await input.emit({ cursor: progress.cursor, kind: "diagnostic", text: errorMessage });
  progress.cursor += 1;
};

const emitCodexAssistantDelta = async (
  params: JsonRecord,
  input: Parameters<ContainedTurnProviderPort["execute"]>[0],
  threadId: string,
  turnId: string,
  progress: ActiveTurnProgress,
): Promise<void> => {
  if (params.threadId !== threadId || params.turnId !== turnId || typeof params.delta !== "string") {
    throw new CodexAppServerProtocolError("Codex assistant delta identity is invalid", true);
  }
  await input.emit({ cursor: progress.cursor, kind: "assistant", text: params.delta });
  progress.cursor += 1;
};

const completeCodexTurn = async (
  params: JsonRecord,
  input: Parameters<ContainedTurnProviderPort["execute"]>[0],
  threadId: string,
  turnId: string,
  progress: ActiveTurnProgress,
): Promise<ActiveTurnCompletion> => {
  if (params.threadId !== threadId) {throw new CodexAppServerProtocolError("Codex terminal thread identity changed", true);}
  const completed = parseTurn(params);
  if (completed.id !== turnId || !["completed", "failed", "interrupted"].includes(completed.status)) {
    throw new CodexAppServerProtocolError("Codex terminal turn identity or status is invalid", true);
  }
  if (completed.status === "failed" && isRecord(params.turn) && isRecord(params.turn.error)) {
    const terminalMessage = stringField(params.turn.error, "message");
    if (terminalMessage !== undefined) {
      await input.emit({ cursor: progress.cursor, kind: "diagnostic", text: terminalMessage });
      progress.cursor += 1;
    }
  }
  return { ...progress, status: completed.status as ActiveTurnCompletion["status"] };
};

export class CodexAppServerContainedTurnProvider implements ContainedTurnProviderPort {
  public readonly manifest: ContainedTurnAdapterCapabilityManifest;
  readonly #cancellationPollMs: number;
  readonly #maxLineBytes: number;
  readonly #processes: CustodiedProviderProcessRegistry;
  readonly #requestTimeoutMs: number;
  readonly #turnTimeoutMs: number;

  public constructor(options: CodexAppServerContainedTurnProviderOptions) {
    if (options.manifest.providerBinding.provider !== "codex") {
      throw new TypeError("Codex App Server adapter requires a Codex provider binding");
    }
    this.manifest = Object.freeze({
      effectClass: options.manifest.effectClass,
      providerBinding: Object.freeze({ ...options.manifest.providerBinding }),
      supportedModes: Object.freeze([...options.manifest.supportedModes]),
    });
    this.#processes = options.processes;
    this.#maxLineBytes = positiveInteger("maxLineBytes", options.maxLineBytes, DEFAULT_MAX_LINE_BYTES);
    this.#requestTimeoutMs = positiveInteger("requestTimeoutMs", options.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS);
    this.#turnTimeoutMs = positiveInteger("turnTimeoutMs", options.turnTimeoutMs, DEFAULT_TURN_TIMEOUT_MS);
    this.#cancellationPollMs = positiveInteger("cancellationPollMs", options.cancellationPollMs, DEFAULT_CANCELLATION_POLL_MS);
  }

  async #request(
    process: CustodiedProviderProcess,
    reader: BoundedJsonLineReader,
    request: JsonRecord,
    afterTurnRequest: boolean,
  ): Promise<unknown> {
    const requestId = String(request.id);
    await process.write(encode(request));
    const deadline = Date.now() + this.#requestTimeoutMs;
    while (true) {
      const message = await reader.read(deadline);
      if (message === TIMEOUT || message === undefined) {
        throw new CodexAppServerProtocolError("Codex App Server closed or timed out before a response", afterTurnRequest);
      }
      const serverMethod = serverRequestMethod(message);
      if (serverMethod !== undefined) {
        throw new CodexAppServerProtocolError(`unexpected Codex server request ${serverMethod}`, afterTurnRequest);
      }
      if ("id" in message) {
        try {
          const result = responseResult(message, requestId);
          if (result !== TIMEOUT) {return result;}
        } catch (error) {
          if (error instanceof CodexAppServerProtocolError) {
            throw new CodexAppServerProtocolError(error.message, afterTurnRequest, error.explicitlyRejected);
          }
          throw error;
        }
        throw new CodexAppServerProtocolError("Codex App Server returned an unexpected response identity", afterTurnRequest);
      }
    }
  }

  async #handleActiveMessage(
    message: JsonRecord,
    input: Parameters<ContainedTurnProviderPort["execute"]>[0],
    threadId: string,
    turnId: string,
    progress: ActiveTurnProgress,
  ): Promise<ActiveTurnCompletion | undefined> {
    const serverMethod = serverRequestMethod(message);
    if (serverMethod !== undefined) {
      throw new CodexAppServerProtocolError(`unexpected Codex server request ${serverMethod}`, true);
    }
    if ("id" in message) {
      if (message.id !== progress.interruptRequestId) {
        throw new CodexAppServerProtocolError("Codex App Server returned an unexpected response identity", true);
      }
      if (isRecord(message.error)) {throw new CodexAppServerProtocolError("Codex rejected turn interruption", true);}
      progress.interruptAcknowledged = true;
      progress.interruptDeadline = undefined;
      return undefined;
    }
    const method = notificationMethod(message);
    if (!isRecord(message.params)) {return undefined;}
    if (method === "error") {
      await emitCodexError(message.params, input, threadId, turnId, progress);
      return undefined;
    }
    if (method === "item/agentMessage/delta") {
      await emitCodexAssistantDelta(message.params, input, threadId, turnId, progress);
      return undefined;
    }
    if (method !== "turn/completed") {return undefined;}
    return completeCodexTurn(message.params, input, threadId, turnId, progress);
  }

  async #awaitTurnCompletion(
    process: CustodiedProviderProcess,
    reader: BoundedJsonLineReader,
    input: Parameters<ContainedTurnProviderPort["execute"]>[0],
    threadId: string,
    turnId: string,
  ): Promise<ActiveTurnCompletion> {
    const progress: ActiveTurnProgress = { cursor: 0, interruptAcknowledged: false, interruptDeadline: undefined };
    const deadline = Date.now() + this.#turnTimeoutMs;
    let nextCancellationCheck = Date.now();
    while (true) {
      if (progress.interruptRequestId === undefined && Date.now() >= nextCancellationCheck) {
        if (await input.isCancellationRequested()) {
          progress.interruptRequestId = `${input.attemptId}:turn-interrupt`;
          await process.write(encode({
            id: progress.interruptRequestId,
            method: "turn/interrupt",
            params: { threadId, turnId },
          }));
          progress.interruptDeadline = Date.now() + this.#requestTimeoutMs;
        }
        nextCancellationCheck = Date.now() + this.#cancellationPollMs;
      }
      const pollDeadline = progress.interruptRequestId === undefined
        ? Math.min(deadline, nextCancellationCheck)
        : Math.min(deadline, progress.interruptDeadline ?? deadline);
      const message = await reader.read(pollDeadline);
      if (message === TIMEOUT) {
        if (Date.now() >= deadline) {throw new CodexAppServerProtocolError("Codex turn timed out", true);}
        if (progress.interruptDeadline !== undefined && Date.now() >= progress.interruptDeadline) {
          throw new CodexAppServerProtocolError("Codex turn interruption timed out", true);
        }
        continue;
      }
      if (message === undefined) {throw new CodexAppServerProtocolError("Codex App Server closed before turn completion", true);}
      const completed = await this.#handleActiveMessage(message, input, threadId, turnId, progress);
      if (completed !== undefined) {return completed;}
    }
  }

  public async execute(input: Parameters<ContainedTurnProviderPort["execute"]>[0]): Promise<ContainedTurnProviderExecutionOutcome> {
    const process = this.#processes.get(input.custody.custodyRef);
    if (process === undefined) {
      return { evidenceRef: receipt("codex-custody-process-missing", [input.operationId, input.attemptId]), kind: "ambiguous" };
    }
    const reader = new BoundedJsonLineReader(process.stdout, this.#maxLineBytes);
    void drainStderr(process);
    let turnRequestWritten = false;
    let threadId: string | undefined;
    let turnId: string | undefined;
    try {
      await this.#request(process, reader, {
        id: `${input.attemptId}:initialize`,
        method: "initialize",
        params: {
          capabilities: { experimentalApi: false, requestAttestation: false },
          clientInfo: { name: "agent-runtime", title: "Agent Runtime", version: this.manifest.providerBinding.adapterRevision },
        },
      }, false);
      await process.write(encode({ method: "initialized" }));
      const threadResult = await this.#request(process, reader, {
        id: `${input.attemptId}:thread-start`,
        method: "thread/start",
        params: {
          approvalPolicy: "never",
          config: threadConfig(),
          cwd: input.workspaceRef,
          ephemeral: true,
          sandbox: input.intent.mode === "analysis" ? "read-only" : "workspace-write",
        },
      }, false);
      threadId = parseThreadId(threadResult);
      turnRequestWritten = true;
      const turnResult = await this.#request(process, reader, {
        id: `${input.attemptId}:turn-start`,
        method: "turn/start",
        params: {
          approvalPolicy: "never",
          cwd: input.workspaceRef,
          input: [{ text: input.intent.prompt, text_elements: [], type: "text" }],
          sandboxPolicy: turnSandboxPolicy(input.intent.mode, input.workspaceRef),
          threadId,
        },
      }, true);
      turnId = parseTurn(turnResult).id;
      const completion = await this.#awaitTurnCompletion(process, reader, input, threadId, turnId);
      await process.closeInput().catch(() => {});
      return completedOutcome({
        adapterRevision: this.manifest.providerBinding.adapterRevision,
        attemptId: input.attemptId,
        binaryRevision: this.manifest.providerBinding.binaryRevision,
        completion,
        effectId: input.effectId,
        operationId: input.operationId,
        threadId,
        turnId,
      });
    } catch (error) {
      if (!turnRequestWritten) {
        return notAccepted({
          attemptId: input.attemptId,
          effectId: input.effectId,
          operationId: input.operationId,
          reason: error instanceof Error ? error.name : "unknown-error",
        });
      }
      if (error instanceof CodexAppServerProtocolError) {
        if (!error.afterTurnRequest || error.explicitlyRejected) {
          return notAccepted({
            attemptId: input.attemptId,
            effectId: input.effectId,
            operationId: input.operationId,
            reason: error.message,
          });
        }
      }
      return {
        evidenceRef: receipt("codex-provider-ambiguous", [
          input.operationId,
          input.effectId,
          input.attemptId,
          turnRequestWritten,
          threadId,
          turnId,
          error instanceof Error ? error.name : "unknown-error",
        ]),
        kind: "ambiguous",
      };
    }
  }
}
