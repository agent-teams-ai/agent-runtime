import { isAbsolute, relative, resolve } from "node:path";

import type {
  ContainedTurnAdapterCapabilityManifest,
  ContainedTurnProviderPort,
} from "../legacy/legacy-contained-turn-ports.js";
import type {
  CustodiedProviderProcess,
  CustodiedProviderProcessRegistry,
} from "../host-custody/custodied-provider-process.js";
import {
  BoundedCodexJsonLineReader,
  CodexAppServerProtocolError,
  CODEX_APP_SERVER_TIMEOUT as TIMEOUT,
  codexResponseResult as responseResult,
  codexServerRequestMethod as serverRequestMethod,
  encodeCodexMessage as encode,
  type CodexJsonRecord as JsonRecord,
} from "./codex-app-server-jsonl.js";
import {
  createCodexActiveTurnProgress,
  handleCodexActiveMessage,
  parseCodexThreadId,
  parseCodexTurn,
  type CodexActiveTurnCompletion,
} from "./codex-app-server-active-turn.js";
import type {
  CodexEffectCustodyAuthority,
  CodexEffectCustodyBinding,
} from "./codex-app-server-effect-custody.js";
import {
  codexContainedThreadConfig,
  codexThreadSandbox,
  codexTurnSandboxPolicy,
  observeCodexActiveProfileEvidence,
  type CodexAppServerPermissionBoundary,
  validateCodexConfigEvidence,
  validateCodexInitializeEvidence,
  validateCodexPermissionProfileEvidence,
} from "./codex-app-server-permission-boundary.js";
import {
  codexAppServerTupleForBinaryRevision,
  type CodexAppServerPlatformTuple,
} from "./codex-app-server-platform-tuple.js";
import {
  closeCodexInputBounded,
  drainCodexStderr,
  observeCodexStderrBounded,
  proveCodexNoStart,
  proveCodexOutputDrain,
} from "./codex-app-server-process-closure.js";
import {
  codexReceipt,
  completedCodexOutcome,
  detachCodexExecutionInput,
  codexNotAccepted,
  type CodexReceiptIdentity,
} from "./codex-app-server-receipt-identity.js";
import { detachCodexProviderOptions } from "./codex-app-server-provider-options.js";
import {
  codexContainmentRequired,
  type CodexAppServerExecutionOutcome,
  type CodexPublicEvidenceCode,
} from "./codex-app-server-containment-outcome.js";

export type {
  CodexAppServerExecutionOutcome,
  CodexContainmentReconciliationRequiredOutcome,
} from "./codex-app-server-containment-outcome.js";

const DEFAULT_MAX_LINE_BYTES = 1_048_576; const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_TURN_TIMEOUT_MS = 1_200_000; const DEFAULT_CANCELLATION_POLL_MS = 100;
const MAX_PRE_TURN_NOTIFICATIONS = 256;
const DEFAULT_MAX_ACTIVE_NOTIFICATION_BYTES = 16_777_216;
const DEFAULT_MAX_ACTIVE_NOTIFICATIONS = 16_384;

export interface CodexAppServerContainedTurnProviderOptions {
  readonly boundary: CodexAppServerPermissionBoundary;
  readonly cancellationPollMs?: number;
  readonly effectCustody?: CodexEffectCustodyAuthority;
  readonly manifest: ContainedTurnAdapterCapabilityManifest;
  readonly maxActiveNotificationBytes?: number;
  readonly maxActiveNotifications?: number;
  readonly maxLineBytes?: number;
  readonly processes: CustodiedProviderProcessRegistry;
  readonly privateRootPath: string;
  readonly requestTimeoutMs?: number;
  readonly sensitiveOutputTokens?: readonly string[];
  readonly tmpDir: string;
  readonly turnTimeoutMs?: number;
}

const positiveInteger = (name: string, value: number | undefined, fallback: number): number => {const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected <= 0) {throw new TypeError(`${name} must be a positive integer`);}
  return selected;
};

const deadlineAfter = (milliseconds: number): number => performance.now() + milliseconds;

const beforeDeadline = async <T>(promise: Promise<T>, deadline: number, message: string): Promise<T> => {
  const remaining = deadline - performance.now();
  if (remaining <= 0) {throw new Error(message);}
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), remaining);
  });
  try {return await Promise.race([promise, timeout]);}
  finally {if (timer !== undefined) {clearTimeout(timer);}}
};


const protocolErrorCode = (error: unknown): CodexPublicEvidenceCode => error instanceof CodexAppServerProtocolError
  ? error.afterTurnRequest ? "after-turn-protocol-error" : "before-turn-protocol-error"
  : error instanceof Error ? "pre-turn-error" : "unknown-error";

const stderrEvidenceCode = (status: "drained" | "read_failed" | "unknown"): CodexPublicEvidenceCode =>
  status === "drained" ? "stderr-drained" : status === "read_failed" ? "stderr-failed" : "stderr-unknown";

export class CodexAppServerContainedTurnProvider implements ContainedTurnProviderPort {
  public readonly manifest: ContainedTurnAdapterCapabilityManifest;
  readonly #boundary: CodexAppServerPermissionBoundary;
  readonly #cancellationPollMs: number;
  readonly #effectCustody: CodexEffectCustodyAuthority | undefined;
  readonly #maxLineBytes: number;
  readonly #maxActiveNotificationBytes: number;
  readonly #maxActiveNotifications: number;
  readonly #processes: CustodiedProviderProcessRegistry;
  readonly #platformTuple: CodexAppServerPlatformTuple;
  readonly #privateRootPath: string;
  readonly #requestTimeoutMs: number;
  readonly #additionalSensitiveOutputTokens: readonly string[];
  readonly #tmpDir: string;
  readonly #turnTimeoutMs: number;

  public constructor(options: CodexAppServerContainedTurnProviderOptions) {
    options = detachCodexProviderOptions(options);
    const manifest = options.manifest;
    if (manifest.providerBinding.provider !== "codex") {
      throw new TypeError("Codex App Server adapter requires a Codex provider binding");
    }
    const binding = manifest.providerBinding;
    const platformTuple = codexAppServerTupleForBinaryRevision(binding.binaryRevision);
    if (binding.adapterRevision !== platformTuple.adapterRevision
      || binding.capabilityManifestRevision !== platformTuple.protocolRevision) {
      throw new TypeError("Codex App Server adapter requires the exact admitted implementation tuple");
    }
    if (!isAbsolute(options.tmpDir) || resolve(options.tmpDir) !== options.tmpDir || options.tmpDir === "/") {
      throw new TypeError("Codex App Server adapter requires a normalized absolute private TMPDIR");
    }
    const tmpRelativeToWorkspace = relative(options.boundary.workspaceRef, options.tmpDir);
    if (tmpRelativeToWorkspace === "" || (!tmpRelativeToWorkspace.startsWith("..") && !isAbsolute(tmpRelativeToWorkspace))) {
      throw new TypeError("Codex private TMPDIR must be outside the canonical workspace");
    }
    if (!isAbsolute(options.privateRootPath) || resolve(options.privateRootPath) !== options.privateRootPath
      || options.privateRootPath === "/") {
      throw new TypeError("Codex App Server adapter requires a normalized absolute private root");
    }
    this.#boundary = Object.freeze({
      ...options.boundary,
      permissionProfile: Object.freeze({
        ...options.boundary.permissionProfile,
        file_system: Object.freeze({
          entries: Object.freeze(options.boundary.permissionProfile.file_system.entries.map(entry => Object.freeze({ ...entry }))),
        }),
        network: Object.freeze({ ...options.boundary.permissionProfile.network }),
      }),
    });
    this.manifest = manifest;
    this.#platformTuple = platformTuple;
    this.#privateRootPath = options.privateRootPath;
    this.#processes = options.processes;
    this.#effectCustody = options.effectCustody;
    this.#maxLineBytes = positiveInteger("maxLineBytes", options.maxLineBytes, DEFAULT_MAX_LINE_BYTES);
    this.#maxActiveNotificationBytes = positiveInteger(
      "maxActiveNotificationBytes", options.maxActiveNotificationBytes, DEFAULT_MAX_ACTIVE_NOTIFICATION_BYTES,
    );
    this.#maxActiveNotifications = positiveInteger(
      "maxActiveNotifications", options.maxActiveNotifications, DEFAULT_MAX_ACTIVE_NOTIFICATIONS,
    );
    this.#requestTimeoutMs = positiveInteger("requestTimeoutMs", options.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS);
    this.#additionalSensitiveOutputTokens = Object.freeze([
      ...new Set((options.sensitiveOutputTokens ?? []).filter(token => token.length > 0)),
    ]);
    this.#tmpDir = options.tmpDir;
    this.#turnTimeoutMs = positiveInteger("turnTimeoutMs", options.turnTimeoutMs, DEFAULT_TURN_TIMEOUT_MS);
    this.#cancellationPollMs = positiveInteger("cancellationPollMs", options.cancellationPollMs, DEFAULT_CANCELLATION_POLL_MS);
  }

  async #request(
    process: CustodiedProviderProcess,
    reader: BoundedCodexJsonLineReader,
    request: JsonRecord,
    afterTurnRequest: boolean,
    notifications?: JsonRecord[],
  ): Promise<unknown> {
    const requestId = String(request.id);
    const deadline = deadlineAfter(this.#requestTimeoutMs);
    await beforeDeadline(process.write(encode(request)), deadline, "Codex App Server write timed out").catch(error => {
      throw new CodexAppServerProtocolError(error instanceof Error ? error.message : "Codex write failed", afterTurnRequest);
    });
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
      if (notifications === undefined) {
        throw new CodexAppServerProtocolError("Codex App Server emitted an unexpected pre-response notification", afterTurnRequest);
      }
      if (notifications.length >= MAX_PRE_TURN_NOTIFICATIONS) {
        throw new CodexAppServerProtocolError("Codex App Server exceeded the pre-turn notification bound", afterTurnRequest);
      }
      notifications.push(message);
    }
  }

  async #awaitActiveProfile(
    reader: BoundedCodexJsonLineReader,
    threadId: string,
    buffered: readonly JsonRecord[],
    mode: "analysis" | "workspace-write",
  ): Promise<void> {
    let active = false;
    for (const message of buffered) {
      active = observeCodexActiveProfileEvidence(message, threadId, this.#boundary, mode) || active;
    }
    if (active) {return;}
    const deadline = deadlineAfter(this.#requestTimeoutMs);
    let notificationCount = buffered.length;
    while (true) {
      const message = await reader.read(deadline);
      if (message === TIMEOUT || message === undefined) {
        throw new CodexAppServerProtocolError("Codex active permission provenance was not observed", false);
      }
      if (serverRequestMethod(message) !== undefined || "id" in message) {
        throw new CodexAppServerProtocolError("Codex emitted an unexpected message before permission proof", false);
      }
      notificationCount += 1;
      if (notificationCount > MAX_PRE_TURN_NOTIFICATIONS) {
        throw new CodexAppServerProtocolError("Codex exceeded the pre-turn notification bound before permission proof", false);
      }
      if (observeCodexActiveProfileEvidence(message, threadId, this.#boundary, mode)) {return;}
    }
  }

  async #awaitTurnCompletion(
    process: CustodiedProviderProcess,
    reader: BoundedCodexJsonLineReader,
    input: Parameters<ContainedTurnProviderPort["execute"]>[0],
    active: {
      readonly effectCustody?: CodexEffectCustodyBinding;
      readonly observeProtocolTerminal: () => void;
      readonly sensitiveOutputTokens: readonly string[];
      readonly threadId: string;
      readonly turnId: string;
    },
  ): Promise<CodexActiveTurnCompletion["status"]> {
    const progress = createCodexActiveTurnProgress();
    const deadline = deadlineAfter(this.#turnTimeoutMs);
    let nextCancellationCheck = performance.now();
    while (true) {
      if (progress.interruptRequestId === undefined && performance.now() >= nextCancellationCheck) {
        const cancellationDeadline = Math.min(deadline, deadlineAfter(this.#requestTimeoutMs));
        if (await beforeDeadline(input.isCancellationRequested(), cancellationDeadline, "Codex cancellation check timed out")) {
          progress.interruptRequestId = `${input.attemptId}:turn-interrupt`;
          const interruptDeadline = Math.min(deadline, deadlineAfter(this.#requestTimeoutMs));
          await beforeDeadline(process.write(encode({
            id: progress.interruptRequestId,
            method: "turn/interrupt",
            params: { threadId: active.threadId, turnId: active.turnId },
          })), interruptDeadline, "Codex turn interruption write timed out");
          progress.interruptDeadline = interruptDeadline;
        }
        nextCancellationCheck = performance.now() + this.#cancellationPollMs;
      }
      const pollDeadline = progress.interruptRequestId === undefined
        ? Math.min(deadline, nextCancellationCheck)
        : Math.min(deadline, progress.interruptDeadline ?? deadline);
      const message = await reader.read(pollDeadline);
      if (message === TIMEOUT) {
        if (performance.now() >= deadline) {throw new CodexAppServerProtocolError("Codex turn timed out", true);}
        if (progress.interruptDeadline !== undefined && performance.now() >= progress.interruptDeadline) {
          throw new CodexAppServerProtocolError("Codex turn interruption timed out", true);
        }
        continue;
      }
      if (message === undefined) {throw new CodexAppServerProtocolError("Codex App Server closed before turn completion", true);}
      const completed = await beforeDeadline(
        handleCodexActiveMessage({
          boundary: this.#boundary,
          ...(active.effectCustody === undefined ? {} : { effectCustody: active.effectCustody }),
          emitInput: input,
          message,
          maxNotificationBytes: this.#maxActiveNotificationBytes,
          maxNotifications: this.#maxActiveNotifications,
          mode: input.intent.mode,
          observeProtocolTerminal: active.observeProtocolTerminal,
          progress,
          sensitiveOutputTokens: active.sensitiveOutputTokens,
          threadId: active.threadId,
          turnId: active.turnId,
        }),
        deadline,
        "Codex active message handling timed out",
      );
      if (completed !== undefined) {return completed.status;}
    }
  }

  async #closeAfterFailure(input: {
    readonly error: unknown;
    readonly process: CustodiedProviderProcess;
    readonly protocolTerminalObserved: boolean;
    readonly reader: BoundedCodexJsonLineReader;
    readonly stderrDrain: ReturnType<typeof drainCodexStderr>;
    readonly turnRequestWritten: boolean;
    readonly identity: CodexReceiptIdentity;
  }): Promise<CodexAppServerExecutionOutcome> {
    const noStart = !input.turnRequestWritten
      ? await proveCodexNoStart({ process: input.process, reader: input.reader,
        stderrDrain: input.stderrDrain, timeoutMs: this.#requestTimeoutMs })
      : { proven: false, stderrStatus: "unknown" as const };
    const inputClosed = input.turnRequestWritten && await closeCodexInputBounded(input.process, this.#requestTimeoutMs);
    const stderrStatus = input.turnRequestWritten
      ? await observeCodexStderrBounded(input.stderrDrain, this.#requestTimeoutMs) : noStart.stderrStatus;
    if (!input.turnRequestWritten && noStart.proven) {
      return codexNotAccepted({ identity: input.identity, reason: input.error instanceof CodexAppServerProtocolError
        ? "before-turn-protocol-error" : input.error instanceof Error ? "pre-turn-error" : "unknown-error" });
    }
    if (input.error instanceof CodexAppServerProtocolError && !input.error.afterTurnRequest && noStart.proven) {
      return codexNotAccepted({ identity: input.identity, reason: "before-turn-protocol-error" });
    }
    return codexContainmentRequired(input.identity, [
        input.turnRequestWritten ? "turn-request-written" : "turn-request-missing",
        input.protocolTerminalObserved ? "protocol-terminal-observed" : "protocol-terminal-missing",
        noStart.proven ? "no-start-proved" : "no-start-disproved",
        stderrEvidenceCode(stderrStatus),
        inputClosed ? "input-close-succeeded" : "input-close-failed",
        protocolErrorCode(input.error),
      ], input.protocolTerminalObserved);
  }

  public async execute(input: Parameters<ContainedTurnProviderPort["execute"]>[0]): Promise<CodexAppServerExecutionOutcome> {
    input = detachCodexExecutionInput(input);
    const identity = Object.freeze({
      attemptId: input.attemptId,
      effectId: input.effectId,
      operationId: input.operationId,
      platformTuple: this.#platformTuple,
    });
    let process: CustodiedProviderProcess | undefined;
    try {
      process = this.#processes.get(input.custody.custodyRef);
    } catch {
      return codexContainmentRequired(identity, ["custody-process-lookup-failed"]);
    }
    if (process === undefined) {
      return { evidenceRef: codexReceipt("codex-custody-process-missing", identity, ["custody-process-missing"]), kind: "ambiguous" };
    }
    let reader: BoundedCodexJsonLineReader;
    try {
      reader = new BoundedCodexJsonLineReader(process.stdout, this.#maxLineBytes);
    } catch {
      return codexContainmentRequired(identity, ["stdout-stream-unavailable"]);
    }
    const stderrDrain = drainCodexStderr(process);
    const preTurnNotifications: JsonRecord[] = [];
    let turnRequestWritten = false;
    let protocolTerminalObserved = false;
    let threadId: string | undefined; let turnId: string | undefined;
    let sensitiveOutputTokens: readonly string[] = this.#additionalSensitiveOutputTokens;
    try {
      sensitiveOutputTokens = Object.freeze([...new Set([
        this.#boundary.codexHome,
        this.#privateRootPath,
        this.#tmpDir,
        this.#boundary.workspaceRef,
        ...this.#additionalSensitiveOutputTokens,
      ].filter((token): token is string => typeof token === "string" && token.length > 0))]);
      if (input.workspaceRef !== this.#boundary.workspaceRef) {
        throw new CodexAppServerProtocolError("Codex workspace does not match the immutable permission boundary", false);
      }
      if (sensitiveOutputTokens.some(token => input.intent.prompt.includes(token))) {
        throw new CodexAppServerProtocolError("Codex prompt contains a private path or marker", false);
      }
      const initializeResult = await this.#request(process, reader, {
        id: `${input.attemptId}:initialize`,
        method: "initialize",
        params: {
          capabilities: { experimentalApi: false, requestAttestation: false },
          clientInfo: {
            name: this.#platformTuple.clientName,
            title: "Agent Runtime",
            version: this.#platformTuple.adapterRevision,
          },
        },
      }, false, preTurnNotifications);
      validateCodexInitializeEvidence(initializeResult, this.#boundary, this.#platformTuple);
      await beforeDeadline(
        process.write(encode({ method: "initialized" })),
        deadlineAfter(this.#requestTimeoutMs),
        "Codex initialized write timed out",
      );
      const configResult = await this.#request(process, reader, {
        id: `${input.attemptId}:config-read`,
        method: "config/read",
        params: { cwd: input.workspaceRef, includeLayers: true },
      }, false, preTurnNotifications);
      validateCodexConfigEvidence(configResult, this.#boundary);
      const profileResult = await this.#request(process, reader, {
        id: `${input.attemptId}:permission-profiles`,
        method: "permissionProfile/list",
        params: { cwd: input.workspaceRef },
      }, false, preTurnNotifications);
      validateCodexPermissionProfileEvidence(profileResult, this.#boundary);
      const threadResult = await this.#request(process, reader, {
        id: `${input.attemptId}:thread-start`,
        method: "thread/start",
        params: {
          approvalPolicy: "never",
          config: codexContainedThreadConfig(),
          cwd: input.workspaceRef,
          ephemeral: true,
          sandbox: codexThreadSandbox(input.intent.mode),
        },
      }, false, preTurnNotifications);
      threadId = parseCodexThreadId(threadResult);
      await this.#awaitActiveProfile(reader, threadId, preTurnNotifications, input.intent.mode);
      turnRequestWritten = true;
      const turnResult = await this.#request(process, reader, {
        id: `${input.attemptId}:turn-start`,
        method: "turn/start",
        params: {
          approvalPolicy: "never",
          cwd: input.workspaceRef,
          input: [{ text: input.intent.prompt, text_elements: [], type: "text" }],
          sandboxPolicy: codexTurnSandboxPolicy(input.intent.mode, input.workspaceRef),
          threadId,
        },
      }, true);
      turnId = parseCodexTurn(turnResult).id;
      const effectCustody = this.#effectCustody === undefined ? undefined : Object.freeze({
        authority: this.#effectCustody,
        execution: Object.freeze({
          attemptId: input.attemptId,
          custodyRef: input.custody.custodyRef,
          effectId: input.effectId,
          operationId: input.operationId,
          workspaceRef: input.workspaceRef,
        }),
      });
      const completionStatus = await this.#awaitTurnCompletion(
        process,
        reader,
        input,
        { ...(effectCustody === undefined ? {} : { effectCustody }), observeProtocolTerminal: () => {protocolTerminalObserved = true;},
          sensitiveOutputTokens, threadId, turnId },
      );
      await proveCodexOutputDrain({ process, reader, stderrDrain, timeoutMs: this.#requestTimeoutMs });
      return completedCodexOutcome({ identity, status: completionStatus });
    } catch (error) {
      return this.#closeAfterFailure({ error, identity, process, protocolTerminalObserved,
        reader, stderrDrain, turnRequestWritten });
    }
  }
}
