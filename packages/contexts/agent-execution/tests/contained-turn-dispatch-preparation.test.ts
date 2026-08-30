import assert from "node:assert/strict";
import test from "node:test";

import { reconcileContainedTurnClaimPreparation } from "../dist/features/contained-agent-turn/application/contained-turn-preparation-cleanup.js";
import type { ContainedTurnKernelDependencies } from "../dist/features/contained-agent-turn/application/ports/outbound/contained-turn-ports.js";
import { containedTurnIdentity } from "../dist/features/contained-agent-turn/domain/contained-turn-identities.js";
import type { ContainedTurnKernelOperation } from "../dist/features/contained-agent-turn/domain/contained-turn-kernel-model.js";
import { mutateContainedTurnOperation } from "../dist/features/contained-agent-turn/domain/contained-turn-kernel.js";
import {
  attemptId,
  createOperation,
  createReservedOperation,
  custodyId,
  preparationToken,
  scope,
  workspaceId,
} from "./contained-turn-kernel-fixtures.ts";

test("dispatch preparation cleanup retains possible winners and releases only proved losers", async () => {
  const initial = mutateContainedTurnOperation(createOperation(), { kind: "bind_workspace", workspaceId });
  const winner = createReservedOperation();
  const reservation = { attemptId, custodyId, preparationToken, workspaceId };
  const exercise = async (read: ContainedTurnKernelOperation | undefined, calls = 1) => {
    let current = read;
    const releases: unknown[] = [];
    const dependencies = {
      custody: { releaseReservation: async (input: unknown) => {releases.push(input);} },
      operationStore: {
        commit: async (input: { candidate: ContainedTurnKernelOperation }) => {
          current = input.candidate;
          return { kind: "applied" as const, operation: input.candidate };
        },
        read: async () => current,
      },
    } as unknown as ContainedTurnKernelDependencies;
    let result = initial;
    for (let index = 0; index < calls; index += 1) {
      result = (await reconcileContainedTurnClaimPreparation(
        dependencies, initial, scope, reservation,
      )).operation;
    }
    return { releases, result };
  };

  const sharedReservation = await exercise(winner, 2);
  assert.equal(sharedReservation.releases.length, 0, "a loser sharing the winning reservation cannot release it");
  assert.equal(sharedReservation.result.reconciliation.kind, "required", "lost claim acknowledgement records debt");

  const otherToken = containedTurnIdentity("preparation", "preparation:other-winner");
  if (winner.dispatch.kind !== "claimed") {assert.fail("fixture must be claimed");}
  const otherWinner = {
    ...winner,
    dispatch: { ...winner.dispatch, preparationToken: otherToken },
  } as ContainedTurnKernelOperation;
  assert.equal((await exercise(otherWinner)).releases.length, 1, "a stale claim loses to the durable different token");
  assert.equal((await exercise(initial)).releases.length, 1, "a durable pre-claim state proves safe release");
  assert.equal((await exercise(undefined)).releases.length, 0, "unknown ownership retains the possible winner");
});
