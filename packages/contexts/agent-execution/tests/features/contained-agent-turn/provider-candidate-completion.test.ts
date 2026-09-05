import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createDependencies } from "./support/contained-agent-turn-fixture.ts";
import { submitContainedTurnLiveCanary } from "./support/contained-turn-live-canary-submission.mjs";
import { observeProviderCandidateCompletion, DARWIN_LIMITATIONS } from "../../live/provider-candidate-observation.mjs";
import { createCandidateRunObservation } from "../../live/provider-candidate-run-observation.mjs";
import { sourceFixture, evidenceInput } from "./support/provider-candidate-source-fixture.mjs";

for (const provider of ["codex", "claude"] as const) {
  for (const platform of ["linux", "darwin"] as const) {
    test(`${provider} ${platform}: provider completion preserves real kernel containment and terminal truth`, async t => {
      const fixture = createDependencies({containmentIndeterminate: platform === "darwin"});
      const deps = fixture.dependencies;
      const providerAccess = {
        ...deps.providerAccess,
        async resolveForAcceptance(input: Parameters<typeof deps.providerAccess.resolveForAcceptance>[0]) {
          const outcome = await deps.providerAccess.resolveForAcceptance(input);
          assert.equal(outcome.kind, "resolved");
          return {...outcome, snapshot: {...outcome.snapshot, provider}};
        },
        async revalidateForDispatch(input: Parameters<typeof deps.providerAccess.revalidateForDispatch>[0]) {
          const outcome = await deps.providerAccess.revalidateForDispatch(input);
          assert.equal(outcome.kind, "current");
          return {...outcome, snapshot: {...outcome.snapshot, provider}};
        },
      };
      const command = {
        commandId: "command:one", expectedProvider: provider,
        intent: {mode: "analysis" as const, prompt: "synthetic canary"},
        scope: {projectId: "project:one", tenantId: "tenant:one"},
      };
      let disposals = 0;
      let physicalQueries = 0;
      const unprovenPhysical = async () => {
        physicalQueries += 1;
        return {kind: "indeterminate" as const, evidenceId: "evidence:darwin-physical-unproven" as never};
      };
      const observed = createCandidateRunObservation();
      const result = await submitContainedTurnLiveCanary({
        command, owner: {dispose: () => observed.dispose("ownerDisposal", async () => {disposals += 1;})},
        onObserved: observed.result,
        dependencies: {
          ...deps, providerAccess,
          custody: platform === "linux" ? deps.custody : {...deps.custody,
            ensurePhysicalContainment: unprovenPhysical, queryPhysicalContainment: unprovenPhysical},
          provider: {...deps.provider,
            adapterSnapshot: {...deps.provider.adapterSnapshot, provider},
            manifest: {...deps.provider.manifest, provider},
          },
        },
      });
      // Host custody retains unproven after cooperative Darwin group shutdown.
      const closure = Object.freeze({status: platform === "linux" ? "closed" : "unproven",
        profile: platform === "linux" ? "strict-linux-cgroup-v2" : "cooperative-darwin-posix-process-group",
        limitations: platform === "linux" ? Object.freeze([]) : DARWIN_LIMITATIONS,
      });
      const observation = observeProviderCandidateCompletion({platform, result, closure, expectedOutput: "ok"});
      observed.closure(closure);
      observed.completed(observation);
      await observed.dispose("runtimeDisposal", async () => {});
      assert.equal(observation.providerOutcome, "succeeded");
      assert.equal(observation.terminalStatus, platform === "linux" ? "succeeded" : "reconcile_required");
      assert.equal(fixture.current()?.terminal.kind, platform === "linux" ? "final" : "open");
      assert.equal(fixture.current()?.physicalContainment.kind, platform === "linux" ? "contained" : "pending");
      assert.equal(fixture.current()?.reconciliation.kind, "clear");
      assert.equal(fixture.current()?.closureRecovery.kind, platform === "linux" ? "clear" : "required");
      assert.equal(fixture.providerCalls.value, 1);
      assert.equal(disposals, 1);
      assert.equal(physicalQueries > 0, platform === "darwin");
      const source = await sourceFixture(t, provider);
      const provenance = await source.resolve();
      const input = evidenceInput(source, provenance, {
        ...observed.evidence("provider-completed"),
        binaryRevision: provider === "codex" ? `@openai/codex:0.150.1+${platform}-${platform === "linux" ? "x64" : "arm64"}` : `sha256:${"a".repeat(64)}`,
        platformTuple: Object.freeze({platform, architecture: platform === "linux" ? "x64" : "arm64"}),
      });
      const publish = source.authority.createProviderCandidateEvidenceEnvelope;
      const envelope = await publish(input);
      assert.equal(envelope.observations.terminalStatus, observation.terminalStatus);
      assert.equal(envelope.observations.closureStatus, closure.status);
      assert.equal(envelope.observations.closureRecovery, platform === "linux" ? "clear" : "required");
      assert.equal(envelope.observations.ownerDisposal, "completed");
      assert.equal(envelope.observations.runtimeDisposal, "completed");
      assert.equal(envelope.observations.outputDigest.length, 71);
      assert.equal(envelope.physicalContainment, platform === "linux" ? "contained" : "indeterminate");
      if (platform === "linux") {
        assert.match(envelope.observations.artifactManifestRefDigest, /^sha256:[a-f0-9]{64}$/u);
        assert.match(envelope.observations.resultRefDigest, /^sha256:[a-f0-9]{64}$/u);
      } else {
        assert.equal(envelope.observations.terminalProofDigest, undefined);
        assert.equal(envelope.observations.containmentProofDigest, undefined);
      }
      const assertFailedTeardownEvidence = async () => {
        // A later teardown failure retains persisted success without claiming
        // the canary's expected output was verified. No live provider is run.
        const failed = Object.freeze({...input, status: "failed", observations: Object.freeze({
          ...Object.fromEntries(Object.entries(input.observations).filter(([key]) => key !== "outputDigest")),
          failureKind: "canary-failed", ownerDisposal: "failed",
        })});
        const failedEnvelope = await publish(failed);
        assert.equal(failedEnvelope.observations.terminalStatus, observation.terminalStatus);
        assert.equal(failedEnvelope.observations.outputDigest, undefined);
        assert.equal(failedEnvelope.status, "failed");
        assert.equal(failedEnvelope.networkRouteEnforcement, "unqualified");
        assert.equal(failedEnvelope.qualification, "implementation-evidence-only");
        for (const [key, kind] of [["artifactManifestProofDigest", "artifact_manifest_seal"], ["resultPublicationProofDigest", "result_publication"]]) {
          if (platform === "linux") {
            const proof = result.kernel.proofs.find(candidate => candidate.kind === kind);
            assert.equal(failedEnvelope.observations[key], `sha256:${createHash("sha256").update(proof.proofId).digest("hex")}`);
          } else {assert.equal(failedEnvelope.observations[key], undefined);}
        }
        const required = ["operationIdentityDigest", "executionClosureProofDigest", "providerTerminalProofDigest",
          "outputEvents",
          ...(platform === "linux" ? ["outputDrainProofDigest", "artifactManifestProofDigest", "resultPublicationProofDigest",
            "artifactManifestRefDigest", "resultRefDigest", "terminalProofDigest", "terminalKind", "terminalStatus",
            "reconciliation", "closureRecovery", "containmentProofDigest", "closureStatus"] : [])];
        for (const missing of required) {
          // Omit the field entirely: an invalid undefined value would only test
          // the leaf schema and could mask a missing completeness check.
          await assert.rejects(publish(Object.freeze({...failed, observations: Object.freeze(
            Object.fromEntries(Object.entries(failed.observations).filter(([key]) => key !== missing)),
          )})), TypeError, missing);
        }
        if (platform === "darwin") {
          const withoutDrain = Object.fromEntries(Object.entries(failed.observations).filter(([key]) => key !== "outputDrainProofDigest"));
          const partial = await publish(Object.freeze({...failed, observations: Object.freeze(withoutDrain)}));
          assert.equal(partial.observations.outputDigest, undefined);
          assert.equal(partial.observations.terminalKind, "open");
          await assert.rejects(publish(Object.freeze({...failed, observations: Object.freeze({
            ...withoutDrain, outputDigest: input.observations.outputDigest,
          })})), TypeError);
        }
        for (const patch of [{providerOutcome: "indeterminate"}, {closureRecovery: "proved_no_workspace"}]) {
          await assert.rejects(publish(Object.freeze({...failed,
            observations: Object.freeze({...failed.observations, ...patch})})), TypeError);
        }
      };
      await assertFailedTeardownEvidence();
      const invalid = [
        {closureStatus: platform === "linux" ? "unproven" : "closed"},
        {closureStatus: "not-started"},
        {containmentProfile: platform === "linux" ? "cooperative-darwin-posix-process-group" : "strict-linux-cgroup-v2"},
        {containmentLimitations: platform === "linux" ? DARWIN_LIMITATIONS : Object.freeze([])},
        {providerOutcome: "indeterminate"},
        {executionClosureProofDigest: undefined},
        {outputDrainProofDigest: undefined},
        {providerTerminalProofDigest: undefined},
        {closureRecovery: "clear", reconciliation: "clear", terminalKind: "open", terminalStatus: "reconcile_required"},
        ...(platform === "darwin" ? [
          {closureRecovery: "clear", reconciliation: "required"},
          {terminalKind: "final", terminalStatus: "succeeded", terminalProofDigest: "a".repeat(64)},
          {terminalKind: "final", terminalStatus: "failed", terminalProofDigest: "a".repeat(64)},
          {containmentProofDigest: "a".repeat(64)},
        ] : [{reconciliation: "required"}]),
      ];
      for (const patch of invalid) {
        await assert.rejects(publish(Object.freeze({...input,
          observations: Object.freeze({...input.observations, ...patch})})), TypeError);
      }
      await assert.rejects(publish(Object.freeze({...input,
        physicalContainment: platform === "linux" ? "indeterminate" : "contained"})), TypeError);
      // Even failed canary teardown must not project unproven custody as final.
      await assert.rejects(publish(Object.freeze({...input, status: "failed",
        observations: Object.freeze({...input.observations, failureKind: "canary-failed",
          closureStatus: "unproven", terminalKind: "final", terminalStatus: "failed",
          terminalProofDigest: "a".repeat(64), reconciliation: "clear", closureRecovery: "clear"})})), TypeError);
      if (platform === "darwin") {
        await assert.rejects(publish(Object.freeze({...input, status: "failed",
          observations: Object.freeze({...input.observations, failureKind: "canary-failed",
            closureStatus: "unproven", terminalKind: "open", terminalStatus: "running",
            terminalProofDigest: undefined, reconciliation: "clear", closureRecovery: "clear"})})), TypeError);
      } else {
        await assert.rejects(publish(Object.freeze({...input, status: "failed", physicalContainment: "indeterminate",
          observations: Object.freeze({...input.observations, failureKind: "canary-failed",
            closureStatus: "not-started", containmentProofDigest: undefined,
            terminalKind: "final", terminalStatus: "succeeded", terminalProofDigest: "a".repeat(64),
            reconciliation: "clear", closureRecovery: "clear"})})), TypeError);
      }
      assert.throws(() => observeProviderCandidateCompletion({platform, result, closure, expectedOutput: "wrong"}));
      assert.throws(() => observeProviderCandidateCompletion({
        platform, result: {...result, kernel: {...result.kernel, proofs: []}}, closure, expectedOutput: "ok",
      }));
      for (const status of platform === "linux" ? ["unproven", "not-started"] : ["closed", "not-started"]) {
        assert.throws(() => observeProviderCandidateCompletion({
          platform, result, closure: {...closure, status}, expectedOutput: "ok",
        }));
      }
      if (platform === "darwin") {
        for (const terminal of [{kind: "final", outcome: "succeeded"}, {kind: "final", outcome: "failed"}]) {
          assert.throws(() => observeProviderCandidateCompletion({
            platform, result: {...result, kernel: {...result.kernel, terminal}}, closure, expectedOutput: "ok",
          }));
        }
        assert.throws(() => observeProviderCandidateCompletion({
          platform, result: {...result, kernel: {...result.kernel, closureRecovery: "clear"}}, closure, expectedOutput: "ok",
        }));
      }
    });
  }
}
