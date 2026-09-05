import type { ProbeAnomaly, SafeCallbackEvidence, SafeStderrEvidence } from "./opencode-acp-probe-evidence.ts";
import type { ProcessResult } from "./opencode-acp-probe-lifecycle.ts";
import type { RetainedWorkflow } from "./opencode-acp-probe-workflow.ts";

export const promptCompleted = (
  workflow: RetainedWorkflow,
  callbacks: readonly SafeCallbackEvidence[],
): boolean => {
  const sessionId = workflow.sessionNew?.result.sessionId;
  return sessionId !== undefined &&
    workflow.promptResponse?.result.stopReason === "end_turn" &&
    callbacks.some(callback => callback.kind === "prompt_marker" &&
      callback.sessionId === sessionId && callback.promptMarkerMatched === true);
};

export interface ProbeOutcome extends RetainedWorkflow {
  readonly protocolAnomalies: readonly ProbeAnomaly[];
  readonly retainedCallbacks: readonly SafeCallbackEvidence[];
  readonly process: ProcessResult & { readonly stderr: SafeStderrEvidence };
  readonly closureOutcome: "closed" | "closure_timeout" | "closure_failed";
  readonly sdkDiagnostics: {
    readonly stdout: SafeStderrEvidence;
    readonly stderr: SafeStderrEvidence;
  };
}

/** Decide only after workflow, diagnostic drain, and bounded child cleanup finish. */
export const probeFailed = (summary: ProbeOutcome, executePrompt: boolean): boolean =>
  summary.workflowError !== undefined ||
  summary.initialize?.result.protocolVersion !== 1 ||
  summary.protocolAnomalies.length !== 0 ||
  summary.closureOutcome !== "closed" ||
  summary.process.termination !== "exited" ||
  summary.process.exitCode !== 0 ||
  summary.process.signal !== null ||
  summary.process.stderr.truncated ||
  summary.sdkDiagnostics.stdout.truncated ||
  summary.sdkDiagnostics.stderr.truncated ||
  summary.sdkDiagnostics.stdout.bytesObserved !== 0 ||
  summary.sdkDiagnostics.stderr.bytesObserved !== 0 ||
  (executePrompt && !promptCompleted(summary, summary.retainedCallbacks));
