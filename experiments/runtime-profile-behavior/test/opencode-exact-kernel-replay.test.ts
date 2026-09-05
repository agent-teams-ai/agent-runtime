import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createContainedTurnFeature, type ContainedTurnFeatureDependencies } from "@agent-teams/agent-execution/composition";
// Reuse the existing in-memory owner fixture; this is not a production package export.
import { createDependencies } from "../../../packages/contexts/agent-execution/tests/features/contained-agent-turn/support/contained-agent-turn-fixture.ts";
import { characterizeOpenCodeExactContract, parseOpenCodeExactContractFixture } from "../src/features/acp-compatibility/opencode-exact-contract.ts";

test("replays exact fixture characterization through the neutral kernel with OpenCode identity", async () => {
  const fixture = await parseOpenCodeExactContractFixture(await readFile(new URL(
    "../fixtures/acp-compatibility/opencode-1-18-5-contract.json", import.meta.url,
  )));
  const projection = characterizeOpenCodeExactContract(fixture);
  const harness = createDependencies();
  const original = harness.dependencies;
  let executions = 0;
  const dependencies = {
    ...original,
    providerAccess: {
      ...original.providerAccess,
      async resolveForAcceptance(input) {
        assert.equal(input.provider, "opencode");
        const resolution = await original.providerAccess.resolveForAcceptance(input);
        assert.equal(resolution.kind, "resolved");
        if (resolution.kind !== "resolved") {return resolution;}
        return { ...resolution, snapshot: { ...resolution.snapshot, provider: projection.provider } };
      },
      async revalidateForDispatch(input) {
        const resolution = await original.providerAccess.revalidateForDispatch(input);
        if (resolution.kind !== "current") {return resolution;}
        return { ...resolution, snapshot: { ...resolution.snapshot, provider: projection.provider } };
      },
    },
    provider: {
      adapterSnapshot: {
        ...original.provider.adapterSnapshot,
        provider: projection.provider,
        binaryRevision: projection.providerRevision,
        capabilityManifestRevision: projection.manifestRevision,
      },
      manifest: {
        ...original.provider.manifest,
        provider: projection.provider,
        manifestRevision: projection.manifestRevision,
        supportedModes: projection.supportedModes,
        unknownCapabilityPolicy: projection.unknownCapabilityPolicy,
      },
      async execute(input) {
        executions += 1;
        // The test custody seam records a synthetic start; no process is launched.
        input.start.createProcess(() => Object.freeze({}));
        return { kind: "completed", outcome: projection.terminalObservation };
      },
    },
  } satisfies ContainedTurnFeatureDependencies;
  const result = await createContainedTurnFeature(dependencies).submit.execute({
    commandId: "command:opencode-exact-replay",
    expectedProvider: projection.provider,
    intent: { mode: projection.supportedModes[0], prompt: "synthetic characterization replay" },
    scope: { projectId: "project:one", tenantId: "tenant:one" },
  });
  assert.equal(result.status, "observed");
  if (result.status !== "observed") {assert.fail("kernel did not observe replay");}
  assert.equal(result.turn.status, "succeeded");
  assert.deepEqual(result.turn.output, []);
  const operation = harness.current();
  assert.ok(operation);
  assert.equal(operation.adapterSnapshot.provider, "opencode");
  assert.equal(operation.adapterSnapshot.binaryRevision, fixture.pin.providerRevision);
  assert.equal(operation.capabilityManifest.provider, "opencode");
  assert.equal(operation.capabilityManifest.manifestRevision, fixture.neutralContract.manifestRevision);
  assert.equal(operation.providerAccessSnapshot.provider, "opencode");
  assert.equal(operation.acceptedAuthorityVector.adapterSnapshot.provider, "opencode");
  assert.equal(operation.acceptedAuthorityVector.providerAccessSnapshot.provider, "opencode");
  assert.equal(operation.providerAcceptance.kind, "accepted");
  assert.equal(operation.providerExecution.kind, "closed");
  assert.equal(operation.effect.kind, "resolved");
  assert.equal(operation.output.fence.kind, "fenced");
  assert.equal(operation.containment.kind, "contained");
  assert.equal(operation.terminal.kind, "final");
  assert.equal(operation.requiredReceiptSet.receipts.length, 12);
  assert.equal(executions, 1);
  assert.equal(fixture.claim, "contract_only_no_production_adapter");
  assert.deepEqual(fixture.capabilityDisposition.map(value => value.status).toSorted(), [
    "deferred", "supported", "unknown", "unsupported",
  ]);
});
