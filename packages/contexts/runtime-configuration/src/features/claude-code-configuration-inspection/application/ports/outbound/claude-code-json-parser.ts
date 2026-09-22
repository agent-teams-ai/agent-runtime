export type ClaudeCodeJsonParserDiagnosticCode =
  | "configuration_dialect_unsupported"
  | "config_duplicate_key"
  | "config_invalid_utf8"
  | "config_parse_failed"
  | "config_too_large"
  | "config_unreadable"
  | "credential_material_rejected"
  | "provider_route_deferred"
  | "secret_setting_rejected"
  | "setting_type_unsupported"
  | "setting_value_unsupported"
  | "source_epoch_stale"
  | "source_inventory_overflow"
  | "source_plan_invalid"
  | "source_plan_unsupported"
  | "source_total_too_large"
  | "source_untrusted";

export type ParseClaudeCodeJsonResult =
  | { readonly data: Readonly<Record<string, unknown>>; readonly status: "parsed" }
  | { readonly diagnostic: ClaudeCodeJsonParserDiagnosticCode; readonly status: "rejected" };

export interface ClaudeCodeJsonParser {
  parse(
    bytes: Uint8Array,
    options?: { readonly signal?: AbortSignal },
  ): ParseClaudeCodeJsonResult;
}
