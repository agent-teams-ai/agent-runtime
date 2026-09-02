import type { ContainedTurnProviderPort } from "../legacy/legacy-contained-turn-ports.js";
import {
  CodexAppServerProtocolError,
  codexNotificationMethod as notificationMethod,
  codexServerRequestMethod as serverRequestMethod,
  codexStringField as stringField,
  isCodexRecord as isRecord,
  type CodexJsonRecord as JsonRecord,
} from "./codex-app-server-jsonl.js";
import { canonicalCodexJson, type CodexAppServerPermissionBoundary } from "./codex-app-server-permission-boundary.js";
import type { CodexEffectCustodyBinding } from "./codex-app-server-effect-custody.js";
import {
  assertCodexCanonicalOutputAllowed,
  codexTerminalOutputText,
  type CodexCanonicalOutputPolicy,
} from "./codex-app-server-output-policy.js";
import {
  admitCodexActiveNotification,
  createCodexActiveTurnProgress,
  type CodexActiveTurnCompletion,
  type CodexActiveTurnProgress,
} from "./codex-app-server-notification-evidence.js";
import { admitCodexThreadItem, applyCodexPassiveItemNotification, reconcileCodexCompletedThreadItem, reconcileCodexTerminalThreadItems } from "./codex-app-server-thread-item.js";

export { createCodexActiveTurnProgress, type CodexActiveTurnCompletion };

const exactKeys = (value: JsonRecord, keys: readonly string[]): boolean =>
  Object.keys(value).toSorted().join("\0") === [...keys].toSorted().join("\0");

const exactNotificationEnvelope = (message: JsonRecord): boolean =>
  exactKeys(message, ["method", "params"])
  || (exactKeys(message, ["emittedAtMs", "method", "params"]) && Number.isSafeInteger(message.emittedAtMs));

const CODEX_ERROR_CODES = new Set([
  "badRequest", "contextWindowExceeded", "cyberPolicy", "internalServerError", "misalignmentPolicyViolation",
  "other", "sandboxError", "serverOverloaded", "sessionBudgetExceeded", "threadRollbackFailed", "unauthorized",
  "usageLimitExceeded",
]);

const exactCodexErrorInfo = (value: unknown): boolean => {
  if (typeof value === "string") {return CODEX_ERROR_CODES.has(value);}
  if (!isRecord(value) || Object.keys(value).length !== 1) {return false;}
  const [kind] = Object.keys(value);
  const detail = kind === undefined ? undefined : value[kind];
  if (kind === "activeTurnNotSteerable") {
    return isRecord(detail) && exactKeys(detail, ["turnKind"]) && ["compact", "review"].includes(String(detail.turnKind));
  }
  return ["httpConnectionFailed", "responseStreamConnectionFailed", "responseStreamDisconnected", "responseTooManyFailedAttempts"].includes(kind ?? "")
    && isRecord(detail) && exactKeys(detail, ["httpStatusCode"])
    && (detail.httpStatusCode === null || (Number.isSafeInteger(detail.httpStatusCode)
      && Number(detail.httpStatusCode) >= 0));
};

const exactTurnError = (value: unknown): value is JsonRecord => isRecord(value)
  && exactKeys(value, ["additionalDetails", "codexErrorInfo", "message"])
  && typeof value.message === "string"
  && (value.additionalDetails === null || typeof value.additionalDetails === "string")
  && (value.codexErrorInfo === null || exactCodexErrorInfo(value.codexErrorInfo));

const nullableGeneratedInteger = (value: unknown): boolean =>
  value === null || Number.isSafeInteger(value);

const exactTurnStatusFields = (turn: JsonRecord, status: string): boolean => {
  if (!nullableGeneratedInteger(turn.startedAt)
    || !nullableGeneratedInteger(turn.completedAt)
    || !(turn.durationMs === null
      || (Number.isSafeInteger(turn.durationMs) && Number(turn.durationMs) >= 0))) {return false;}
  if (status === "inProgress") {
    return turn.completedAt === null && turn.durationMs === null && turn.error === null;
  }
  if (!Number.isSafeInteger(turn.completedAt) || !Number.isSafeInteger(turn.durationMs)
    || Number(turn.durationMs) < 0) {return false;}
  return status === "failed" ? exactTurnError(turn.error) : turn.error === null;
};

type PassiveShape = {
  readonly itemType?: string;
  readonly keys: readonly string[];
  readonly validate: (params: JsonRecord) => boolean;
};

const strings = (params: JsonRecord, fields: readonly string[]): boolean =>
  fields.every(field => typeof params[field] === "string");

const exactTokenBreakdown = (value: unknown): boolean => isRecord(value)
  && exactKeys(value, ["cacheWriteInputTokens", "cachedInputTokens", "inputTokens", "outputTokens", "reasoningOutputTokens", "totalTokens"])
  && Object.values(value).every(entry => Number.isSafeInteger(entry) && Number(entry) >= 0);

const exactThreadTokenUsage = (value: unknown): boolean => isRecord(value)
  && exactKeys(value, ["last", "modelContextWindow", "total"])
  && exactTokenBreakdown(value.last) && exactTokenBreakdown(value.total)
  && (value.modelContextWindow === null
    || (Number.isSafeInteger(value.modelContextWindow) && Number(value.modelContextWindow) >= 0));

const exactFileUpdateChange = (value: unknown): boolean => {
  if (!isRecord(value) || !exactKeys(value, ["diff", "kind", "path"]) || !strings(value, ["diff", "path"])
    || !isRecord(value.kind) || typeof value.kind.type !== "string") {return false;}
  return ["add", "delete"].includes(value.kind.type) ? exactKeys(value.kind, ["type"])
    : value.kind.type === "update" && exactKeys(value.kind, ["move_path", "type"])
      && (value.kind.move_path === null || typeof value.kind.move_path === "string");
};

const exactThreadStatus = (value: unknown): boolean => {
  if (!isRecord(value) || typeof value.type !== "string") {return false;}
  if (["idle", "notLoaded", "systemError"].includes(value.type)) {return exactKeys(value, ["type"]);}
  return value.type === "active" && exactKeys(value, ["activeFlags", "type"]) && Array.isArray(value.activeFlags)
    && value.activeFlags.every(flag => ["waitingOnApproval", "waitingOnUserInput"].includes(String(flag)));
};

const itemShape = (keys: readonly string[], itemType: string, validate: (params: JsonRecord) => boolean): PassiveShape => ({
  itemType, keys, validate,
});

const PASSIVE_SHAPES: Readonly<Record<string, PassiveShape>> = Object.freeze({
  "item/commandExecution/outputDelta": itemShape(["delta", "itemId", "threadId", "turnId"], "commandExecution", p => strings(p, ["delta"])),
  "item/commandExecution/terminalInteraction": itemShape(["itemId", "processId", "stdin", "threadId", "turnId"], "commandExecution", p => strings(p, ["processId", "stdin"])),
  "item/fileChange/outputDelta": itemShape(["delta", "itemId", "threadId", "turnId"], "fileChange", p => strings(p, ["delta"])),
  "item/fileChange/patchUpdated": itemShape(["changes", "itemId", "threadId", "turnId"], "fileChange", p => Array.isArray(p.changes) && p.changes.every(exactFileUpdateChange)),
  "item/mcpToolCall/progress": itemShape(["itemId", "message", "threadId", "turnId"], "mcpToolCall", p => strings(p, ["message"])),
  "item/plan/delta": itemShape(["delta", "itemId", "threadId", "turnId"], "plan", p => strings(p, ["delta"])),
  "item/reasoning/summaryPartAdded": itemShape(["itemId", "summaryIndex", "threadId", "turnId"], "reasoning", p => Number.isSafeInteger(p.summaryIndex) && Number(p.summaryIndex) >= 0),
  "item/reasoning/summaryTextDelta": itemShape(["delta", "itemId", "summaryIndex", "threadId", "turnId"], "reasoning", p => Number.isSafeInteger(p.summaryIndex) && Number(p.summaryIndex) >= 0 && strings(p, ["delta"])),
  "item/reasoning/textDelta": itemShape(["contentIndex", "delta", "itemId", "threadId", "turnId"], "reasoning", p => Number.isSafeInteger(p.contentIndex) && Number(p.contentIndex) >= 0 && strings(p, ["delta"])),
  "rawResponse/completed": { keys: ["responseId", "threadId", "turnId", "usage"], validate: p => strings(p, ["responseId"]) && (p.usage === null || exactTokenBreakdown(p.usage)) },
  "thread/status/changed": { keys: ["status", "threadId"], validate: p => exactThreadStatus(p.status) },
  "thread/tokenUsage/updated": { keys: ["threadId", "tokenUsage", "turnId"], validate: p => exactThreadTokenUsage(p.tokenUsage) },
  "turn/diff/updated": { keys: ["diff", "threadId", "turnId"], validate: p => strings(p, ["diff"]) },
  "turn/plan/updated": { keys: ["explanation", "plan", "threadId", "turnId"], validate: p => (p.explanation === null || typeof p.explanation === "string") && Array.isArray(p.plan) && p.plan.every(step => isRecord(step) && exactKeys(step, ["status", "step"]) && typeof step.step === "string" && ["completed", "inProgress", "pending"].includes(String(step.status))) },
  warning: { keys: ["message", "threadId"], validate: p => typeof p.message === "string" && (p.threadId === null || typeof p.threadId === "string") },
});

const validatePassiveNotification = (
  method: string,
  params: JsonRecord,
  threadId: string,
  turnId: string,
  progress: CodexActiveTurnProgress,
): void => {
  const shape = PASSIVE_SHAPES[method];
  if (shape === undefined || !exactKeys(params, shape.keys) || !shape.validate(params)) {
    throw new CodexAppServerProtocolError(`unexpected or malformed Codex active notification ${method}`, true);
  }
  if ("threadId" in params && params.threadId !== null && params.threadId !== threadId) {
    throw new CodexAppServerProtocolError("Codex active notification thread identity changed", true);
  }
  if ("turnId" in params && params.turnId !== turnId) {
    throw new CodexAppServerProtocolError("Codex active notification turn identity changed", true);
  }
  if (shape.itemType !== undefined) {
    const itemId = stringField(params, "itemId");
    if (itemId === undefined || progress.activeItems.get(itemId)?.type !== shape.itemType) {
      throw new CodexAppServerProtocolError("Codex passive item notification was not correlated to its active item", true);
    }
  }
};

const rawResponseReplayKey = (
  method: string,
  params: JsonRecord,
  progress: CodexActiveTurnProgress,
): void => {
  if (method !== "rawResponse/completed") {return;}
  const responseId = stringField(params, "responseId");
  if (responseId === undefined || responseId.length === 0) {
    throw new CodexAppServerProtocolError("Codex raw response identity is invalid", true);
  }
  const immutableSemantics = canonicalCodexJson({
    responseId,
    threadId: params.threadId,
    turnId: params.turnId,
  });
  const observed = progress.observedResponseSemantics.get(responseId);
  if (observed !== undefined) {
    throw new CodexAppServerProtocolError("Codex replayed a raw response identity", true);
  }
  progress.observedResponseSemantics.set(responseId, immutableSemantics);
};

export const parseCodexThreadId = (result: unknown): string => {
  if (!isRecord(result) || !isRecord(result.thread)) {
    throw new Error("Codex thread/start result is invalid");
  }
  const threadId = stringField(result.thread, "id");
  if (threadId === undefined || threadId.length === 0) {
    throw new Error("Codex thread/start returned no thread identity");
  }
  return threadId;
};

export const parseCodexTurn = (result: unknown): { readonly id: string; readonly status: string } => {
  if (!isRecord(result) || !isRecord(result.turn)) {throw new Error("Codex turn result is invalid");}
  const turn = result.turn;
  const id = stringField(turn, "id");
  const status = stringField(turn, "status");
  const turnKeys = ["completedAt", "durationMs", "error", "id", "items", "itemsView", "startedAt", "status"];
  if (id === undefined || id.length === 0 || status === undefined
    || !["completed", "failed", "inProgress", "interrupted"].includes(status)
    || !Array.isArray(turn.items) || !["full", "notLoaded", "summary"].includes(String(turn.itemsView))
    || !exactTurnStatusFields(turn, status)
    || Object.keys(turn).toSorted().join("\0") !== turnKeys.join("\0")) {
    throw new Error("Codex turn result does not match the generated 0.150.1 shape");
  }
  return { id, status };
};

type CodexDiagnosticCode =
  | "codex-provider-error-notification-redacted/v1"
  | "codex-provider-terminal-failure-redacted/v1";

const CODEX_DIAGNOSTIC_CODES = Object.freeze({
  errorNotification: "codex-provider-error-notification-redacted/v1",
  terminalFailure: "codex-provider-terminal-failure-redacted/v1",
} satisfies Readonly<Record<string, CodexDiagnosticCode>>);

const emitCodexError = async (
  params: JsonRecord,
  input: Parameters<ContainedTurnProviderPort["execute"]>[0],
  threadId: string,
  turnId: string,
  progress: CodexActiveTurnProgress,
): Promise<void> => {
  if (!exactKeys(params, ["error", "threadId", "turnId", "willRetry"])
    || params.threadId !== threadId || params.turnId !== turnId || typeof params.willRetry !== "boolean"
    || !exactTurnError(params.error)) {
    throw new CodexAppServerProtocolError("Codex error notification identity is invalid", true);
  }
  await input.emit({
    cursor: progress.cursor,
    kind: "diagnostic",
    text: CODEX_DIAGNOSTIC_CODES.errorNotification,
  });
  progress.cursor += 1;
};

const emitCodexAssistantDelta = (
  params: JsonRecord,
  admission: {
    readonly outputPolicy: CodexCanonicalOutputPolicy;
    readonly progress: CodexActiveTurnProgress;
    readonly threadId: string;
    readonly turnId: string;
  },
): void => {
  if (!exactKeys(params, ["delta", "itemId", "threadId", "turnId"])
    || params.threadId !== admission.threadId || params.turnId !== admission.turnId
    || params.itemId !== admission.progress.activeAgentItemId || typeof params.delta !== "string") {
    throw new CodexAppServerProtocolError("Codex assistant delta identity is invalid", true);
  }
  const combined = admission.progress.pendingAssistantText + params.delta;
  const canonical = admission.progress.pendingCanonicalAssistantText + combined;
  assertCodexCanonicalOutputAllowed(canonical, admission.outputPolicy);
  admission.progress.pendingAssistantText = combined;
  const active = admission.progress.activeItems.get(String(params.itemId));
  if (active === undefined || active.type !== "agentMessage") {
    throw new CodexAppServerProtocolError("Codex assistant lifecycle state is invalid", true);
  }
  active.item.text = combined;
};

const flushCodexAssistantText = async (
  input: Parameters<ContainedTurnProviderPort["execute"]>[0],
  progress: CodexActiveTurnProgress,
  outputPolicy: CodexCanonicalOutputPolicy,
): Promise<void> => {
  const pending = progress.pendingCanonicalAssistantText;
  if (pending.length === 0) {return;}
  progress.pendingCanonicalAssistantText = "";
  const admitted = codexTerminalOutputText(pending, outputPolicy.exactSensitiveTokens);
  if (admitted.length === 0) {return;}
  await input.emit({ cursor: progress.cursor, kind: "assistant", text: admitted });
  progress.cursor += 1;
};

const observeTurnStarted = (params: JsonRecord, threadId: string, turnId: string, progress: CodexActiveTurnProgress): void => {
  if (progress.turnStarted || !exactKeys(params, ["threadId", "turn"]) || params.threadId !== threadId) {
    throw new CodexAppServerProtocolError("Codex turn/started lifecycle is invalid", true);
  }
  const started = parseCodexTurn(params);
  if (started.id !== turnId || started.status !== "inProgress") {
    throw new CodexAppServerProtocolError("Codex turn/started identity or status is invalid", true);
  }
  progress.turnStarted = true;
};

const observeItemStarted = (
  params: JsonRecord,
  identity: { readonly boundary: CodexAppServerPermissionBoundary; readonly effectCustody?: CodexEffectCustodyBinding;
    readonly mode: "analysis" | "workspace-write"; readonly threadId: string; readonly turnId: string },
  progress: CodexActiveTurnProgress,
): void => {
  if (!progress.turnStarted || !exactKeys(params, ["item", "startedAtMs", "threadId", "turnId"])
    || params.threadId !== identity.threadId || params.turnId !== identity.turnId || !Number.isSafeInteger(params.startedAtMs)
    || !isRecord(params.item)) {
    throw new CodexAppServerProtocolError("Codex item/started lifecycle is invalid", true);
  }
  const admitted = admitCodexThreadItem(params.item, identity.mode, identity.boundary, identity.effectCustody);
  const { id: itemId, type: itemType } = admitted;
  if (["commandExecution", "fileChange"].includes(itemType) && admitted.item.status !== "inProgress") {
    throw new CodexAppServerProtocolError("Codex effectful item did not start in progress", true);
  }
  if (progress.observedItemIds.has(itemId)) {
    throw new CodexAppServerProtocolError("Codex item/started identity is invalid", true);
  }
  if (itemType === "agentMessage") {
    if (progress.activeAgentItemId !== undefined
      || admitted.item.text !== "") {
      throw new CodexAppServerProtocolError("Codex agent-message item/start shape is invalid", true);
    }
    progress.activeAgentItemId = itemId;
    progress.pendingAssistantText = "";
  }
  progress.observedItemIds.add(itemId);
  progress.activeItems.set(itemId, { ...admitted, item: structuredClone(admitted.item) });
};

const observeItemCompleted = async (
  params: JsonRecord,
  input: Parameters<ContainedTurnProviderPort["execute"]>[0],
  identity: { readonly boundary: CodexAppServerPermissionBoundary; readonly mode: "analysis" | "workspace-write";
    readonly effectCustody?: CodexEffectCustodyBinding; readonly outputPolicy: CodexCanonicalOutputPolicy;
    readonly threadId: string; readonly turnId: string },
  progress: CodexActiveTurnProgress,
): Promise<void> => {
  if (!exactKeys(params, ["completedAtMs", "item", "threadId", "turnId"])
    || params.threadId !== identity.threadId || params.turnId !== identity.turnId || !Number.isSafeInteger(params.completedAtMs)
    || !isRecord(params.item)) {
    throw new CodexAppServerProtocolError("Codex item/completed lifecycle is invalid", true);
  }
  const itemId = params.item.id;
  const itemType = params.item.type;
  if (typeof itemId !== "string" || typeof itemType !== "string") {
    throw new CodexAppServerProtocolError("Codex item/completed identity is invalid", true);
  }
  const active = progress.activeItems.get(itemId);
  if (active?.type !== itemType) {
    throw new CodexAppServerProtocolError("Codex item/completed identity was not started", true);
  }
  const admitted = admitCodexThreadItem(
    params.item,
    identity.mode,
    identity.boundary,
    identity.effectCustody,
    { phase: "completed", ...(active.effectCustodyAdmission === undefined
      ? {} : { priorAdmission: active.effectCustodyAdmission }) },
  );
  if (!reconcileCodexCompletedThreadItem(active, admitted)) {
    throw new CodexAppServerProtocolError("Codex completed item payload did not match its observed lifecycle", true);
  }
  if (itemType === "agentMessage") {
    if (itemId !== progress.activeAgentItemId
      || admitted.item.text !== progress.pendingAssistantText) {
      throw new CodexAppServerProtocolError("Codex completed agent message does not match its exact delta lifecycle", true);
    }
    progress.pendingCanonicalAssistantText += progress.pendingAssistantText;
    progress.pendingAssistantText = "";
    delete progress.activeAgentItemId;
  }
  progress.completedItems.push(admitted);
  progress.activeItems.delete(itemId);
};

const terminalLifecycleClosed = (progress: CodexActiveTurnProgress): boolean =>
  progress.turnStarted && progress.activeItems.size === 0
  && progress.activeAgentItemId === undefined && progress.pendingAssistantText.length === 0;

const completeCodexTurn = async (
  params: JsonRecord,
  input: Parameters<ContainedTurnProviderPort["execute"]>[0],
  threadId: string,
  turnId: string,
  lifecycle: {
    readonly boundary: CodexAppServerPermissionBoundary; readonly observeProtocolTerminal: () => void;
    readonly effectCustody?: CodexEffectCustodyBinding; readonly progress: CodexActiveTurnProgress;
    readonly outputPolicy: CodexCanonicalOutputPolicy;
  },
): Promise<CodexActiveTurnCompletion> => {
  if (!exactKeys(params, ["threadId", "turn"]) || params.threadId !== threadId) {
    throw new CodexAppServerProtocolError("Codex terminal thread identity changed", true);
  }
  const completed = parseCodexTurn(params);
  if (completed.id !== turnId || !["completed", "failed", "interrupted"].includes(completed.status)) {
    throw new CodexAppServerProtocolError("Codex terminal turn identity or status is invalid", true);
  }
  if (!terminalLifecycleClosed(lifecycle.progress)) {
    throw new CodexAppServerProtocolError("Codex terminal turn did not close the exact item lifecycle", true);
  }
  if (!isRecord(params.turn) || params.turn.itemsView !== "full"
    || !reconcileCodexTerminalThreadItems(params.turn.items, lifecycle.progress.completedItems,
      input.intent.mode, lifecycle.boundary, lifecycle.effectCustody)) {
    throw new CodexAppServerProtocolError("Codex terminal turn items did not reconcile with the observed lifecycle", true);
  }
  if (completed.status === "interrupted"
    && (lifecycle.progress.interruptRequestId === undefined || !lifecycle.progress.interruptAcknowledged)) {
    throw new CodexAppServerProtocolError(
      "Codex interrupted status lacks the exact AR cancellation-derived interrupt acknowledgement",
      true,
    );
  }
  if (lifecycle.progress.interruptRequestId !== undefined && !lifecycle.progress.interruptAcknowledged) {
    throw new CodexAppServerProtocolError("Codex turn completed before exact interruption acknowledgement", true);
  }
  lifecycle.observeProtocolTerminal();
  try {
    assertCodexCanonicalOutputAllowed(lifecycle.progress.pendingCanonicalAssistantText, lifecycle.outputPolicy);
    await flushCodexAssistantText(input, lifecycle.progress, lifecycle.outputPolicy);
  } finally {
    lifecycle.progress.pendingCanonicalAssistantText = "";
  }
  if (completed.status === "failed") {
    await input.emit({
      cursor: lifecycle.progress.cursor,
      kind: "diagnostic",
      text: CODEX_DIAGNOSTIC_CODES.terminalFailure,
    });
    lifecycle.progress.cursor += 1;
  }
  return Object.freeze({ status: completed.status as CodexActiveTurnCompletion["status"] });
};

export const handleCodexActiveMessage = async (input: {
  readonly boundary: CodexAppServerPermissionBoundary;
  readonly effectCustody?: CodexEffectCustodyBinding;
  readonly emitInput: Parameters<ContainedTurnProviderPort["execute"]>[0];
  readonly message: JsonRecord;
  readonly maxNotificationBytes: number;
  readonly maxNotifications: number;
  readonly mode: "analysis" | "workspace-write";
  readonly observeProtocolTerminal: () => void;
  readonly progress: CodexActiveTurnProgress;
  readonly outputPolicy: CodexCanonicalOutputPolicy;
  readonly threadId: string;
  readonly turnId: string;
}): Promise<CodexActiveTurnCompletion | undefined> => {
  const serverMethod = serverRequestMethod(input.message);
  if (serverMethod !== undefined) {
    throw new CodexAppServerProtocolError(`unexpected Codex server request ${serverMethod}`, true);
  }
  if ("id" in input.message) {
    observeInterruptResponse(input.message, input.progress);
    return undefined;
  }
  const method = notificationMethod(input.message);
  if (method === undefined || !isRecord(input.message.params) || !exactNotificationEnvelope(input.message)) {
    throw new CodexAppServerProtocolError("Codex active notification is malformed", true);
  }
  const params = input.message.params;
  if (method === "error") {
    if (!exactKeys(params, ["error", "threadId", "turnId", "willRetry"]) || !exactTurnError(params.error)) {
      throw new CodexAppServerProtocolError("Codex error notification shape is invalid", true);
    }
  } else if (Object.hasOwn(PASSIVE_SHAPES, method)) {
    validatePassiveNotification(method, params, input.threadId, input.turnId, input.progress);
    rawResponseReplayKey(method, params, input.progress);
  }
  admitCodexActiveNotification(input);
  if (method === "turn/started") {
    observeTurnStarted(params, input.threadId, input.turnId, input.progress);
    return undefined;
  }
  if (method === "item/started") {
    observeItemStarted(params, input, input.progress);
    return undefined;
  }
  if (method === "item/completed") {
    await observeItemCompleted(params, input.emitInput, input, input.progress);
    return undefined;
  }
  if (method === "error") {
    await emitCodexError(params, input.emitInput, input.threadId, input.turnId, input.progress);
    return undefined;
  }
  if (method === "item/agentMessage/delta") {
    emitCodexAssistantDelta(params, {
      outputPolicy: input.outputPolicy,
      progress: input.progress,
      threadId: input.threadId,
      turnId: input.turnId,
    });
    return undefined;
  }
  if (method === "turn/completed") {
    return completeCodexTurn(
      params,
      input.emitInput,
      input.threadId,
      input.turnId,
      { boundary: input.boundary, ...(input.effectCustody === undefined ? {} : { effectCustody: input.effectCustody }),
        observeProtocolTerminal: input.observeProtocolTerminal, progress: input.progress,
        outputPolicy: input.outputPolicy },
    );
  }
  if (!Object.hasOwn(PASSIVE_SHAPES, method)) {
    throw new CodexAppServerProtocolError(`unexpected Codex active notification ${method}`, true);
  }
  applyCodexPassiveItemNotification(method, params, input.progress, input.boundary, input.effectCustody);
  return undefined;
};

const observeInterruptResponse = (message: JsonRecord, progress: CodexActiveTurnProgress): void => {
  if (message.id !== progress.interruptRequestId || progress.interruptAcknowledged) {
    throw new CodexAppServerProtocolError("Codex App Server returned an unexpected response identity", true);
  }
  if (isRecord(message.error)) {throw new CodexAppServerProtocolError("Codex rejected turn interruption", true);}
  if (!isRecord(message.result) || Object.keys(message.result).length !== 0) {
    throw new CodexAppServerProtocolError("Codex turn interruption acknowledgement is malformed", true);
  }
  progress.interruptAcknowledged = true;
  progress.interruptDeadline = undefined;
};
