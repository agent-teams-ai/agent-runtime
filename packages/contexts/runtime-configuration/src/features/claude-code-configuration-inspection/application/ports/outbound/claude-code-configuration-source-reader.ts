import type { ClaudeCodeConfigurationSource } from "../../models/claude-code-inspection-models.js";

export type ReadClaudeCodeConfigurationSourceResult =
  | { readonly bytes: Uint8Array; readonly status: "read" }
  | { readonly status: "missing" | "stale" | "too-large" | "unreadable" };

export interface ClaudeCodeConfigurationSourceReader {
  measure?(
    source: Extract<ClaudeCodeConfigurationSource, { readonly access: "authorized" }>,
    options?: { readonly signal?: AbortSignal },
  ): Promise<
    | { readonly bytes: number; readonly status: "measured" }
    | { readonly status: "missing" | "stale" | "unreadable" }
  >;
  read(
    source: Extract<ClaudeCodeConfigurationSource, { readonly access: "authorized" }>,
    maximumBytes: number,
    options?: { readonly signal?: AbortSignal },
  ): Promise<ReadClaudeCodeConfigurationSourceResult>;
}
