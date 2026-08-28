export const CLAUDE_CODE_SETTINGS_DIALECT = "claude-code-settings@2026-08-28" as const;
export const CLAUDE_CODE_OBSERVED_SOURCE_PLAN_CONTRACT =
  "claude-code-observed-source-plan/v1" as const;
export const CLAUDE_CODE_MODEL_DEFAULT = "default" as const;

export const CLAUDE_CODE_MODEL_ALIASES = [
  "best", "fable", "sonnet", "opus", "haiku", "sonnet[1m]", "opus[1m]", "opusplan",
] as const;

export const CLAUDE_CODE_EFFORT_VALUES = ["low", "medium", "high", "xhigh"] as const;

export const CLAUDE_CODE_PROVIDER_ROUTE_VOCABULARY_REVISION =
  "claude-code-provider-route-vocabulary/v2" as const;

export const CLAUDE_CODE_PROVIDER_ROUTE_KEYS = Object.freeze(([
  { category: "endpoint", key: "ANTHROPIC_BASE_URL" },
  { category: "endpoint", key: "ANTHROPIC_BEDROCK_BASE_URL" },
  { category: "endpoint", key: "ANTHROPIC_BEDROCK_MANTLE_BASE_URL" },
  { category: "endpoint", key: "ANTHROPIC_FOUNDRY_BASE_URL" },
  { category: "endpoint", key: "ANTHROPIC_VERTEX_BASE_URL" },
  { category: "header-routing", key: "ANTHROPIC_CUSTOM_HEADERS" },
  { category: "model-binding", key: "ANTHROPIC_DEFAULT_HAIKU_MODEL" },
  { category: "model-binding", key: "ANTHROPIC_DEFAULT_OPUS_MODEL" },
  { category: "model-binding", key: "ANTHROPIC_DEFAULT_SONNET_MODEL" },
  { category: "model-binding", key: "ANTHROPIC_MODEL" },
  { category: "model-binding", key: "ANTHROPIC_SMALL_FAST_MODEL" },
  { category: "region", key: "ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION" },
  { category: "region-prefix", key: "ANTHROPIC_BEDROCK_REGION_PREFIX" },
  { category: "service-tier", key: "ANTHROPIC_BEDROCK_SERVICE_TIER" },
  { category: "region", key: "AWS_DEFAULT_REGION" },
  { category: "account-route", key: "AWS_PROFILE" },
  { category: "region", key: "AWS_REGION" },
  { category: "provider-toggle", key: "CLAUDE_CODE_SKIP_BEDROCK_AUTH" },
  { category: "provider-toggle", key: "CLAUDE_CODE_SKIP_FOUNDRY_AUTH" },
  { category: "provider-toggle", key: "CLAUDE_CODE_SKIP_MANTLE_AUTH" },
  { category: "provider-toggle", key: "CLAUDE_CODE_SKIP_VERTEX_AUTH" },
  { category: "provider-toggle", key: "CLAUDE_CODE_USE_BEDROCK" },
  { category: "provider-toggle", key: "CLAUDE_CODE_USE_FOUNDRY" },
  { category: "provider-toggle", key: "CLAUDE_CODE_USE_MANTLE" },
  { category: "provider-toggle", key: "CLAUDE_CODE_USE_VERTEX" },
  { category: "region", key: "CLOUD_ML_REGION" },
  { category: "account-route", key: "CLOUD_ML_PROJECT_ID" },
  { category: "model-binding", key: "modelOverrides" },
] as const).map(entry => Object.freeze(entry)));

export const CLAUDE_CODE_CONFIGURATION_BUDGETS = Object.freeze({
  aggregateSourceBytes: 1_024 * 1_024,
  arrayItems: 1_024,
  bytesPerSource: 128 * 1_024,
  classifierValueLength: 256,
  depth: 16,
  diagnostics: 1_024,
  identifierLength: 128,
  keyLength: 256,
  locationClaimsPerSource: 4,
  nodes: 4_096,
  objectKeys: 1_024,
  pathLength: 16_384,
  rootSlots: 16,
  sourceSlots: 16,
  stringLength: 16_384,
});

export type ClaudeCodeConfigurationDialect = typeof CLAUDE_CODE_SETTINGS_DIALECT;
export type ClaudeCodeModelAlias = typeof CLAUDE_CODE_MODEL_ALIASES[number];
export type ClaudeCodeEffort = typeof CLAUDE_CODE_EFFORT_VALUES[number];
export type ClaudeCodeConfigurationSourceRole = "user" | "shared-project" | "project-local";
export type ClaudeCodeConfigurationSourceKind = ClaudeCodeConfigurationSourceRole;
export type ClaudeCodeSourceSelectionBasis =
  | "home-default" | "claude-config-dir" | "session-primary-working-directory"
  | "repository-root" | "main-worktree-root" | "legacy-starting-directory"
  | "caller-explicit" | "static-preview";

export interface ClaudeCodeCustodyRoot {
  readonly absolutePath: string;
  readonly canonicalPath: string;
  readonly rootId: string;
}

interface ClaudeCodeConfigurationSourceEvidence {
  readonly displayPath: string;
  readonly locationClaims?: readonly string[];
  readonly observationEpoch: string;
  readonly role: ClaudeCodeConfigurationSourceRole;
  readonly selectionBasis: ClaudeCodeSourceSelectionBasis;
  readonly sourceId: string;
  readonly trust: "user" | "workspace-trusted" | "workspace-untrusted";
}

export type ClaudeCodeConfigurationSource =
  | (ClaudeCodeConfigurationSourceEvidence & {
      readonly access: "authorized";
      readonly absolutePath: string;
      readonly authorizedFileIdentity?: string;
      readonly canonicalPath: string;
      readonly custodyRoot: ClaudeCodeCustodyRoot;
    })
  | (ClaudeCodeConfigurationSourceEvidence & {
      readonly access: "rejected" | "stale" | "untrusted";
      readonly custodyRootRef: string;
    });

export interface TrustedClaudeCodeObservedSourcePlan {
  readonly claim: "observed-files-only";
  readonly collector: {
    readonly bundleId: string;
    readonly id: string;
    readonly observationEpoch: string;
    readonly platform: "darwin";
    readonly version: string;
  };
  readonly contract: typeof CLAUDE_CODE_OBSERVED_SOURCE_PLAN_CONTRACT;
  readonly roots: readonly ClaudeCodeCustodyRoot[];
  readonly sources: readonly ClaudeCodeConfigurationSource[];
}

export type ClaudeCodeModelSelection =
  | { readonly kind: "provider-default" }
  | { readonly kind: "alias"; readonly value: ClaudeCodeModelAlias }
  | { readonly kind: "exact-name"; readonly value: string };

export interface ClaudeCodeSourceObservation {
  readonly displayPath: string;
  readonly role: ClaudeCodeConfigurationSourceRole;
  readonly selectionBasis: ClaudeCodeSourceSelectionBasis;
  readonly semanticDigest?: string;
  readonly sourceRef: string;
  readonly status: "applied" | "malformed" | "missing" | "rejected" | "stale" | "unreadable";
}

export type ObservedPortableClaudeCodeIntent =
  | { readonly key: "model"; readonly selection: ClaudeCodeModelSelection; readonly sourceRef: string }
  | { readonly key: "effortLevel"; readonly sourceRef: string; readonly value: ClaudeCodeEffort };

export interface ClaudeCodeDeferredModelObservation {
  readonly form: "provider-deployment" | "unclassified-selector";
  readonly key: "model";
  readonly sourceRef: string;
  readonly status: "deferred";
}

export type ClaudeCodeConfigurationDiagnosticCode =
  | "configuration_dialect_unsupported" | "config_duplicate_key" | "config_invalid_utf8"
  | "config_parse_failed" | "config_too_large" | "config_unreadable"
  | "credential_material_rejected" | "provider_route_deferred" | "secret_setting_rejected"
  | "setting_type_unsupported" | "setting_value_unsupported" | "source_epoch_stale"
  | "source_inventory_overflow" | "source_plan_invalid" | "source_plan_unsupported"
  | "source_total_too_large" | "source_untrusted";

export interface ClaudeCodeConfigurationDiagnostic {
  readonly code: ClaudeCodeConfigurationDiagnosticCode;
  readonly safeRef?: string;
}

export interface InspectClaudeCodeConfigurationInput {
  readonly dialect: ClaudeCodeConfigurationDialect;
  readonly identityScope: string;
  readonly sourcePlan: TrustedClaudeCodeObservedSourcePlan;
}

export interface InspectClaudeCodeConfigurationResult {
  readonly deferredObservations: readonly ClaudeCodeDeferredModelObservation[];
  readonly diagnostics: readonly ClaudeCodeConfigurationDiagnostic[];
  readonly observedPortableIntent: readonly ObservedPortableClaudeCodeIntent[];
  readonly sourceModel: {
    readonly claim: "observed-files-only";
    readonly classifierRevision: string;
    readonly collectorRef: string;
    readonly compatibility: "unqualified";
    readonly contract: typeof CLAUDE_CODE_OBSERVED_SOURCE_PLAN_CONTRACT;
    readonly dialect: ClaudeCodeConfigurationDialect;
    readonly precedence: "not-evaluated";
    readonly topologyRef: string;
  };
  readonly sources: readonly ClaudeCodeSourceObservation[];
}

export interface InspectClaudeCodeConfiguration {
  execute(input: InspectClaudeCodeConfigurationInput, options?: { readonly signal?: AbortSignal }):
    Promise<InspectClaudeCodeConfigurationResult>;
}
