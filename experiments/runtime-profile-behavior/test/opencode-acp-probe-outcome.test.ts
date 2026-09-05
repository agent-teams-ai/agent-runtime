import assert from "node:assert/strict";
import test from "node:test";

import { ProbeEvidence, MAX_RETAINED_CALLBACKS, mergeProbeAnomalies } from "../src/features/acp-compatibility/opencode-acp-probe-evidence.ts";
import { probeFailed, promptCompleted, type ProbeOutcome } from "../src/features/acp-compatibility/opencode-acp-probe-outcome.ts";

const successful = (): ProbeOutcome => {
  const empty = new ProbeEvidence().stderr(new Uint8Array(), 0, false);
  return {
    initialize: { result: { observed: true, protocolVersion: 1 } },
    sessionNew: { result: { observed: true, sessionId: "new-session" } },
    promptResponse: { result: { observed: true, stopReason: "end_turn" } },
    retainedCallbacks: [{ kind: "prompt_marker", sessionId: "new-session", promptMarkerMatched: true }],
    protocolAnomalies: [],
    closureOutcome: "closed",
    process: { exitCode: 0, signal: null, termination: "exited", stderr: empty },
    sdkDiagnostics: { stdout: empty, stderr: empty },
  };
};

test("final success requires the new session marker and exactly end_turn", () => {
  const summary = successful();
  assert.equal(probeFailed(summary, true), false);
  for (const stopReason of ["refusal", "cancelled", "max_tokens", "max_turn_requests", "unknown", undefined]) {
    const candidate = { ...summary, promptResponse: { result: {
      observed: true as const, ...(stopReason === undefined ? {} : { stopReason }),
    } } };
    assert.equal(promptCompleted(candidate, candidate.retainedCallbacks), false, stopReason);
    assert.equal(probeFailed(candidate, true), true, stopReason);
  }
  for (const callbacks of [[], [{ kind: "prompt_marker" as const, sessionId: "old-session", promptMarkerMatched: true as const }]]) {
    const candidate = { ...summary, retainedCallbacks: callbacks };
    assert.equal(promptCompleted(candidate, callbacks), false);
    assert.equal(probeFailed(candidate, true), true);
    assert.equal(probeFailed(candidate, false), false, "non-prompt workflow needs no marker");
  }
  assert.equal(probeFailed({ ...summary, sessionNew: { result: { observed: true } } }, true), true);
});

test("retained anomalies and evidence overflow poison an otherwise successful workflow", () => {
  const summary = successful();
  const evidence = new ProbeEvidence();
  evidence.callback("available_commands", { sessionId: "new-session", update: { availableCommands: [{ name: "x".repeat(129) }] } });
  assert.equal(probeFailed({ ...summary, protocolAnomalies: evidence.anomalies }, true), true);
  const overflow = new ProbeEvidence();
  for (let index = 0; index <= MAX_RETAINED_CALLBACKS; index += 1) {
    overflow.callback("prompt_marker", { sessionId: "new-session", update: {
      sessionUpdate: "agent_message_chunk", content: { type: "text", text: "runtime-profile-acp-ok" },
    } });
  }
  assert.equal(probeFailed({ ...summary, protocolAnomalies: overflow.anomalies }, true), true);
  for (let index = 0; index < 40; index += 1) {evidence.anomaly("evidence_value_rejected");}
  const merged = mergeProbeAnomalies(evidence.anomalies, overflow.anomalies);
  assert.equal(merged.at(-1)?.code, "evidence_anomaly_limit_exceeded");
  assert.equal(probeFailed({ ...summary, protocolAnomalies: merged }, true), true);
});

test("every diagnostic or stderr truncation and abnormal exit fails final success", () => {
  const summary = successful();
  for (const field of ["stdout", "stderr"] as const) {
    for (const diagnostic of [
      { ...summary.sdkDiagnostics[field], truncated: true },
      { ...summary.sdkDiagnostics[field], bytesObserved: 1 },
    ]) {
      assert.equal(probeFailed({ ...summary, sdkDiagnostics: { ...summary.sdkDiagnostics, [field]: diagnostic } }, true), true);
    }
  }
  assert.equal(probeFailed({ ...summary, process: { ...summary.process, stderr: { ...summary.process.stderr, truncated: true } } }, true), true);
  for (const process of [
    { ...summary.process, exitCode: 1 },
    { ...summary.process, exitCode: null },
    { ...summary.process, signal: "SIGTERM" as const },
    ...(["sigterm", "sigkill", "unconfirmed_after_sigkill"] as const).map(termination => ({ ...summary.process, termination })),
  ]) {assert.equal(probeFailed({ ...summary, process }, true), true);}
  for (const closureOutcome of ["closure_timeout", "closure_failed"] as const) {
    assert.equal(probeFailed({ ...summary, closureOutcome }, true), true);
  }
});
