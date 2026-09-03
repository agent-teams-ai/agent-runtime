import { CodexAppServerProtocolError, type CodexJsonRecord as JsonRecord } from "./codex-app-server-jsonl.js";
import type { CodexEffectCustodyBinding } from "./codex-app-server-effect-custody.js";
import { observeCodexWorkspaceEndpoint, type CodexEndpointPathObservation } from "./codex-app-server-path-identity.js";
import type { CodexAppServerPermissionBoundary } from "./codex-app-server-permission-boundary.js";

export interface CodexBoundThreadItem {
  readonly endpointObservations: CodexEndpointPathObservation[];
  readonly item: JsonRecord;
}

export const bindCommandExecutionPaths = (
  item: JsonRecord,
  boundary: CodexAppServerPermissionBoundary,
): CodexBoundThreadItem => {
  const bound = structuredClone(item);
  const endpointObservations: CodexEndpointPathObservation[] = [];
  const cwd = observeCodexWorkspaceEndpoint(bound.cwd as string, boundary, true);
  bound.cwd = cwd.path; endpointObservations.push(cwd.endpointObservation);
  if (typeof bound.scriptPath === "string") {
    const script = observeCodexWorkspaceEndpoint(bound.scriptPath, boundary);
    bound.scriptPath = script.path; endpointObservations.push(script.endpointObservation);
  }
  for (const value of bound.commandActions as unknown[]) {
    const action = value as JsonRecord;
    if (action.type === "read") {
      const path = observeCodexWorkspaceEndpoint(action.path as string, boundary, true);
      action.path = path.path; endpointObservations.push(path.endpointObservation);
    } else if ((action.type === "listFiles" || action.type === "search") && typeof action.path === "string") {
      const path = observeCodexWorkspaceEndpoint(action.path, boundary, true);
      action.path = path.path; endpointObservations.push(path.endpointObservation);
    }
  }
  if (!Object.hasOwn(bound, "pluginId")) {bound.pluginId = null;}
  if (!Object.hasOwn(bound, "scriptPath")) {bound.scriptPath = null;}
  if (!Object.hasOwn(bound, "source")) {bound.source = "agent";}
  return { endpointObservations, item: bound };
};

export const bindFileChangePaths = (item: JsonRecord, boundary: CodexAppServerPermissionBoundary): CodexBoundThreadItem => {
  const bound = structuredClone(item);
  const endpointObservations: CodexEndpointPathObservation[] = [];
  for (const value of bound.changes as unknown[]) {
    const change = value as JsonRecord;
    const path = observeCodexWorkspaceEndpoint(change.path as string, boundary);
    change.path = path.path; endpointObservations.push(path.endpointObservation);
    const kind = change.kind as JsonRecord;
    if (kind.type === "update" && kind.move_path !== null) {
      const movePath = observeCodexWorkspaceEndpoint(kind.move_path as string, boundary);
      kind.move_path = movePath.path; endpointObservations.push(movePath.endpointObservation);
    }
  }
  return { endpointObservations, item: bound };
};

export const bindSafeItemPaths = (item: JsonRecord, boundary: CodexAppServerPermissionBoundary): CodexBoundThreadItem => {
  if (item.type !== "agentMessage" && item.type !== "userMessage") {return { endpointObservations: [], item };}
  const bound = structuredClone(item);
  const endpointObservations: CodexEndpointPathObservation[] = [];
  if (bound.type === "agentMessage" && bound.memoryCitation !== null) {
    const citation = bound.memoryCitation as JsonRecord;
    for (const value of citation.entries as unknown[]) {
      const entry = value as JsonRecord;
      const path = observeCodexWorkspaceEndpoint(entry.path as string, boundary);
      entry.path = path.path; endpointObservations.push(path.endpointObservation);
    }
  }
  if (bound.type === "userMessage") {
    for (const value of bound.content as unknown[]) {
      const input = value as JsonRecord;
      if (["localAudio", "localImage", "mention", "skill"].includes(input.type as string)) {
        const path = observeCodexWorkspaceEndpoint(input.path as string, boundary);
        input.path = path.path; endpointObservations.push(path.endpointObservation);
      }
    }
  }
  return { endpointObservations, item: bound };
};

export const bindEffectCustody = (input: {
  readonly bound: CodexBoundThreadItem;
  readonly custody?: CodexEffectCustodyBinding;
  readonly normalized: JsonRecord;
  readonly phase: "completed" | "started" | "terminal";
  readonly priorAdmission?: object;
}): object | undefined => {
  if (input.normalized.type !== "commandExecution" && input.normalized.type !== "fileChange") {return undefined;}
  if (input.custody === undefined || input.bound.endpointObservations.length === 0) {
    throw new CodexAppServerProtocolError("Codex path-bearing effect lacks exact opened-object workspace custody evidence", true);
  }
  const admission = input.custody.authority.admit({
    ...input.custody.execution,
    endpointObservations: input.bound.endpointObservations,
    itemId: input.normalized.id as string,
    itemType: input.normalized.type,
    phase: input.phase,
    ...(input.priorAdmission === undefined ? {} : { priorAdmission: input.priorAdmission }),
  });
  if (admission === undefined || (input.priorAdmission !== undefined && admission !== input.priorAdmission)) {
    throw new CodexAppServerProtocolError("Codex effect custody evidence was missing, stale, or substituted", true);
  }
  return admission;
};
