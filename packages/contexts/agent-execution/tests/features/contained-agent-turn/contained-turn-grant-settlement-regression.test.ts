import assert from "node:assert/strict";
import test from "node:test";

import { recoverContainedTurnCommittedGrantSettlements } from "../../../dist/features/contained-agent-turn/application/contained-turn-preparation-recovery.js";
import { createContainedTurnFeature } from "../../../dist/features/contained-agent-turn/composition/feature-module-factory.js";
import { containedTurnIdentity } from "../../../dist/features/contained-agent-turn/domain/contained-turn-identities.js";
import { mutateContainedTurnOperation } from "../../../dist/features/contained-agent-turn/domain/contained-turn-kernel.js";
import { createReservedOperation } from "../../contained-turn-kernel-fixtures.ts";
import { createDependencies } from "./support/contained-agent-turn-fixture.ts";

for (const duplicate of [false, true]) {
  test(`unknown process start preserves prior debt and deduplicates evidence: ${duplicate}`, () => {
    const prior = containedTurnIdentity("evidence", "evidence:settlement-debt");
    const next = duplicate ? prior : containedTurnIdentity("evidence", "evidence:unknown-start");
    const indebted = mutateContainedTurnOperation(createReservedOperation(), {
      evidenceId: prior, kind: "record_reconciliation_debt", source: "dispatch_authority",
    });
    const result = mutateContainedTurnOperation(indebted, {
      evidenceId: next, kind: "record_process_start_unknown",
    });
    assert.deepEqual(result.reconciliation, {
      evidenceIds: duplicate ? [prior] : [prior, next], kind: "required",
    });
    assert.deepEqual(result.dispatch, indebted.dispatch);
    assert.equal(result.operationCutoff.kind, "closed");
    assert.equal(result.operationCutoff.revision, indebted.operationCutoff.revision + 1);
    assert.deepEqual(result.output, indebted.output);
    assert.deepEqual(result.providerProcessStart, { evidenceId: next, kind: "unknown" });
    assert.equal(result.terminal.kind, "open");
  });
}

for (const owner of ["providerAccess", "security"] as const) {
  for (const failure of ["indeterminate", "rejected"] as const) {
    test(`${owner} ${failure} settlement stops the committed claim before custody start and provider execution`, async () => {
      const fixture = createDependencies();
      const { dependencies } = fixture;
      let failSettlement = true;
      const settlements: string[] = [];
      const configured = {
        ...dependencies,
        [owner]: {
          ...dependencies[owner],
          settleConsumedGrant: async (input: Parameters<typeof dependencies.providerAccess.settleConsumedGrant>[0]) => {
            settlements.push(input.disposition);
            if (failSettlement) {
              if (failure === "rejected") {throw new Error("synthetic settlement rejection");}
              return { kind: "indeterminate" as const, evidenceId: containedTurnIdentity("evidence", "evidence:settlement-unavailable") };
            }
            return { kind: "already_settled" as const };
          },
        },
      };
      const feature = createContainedTurnFeature(configured);
      const input = {
        commandId: "command:one", expectedProvider: "codex",
        intent: { mode: "analysis" as const, prompt: "synthetic settlement regression" },
        scope: { projectId: "project:one", tenantId: "tenant:one" },
      };
      const result = await feature.submit.execute(input);
      assert.equal(result.status, "observed");
      if (result.status !== "observed") {assert.fail("must expose durable reconciliation debt");}
      assert.equal(result.turn.status, "reconcile_required");
      const indebted = fixture.current();
      assert.ok(indebted);
      assert.equal(result.turn.revision, indebted.revision);
      assert.equal(indebted.dispatch.kind, "claimed");
      assert.equal(indebted.providerProcessStart.kind, "pending");
      assert.equal(indebted.providerExecution.kind, "not_started");
      assert.equal(indebted.reconciliation.kind, "required");
      assert.equal(indebted.terminal.kind, "open");
      assert.equal(fixture.custodyStartInputs.length, 0);
      assert.equal(fixture.providerCalls.value, 0);
      assert.equal(fixture.custodyReleases.length, 0);

      failSettlement = false;
      await recoverContainedTurnCommittedGrantSettlements(configured, indebted);
      const replay = await createContainedTurnFeature({
        ...configured,
        operationStore: {
          ...configured.operationStore,
          identifyAcceptance: async () => ({ kind: "replayed" as const, operation: indebted }),
        },
      }).submit.execute(input);
      assert.equal(replay.status, "observed");
      assert.deepEqual(fixture.current()?.dispatch, indebted.dispatch);
      assert.deepEqual(fixture.current()?.reconciliation, indebted.reconciliation);
      assert.equal(fixture.claimAuthorities.length, 1);
      assert.equal(fixture.custodyStartInputs.length, 0);
      assert.equal(fixture.providerCalls.value, 0, "settlement replay cannot recover start authority");
      assert.deepEqual(settlements, ["claim_committed", "claim_committed"]);
    });
  }
}
