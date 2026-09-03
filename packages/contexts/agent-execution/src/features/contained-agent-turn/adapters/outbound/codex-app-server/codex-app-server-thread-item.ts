import {
  CodexAppServerProtocolError,
  isCodexRecord as isRecord,
  type CodexJsonRecord as JsonRecord,
} from "./codex-app-server-jsonl.js";
import type { CodexAppServerPermissionBoundary } from "./codex-app-server-permission-boundary.js";
import type { CodexEffectCustodyBinding } from "./codex-app-server-effect-custody.js";
import { validateAndNormalizeCodexThreadItem } from "./codex-app-server-item-schema.js";
import {
  type CodexEndpointPathObservation,
} from "./codex-app-server-path-identity.js";
import {
  bindCommandExecutionPaths,
  bindEffectCustody,
  bindFileChangePaths,
  bindSafeItemPaths,
} from "./codex-app-server-thread-item-custody.js";

export { applyCodexPassiveItemNotification } from "./codex-app-server-thread-item-lifecycle.js";

const exactKeys = (value: JsonRecord, keys: readonly string[]): boolean =>
  Object.keys(value).toSorted().join("\0") === [...keys].toSorted().join("\0");

const optionalKeys = (value: JsonRecord, required: readonly string[], optional: readonly string[]): boolean => {
  const keys = Object.keys(value);
  return required.every(key => keys.includes(key))
    && keys.every(key => required.includes(key) || optional.includes(key));
};

const strings = (value: JsonRecord, keys: readonly string[]): boolean =>
  keys.every(key => typeof value[key] === "string");

export const CODEX_THREAD_ITEM_UNION_TYPES = Object.freeze([
  "agentMessage", "collabAgentToolCall", "commandExecution", "contextCompaction", "dynamicToolCall",
  "enteredReviewMode", "exitedReviewMode", "fileChange", "hookPrompt", "imageGeneration", "imageView",
  "mcpToolCall", "plan", "reasoning", "sleep", "subAgentActivity", "userMessage", "webSearch",
] as const);

const threadItemShape = (
  requiredKeys: readonly string[],
  optionalShapeKeys: readonly string[] = [],
  defaults: Readonly<Record<string, unknown>> = {},
) => Object.freeze({
  allowedKeys: Object.freeze([...requiredKeys, ...optionalShapeKeys].toSorted()),
  decoderAllowsAdditionalProperties: false as const,
  defaults: Object.freeze(defaults),
  optionalKeys: Object.freeze([...optionalShapeKeys].toSorted()),
  requiredKeys: Object.freeze([...requiredKeys].toSorted()),
  schemaAllowsAdditionalProperties: true,
});

/** Static decoder contract checked byte-for-byte against the pinned 0.150.1 ThreadItem union in tests. */
export const CODEX_THREAD_ITEM_DECODER_AUTHORITY = Object.freeze({
  agentMessage: threadItemShape(["id", "text", "type"], ["delivery", "memoryCitation", "phase"],
    { delivery: null, memoryCitation: null, phase: null }),
  collabAgentToolCall: threadItemShape(
    ["agentsStates", "id", "receiverThreadIds", "senderThreadId", "status", "tool", "type"],
    ["model", "prompt", "reasoningEffort"],
  ),
  commandExecution: threadItemShape(["command", "commandActions", "cwd", "id", "status", "type"],
    ["aggregatedOutput", "durationMs", "exitCode", "pluginId", "processId", "scriptPath", "source"],
    { pluginId: null, scriptPath: null, source: "agent" }),
  contextCompaction: threadItemShape(["id", "type"]),
  dynamicToolCall: threadItemShape(["arguments", "id", "status", "tool", "type"],
    ["contentItems", "durationMs", "namespace", "success"]),
  enteredReviewMode: threadItemShape(["id", "review", "type"]),
  exitedReviewMode: threadItemShape(["id", "review", "type"]),
  fileChange: threadItemShape(["changes", "id", "status", "type"]),
  hookPrompt: threadItemShape(["fragments", "id", "type"]),
  imageGeneration: threadItemShape(["id", "result", "status", "type"],
    ["failure", "revisedPrompt", "savedPath", "transparentBackground"],
    { failure: null, transparentBackground: null }),
  imageView: threadItemShape(["id", "path", "type"]),
  mcpToolCall: threadItemShape(["arguments", "id", "server", "status", "tool", "type"],
    ["appContext", "durationMs", "error", "mcpAppResourceUri", "pluginId", "readOnlyHint", "result"]),
  plan: threadItemShape(["id", "text", "type"]),
  reasoning: threadItemShape(["id", "type"], ["content", "summary"], { content: [], summary: [] }),
  sleep: threadItemShape(["durationMs", "id", "type"]),
  subAgentActivity: threadItemShape(["agentPath", "agentThreadId", "id", "kind", "type"]),
  userMessage: threadItemShape(["content", "id", "type"], ["clientId"]),
  webSearch: threadItemShape(["id", "query", "type"], ["action", "results"], { results: null }),
});

export const CODEX_COMMAND_DECODER_AUTHORITY = Object.freeze({
  actions: Object.freeze({
    listFiles: Object.freeze({
      allowedKeys: Object.freeze(["command", "path", "type"]),
      decoderAllowsAdditionalProperties: false, nullableKeys: Object.freeze(["path"]),
      optionalKeys: Object.freeze(["path"]), requiredKeys: Object.freeze(["command", "type"]),
      schemaAllowsAdditionalProperties: true,
    }),
    read: Object.freeze({
      allowedKeys: Object.freeze(["command", "name", "path", "type"]),
      decoderAllowsAdditionalProperties: false, nullableKeys: Object.freeze([]),
      optionalKeys: Object.freeze([]), requiredKeys: Object.freeze(["command", "name", "path", "type"]),
      schemaAllowsAdditionalProperties: true,
    }),
    search: Object.freeze({
      allowedKeys: Object.freeze(["command", "path", "query", "type"]),
      decoderAllowsAdditionalProperties: false, nullableKeys: Object.freeze(["path", "query"]),
      optionalKeys: Object.freeze(["path", "query"]), requiredKeys: Object.freeze(["command", "type"]),
      schemaAllowsAdditionalProperties: true,
    }),
    unknown: Object.freeze({
      allowedKeys: Object.freeze(["command", "type"]),
      decoderAllowsAdditionalProperties: false, nullableKeys: Object.freeze([]),
      optionalKeys: Object.freeze([]), requiredKeys: Object.freeze(["command", "type"]),
      schemaAllowsAdditionalProperties: true,
    }),
  }),
  item: Object.freeze({
    allowedKeys: Object.freeze([
      "aggregatedOutput", "command", "commandActions", "cwd", "durationMs", "exitCode", "id", "pluginId",
      "processId", "scriptPath", "source", "status", "type",
    ]),
    decoderAllowsAdditionalProperties: false, integerFormats: Object.freeze({ durationMs: "int64", exitCode: "int32" }),
    nullableKeys: Object.freeze([
      "aggregatedOutput", "durationMs", "exitCode", "pluginId", "processId", "scriptPath",
    ]),
    optionalKeys: Object.freeze([
      "aggregatedOutput", "durationMs", "exitCode", "pluginId", "processId", "scriptPath", "source",
    ]),
    requiredKeys: Object.freeze(["command", "commandActions", "cwd", "id", "status", "type"]),
    schemaAllowsAdditionalProperties: true, statuses: Object.freeze(["inProgress", "completed", "failed", "declined"]),
  }),
  sources: Object.freeze(["agent", "userShell", "unifiedExecStartup", "unifiedExecInteraction"]),
});

export const CODEX_CONSUMED_THREAD_ITEM_SHAPES = Object.freeze({
  agentMessage: Object.freeze(["delivery", "id", "memoryCitation", "phase", "text", "type"]),
  commandExecution: Object.freeze([
    "aggregatedOutput", "command", "commandActions", "cwd", "durationMs", "exitCode", "id",
    "pluginId", "processId", "scriptPath", "source", "status", "type",
  ]),
  contextCompaction: Object.freeze(["id", "type"]),
  enteredReviewMode: Object.freeze(["id", "review", "type"]),
  exitedReviewMode: Object.freeze(["id", "review", "type"]),
  fileChange: Object.freeze(["changes", "id", "status", "type"]),
  hookPrompt: Object.freeze(["fragments", "id", "type"]),
  plan: Object.freeze(["id", "text", "type"]),
  reasoning: Object.freeze(["content", "id", "summary", "type"]),
  userMessage: Object.freeze(["clientId", "content", "id", "type"]),
});

export const CODEX_CONSUMED_THREAD_ITEM_NESTED_AUTHORITY = Object.freeze({
  agentMessage: Object.freeze({ deliveries: Object.freeze(["async"]), phases: Object.freeze(["commentary", "final_answer"]) }),
  commandExecution: Object.freeze({ sources: CODEX_COMMAND_DECODER_AUTHORITY.sources, statuses: Object.freeze(["completed", "declined", "failed", "inProgress"]) }),
  fileChange: Object.freeze({ statuses: Object.freeze(["completed", "declined", "failed", "inProgress"]) }),
  fileChangeKeys: Object.freeze(["diff", "kind", "path"]),
  fileChangeKindKeys: Object.freeze({ add: Object.freeze(["type"]), delete: Object.freeze(["type"]), update: Object.freeze(["move_path", "type"]) }),
  hookFragmentKeys: Object.freeze(["hookRunId", "text"]),
  memoryCitationEntryKeys: Object.freeze(["lineEnd", "lineStart", "note", "path"]),
  memoryCitationKeys: Object.freeze(["entries", "threadIds"]),
  textElementByteRangeKeys: Object.freeze(["end", "start"]),
  textElementKeys: Object.freeze(["byteRange", "placeholder"]),
  userInputKeys: Object.freeze({
    audio: Object.freeze(["type", "url"]), image: Object.freeze(["detail", "type", "url"]), localAudio: Object.freeze(["path", "type"]),
    localImage: Object.freeze(["detail", "path", "type"]), mention: Object.freeze(["name", "path", "type"]), skill: Object.freeze(["name", "path", "type"]), text: Object.freeze(["text", "text_elements", "type"]),
  }),
});

const nullableString = (value: unknown): boolean => value === null || typeof value === "string";
const int64 = (value: unknown): boolean => Number.isSafeInteger(value);
const int32 = (value: unknown): boolean => Number.isInteger(value)
  && Number(value) >= -2_147_483_648 && Number(value) <= 2_147_483_647;
const uint = (value: unknown): boolean => Number.isSafeInteger(value) && Number(value) >= 0;
const uint32 = (value: unknown): boolean => Number.isInteger(value)
  && Number(value) >= 0 && Number(value) <= 4_294_967_295;

const exactTextElement = (value: unknown): boolean => isRecord(value)
  && optionalKeys(value, ["byteRange"], ["placeholder"])
  && isRecord(value.byteRange)
  && exactKeys(value.byteRange, CODEX_CONSUMED_THREAD_ITEM_NESTED_AUTHORITY.textElementByteRangeKeys)
  && uint(value.byteRange.start)
  && uint(value.byteRange.end)
  && (!Object.hasOwn(value, "placeholder") || nullableString(value.placeholder));

const exactUserInput = (value: unknown): boolean => {
  if (!isRecord(value) || typeof value.type !== "string") {return false;}
  if (value.type === "text") {
    return exactKeys(value, CODEX_CONSUMED_THREAD_ITEM_NESTED_AUTHORITY.userInputKeys.text)
      && typeof value.text === "string"
      && Array.isArray(value.text_elements)
      && value.text_elements.every(exactTextElement);
  }
  if (["image", "localImage"].includes(value.type)) {
    const kind = value.type as "image" | "localImage";
    const location = kind === "image" ? "url" : "path";
    const allowed = CODEX_CONSUMED_THREAD_ITEM_NESTED_AUTHORITY.userInputKeys[kind];
    return optionalKeys(value, [location, "type"], allowed.filter(key => ![location, "type"].includes(key)))
      && typeof value[location] === "string"
      && (value.detail === undefined || ["auto", "high", "low", "original"].includes(String(value.detail)));
  }
  if (value.type === "audio") {return exactKeys(value,
    CODEX_CONSUMED_THREAD_ITEM_NESTED_AUTHORITY.userInputKeys.audio) && typeof value.url === "string";}
  if (value.type === "localAudio") {return exactKeys(value,
    CODEX_CONSUMED_THREAD_ITEM_NESTED_AUTHORITY.userInputKeys.localAudio) && typeof value.path === "string";}
  return ["mention", "skill"].includes(value.type)
    && exactKeys(value, CODEX_CONSUMED_THREAD_ITEM_NESTED_AUTHORITY.userInputKeys[
      value.type as "mention" | "skill"
    ])
    && strings(value, ["name", "path"]);
};

const exactMemoryCitation = (value: unknown): boolean => isRecord(value)
  && exactKeys(value, CODEX_CONSUMED_THREAD_ITEM_NESTED_AUTHORITY.memoryCitationKeys)
  && Array.isArray(value.threadIds)
  && value.threadIds.every(entry => typeof entry === "string")
  && Array.isArray(value.entries)
  && value.entries.every(entry => isRecord(entry)
    && exactKeys(entry, CODEX_CONSUMED_THREAD_ITEM_NESTED_AUTHORITY.memoryCitationEntryKeys)
    && strings(entry, ["note", "path"])
    && uint32(entry.lineStart)
    && uint32(entry.lineEnd));

const SAFE_ITEM_TYPES = new Set([
  "agentMessage",
  "contextCompaction",
  "enteredReviewMode",
  "exitedReviewMode",
  "hookPrompt",
  "plan",
  "reasoning",
  "userMessage",
]);

const EFFECTFUL_ITEM_TYPES = new Set([
  "collabAgentToolCall",
  "commandExecution",
  "dynamicToolCall",
  "fileChange",
  "imageGeneration",
  "imageView",
  "mcpToolCall",
  "sleep",
  "subAgentActivity",
  "webSearch",
]);

const exactUserMessage = (item: JsonRecord): boolean =>
  optionalKeys(item, ["content", "id", "type"], ["clientId"])
  && (!Object.hasOwn(item, "clientId") || nullableString(item.clientId))
  && Array.isArray(item.content)
  && item.content.every(exactUserInput);

const exactHookPrompt = (item: JsonRecord): boolean =>
  exactKeys(item, CODEX_CONSUMED_THREAD_ITEM_SHAPES.hookPrompt)
  && Array.isArray(item.fragments)
  && item.fragments.every(fragment => isRecord(fragment)
    && exactKeys(fragment, CODEX_CONSUMED_THREAD_ITEM_NESTED_AUTHORITY.hookFragmentKeys)
    && strings(fragment, ["hookRunId", "text"]));

const exactAgentMessage = (item: JsonRecord): boolean =>
  exactKeys(item, CODEX_CONSUMED_THREAD_ITEM_SHAPES.agentMessage)
  && typeof item.text === "string"
  && (item.phase === null || CODEX_CONSUMED_THREAD_ITEM_NESTED_AUTHORITY.agentMessage.phases.includes(
    item.phase as "commentary" | "final_answer",
  ))
  && (item.delivery === null || CODEX_CONSUMED_THREAD_ITEM_NESTED_AUTHORITY.agentMessage.deliveries.includes(
    item.delivery as "async",
  ))
  && (item.memoryCitation === null || exactMemoryCitation(item.memoryCitation));

const exactReasoning = (item: JsonRecord): boolean =>
  exactKeys(item, CODEX_CONSUMED_THREAD_ITEM_SHAPES.reasoning)
  && Array.isArray(item.summary) && item.summary.every(value => typeof value === "string")
  && Array.isArray(item.content) && item.content.every(value => typeof value === "string");

const exactCommandAction = (value: unknown): boolean => {
  if (!isRecord(value) || typeof value.type !== "string") {return false;}
  if (!Object.hasOwn(CODEX_COMMAND_DECODER_AUTHORITY.actions, value.type)) {return false;}
  const authority = CODEX_COMMAND_DECODER_AUTHORITY.actions[
    value.type as keyof typeof CODEX_COMMAND_DECODER_AUTHORITY.actions
  ];
  if (!optionalKeys(value, authority.requiredKeys, authority.optionalKeys)
    || typeof value.command !== "string") {return false;}
  if (value.type === "read") {
    return strings(value, ["name", "path"]);
  }
  if (value.type === "listFiles") {
    return !Object.hasOwn(value, "path") || nullableString(value.path);
  }
  if (value.type === "search") {
    return (!Object.hasOwn(value, "query") || nullableString(value.query))
      && (!Object.hasOwn(value, "path") || nullableString(value.path));
  }
  return value.type === "unknown";
};

const exactOptionalCommandScalars = (item: JsonRecord): boolean => {
  for (const key of ["aggregatedOutput", "pluginId", "processId", "scriptPath"]) {
    if (Object.hasOwn(item, key) && !nullableString(item[key])) {return false;}
  }
  if (Object.hasOwn(item, "durationMs") && item.durationMs !== null && !int64(item.durationMs)) {return false;}
  if (Object.hasOwn(item, "exitCode") && item.exitCode !== null && !int32(item.exitCode)) {return false;}
  return !Object.hasOwn(item, "source") || CODEX_COMMAND_DECODER_AUTHORITY.sources.includes(
    item.source as "agent" | "userShell" | "unifiedExecStartup" | "unifiedExecInteraction",
  );
};

const exactCommandExecution = (item: JsonRecord): boolean =>
  optionalKeys(item, CODEX_COMMAND_DECODER_AUTHORITY.item.requiredKeys,
    CODEX_COMMAND_DECODER_AUTHORITY.item.optionalKeys)
  && strings(item, ["command", "cwd"])
  && exactOptionalCommandScalars(item)
  && CODEX_COMMAND_DECODER_AUTHORITY.item.statuses.includes(
    item.status as "completed" | "declined" | "failed" | "inProgress",
  )
  && Array.isArray(item.commandActions)
  && item.commandActions.every(exactCommandAction);

const exactFileChangeKind = (value: unknown): boolean => {
  if (!isRecord(value) || typeof value.type !== "string") {return false;}
  if (["add", "delete"].includes(value.type)) {return exactKeys(value,
    CODEX_CONSUMED_THREAD_ITEM_NESTED_AUTHORITY.fileChangeKindKeys[value.type as "add" | "delete"]);}
  return value.type === "update" && exactKeys(value,
    CODEX_CONSUMED_THREAD_ITEM_NESTED_AUTHORITY.fileChangeKindKeys.update)
    && nullableString(value.move_path);
};

const exactFileChange = (item: JsonRecord): boolean =>
  exactKeys(item, CODEX_CONSUMED_THREAD_ITEM_SHAPES.fileChange)
  && CODEX_CONSUMED_THREAD_ITEM_NESTED_AUTHORITY.fileChange.statuses.includes(
    item.status as "completed" | "declined" | "failed" | "inProgress",
  )
  && Array.isArray(item.changes)
  && item.changes.every(change => isRecord(change)
    && exactKeys(change, CODEX_CONSUMED_THREAD_ITEM_NESTED_AUTHORITY.fileChangeKeys)
    && strings(change, ["diff", "path"])
    && exactFileChangeKind(change.kind));

const exactSafeItem = (item: JsonRecord): boolean => {
  switch (item.type) {
    case "userMessage":
      return exactUserMessage(item);
    case "hookPrompt":
      return exactHookPrompt(item);
    case "agentMessage":
      return exactAgentMessage(item);
    case "plan":
      return exactKeys(item, CODEX_CONSUMED_THREAD_ITEM_SHAPES.plan) && typeof item.text === "string";
    case "reasoning":
      return exactReasoning(item);
    case "enteredReviewMode":
    case "exitedReviewMode":
      return exactKeys(item, CODEX_CONSUMED_THREAD_ITEM_SHAPES[item.type]) && typeof item.review === "string";
    case "contextCompaction":
      return exactKeys(item, CODEX_CONSUMED_THREAD_ITEM_SHAPES.contextCompaction);
    default:
      return false;
  }
};

export interface CodexAdmittedThreadItem {
  readonly effectCustodyAdmission?: object;
  readonly id: string;
  readonly item: JsonRecord;
  /** Diagnostic provider observations only; terminal authority remains with Host/workspace/artifact custody. */
  readonly endpointObservations: CodexEndpointPathObservation[];
  readonly type: string;
}

type EffectPhase = "completed" | "started" | "terminal";

type CodexThreadItemAdmissionInput = Readonly<{
  boundary: CodexAppServerPermissionBoundary;
  custody?: CodexEffectCustodyBinding;
  mode: "analysis" | "workspace-write";
  phase: EffectPhase;
  priorAdmission?: object;
  value: unknown;
}>;

const validateCodexThreadItemAdmission = (
  value: unknown,
  mode: "analysis" | "workspace-write",
): JsonRecord => {
  if (!isRecord(value) || typeof value.type !== "string") {
    throw new CodexAppServerProtocolError("Codex item did not match the 0.150.1 item union", true);
  }
  const normalized = validateAndNormalizeCodexThreadItem(value) as JsonRecord | undefined;
  if (normalized === undefined) {
    throw new CodexAppServerProtocolError("Codex item did not match the complete generated 0.150.1 item schema", true);
  }
  if (EFFECTFUL_ITEM_TYPES.has(normalized.type as string) && normalized.type !== "commandExecution"
    && (mode === "analysis" || normalized.type !== "fileChange")) {
    throw new CodexAppServerProtocolError("Codex reported an effectful item without an AR effect receipt", true);
  }
  const validEffect = normalized.type === "commandExecution" ? exactCommandExecution(normalized)
    : mode === "workspace-write" && normalized.type === "fileChange" && exactFileChange(normalized);
  if ((!SAFE_ITEM_TYPES.has(normalized.type as string) || !exactSafeItem(normalized)) && !validEffect) {
    throw new CodexAppServerProtocolError("Codex item did not match an admitted 0.150.1 item-union member", true);
  }
  if (typeof normalized.id !== "string" || normalized.id.length === 0) {
    throw new CodexAppServerProtocolError("Codex item identity is invalid", true);
  }
  return normalized;
};

const admitCodexThreadItemForPhase = (input: CodexThreadItemAdmissionInput): CodexAdmittedThreadItem => {
  const normalized = validateCodexThreadItemAdmission(input.value, input.mode);
  const bound = normalized.type === "commandExecution" ? bindCommandExecutionPaths(normalized, input.boundary)
    : normalized.type === "fileChange" ? bindFileChangePaths(normalized, input.boundary)
      : bindSafeItemPaths(normalized, input.boundary);
  const effectCustodyAdmission = bindEffectCustody({ bound,
    ...(input.custody === undefined ? {} : { custody: input.custody }), normalized, phase: input.phase,
    ...(input.priorAdmission === undefined ? {} : { priorAdmission: input.priorAdmission }) });
  return { ...(effectCustodyAdmission === undefined ? {} : { effectCustodyAdmission }),
    endpointObservations: bound.endpointObservations, id: normalized.id as string,
    item: bound.item, type: normalized.type as string };
};

export const admitCodexThreadItem = (
  value: unknown,
  mode: "analysis" | "workspace-write",
  boundary: CodexAppServerPermissionBoundary,
  custody?: CodexEffectCustodyBinding,
  lifecycle: Readonly<{ phase: EffectPhase; priorAdmission?: object }> = { phase: "started" },
): CodexAdmittedThreadItem => admitCodexThreadItemForPhase({ boundary,
  ...(custody === undefined ? {} : { custody }), mode, phase: lifecycle.phase,
  ...(lifecycle.priorAdmission === undefined ? {} : { priorAdmission: lifecycle.priorAdmission }), value });

export const reconcileCodexCompletedThreadItem = (
  active: CodexAdmittedThreadItem,
  completed: CodexAdmittedThreadItem,
): boolean => {
  if (active.type !== completed.type) {return false;}
  if (completed.type === "commandExecution") {
    const immutable = ["command", "commandActions", "cwd", "id", "pluginId", "scriptPath", "source", "type"];
    return active.item.status === "inProgress" && completed.item.status !== "inProgress"
      && immutable.every(key => canonicalValue(active.item[key]) === canonicalValue(completed.item[key]))
      && (active.item.aggregatedOutput ?? "") === (completed.item.aggregatedOutput ?? "")
      && active.item.processId === completed.item.processId;
  }
  if (completed.type === "fileChange") {
    return active.item.status === "inProgress" && completed.item.status !== "inProgress"
      && active.item.id === completed.item.id
      && canonicalValue(active.item.changes) === canonicalValue(completed.item.changes);
  }
  return canonicalValue(active.item) === canonicalValue(completed.item);
};

export const reconcileCodexTerminalThreadItems = (
  items: unknown,
  completedItems: readonly CodexAdmittedThreadItem[],
  mode: "analysis" | "workspace-write",
  boundary: CodexAppServerPermissionBoundary,
  custody?: CodexEffectCustodyBinding,
): boolean => {
  if (!Array.isArray(items)) {return false;}
  if (items.length !== completedItems.length) {return false;}
  const terminal = items.map((value, index) => admitCodexThreadItemForPhase({ boundary,
    ...(custody === undefined ? {} : { custody }), mode, phase: "terminal",
    ...(completedItems[index]?.effectCustodyAdmission === undefined ? {}
      : { priorAdmission: completedItems[index].effectCustodyAdmission }), value }));
  return canonicalValue(terminal.map(item => item.item)) === canonicalValue(completedItems.map(item => item.item));
};

const canonicalValue = (value: unknown): string => {
  if (Array.isArray(value)) {return `[${value.map(canonicalValue).join(",")}]`;}
  if (isRecord(value)) {
    return `{${Object.entries(value).toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalValue(nested)}`).join(",")}}`;
  }
  return JSON.stringify(value);
};
