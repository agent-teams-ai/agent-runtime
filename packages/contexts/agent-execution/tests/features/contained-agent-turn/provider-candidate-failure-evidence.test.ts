import assert from "node:assert/strict";
import test from "node:test";
import { sourceFixture, evidenceInput } from "./support/provider-candidate-source-fixture.mjs";
import { createDependencies } from "./support/contained-agent-turn-fixture.ts";
import { submitContainedTurnLiveCanary } from "./support/contained-turn-live-canary-submission.mjs";
import { createCandidateRunObservation } from "../../live/provider-candidate-run-observation.mjs";
import { DARWIN_LIMITATIONS } from "../../live/provider-candidate-observation.mjs";

const freeze = Object.freeze;
const digest = "a".repeat(64);
const without = (value: Record<string, unknown>, ...keys: string[]) =>
  freeze(Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key))));

for (const provider of ["codex", "claude"] as const) {
  test(`${provider}: failure cannot bypass containment or terminal success evidence`, async t => {
    const source = await sourceFixture(t, provider);
    const input = evidenceInput(source, await source.resolve(), {physicalContainment: "contained"});
    const publish = source.authority.createProviderCandidateEvidenceEnvelope;
    await t.test("arbitrary containment digest without closure or identity", async () => {
      await assert.rejects(publish(freeze({...input, observations: freeze({
        ...input.observations, containmentProofDigest: digest,
      })})), TypeError);
    });
    await t.test("succeeded terminal without identity, execution, drain or artifacts", async () => {
      await assert.rejects(publish(freeze({...input, observations: freeze({
        ...input.observations, containmentProofDigest: digest, terminalProofDigest: digest,
        terminalKind: "final", terminalStatus: "succeeded", providerOutcome: "succeeded",
        reconciliation: "clear", closureRecovery: "clear", closureStatus: "closed",
        containmentProfile: "strict-linux-cgroup-v2", containmentLimitations: freeze([]),
      })})), TypeError);
    });
    const unknown = evidenceInput(source, input.executionProvenance);
    for (const claim of [
      {providerOutcome: "succeeded"}, {outputDigest: digest}, {outputDrainProofDigest: digest},
      {executionClosureProofDigest: digest}, {providerTerminalProofDigest: digest},
      {terminalProofDigest: digest}, {terminalKind: "final"}, {terminalStatus: "succeeded"},
      {artifactManifestRefDigest: digest}, {resultRefDigest: digest},
      {artifactManifestRef: `urn:agent-runtime:artifact-manifest:${digest}`},
      {resultRef: `urn:agent-runtime:contained-turn-result:${digest}`},
      {artifactManifestProofDigest: digest}, {resultPublicationProofDigest: digest},
    ]) {
      await assert.rejects(publish(freeze({...unknown, observations: freeze({...unknown.observations, ...claim})})), TypeError);
    }
    // Physical closure is useful failure evidence independently of provider
    // completion, output verification or a final kernel result.
    const contained = freeze({...input, observations: freeze({...input.observations,
      operationIdentityDigest: digest, containmentProofDigest: digest, closureStatus: "closed",
      containmentProfile: "strict-linux-cgroup-v2", containmentLimitations: freeze([]),
    })});
    assert.equal((await publish(contained)).physicalContainment, "contained");
    for (const missing of ["operationIdentityDigest", "containmentProofDigest", "closureStatus",
      "containmentProfile", "containmentLimitations"]) {
      await assert.rejects(publish(freeze({...contained, observations: without(contained.observations, missing)})), TypeError, missing);
    }
    for (const patch of [
      {terminalKind: "open", terminalStatus: "failed"},
      {reconciliation: "required", terminalStatus: "running"},
      {closureRecovery: "required", terminalStatus: "accepted"},
      {reconciliation: "clear", closureRecovery: "clear", terminalStatus: "reconcile_required"},
    ]) {
      await assert.rejects(publish(freeze({...unknown, observations: freeze({...unknown.observations, ...patch})})), TypeError);
    }
  });

  for (const platform of ["linux", "darwin"] as const) {
    test(`${provider} ${platform}: persistence read failure retains truthful unproven custody and teardown`, async t => {
      const source = await sourceFixture(t, provider);
      const execution = await source.resolve();
      const observed = createCandidateRunObservation();
      const fixture = createDependencies({custodyOpenThrows: true});
      const failure = new Error("private persistence read failure");
      let reads = 0;
      await assert.rejects(submitContainedTurnLiveCanary({
        command: {commandId: "command:one", expectedProvider: "codex",
          intent: {mode: "analysis", prompt: "disposable read failure"},
          scope: {projectId: "project:one", tenantId: "tenant:one"}},
        dependencies: {...fixture.dependencies, operationStore: {...fixture.dependencies.operationStore,
          read: async () => {reads += 1; throw failure;},
        }},
        onObserved: observed.result,
        owner: {dispose: () => observed.dispose("ownerDisposal", async () => {
          observed.closure({status: "unproven",
            profile: platform === "linux" ? "strict-linux-cgroup-v2" : "cooperative-darwin-posix-process-group",
            limitations: platform === "linux" ? [] : DARWIN_LIMITATIONS});
        })},
      }), error => error === failure);
      await observed.dispose("runtimeDisposal", async () => {});
      assert.ok(reads > 0);
      assert.equal(fixture.providerCalls.value, 0);
      const input = evidenceInput(source, execution, {...observed.evidence("failed"),
        binaryRevision: provider === "codex" ? `@openai/codex:0.150.1+${platform}-${platform === "linux" ? "x64" : "arm64"}` : `sha256:${digest}`,
        platformTuple: freeze({platform, architecture: platform === "linux" ? "x64" : "arm64"}),
      });
      const publish = source.authority.createProviderCandidateEvidenceEnvelope;
      const envelope = await publish(input);
      assert.equal(envelope.status, "failed");
      assert.equal(envelope.observations.closureStatus, "unproven");
      assert.equal(envelope.observations.ownerDisposal, "completed");
      assert.equal(envelope.observations.runtimeDisposal, "completed");
      assert.equal(envelope.physicalContainment, "indeterminate");
      assert.equal(envelope.compositeContainment, "indeterminate");
      assert.equal(envelope.networkRouteEnforcement, "unqualified");
      assert.equal(envelope.qualification, "implementation-evidence-only");
      assert.equal(envelope.sourceSha, execution.sourceSha);
      assert.ok(Object.isFrozen(envelope) && Object.isFrozen(envelope.observations));
      for (const key of ["terminalKind", "terminalStatus", "closureRecovery", "reconciliation",
        "providerOutcome", "terminalProofDigest", "containmentProofDigest", "outputDigest"]) {
        assert.equal(Object.hasOwn(envelope.observations, key), false, key);
      }
      assert.doesNotMatch(JSON.stringify(envelope), /private persistence|errorDigest|command:one|project:one/u);

      // Missing observations stay missing, including partial kernel reads.
      const kernel = {terminalKind: "open", terminalStatus: "reconcile_required",
        reconciliation: "clear", closureRecovery: "required"};
      for (let mask = 0; mask < 16; mask += 1) {
        const subset = Object.fromEntries(Object.entries(kernel).filter((_, index) => mask & (1 << index)));
        const partial = await publish(freeze({...input, observations: freeze({...input.observations, ...subset})}));
        for (const key of Object.keys(kernel)) {
          assert.equal(Object.hasOwn(partial.observations, key), Object.hasOwn(subset, key), key);
        }
      }
      for (const patch of [
        {terminalKind: "final"}, {terminalStatus: "succeeded"}, {terminalStatus: "failed"},
        {terminalStatus: "running"}, {closureRecovery: "clear"}, {closureRecovery: "proved_no_workspace"},
        {terminalProofDigest: digest}, {containmentProofDigest: digest},
      ]) {
        await assert.rejects(publish(freeze({...input, observations: freeze({...input.observations, ...patch})})), TypeError);
      }
      await assert.rejects(publish(freeze({...input, physicalContainment: "contained"})), TypeError);
      await assert.rejects(publish(freeze({...input, status: "provider-completed",
        observations: without(input.observations, "failureKind")})), TypeError);
    });
  }
}
