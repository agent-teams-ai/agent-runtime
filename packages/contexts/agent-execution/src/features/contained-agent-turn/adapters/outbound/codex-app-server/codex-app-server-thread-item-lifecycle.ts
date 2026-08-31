import {
  CodexAppServerProtocolError,
  type CodexJsonRecord as JsonRecord,
} from "./codex-app-server-jsonl.js";
import type { CodexAppServerPermissionBoundary } from "./codex-app-server-permission-boundary.js";
import type { CodexEffectCustodyBinding } from "./codex-app-server-effect-custody.js";
import { bindFileChangePaths } from "./codex-app-server-thread-item-custody.js";
import type { CodexAdmittedThreadItem } from "./codex-app-server-thread-item.js";

export const applyCodexPassiveItemNotification = (
  method: string,
  params: JsonRecord,
  progress: {
    readonly activeItems: Map<string, CodexAdmittedThreadItem>;
  },
  boundary: CodexAppServerPermissionBoundary,
  custody?: CodexEffectCustodyBinding,
): void => {
  if (typeof params.itemId !== "string") {return;}
  const active = progress.activeItems.get(params.itemId);
  if (active === undefined) {return;}
  if (applyCodexEffectItemNotification(method, params, active, boundary, custody)) {return;}
  if (method === "item/plan/delta") {
    active.item.text = String(active.item.text) + String(params.delta);
    return;
  }
  applyCodexReasoningNotification(method, params, active);
};

const applyCodexEffectItemNotification = (
  method: string,
  params: JsonRecord,
  active: CodexAdmittedThreadItem,
  boundary: CodexAppServerPermissionBoundary,
  custody?: CodexEffectCustodyBinding,
): boolean => {
  if (method === "item/commandExecution/outputDelta") {
    const prior = active.item.aggregatedOutput;
    if (active.type !== "commandExecution"
      || (prior !== null && prior !== undefined && typeof prior !== "string")) {
      throw new CodexAppServerProtocolError("Codex command output lifecycle state is invalid", true);
    }
    active.item.aggregatedOutput = (prior ?? "") + String(params.delta);
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
    const rebound = bindFileChangePaths({ changes: params.changes }, boundary);
    const priorAdmission = active.effectCustodyAdmission;
    if (custody === undefined || priorAdmission === undefined) {
      throw new CodexAppServerProtocolError("Codex file-change update lacks workspace custody evidence", true);
    }
    const admission = custody.authority.admit({
      ...custody.execution,
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
): void => {
  if (active.type !== "reasoning") {return;}
  if (!Array.isArray(active.item.summary) || !Array.isArray(active.item.content)) {
    throw new CodexAppServerProtocolError("Codex reasoning lifecycle state is invalid", true);
  }
  if (method === "item/reasoning/summaryPartAdded") {
    if (params.summaryIndex !== active.item.summary.length) {
      throw new CodexAppServerProtocolError("Codex reasoning summary index is discontinuous", true);
    }
    active.item.summary.push("");
    return;
  }
  if (method === "item/reasoning/summaryTextDelta") {
    const index = params.summaryIndex;
    if (typeof index !== "number" || typeof active.item.summary[index] !== "string") {
      throw new CodexAppServerProtocolError("Codex reasoning summary delta is uncorrelated", true);
    }
    active.item.summary[index] += String(params.delta);
    return;
  }
  if (method === "item/reasoning/textDelta") {
    const index = params.contentIndex;
    if (typeof index !== "number" || index < 0 || index > active.item.content.length) {
      throw new CodexAppServerProtocolError("Codex reasoning content index is discontinuous", true);
    }
    if (index === active.item.content.length) {active.item.content.push("");}
    active.item.content[index] += String(params.delta);
  }
};
