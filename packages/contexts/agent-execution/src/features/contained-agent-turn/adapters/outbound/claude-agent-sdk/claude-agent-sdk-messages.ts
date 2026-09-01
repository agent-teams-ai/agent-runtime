import { createHash } from "node:crypto";

import { redactClaudeCanonicalText } from "./claude-agent-sdk-output-redaction.js";

interface ClaudeSdkResultBase {
  readonly is_error: boolean;
  readonly session_id: string;
  readonly type: "result";
  readonly uuid: string;
}

export interface ClaudeSdkResultSuccess extends ClaudeSdkResultBase {
  readonly result: string;
  readonly subtype: "success";
}

export interface ClaudeSdkResultError extends ClaudeSdkResultBase {
  readonly errors: string[];
  readonly subtype: "error_during_execution" | "error_max_turns" | "error_max_budget_usd" | "error_max_structured_output_retries";
}

export type ClaudeSdkResultMessage = ClaudeSdkResultSuccess | ClaudeSdkResultError;

export type NormalizedClaudeSdkMessage =
  | { readonly kind: "assistant_text"; readonly text: string }
  | { readonly kind: "ignored" }
  | { readonly kind: "malformed" }
  | { readonly kind: "result"; readonly result: ClaudeSdkResultMessage };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const isClaudeResult = (message: unknown): message is ClaudeSdkResultMessage => {
  if (!isRecord(message) || message.type !== "result" || typeof message.subtype !== "string" ||
      typeof message.is_error !== "boolean" || typeof message.session_id !== "string" || typeof message.uuid !== "string") {
    return false;
  }
  return message.subtype === "success"
    ? typeof message.result === "string"
    : ["error_during_execution", "error_max_turns", "error_max_budget_usd", "error_max_structured_output_retries"].includes(message.subtype) &&
      Array.isArray(message.errors) && message.errors.every(error => typeof error === "string");
};

export const normalizeClaudeSdkMessage = (message: unknown): NormalizedClaudeSdkMessage => {
  if (!isRecord(message) || typeof message.type !== "string") {return { kind: "malformed" };}
  if (message.type === "result") {
    return isClaudeResult(message) ? { kind: "result", result: message } : { kind: "malformed" };
  }
  if (message.type !== "stream_event") {return { kind: "ignored" };}
  if (
    typeof message.session_id !== "string" ||
    typeof message.uuid !== "string" ||
    (message.parent_tool_use_id !== null && typeof message.parent_tool_use_id !== "string") ||
    !("event" in message) ||
    !isRecord(message.event) ||
    typeof message.event.type !== "string"
  ) {
    return { kind: "malformed" };
  }
  if (message.parent_tool_use_id !== null || message.event.type !== "content_block_delta") {
    return { kind: "ignored" };
  }
  if (!("delta" in message.event) || !isRecord(message.event.delta) || typeof message.event.delta.type !== "string") {
    return { kind: "malformed" };
  }
  if (message.event.delta.type !== "text_delta") {return { kind: "ignored" };}
  return typeof message.event.delta.text === "string"
    ? { kind: "assistant_text", text: message.event.delta.text }
    : { kind: "malformed" };
};

const diagnosticCode = (result: ClaudeSdkResultMessage): string | undefined => {
  if (result.subtype === "success") {return result.is_error ? "CLAUDE_RESULT_ERROR" : undefined;}
  switch (result.subtype) {
    case "error_during_execution": return "CLAUDE_EXECUTION_ERROR";
    case "error_max_budget_usd": return "CLAUDE_BUDGET_LIMIT";
    case "error_max_structured_output_retries": return "CLAUDE_STRUCTURED_OUTPUT_LIMIT";
    case "error_max_turns": return "CLAUDE_TURN_LIMIT";
  }
};


export const claudeResultDiagnostic = (result: ClaudeSdkResultMessage): string | undefined => {
  const code = diagnosticCode(result);
  if (code === undefined) {return undefined;}
  const raw = result.subtype === "success" ? result.result : result.errors.join("\n");
  const bounded = raw.slice(0, 4_096);
  const redacted = redactClaudeCanonicalText(bounded);
  const digest = createHash("sha256").update(redacted).digest("hex");
  return JSON.stringify({ code, diagnosticDigest: `sha256:${digest}`, truncated: bounded.length < raw.length });
};
