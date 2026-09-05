import assert from "node:assert/strict";
import test from "node:test";
import { createDependencies } from "./support/contained-agent-turn-fixture.ts";
import { submitContainedTurnLiveCanary } from "./support/contained-turn-live-canary-submission.mjs";
import { observeProviderCandidateCompletion, DARWIN_LIMITATIONS } from "../../live/provider-candidate-observation.mjs";

for (const provider of ["codex", "claude"] as const) {
  for (const platform of ["linux", "darwin"] as const) {
    test(`${provider} ${platform}: provider completion preserves real kernel containment and terminal truth`, async () => {
      const fixture = createDependencies();
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
      const result = await submitContainedTurnLiveCanary({
        command, owner: {async dispose() {disposals += 1;}},
        dependencies: {
          ...deps, providerAccess,
          provider: {...deps.provider,
            adapterSnapshot: {...deps.provider.adapterSnapshot, provider},
            manifest: {...deps.provider.manifest, provider},
          },
          custody: platform === "linux" ? deps.custody : {
            ...deps.custody,
            async requestPhysicalContainment() {
              return {kind: "indeterminate" as const, evidenceId: "evidence:darwin-physical-unproven" as never};
            },
          },
        },
      });
      const closure = Object.freeze({status: "closed",
        profile: platform === "linux" ? "strict-linux-cgroup-v2" : "cooperative-darwin-posix-process-group",
        limitations: platform === "linux" ? Object.freeze([]) : DARWIN_LIMITATIONS,
      });
      const observation = observeProviderCandidateCompletion({platform, result, closure, expectedOutput: "ok"});
      assert.equal(observation.providerOutcome, "succeeded");
      assert.equal(observation.terminalStatus, platform === "linux" ? "succeeded" : "reconcile_required");
      assert.equal(fixture.current()?.terminal.kind, platform === "linux" ? "final" : "open");
      assert.equal(fixture.current()?.physicalContainment.kind, platform === "linux" ? "contained" : "uncertain");
      assert.equal(fixture.providerCalls.value, 1);
      assert.equal(disposals, 1);
      assert.throws(() => observeProviderCandidateCompletion({platform, result, closure, expectedOutput: "wrong"}));
      assert.throws(() => observeProviderCandidateCompletion({
        platform, result: {...result, kernel: {...result.kernel, proofs: []}}, closure, expectedOutput: "ok",
      }));
    });
  }
}
