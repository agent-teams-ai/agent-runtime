import type { ClaudeCodeInspectionDiagnosticCode } from "../../models/claude-code-inspection-models.js";

export type ParseClaudeCodeJsonResult =
  | { readonly data: Readonly<Record<string, unknown>>; readonly status: "parsed" }
  | { readonly diagnostic: ClaudeCodeInspectionDiagnosticCode; readonly status: "rejected" };

export interface ClaudeCodeJsonParser {
  parse(
    bytes: Uint8Array,
    options?: { readonly signal?: AbortSignal },
  ): ParseClaudeCodeJsonResult;
}
