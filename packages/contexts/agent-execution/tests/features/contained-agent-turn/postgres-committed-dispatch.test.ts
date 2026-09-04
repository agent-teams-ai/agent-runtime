import assert from "node:assert/strict";

import { type Pool, type PoolClient } from "pg";

import { PostgresContainedTurnOperationStore } from "../../../dist/features/contained-agent-turn/adapters/outbound/postgres/postgres-contained-turn-operation-store.js";
import { PostgresCommitIndeterminateError } from "../../../dist/features/contained-agent-turn/adapters/outbound/postgres/contained-turn-postgres-transactions.js";
import {
  postgresTest,
  resetSchema,
  withPool,
} from "./postgres-contained-turn-test-helpers.ts";
import { preparePostgresClaim } from "./support/postgres-committed-dispatch-fixture.ts";

postgresTest("claim finalization failure rolls back the operation and exposes no committed proof", async () => {
  await withPool(async pool => {
    await resetSchema(pool);
    const fixture = await preparePostgresClaim(pool, "claim-finalization-failure");
    await pool.query(`CREATE FUNCTION agent_execution.reject_claimed_preparation_for_test()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.state->'payload'->>'kind' = 'claimed' THEN
          RAISE EXCEPTION 'simulated preparation finalization failure';
        END IF;
        RETURN NEW;
      END $$`);
    await pool.query(`CREATE TRIGGER reject_claimed_preparation_for_test
      BEFORE UPDATE ON agent_execution.contained_turn_dispatch_preparation_v1
      FOR EACH ROW EXECUTE FUNCTION agent_execution.reject_claimed_preparation_for_test()`);

    let returned: Awaited<ReturnType<typeof fixture.store.claimPreparedDispatch>> | undefined;
    await assert.rejects(async () => {
      returned = await fixture.store.claimPreparedDispatch(fixture.claim.claimInput);
    }, /simulated preparation finalization failure/u);
    assert.equal(returned, undefined);
    const durable = await fixture.store.read({
      operationId: fixture.bound.operationId,
      scope: fixture.bound.scope,
    });
    assert.equal(durable?.dispatch.kind, "unclaimed");
    assert.equal(durable?.revision, fixture.bound.revision);
  });
});

postgresTest("lost claim COMMIT acknowledgement exposes no proof and replay only observes durable truth", async () => {
  await withPool(async pool => {
    await resetSchema(pool);
    const fixture = await preparePostgresClaim(pool, "claim-commit-loss");
    let loseNextCommit = true;
    const ambiguousPool = new Proxy(pool, {
      get(target, property) {
        if (property !== "connect") {
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        }
        return async () => {
          const client = await target.connect();
          return new Proxy(client, {
            get(clientTarget, clientProperty) {
              if (clientProperty !== "query") {
                const value = Reflect.get(clientTarget, clientProperty, clientTarget);
                return typeof value === "function" ? value.bind(clientTarget) : value;
              }
              return async (...arguments_: Parameters<PoolClient["query"]>) => {
                const statement = arguments_[0];
                if (loseNextCommit && typeof statement === "string" && statement === "COMMIT") {
                  loseNextCommit = false;
                  await (clientTarget.query as (...args: typeof arguments_) => Promise<unknown>)(...arguments_);
                  throw new Error("simulated lost claim COMMIT acknowledgement");
                }
                return (clientTarget.query as (...args: typeof arguments_) => Promise<unknown>)(...arguments_);
              };
            },
          });
        };
      },
    }) as unknown as Pool;
    const ambiguous = new PostgresContainedTurnOperationStore({ pool: ambiguousPool });
    let returned: Awaited<ReturnType<typeof ambiguous.claimPreparedDispatch>> | undefined;
    await assert.rejects(async () => {
      returned = await ambiguous.claimPreparedDispatch(fixture.claim.claimInput);
    }, (error: unknown) => error instanceof PostgresCommitIndeterminateError);
    assert.equal(returned, undefined);
    assert.equal(loseNextCommit, false);

    const durable = await fixture.store.read({
      operationId: fixture.bound.operationId,
      scope: fixture.bound.scope,
    });
    assert.equal(durable?.dispatch.kind, "claimed");
    const replay = await fixture.store.claimPreparedDispatch(fixture.claim.claimInput);
    assert.equal(replay.kind, "observed_claim");
    assert.equal("committedDispatchProof" in replay, false);
  });
});
