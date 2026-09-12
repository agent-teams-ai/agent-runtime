import { compileComposition } from "@get-modular/core";
import type { AssemblyOutcome } from "@get-modular/assembly";
import type { AgentRuntimeHost } from "./agent-runtime-host.js";
import { AgentRuntimeHostCreationError, assemblyErrorCodes, projectDiagnostics, type AgentRuntimeHostCreationPhase } from "./agent-runtime-host-creation-error.js";
import { bindRuntimeSetup, createRuntimeSetupFactories, runtimeSetupDeclarations, runtimeSetupProfile, type RuntimeSetupFactories, type RuntimeSetupRootCompletion } from "./runtime-setup-assembly.js";

export interface DefaultAgentRuntimeHostOptions { readonly signal?: AbortSignal; }

// Internal fixed checkpoints, absent from the private package entrypoint.
interface RuntimeSetupAttemptCheckpoints {
  readonly completeRoot?: RuntimeSetupRootCompletion;
  readonly observeOutcome?: (outcome: AssemblyOutcome<ReturnType<typeof bindRuntimeSetup>["roots"]>) => void;
}

export async function createDefaultAgentRuntimeHost(options?: DefaultAgentRuntimeHostOptions): Promise<AgentRuntimeHost> {
  return createRuntimeSetupAttempt(options);
}

// Owner-local seam; never exported through the package composition surface.
export async function createRuntimeSetupAttempt(
  options?: DefaultAgentRuntimeHostOptions,
  factoriesForAttempt: (platform: NodeJS.Platform) => RuntimeSetupFactories = createRuntimeSetupFactories,
  checkpoints: RuntimeSetupAttemptCheckpoints = {},
): Promise<AgentRuntimeHost> {
  let phase: AgentRuntimeHostCreationPhase = "options";
  let signal: AbortSignal | undefined;
  let ownedHost: AgentRuntimeHost | undefined;
  const ownedFailures = new Map<unknown, AgentRuntimeHostCreationError>();
  const failureForAttempt = (...args: ConstructorParameters<typeof AgentRuntimeHostCreationError>) => {
    const failure = new AgentRuntimeHostCreationError(...args);
    ownedFailures.set(failure, failure);
    return failure;
  };
  const checkCancellation = () => {
    if (signal?.aborted) { throw failureForAttempt("cancelled", phase, { cancellationObserved: true }); }
  };
  try {
    signal = options?.signal;
    const platform = process.platform;
    checkCancellation();
    phase = "compile";
    const composition = await compileComposition({ declarations: runtimeSetupDeclarations, profile: runtimeSetupProfile });
    if (!composition.ok) { throw failureForAttempt("invalid_composition", phase, {
      cancellationObserved: signal?.aborted, diagnostics: projectDiagnostics(composition.diagnostics) }); }
    checkCancellation();
    phase = "bind";
    const bindings = bindRuntimeSetup(factoriesForAttempt(platform), (host) => { ownedHost = host; }, checkpoints.completeRoot);
    phase = "prepare";
    const preparation = await bindings.assembly.prepare({ composition, factories: bindings.factories, roots: bindings.roots });
    if (preparation.status === "failed") { throw failureForAttempt(
      assemblyErrorCodes[preparation.error.code] ?? "invalid_composition", phase, { cancellationObserved: signal?.aborted,
      diagnostics: projectDiagnostics(preparation.diagnostics), cause: preparation.error.cause }); }
    checkCancellation();
    phase = "run";
    const outcome = await preparation.prepared.run(signal === undefined ? {} : { signal });
    checkpoints.observeOutcome?.(outcome);
    assertSuccessfulOutcome(outcome, signal, failureForAttempt);
    phase = "handoff";
    checkCancellation();
    if (outcome.roots.host !== ownedHost) { throw failureForAttempt("internal_failure", phase); }
    const host = outcome.roots.host;
    ownedHost = undefined;
    return host;
  } catch (cause) {
    // Cancellation metadata is best effort: a hostile accessor must not replace
    // the primary private cause or prevent release of this attempt's Host.
    let cancellationObserved = false;
    try { cancellationObserved = signal?.aborted === true; } catch { /* Preserve the primary cause. */ }
    let failure = ownedFailures.get(cause) ?? new AgentRuntimeHostCreationError(
      phase === "options" ? "invalid_options" : phase === "bind" ? "invalid_composition" : "internal_failure",
      phase, { cancellationObserved, cause });
    if (ownedHost !== undefined) {
      const host = ownedHost;
      ownedHost = undefined;
      try { await host.dispose(); } catch (cleanupCause) { failure = failure.withCleanupFailure(cleanupCause); }
    }
    throw failure;
  }
}

type RuntimeSetupOutcome = AssemblyOutcome<ReturnType<typeof bindRuntimeSetup>["roots"]>;
function assertSuccessfulOutcome(
  outcome: RuntimeSetupOutcome,
  signal: AbortSignal | undefined,
  failure: (...args: ConstructorParameters<typeof AgentRuntimeHostCreationError>) => AgentRuntimeHostCreationError,
): asserts outcome is Extract<RuntimeSetupOutcome, { status: "succeeded" }> {
  if (outcome.status === "failed") {
    throw failure(assemblyErrorCodes[outcome.code] ?? "internal_failure", "run", {
      cancellationObserved: outcome.cancellation !== undefined || signal?.aborted === true,
      cause: outcome.cause,
      moduleId: runtimeSetupDeclarations.find(({ implementationId }) => implementationId === outcome.implementationId)?.moduleId,
    });
  }
  if (outcome.status === "cancelled") { throw failure("cancelled", "run", { cancellationObserved: true }); }
}
