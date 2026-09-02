import {
  CodexAppServerProtocolError,
  type CodexJsonRecord as JsonRecord,
} from "./codex-app-server-jsonl.js";
import type { CodexAppServerPermissionBoundary } from "./codex-app-server-permission-boundary.js";
import type { CodexEffectCustodyBinding } from "./codex-app-server-effect-custody.js";
import { bindFileChangePaths } from "./codex-app-server-thread-item-custody.js";
import type { CodexAdmittedThreadItem } from "./codex-app-server-thread-item.js";
import { CodexAppServerTextSegments } from "./codex-app-server-text-segments.js";

export interface CodexItemTextSegments {
  readonly fields: Map<string, CodexAppServerTextSegments>;
  readonly maxBytes: number;
  readonly maxChunks: number;
}

const textSegments = (value: unknown, maxBytes: number, maxChunks: number): CodexAppServerTextSegments => {
  const segments = new CodexAppServerTextSegments(maxBytes, maxChunks);
  if (typeof value === "string" && value.length > 0) {segments.append(value);}
  return segments;
};

export const createCodexItemTextSegments = (
  active: CodexAdmittedThreadItem,
  maxBytes: number,
  maxChunks: number,
): CodexItemTextSegments | undefined => {
  const fields = new Map<string, CodexAppServerTextSegments>();
  if (active.type === "plan") {
    fields.set("text", textSegments(active.item.text, maxBytes, maxChunks));
    active.item.text = "";
  }
  if (active.type === "commandExecution") {
    fields.set("aggregatedOutput", textSegments(active.item.aggregatedOutput, maxBytes, maxChunks));
    active.item.aggregatedOutput = "";
  }
  if (active.type === "reasoning") {
    for (const [index, value] of (active.item.summary as unknown[]).entries()) {
      fields.set(`summary:${index}`, textSegments(value, maxBytes, maxChunks));
    }
    for (const [index, value] of (active.item.content as unknown[]).entries()) {
      fields.set(`content:${index}`, textSegments(value, maxBytes, maxChunks));
    }
    active.item.summary = (active.item.summary as unknown[]).map(() => "");
    active.item.content = (active.item.content as unknown[]).map(() => "");
  }
  return fields.size === 0 && active.type !== "reasoning" ? undefined : { fields, maxBytes, maxChunks };
};

export const materializeCodexItemText = (
  active: CodexAdmittedThreadItem,
  accumulation: CodexItemTextSegments | undefined,
): void => {
  if (accumulation === undefined) {return;}
  if (active.type === "plan") {active.item.text = accumulation.fields.get("text")?.materialize() ?? ""; return;}
  if (active.type === "commandExecution") {
    active.item.aggregatedOutput = accumulation.fields.get("aggregatedOutput")?.materialize() ?? "";
    return;
  }
  if (active.type !== "reasoning") {return;}
  active.item.summary = [...accumulation.fields.entries()]
    .filter(([key]) => key.startsWith("summary:"))
    .toSorted(([left], [right]) => Number(left.slice(8)) - Number(right.slice(8)))
    .map(([, segments]) => segments.materialize());
  active.item.content = [...accumulation.fields.entries()]
    .filter(([key]) => key.startsWith("content:"))
    .toSorted(([left], [right]) => Number(left.slice(8)) - Number(right.slice(8)))
    .map(([, segments]) => segments.materialize());
};

export const applyCodexPassiveItemNotification = (
  method: string,
  params: JsonRecord,
  progress: {
    readonly activeItems: Map<string, CodexAdmittedThreadItem>;
    readonly itemTextSegments: Map<string, CodexItemTextSegments>;
  },
  boundary: CodexAppServerPermissionBoundary,
  custody?: CodexEffectCustodyBinding,
): void => {
  if (typeof params.itemId !== "string") {return;}
  const active = progress.activeItems.get(params.itemId);
  if (active === undefined) {return;}
  if (applyCodexEffectItemNotification(method, params, active, {
    accumulation: progress.itemTextSegments.get(active.id), boundary,
    ...(custody === undefined ? {} : { custody }),
  })) {return;}
  if (method === "item/plan/delta") {
    progress.itemTextSegments.get(active.id)?.fields.get("text")?.append(String(params.delta));
    return;
  }
  applyCodexReasoningNotification(method, params, active, progress.itemTextSegments.get(active.id));
};

const applyCodexEffectItemNotification = (
  method: string,
  params: JsonRecord,
  active: CodexAdmittedThreadItem,
  binding: {
    readonly accumulation: CodexItemTextSegments | undefined;
    readonly boundary: CodexAppServerPermissionBoundary;
    readonly custody?: CodexEffectCustodyBinding;
  },
): boolean => {
  if (method === "item/commandExecution/outputDelta") {
    if (active.type !== "commandExecution"
      || (active.item.aggregatedOutput !== null && active.item.aggregatedOutput !== undefined
        && typeof active.item.aggregatedOutput !== "string")) {
      throw new CodexAppServerProtocolError("Codex command output lifecycle state is invalid", true);
    }
    const segments = binding.accumulation?.fields.get("aggregatedOutput");
    if (segments === undefined) {
      throw new CodexAppServerProtocolError("Codex command output lacks a bounded accumulator", true);
    }
    segments.append(String(params.delta));
    return true;
  }
  if (method === "item/commandExecution/terminalInteraction") {
    if (active.type !== "commandExecution"
      || (active.item.processId !== null && active.item.processId !== undefined
        && active.item.processId !== params.processId)) {
      throw new CodexAppServerProtocolError("Codex terminal interaction lifecycle state is invalid", true);
    }
    active.item.processId = params.processId;
    return true;
  }
  if (method === "item/fileChange/patchUpdated") {
    if (active.type !== "fileChange") {
      throw new CodexAppServerProtocolError("Codex file-change lifecycle state is invalid", true);
    }
    const rebound = bindFileChangePaths({ changes: params.changes }, binding.boundary);
    const priorAdmission = active.effectCustodyAdmission;
    if (binding.custody === undefined || priorAdmission === undefined) {
      throw new CodexAppServerProtocolError("Codex file-change update lacks workspace custody evidence", true);
    }
    const admission = binding.custody.authority.admit({
      ...binding.custody.execution,
      endpointObservations: rebound.endpointObservations,
      itemId: active.id,
      itemType: "fileChange",
      phase: "updated",
      priorAdmission,
    });
    if (admission !== priorAdmission) {
      throw new CodexAppServerProtocolError("Codex file-change update custody evidence was stale or substituted", true);
    }
    active.item.changes = rebound.item.changes;
    active.endpointObservations.push(...rebound.endpointObservations);
    return true;
  }
  return method === "item/fileChange/outputDelta";
};

const applyCodexReasoningNotification = (
  method: string,
  params: JsonRecord,
  active: CodexAdmittedThreadItem,
  accumulation: CodexItemTextSegments | undefined,
): void => {
  if (active.type !== "reasoning") {return;}
  if (!Array.isArray(active.item.summary) || !Array.isArray(active.item.content)) {
    throw new CodexAppServerProtocolError("Codex reasoning lifecycle state is invalid", true);
  }
  if (method === "item/reasoning/summaryPartAdded") {
    if (params.summaryIndex !== active.item.summary.length) {
      throw new CodexAppServerProtocolError("Codex reasoning summary index is discontinuous", true);
    }
    accumulation?.fields.set(`summary:${String(params.summaryIndex)}`,
      new CodexAppServerTextSegments(accumulation.maxBytes, accumulation.maxChunks));
    active.item.summary.push("");
    return;
  }
  if (method === "item/reasoning/summaryTextDelta") {
    const index = params.summaryIndex;
    const segments = typeof index === "number" ? accumulation?.fields.get(`summary:${index}`) : undefined;
    if (segments === undefined) {
      throw new CodexAppServerProtocolError("Codex reasoning summary delta is uncorrelated", true);
    }
    segments.append(String(params.delta));
    return;
  }
  if (method === "item/reasoning/textDelta") {
    const index = params.contentIndex;
    if (typeof index !== "number" || index < 0 || index > active.item.content.length) {
      throw new CodexAppServerProtocolError("Codex reasoning content index is discontinuous", true);
    }
    let segments = accumulation?.fields.get(`content:${index}`);
    if (index === active.item.content.length) {
      active.item.content.push("");
      if (accumulation !== undefined) {
        segments = new CodexAppServerTextSegments(accumulation.maxBytes, accumulation.maxChunks);
        accumulation.fields.set(`content:${index}`, segments);
      }
    }
    if (segments === undefined) {
      throw new CodexAppServerProtocolError("Codex reasoning content delta has no bounded accumulator", true);
    }
    segments.append(String(params.delta));
  }
};
