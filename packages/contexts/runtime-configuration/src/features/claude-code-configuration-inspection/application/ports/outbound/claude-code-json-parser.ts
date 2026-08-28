import type { ClaudeCodeConfigurationDiagnosticCode } from "../../../contracts/claude-code-configuration-inspection.js";

export type ParseClaudeCodeJsonResult =
  | { readonly data: Readonly<Record<string, unknown>>; readonly status: "parsed" }
  | { readonly diagnostic: ClaudeCodeConfigurationDiagnosticCode; readonly status: "rejected" };

export interface ClaudeCodeJsonParser {
  parse(
    bytes: Uint8Array,
    options?: { readonly signal?: AbortSignal },
  ): ParseClaudeCodeJsonResult;
}
