import type { runtimeSetupDeclarations } from "./runtime-setup-assembly.js";
import type { Diagnostic, DiagnosticCode } from "@get-modular/core";
import type { BindingErrorCode, PreparationErrorCode, RunErrorCode } from "@get-modular/assembly";

export type AgentRuntimeHostCreationErrorCode = "invalid_options" | "invalid_composition" | "factory_failed" | "invalid_factory_product" | "cancelled" | "internal_failure";
export type AgentRuntimeHostCreationPhase = "options" | "compile" | "bind" | "prepare" | "run" | "handoff";
const coreCodes = {
  "binding.capability-missing": true,
  "binding.cardinality": true,
  "binding.compatibility-mismatch": true,
  "binding.duplicate": true,
  "binding.duplicate-record": true,
  "binding.missing": true,
  "binding.provider-not-selected": true,
  "binding.unknown-consumer": true,
  "binding.unknown-provider": true,
  "binding.unknown-slot": true,
  "declaration.duplicate-capability": true,
  "declaration.duplicate-implementation": true,
  "declaration.duplicate-slot": true,
  "decode.duplicate-key": true,
  "decode.invalid-json": true,
  "diagnostics.truncated": true,
  "graph.cycle": true,
  "identity.invalid": true,
  "input.invalid-byte-carrier": true,
  "input.limit-exceeded": true,
  "profile.duplicate-root": true,
  "profile.duplicate-selection": true,
  "profile.implementation-mismatch": true,
  "profile.missing-selection": true,
  "profile.unknown-implementation": true,
  "profile.unknown-module": true,
  "profile.unknown-root": true,
  "profile.unreachable-selection": true,
  "schema.invalid-value": true,
  "schema.non-plain-value": true,
  "schema.unknown-field": true,
  "schema.unsupported-version": true,
} satisfies Record<DiagnosticCode, true>;
export function projectDiagnostics(diagnostics: readonly Diagnostic[]): readonly string[] {
  return Object.freeze(diagnostics.slice(0, 16).map(({ code }) =>
    Object.hasOwn(coreCodes, code) ? code : "unknown_upstream_diagnostic"));
}
export const assemblyErrorCodes = {
  "assembly.bind.invalid-declaration": "invalid_composition",
  "assembly.bind.limit": "invalid_composition",
  "assembly.bind.invalid-factory": "invalid_composition",
  "assembly.prepare.invalid-input": "invalid_composition",
  "assembly.prepare.limit": "invalid_composition",
  "assembly.prepare.handles": "invalid_composition",
  "assembly.prepare.roots": "invalid_composition",
  "assembly.prepare.core-rejected": "invalid_composition",
  "assembly.prepare.plan-mismatch": "invalid_composition",
  "assembly.run.factory-threw": "factory_failed",
  "assembly.run.factory-rejected": "factory_failed",
  "assembly.run.unsupported-carrier": "invalid_factory_product",
  "assembly.run.invalid-product": "invalid_factory_product",
  "assembly.run.internal": "internal_failure",
} satisfies Record<BindingErrorCode | PreparationErrorCode | RunErrorCode, AgentRuntimeHostCreationErrorCode>;

export type RuntimeSetupModuleId = (typeof runtimeSetupDeclarations)[number]["moduleId"];

interface CreationErrorDetails {
  readonly cancellationObserved?: boolean | undefined;
  readonly cleanupFailed?: boolean;
  readonly diagnostics?: readonly string[];
  readonly cause?: unknown;
  readonly cleanupCauses?: readonly unknown[];
  readonly moduleId?: RuntimeSetupModuleId | undefined;
}

export class AgentRuntimeHostCreationError extends Error {
  readonly #privateCause: unknown;
  readonly #cleanupCauses: readonly unknown[];
  readonly cancellationObserved: boolean;
  readonly cleanupFailed: boolean;
  readonly diagnostics: readonly string[];
  readonly moduleId: RuntimeSetupModuleId | undefined;
  constructor(
    readonly code: AgentRuntimeHostCreationErrorCode,
    readonly phase: AgentRuntimeHostCreationPhase,
    details: CreationErrorDetails = {},
  ) {
    super(`Agent Runtime Host creation failed: ${code}`);
    this.name = "AgentRuntimeHostCreationError";
    this.cancellationObserved = details.cancellationObserved ?? false;
    this.cleanupFailed = details.cleanupFailed ?? false;
    this.diagnostics = details.diagnostics ?? [];
    this.moduleId = details.moduleId;
    this.#privateCause = details.cause;
    this.#cleanupCauses = details.cleanupCauses ?? [];
  }
  toJSON() {
    return { name: this.name, code: this.code, phase: this.phase,
      cancellationObserved: this.cancellationObserved, cleanupFailed: this.cleanupFailed,
      diagnostics: this.diagnostics, moduleId: this.moduleId };
  }
  withCleanupFailure(cause: unknown): AgentRuntimeHostCreationError {
    return new AgentRuntimeHostCreationError(this.code, this.phase, {
      cancellationObserved: this.cancellationObserved, cleanupFailed: true,
      diagnostics: this.diagnostics, cause: this.#privateCause,
      cleanupCauses: [...this.#cleanupCauses, cause], moduleId: this.moduleId,
    });
  }
}
