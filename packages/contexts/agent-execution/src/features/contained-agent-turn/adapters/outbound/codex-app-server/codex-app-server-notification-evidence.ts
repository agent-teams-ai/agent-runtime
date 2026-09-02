import { CodexAppServerProtocolError, type CodexJsonRecord as JsonRecord } from "./codex-app-server-jsonl.js";
import { canonicalCodexJson } from "./codex-app-server-permission-boundary.js";
import type { CodexAdmittedThreadItem } from "./codex-app-server-thread-item.js";
import type { CodexItemTextSegments } from "./codex-app-server-thread-item-lifecycle.js";
import type { CodexAppServerTextSegments } from "./codex-app-server-text-segments.js";

export interface CodexActiveTurnProgress {
  activeItems: Map<string, CodexAdmittedThreadItem>;
  activeAgentItemId?: string;
  activeAssistantText?: CodexAppServerTextSegments;
  assistantTurnText?: CodexAppServerTextSegments;
  readonly completedItems: CodexAdmittedThreadItem[];
  cursor: number;
  interruptAcknowledged: boolean;
  interruptDeadline: number | undefined;
  interruptRequestId?: string;
  readonly itemTextSegments: Map<string, CodexItemTextSegments>;
  notificationCount: number;
  notificationBytes: number;
  readonly observedResponseSemantics: Map<string, string>;
  readonly observedItemIds: Set<string>;
  turnStarted: boolean;
}

export interface CodexActiveTurnCompletion {
  readonly status: "completed" | "failed" | "interrupted";
}

export const createCodexActiveTurnProgress = (): CodexActiveTurnProgress => ({
  activeItems: new Map(), completedItems: [], cursor: 0, interruptAcknowledged: false,
  interruptDeadline: undefined, itemTextSegments: new Map(), notificationCount: 0, notificationBytes: 0,
  observedResponseSemantics: new Map(), observedItemIds: new Set(),
  turnStarted: false,
});

export const admitCodexActiveNotification = (input: {
  readonly maxNotificationBytes: number;
  readonly maxNotifications: number;
  readonly message: JsonRecord;
  readonly progress: CodexActiveTurnProgress;
}): void => {
  const canonicalBytes = Buffer.byteLength(canonicalCodexJson(input.message), "utf8");
  const framedBytes = Buffer.byteLength(String(canonicalBytes), "ascii") + 1 + canonicalBytes;
  input.progress.notificationBytes += framedBytes;
  input.progress.notificationCount += 1;
  if (input.progress.notificationCount > input.maxNotifications
    || input.progress.notificationBytes > input.maxNotificationBytes) {
    throw new CodexAppServerProtocolError("Codex active notification stream exceeded its bound", true);
  }
};
