import assert from "node:assert/strict";
import { createHash } from "node:crypto";

const digest = value => createHash("sha256").update(value).digest("hex");
export const DARWIN_LIMITATIONS = Object.freeze([
  "canonical-executable-path-is-name-bound-at-spawn",
  "canonical-workspace-path-is-name-bound-at-spawn",
  "private-environment-paths-are-name-bound-at-spawn",
  "descendant-may-escape-via-new-session",
]);

export const observeCustodyReservation = custody => {
  let opened;
  return Object.freeze({
    hostCustody: new Proxy(custody, {
      get(target, property) {
        if (property === "reserve") {
          return async input => {
            assert.equal(opened, undefined);
            opened = await target.reserve(input);
            return opened;
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }),
    closure() {
      assert.ok(opened);
      const evidence = custody.evidence(opened.custodyRef);
      assert.ok(evidence);
      return evidence.closure;
    },
  });
};

// Called by both canaries only after the sole kernel submission and owner
// disposal. This asserts observations; it never writes a receipt or state.
export const observeProviderCandidateCompletion = ({ platform, result, closure, expectedOutput }) => {
  const { kernel, physicalContainment, turn } = result;
  assert.equal(kernel.providerExecution.kind, "closed");
  assert.equal(kernel.providerExecution.outcome, "succeeded");
  const proof = kind => {
    const found = kernel.proofs.find(candidate => candidate.kind === kind);
    assert.ok(found, `missing persisted ${kind}`);
    return found;
  };
  assert.equal(proof("provider_terminal_observation").binding.outcome, "succeeded");
  assert.equal(proof("output_drain").binding.finalCursor, turn.output.length);
  assert.equal(turn.output.map(chunk => chunk.text).join(""), expectedOutput);
  assert.equal(closure.status, "closed");
  if (platform === "linux") {
    assert.equal(physicalContainment.kind, "contained");
    assert.equal(turn.status, "succeeded");
    assert.equal(kernel.terminal.kind, "final");
    assert.equal(kernel.terminal.outcome, "succeeded");
    assert.equal(kernel.reconciliation, "clear");
    assert.equal(closure.profile, "strict-linux-cgroup-v2");
    assert.deepEqual(closure.limitations, []);
  } else {
    assert.equal(platform, "darwin");
    assert.equal(physicalContainment.kind, "indeterminate");
    assert.equal(turn.status, "reconcile_required");
    assert.equal(kernel.terminal.kind, "open");
    assert.equal(kernel.reconciliation, "required");
    assert.equal(closure.profile, "cooperative-darwin-posix-process-group");
    assert.deepEqual(closure.limitations, DARWIN_LIMITATIONS);
  }
  return Object.freeze({
    ...(turn.artifactManifestRef === undefined ? {} : {artifactManifestRef: turn.artifactManifestRef}),
    ...(turn.resultRef === undefined ? {} : {resultRef: turn.resultRef}),
    ...(physicalContainment.kind === "contained" ? {containmentProofDigest: digest(physicalContainment.proofId)} : {}),
    ...(kernel.terminal.kind === "final" ? {terminalProofDigest: digest(kernel.terminal.terminalProofId)} : {}),
    closureStatus: closure.status,
    containmentLimitations: Object.freeze([...closure.limitations]),
    containmentProfile: closure.profile,
    executionClosureProofDigest: digest(proof("execution_closure").proofId),
    operationIdentityDigest: digest(JSON.stringify([turn.operationId, turn.commandId, turn.effectId])),
    outputDigest: digest(expectedOutput),
    outputDrainProofDigest: digest(proof("output_drain").proofId),
    outputEvents: turn.output.length,
    providerOutcome: "succeeded",
    providerTerminalProofDigest: digest(proof("provider_terminal_observation").proofId),
    reconciliation: kernel.reconciliation,
    terminalKind: kernel.terminal.kind,
    terminalStatus: turn.status,
    ownerDisposal: "completed",
  });
};
