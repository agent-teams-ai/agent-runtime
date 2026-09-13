/** Application-owned Claude Code inspection models.
 *
 * These mirror what the use case needs, not what a caller transports. The
 * external contract in `contracts/` is a separate declaration; an inbound
 * adapter maps between the two so application code never names a transport
 * type. */

import {
  CLAUDE_CODE_DIALECT,
  CLAUDE_CODE_SOURCE_PLAN_CONTRACT,
  type ClaudeCodeDialect,
  type ClaudeCodeEffortLevel,
  type ClaudeCodeModelName,
} from "./claude-code-vocabulary.js";

export type ClaudeCodeSourceRole = "user" | "shared-project" | "project-local";

export type ClaudeCodeSourceSelectionBasis =
  | "home-default"
  | "claude-config-dir"
  | "session-primary-working-directory"
  | "repository-root"
  | "main-worktree-root"
  | "legacy-starting-directory"
  | "caller-explicit"
  | "static-preview";

export interface ClaudeCodeCustodyRoot {
  readonly absolutePath: string;
  readonly canonicalPath: string;
  readonly rootId: string;
}

interface ClaudeCodeSourceEvidence {
  readonly displayPath: string;
  readonly locationClaims?: readonly string[];
  readonly observationEpoch: string;
  readonly role: ClaudeCodeSourceRole;
  readonly selectionBasis: ClaudeCodeSourceSelectionBasis;
  readonly sourceId: string;
  readonly trust: "user" | "workspace-trusted" | "workspace-untrusted";
}

export type ClaudeCodeConfigurationSource =
  | (ClaudeCodeSourceEvidence & {
      readonly access: "authorized";
      readonly absolutePath: string;
      readonly authorizedFileIdentity?: string;
      readonly canonicalPath: string;
      readonly custodyRoot: ClaudeCodeCustodyRoot;
    })
  | (ClaudeCodeSourceEvidence & {
      readonly access: "rejected" | "stale" | "untrusted";
      readonly custodyRootRef: string;
    });

export interface ClaudeCodeObservedSourcePlan {
  readonly claim: "observed-files-only";
  readonly collector: {
    readonly bundleId: string;
    readonly id: string;
    readonly observationEpoch: string;
    readonly platform: "darwin";
    readonly version: string;
  };
  readonly contract: typeof CLAUDE_CODE_SOURCE_PLAN_CONTRACT;
  readonly roots: readonly ClaudeCodeCustodyRoot[];
  readonly sources: readonly ClaudeCodeConfigurationSource[];
}

export type ClaudeCodeModelSelection =
  | { readonly kind: "provider-default" }
  | { readonly kind: "alias"; readonly value: ClaudeCodeModelName }
  | { readonly kind: "exact-name"; readonly value: string };

export interface ClaudeCodeSourceObservation {
  readonly displayPath: string;
  readonly role: ClaudeCodeSourceRole;
  readonly selectionBasis: ClaudeCodeSourceSelectionBasis;
  readonly semanticDigest?: string;
  readonly sourceRef: string;
  readonly status: "applied" | "malformed" | "missing" | "rejected" | "stale" | "unreadable";
}

export type ObservedPortableClaudeCodeIntent =
  | { readonly key: "model"; readonly selection: ClaudeCodeModelSelection; readonly sourceRef: string }
  | { readonly key: "effortLevel"; readonly sourceRef: string; readonly value: ClaudeCodeEffortLevel };

export interface ClaudeCodeDeferredModelObservation {
  readonly form: "provider-deployment" | "unclassified-selector";
  readonly key: "model";
  readonly sourceRef: string;
  readonly status: "deferred";
}

export type ClaudeCodeInspectionDiagnosticCode =
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

export interface ClaudeCodeInspectionDiagnostic {
  readonly code: ClaudeCodeInspectionDiagnosticCode;
  readonly safeRef?: string;
}

export interface ClaudeCodeInspectionRequest {
  readonly dialect: ClaudeCodeDialect;
  readonly identityScope: string;
  readonly sourcePlan: ClaudeCodeObservedSourcePlan;
}

export interface ClaudeCodeInspectionOutcome {
  readonly deferredObservations: readonly ClaudeCodeDeferredModelObservation[];
  readonly diagnostics: readonly ClaudeCodeInspectionDiagnostic[];
  readonly observedPortableIntent: readonly ObservedPortableClaudeCodeIntent[];
  readonly sourceModel: {
    readonly claim: "observed-files-only";
    readonly classifierRevision: string;
    readonly collectorRef: string;
    readonly compatibility: "unqualified";
    readonly contract: typeof CLAUDE_CODE_SOURCE_PLAN_CONTRACT;
    readonly dialect: ClaudeCodeDialect;
    readonly precedence: "not-evaluated";
    readonly topologyRef: string;
  };
  readonly sources: readonly ClaudeCodeSourceObservation[];
}

export interface InspectClaudeCodeConfigurationUseCase {
  execute(
    request: ClaudeCodeInspectionRequest,
    options?: { readonly signal?: AbortSignal },
  ): Promise<ClaudeCodeInspectionOutcome>;
}

export { CLAUDE_CODE_DIALECT, CLAUDE_CODE_SOURCE_PLAN_CONTRACT };
