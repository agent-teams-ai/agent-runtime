import type { runtimeSetupDeclarations, runtimeOrdinarySetupDeclarations } from "./runtime-setup-assembly.js";
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

type InternalRuntimeSetupModuleId =
  | (typeof runtimeSetupDeclarations)[number]["moduleId"]
  | (typeof runtimeOrdinarySetupDeclarations)[number]["moduleId"];

/** Stable public projection of the private Core/Assembly module identities that
 * may accompany a Host creation failure. Assembly declarations remain private. */
export type RuntimeSetupModuleId =
  | "agent-runtime/setup-security"
  | "agent-runtime/installation-discovery"
  | "agent-runtime/codex-configuration"
  | "agent-runtime/claude-configuration"
  | "agent-runtime/codex-planner"
  | "agent-runtime/claude-planner"
  | "agent-runtime/runtime-host"
  | "ordinary/store"
  | "ordinary/security"
  | "ordinary/provider-access"
  | "ordinary/workspace"
  | "ordinary/artifacts"
  | "ordinary/process"
  | "ordinary/provider"
  | "ordinary/turn";

type SameModuleIds =
  [InternalRuntimeSetupModuleId] extends [RuntimeSetupModuleId]
    ? [RuntimeSetupModuleId] extends [InternalRuntimeSetupModuleId] ? true : false
    : false;
type AssertModuleIds<T extends true> = T;
type _RuntimeSetupModuleIdsRemainExact = AssertModuleIds<SameModuleIds>;

export interface AgentRuntimeHostCreationErrorDetails {
  readonly cancellationObserved?: boolean | undefined;
  readonly cleanupFailed?: boolean;
  readonly diagnostics?: readonly string[];
  readonly cause?: unknown;
  readonly cleanupCauses?: readonly unknown[];
  readonly moduleId?: RuntimeSetupModuleId | undefined;
  readonly cleanupRecovery?: HostCreationCleanupRecovery | undefined;
}

/** Cleanup authority only; no Host, command or capability is published. */
export interface HostCreationCleanupRecovery { recover(): Promise<void>; }

function retainCleanup(action: () => Promise<void>): HostCreationCleanupRecovery {
  let pending: (() => Promise<void>) | undefined = action;
  let flight: Promise<void> | undefined;
  return Object.freeze({recover: (): Promise<void> => flight ??= Promise.resolve().then(async () => {
    await pending?.();
    pending = undefined;
    return;
  }).catch((error: unknown) => {flight = undefined; throw error;})});
}

export class AgentRuntimeHostCreationError extends Error {
  readonly #privateCause: unknown;
  readonly #cleanupCauses: readonly unknown[];
  readonly #cleanupRecovery: HostCreationCleanupRecovery | undefined;
  readonly cancellationObserved: boolean;
  readonly cleanupFailed: boolean;
  readonly diagnostics: readonly string[];
  readonly moduleId: RuntimeSetupModuleId | undefined;
  constructor(
    readonly code: AgentRuntimeHostCreationErrorCode,
    readonly phase: AgentRuntimeHostCreationPhase,
    details: AgentRuntimeHostCreationErrorDetails = {},
  ) {
    super(`Agent Runtime Host creation failed: ${code}`);
    this.name = "AgentRuntimeHostCreationError";
    this.cancellationObserved = details.cancellationObserved ?? false;
    this.cleanupFailed = details.cleanupFailed ?? false;
    this.diagnostics = details.diagnostics ?? [];
    this.moduleId = details.moduleId;
    this.#privateCause = details.cause;
    this.#cleanupCauses = details.cleanupCauses ?? [];
    this.#cleanupRecovery = details.cleanupRecovery;
  }
  get cleanupRecovery(): HostCreationCleanupRecovery | undefined {return this.#cleanupRecovery;}
  static is(value: unknown): value is AgentRuntimeHostCreationError {
    return value !== null && typeof value === "object" && #privateCause in value;
  }
  toJSON() {
    return { name: this.name, code: this.code, phase: this.phase,
      cancellationObserved: this.cancellationObserved, cleanupFailed: this.cleanupFailed,
      diagnostics: this.diagnostics, moduleId: this.moduleId };
  }
  withCleanupFailure(cause: unknown, cleanup?: () => Promise<void>): AgentRuntimeHostCreationError {
    const previous = this.#cleanupRecovery;
    return new AgentRuntimeHostCreationError(this.code, this.phase, {
      cancellationObserved: this.cancellationObserved, cleanupFailed: true,
      diagnostics: this.diagnostics, cause: this.#privateCause,
      cleanupCauses: [...this.#cleanupCauses, cause], moduleId: this.moduleId,
      cleanupRecovery: cleanup === undefined ? previous : retainCleanup(async () => {
        // Inner owners must settle before releasing their prerequisites. A
        // successful earlier recovery is idempotent across outer retries.
        await previous?.recover();
        await cleanup();
      }),
    });
  }
}
