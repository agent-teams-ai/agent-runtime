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
      if (opened === undefined) {return undefined;}
      const evidence = custody.evidence(opened.custodyRef);
      assert.ok(evidence);
      return evidence.closure;
    },
  });
};

// Retain persisted facts even when completion assertions or teardown fail.
// Opaque owner references are hashed; raw output is never retained here.
export const observeProviderCandidateResult = ({kernel, physicalContainment, turn}) => {
  const facts = {
    operationIdentityDigest: digest(JSON.stringify([turn.operationId, turn.commandId, turn.effectId])),
    outputEvents: turn.output.length, reconciliation: kernel.reconciliation,
    closureRecovery: kernel.closureRecovery,
    terminalKind: kernel.terminal.kind, terminalStatus: turn.status,
  };
  for (const key of ["artifactManifestRef", "resultRef"]) {
    if (turn[key] !== undefined) {facts[`${key}Digest`] = digest(turn[key]);}
  }
  for (const [kind, key] of [
    ["execution_closure", "executionClosureProofDigest"],
    ["output_drain", "outputDrainProofDigest"],
    ["provider_terminal_observation", "providerTerminalProofDigest"],
  ]) {
    const proof = kernel.proofs.find(candidate => candidate.kind === kind);
    if (proof !== undefined) {facts[key] = digest(proof.proofId);}
  }
  if (kernel.providerExecution.kind === "closed") {facts.providerOutcome = kernel.providerExecution.outcome;}
  if (physicalContainment.kind === "contained") {facts.containmentProofDigest = digest(physicalContainment.proofId);}
  if (kernel.terminal.kind === "final") {facts.terminalProofDigest = digest(kernel.terminal.terminalProofId);}
  return Object.freeze(facts);
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
  assert.equal(proof("execution_closure").binding.outcome, "succeeded");
  assert.equal(proof("output_drain").binding.finalCursor, turn.output.length);
  assert.equal(turn.output.map(chunk => chunk.text).join(""), expectedOutput);
  if (platform === "linux") {
    assert.equal(closure.status, "closed");
    assert.equal(physicalContainment.kind, "contained");
    assert.equal(turn.status, "succeeded");
    assert.equal(kernel.terminal.kind, "final");
    assert.equal(kernel.terminal.outcome, "succeeded");
    assert.equal(kernel.reconciliation, "clear");
    assert.equal(kernel.closureRecovery, "clear");
    assert.equal(closure.profile, "strict-linux-cgroup-v2");
    assert.deepEqual(closure.limitations, []);
  } else {
    assert.equal(platform, "darwin");
    assert.equal(closure.status, "unproven");
    assert.equal(physicalContainment.kind, "indeterminate");
    assert.equal(turn.status, "reconcile_required");
    assert.equal(kernel.terminal.kind, "open");
    assert.equal(kernel.closureRecovery, "required");
    assert.ok(["clear", "required"].includes(kernel.reconciliation));
    assert.equal(closure.profile, "cooperative-darwin-posix-process-group");
    assert.deepEqual(closure.limitations, DARWIN_LIMITATIONS);
  }
  return Object.freeze({
    ...observeProviderCandidateResult(result),
    closureStatus: closure.status,
    containmentLimitations: Object.freeze([...closure.limitations]),
    containmentProfile: closure.profile,
    outputDigest: digest(expectedOutput),
  });
};
