import { intentAuthority } from "./support/intent-guard-fixture.ts";
import assert from "node:assert/strict";

import { type Pool, type PoolClient } from "pg";

import { PostgresContainedTurnOperationStore } from "../../../dist/features/contained-agent-turn/adapters/outbound/postgres/postgres-contained-turn-operation-store.js";
import { createOperation } from "../../contained-turn-kernel-fixtures.ts";
import {
  operationAuthority,
  operationForProject,
  postgresTest,
  resetSchema,
  withPool,
} from "./postgres-contained-turn-test-helpers.ts";

const poolWithLostAcceptanceCommit = (
  pool: Pool,
  options: Readonly<{ failObservation?: boolean }> = {},
) => {
  let acceptanceAttempts = 0;
  let loseCommit = true;
  let failObservation = options.failObservation ?? false;
  const ambiguousPool = new Proxy(pool, {
    get(target, property) {
      if (property !== "connect") {
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      }
      return async () => {
        const client = await target.connect();
        let acceptanceAttempted = false;
        return new Proxy(client, {
          get(clientTarget, clientProperty) {
            if (clientProperty !== "query") {
              const value = Reflect.get(clientTarget, clientProperty, clientTarget);
              return typeof value === "function" ? value.bind(clientTarget) : value;
            }
            return async (...arguments_: Parameters<PoolClient["query"]>) => {
              const statement = arguments_[0];
              if (typeof statement === "string" &&
                  statement.startsWith("INSERT INTO agent_execution.contained_turn_operation_v1")) {
                acceptanceAttempts += 1;
                acceptanceAttempted = true;
              }
              if (typeof statement === "string" &&
                  statement.startsWith("SELECT authority_digest,command_fingerprint,operation_id")) {
                acceptanceAttempted = true;
              }
              if (typeof statement === "string" && statement === "COMMIT" &&
                  acceptanceAttempted && loseCommit) {
                loseCommit = false;
                await (clientTarget.query as (...args: typeof arguments_) => Promise<unknown>)(...arguments_);
                throw new Error("simulated lost acceptance COMMIT acknowledgement");
              }
              if (!loseCommit && failObservation && typeof statement === "string" &&
                  statement.startsWith("SELECT operation_id FROM agent_execution.contained_turn_operation_v1") &&
                  !statement.includes("FOR UPDATE")) {
                failObservation = false;
                throw new Error("simulated unavailable acceptance observation");
              }
              return (clientTarget.query as (...args: typeof arguments_) => Promise<unknown>)(...arguments_);
            };
          },
        });
      };
    },
  }) as unknown as Pool;
  return Object.freeze({ acceptanceAttempts: () => acceptanceAttempts, pool: ambiguousPool });
};

postgresTest("lost initial acceptance COMMIT reconciles exact durable accepted truth without retry", async () => {
  await withPool(async pool => {
    await resetSchema(pool);
    const operation = operationForProject("project:accept-commit-loss", "accept-commit-loss");
    const ambiguous = poolWithLostAcceptanceCommit(pool);
    const store = new PostgresContainedTurnOperationStore({ intentAuthority, pool: ambiguous.pool });

    const outcome = await store.accept(operation, operationAuthority(operation));

    assert.equal(outcome.kind, "accepted");
    assert.equal(ambiguous.acceptanceAttempts(), 1);
    if (outcome.kind === "accepted") {
      assert.equal(outcome.operation.operationId, operation.operationId);
      assert.equal(outcome.operation.revision, 0);
    }
  });
});

postgresTest("lost exact-replay COMMIT reconciles the durable replay without retry", async () => {
  await withPool(async pool => {
    await resetSchema(pool);
    const operation = operationForProject("project:accept-replay-loss", "accept-replay-loss");
    const normal = new PostgresContainedTurnOperationStore({ intentAuthority, pool });
    assert.equal((await normal.accept(operation, operationAuthority(operation))).kind, "accepted");
    const ambiguous = poolWithLostAcceptanceCommit(pool);
    const store = new PostgresContainedTurnOperationStore({ intentAuthority, pool: ambiguous.pool });

    const outcome = await store.accept(operation, operationAuthority(operation));

    assert.equal(outcome.kind, "replayed");
    assert.equal(ambiguous.acceptanceAttempts(), 1);
    if (outcome.kind === "replayed") {
      assert.equal(outcome.operation.operationId, operation.operationId);
      assert.equal(outcome.operation.commandFingerprint, operation.commandFingerprint);
    }
  });
});

postgresTest("lost fingerprint-conflict COMMIT reconciles the exact durable conflict without retry", async () => {
  await withPool(async pool => {
    await resetSchema(pool);
    const winner = operationForProject("project:accept-conflict-loss", "accept-conflict-winner");
    const other = operationForProject("project:accept-conflict-loss", "accept-conflict-other");
    const conflict = createOperation({
      acceptedAuthorityVector: winner.acceptedAuthorityVector,
      commandId: winner.commandId,
      effectId: other.effectId,
      intent: { mode: "analysis", prompt: "different acceptance fingerprint" },
      operationId: other.operationId,
      providerAccessSnapshot: winner.providerAccessSnapshot,
      scope: winner.scope,
    });
    const normal = new PostgresContainedTurnOperationStore({ intentAuthority, pool });
    assert.equal((await normal.accept(winner, operationAuthority(winner))).kind, "accepted");
    const ambiguous = poolWithLostAcceptanceCommit(pool);
    const store = new PostgresContainedTurnOperationStore({ intentAuthority, pool: ambiguous.pool });

    const outcome = await store.accept(conflict, operationAuthority(conflict));

    assert.equal(outcome.kind, "fingerprint_conflict");
    assert.equal(ambiguous.acceptanceAttempts(), 0);
  });
});

postgresTest("unavailable post-COMMIT observation returns typed potential acceptance evidence", async () => {
  await withPool(async pool => {
    await resetSchema(pool);
    const operation = operationForProject("project:accept-unknown", "accept-unknown");
    const ambiguous = poolWithLostAcceptanceCommit(pool, { failObservation: true });
    const store = new PostgresContainedTurnOperationStore({ intentAuthority, pool: ambiguous.pool });

    const outcome = await store.accept(operation, operationAuthority(operation));

    assert.equal(outcome.kind, "potential_acceptance");
    assert.equal(ambiguous.acceptanceAttempts(), 1);
    if (outcome.kind === "potential_acceptance") {
      assert.equal(outcome.candidateOperation.operationId, operation.operationId);
      assert.match(outcome.evidenceId, /^evidence:postgres-acceptance-commit:/u);
    }
    const durable = await new PostgresContainedTurnOperationStore({ intentAuthority, pool }).read({
      operationId: operation.operationId,
      scope: operation.scope,
    });
    assert.equal(durable?.operationId, operation.operationId);
  });
});
