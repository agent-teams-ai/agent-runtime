import assert from "node:assert/strict";
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
      const closure = Object.freeze({status: "closed",
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
      const envelope = await source.authority.createProviderCandidateEvidenceEnvelope(evidenceInput(source, provenance, {
        ...observed.evidence("provider-completed"),
        binaryRevision: provider === "codex" ? `@openai/codex:0.150.1+${platform}-${platform === "linux" ? "x64" : "arm64"}` : `sha256:${"a".repeat(64)}`,
        platformTuple: Object.freeze({platform, architecture: platform === "linux" ? "x64" : "arm64"}),
      }));
      assert.equal(envelope.observations.terminalStatus, observation.terminalStatus);
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
      assert.throws(() => observeProviderCandidateCompletion({platform, result, closure, expectedOutput: "wrong"}));
      assert.throws(() => observeProviderCandidateCompletion({
        platform, result: {...result, kernel: {...result.kernel, proofs: []}}, closure, expectedOutput: "ok",
      }));
    });
  }
}
