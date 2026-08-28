import type { ClaudeCodeConfigurationSource } from "../../../contracts/claude-code-configuration-inspection.js";

export type ReadClaudeCodeConfigurationSourceResult =
  | { readonly bytes: Uint8Array; readonly status: "read" }
  | { readonly status: "missing" | "stale" | "unreadable" };

export interface ClaudeCodeConfigurationSourceReader {
  read(
    source: ClaudeCodeConfigurationSource,
    maximumBytes: number,
    options?: { readonly signal?: AbortSignal },
  ): Promise<ReadClaudeCodeConfigurationSourceResult>;
}
