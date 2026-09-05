import { createAgentRuntimeHost } from "./helpers/create-contained-turn-host.ts";
import assert from "node:assert/strict";
import test from "node:test";

import { createContainedTurnFeature } from "@agent-teams/agent-execution/composition";
import {
  createDependencies,
  operationId as fixtureOperationId,
} from "../../../contexts/agent-execution/tests/features/contained-agent-turn/support/contained-agent-turn-fixture.ts";

import {
  AgentRuntimeHostLifecycleError,
  ContainedTurnOwnerContractError,
  createClaudeCodeSetupInspectionPlanner,
  createCodexSetupInspectionPlanner,
} from "../dist/composition.js";
import { copySubmitOutcome } from "../dist/composition/contained-turn-runtime-validation.js";

const unavailable = (): never => {throw new Error("setup dependency must not be reached");};

const setupDependencies = Object.freeze({
  claudeCodeSetup: Object.freeze({
    authorizeClaudeCodeSetupInspection: Object.freeze({ execute: unavailable }),
    discoverClaudeCodeInstallations: Object.freeze({ execute: unavailable }),
    inspectClaudeCodeConfiguration: Object.freeze({ execute: unavailable }),
    planClaudeCodeSetupInspection: createClaudeCodeSetupInspectionPlanner("linux"),
  }),
  codexSetup: Object.freeze({
    authorizeSetupInspection: Object.freeze({ execute: unavailable }),
    discoverCodexInstallations: Object.freeze({ execute: unavailable }),
    inspectCodexConfiguration: Object.freeze({ execute: unavailable }),
    planCodexSetupInspection: createCodexSetupInspectionPlanner("linux"),
  }),
});

// Match the reused operation fixture's Provider Access authority.
const trustedScope = Object.freeze({ projectId: "project:one", tenantId: "tenant:one" });

test("potential durable acceptance is not accepted or tracked by RuntimeAccessHandle", async () => {
  const fixture = createDependencies({ potentialAcceptance: true });
  let acceptanceCalls = 0;
  let cancellationCalls = 0;
  const feature = createContainedTurnFeature({
    ...fixture.dependencies,
    operationStore: {
      ...fixture.dependencies.operationStore,
      accept: async (...args) => {
        acceptanceCalls += 1;
        return fixture.dependencies.operationStore.accept(...args);
      },
    },
  });
  const host = createAgentRuntimeHost({
    ...setupDependencies,
    containedTurn: {
      ...feature,
      cancel: { execute: async (...args) => {
        cancellationCalls += 1;
        return feature.cancel.execute(...args);
      } },
    },
  });
  const access = host.bindAccess({ containedTurn: trustedScope });
  const outcome = await access.containedTurn.submit({
    commandId: "command:one",
    expectedProvider: "codex",
    intent: { mode: "analysis", prompt: "inspect potential durable acceptance" },
  });
  assert.deepEqual(outcome, {
    candidateOperationId: fixtureOperationId,
    commandId: "command:one",
    evidenceId: "evidence:potential-acceptance",
    status: "potential_acceptance",
  });
  assert.equal(Object.isFrozen(outcome), true);
  assert.equal(fixture.current(), undefined);
  assert.deepEqual(await access.containedTurn.observe(fixtureOperationId), { status: "not_found" });
  assert.deepEqual(await access.containedTurn.cancel(fixtureOperationId), { status: "not_found" });
  assert.equal(cancellationCalls, 1);
  // An ephemeral owner registration would make disposal attempt cancellation again
  // and fail with termination_unproven after observing not_found.
  await host.dispose();
  assert.equal(cancellationCalls, 1);
  assert.equal(acceptanceCalls, 1);
  assert.equal(fixture.current(), undefined);
  assert.equal(fixture.createdWorkspaces.length, 0);
  assert.equal(fixture.providerCalls.value, 0);
  await assert.rejects(access.containedTurn.submit({
    commandId: "command:one", expectedProvider: "codex",
    intent: { mode: "analysis", prompt: "inspect potential durable acceptance" },
  }), error => error instanceof AgentRuntimeHostLifecycleError && error.code === "host_disposed");
  assert.equal(acceptanceCalls, 1);
});

test("potential acceptance projection retains only bounded detached reconciliation references", () => {
  const owner = {
    candidateOperationId: "operation:potential", commandId: "command:potential",
    evidenceId: "evidence:potential", status: "potential_acceptance",
    revision: 77, scope: trustedScope, candidateOperation: { private: "owner state" },
    credential: "private credential", path: "/private/owner/workspace",
  };
  let confirmedReferences = 0;
  const copied = copySubmitOutcome(owner, () => {confirmedReferences += 1;});
  const expected = {
    candidateOperationId: "operation:potential", commandId: "command:potential",
    evidenceId: "evidence:potential", status: "potential_acceptance",
  };
  assert.deepEqual(copied, { outcome: expected });
  owner.candidateOperationId = "operation:mutated";
  owner.commandId = "command:mutated";
  owner.evidenceId = "evidence:mutated";
  assert.deepEqual(copied.outcome, expected);
  assert.equal(Object.isFrozen(copied.outcome), true);
  assert.equal(confirmedReferences, 0);
  for (const field of ["candidateOperationId", "commandId", "evidenceId"] as const) {
    for (const value of [undefined, "", "x".repeat(513), "bad\nidentity", trustedScope]) {
      assert.throws(() => copySubmitOutcome({ ...expected, [field]: value }),
        error => error instanceof ContainedTurnOwnerContractError && error.code === "malformed_owner_outcome");
    }
  }
});
