import assert from "node:assert/strict";
import test from "node:test";

import { Pool } from "pg";

import { applyContainedTurnPostgresSchema, CONTAINED_TURN_POSTGRES_SCHEMA_VERSION } from "../../../dist/features/contained-agent-turn/adapters/outbound/postgres/contained-turn-postgres-schema.js";
import { containedTurnScopeDigest } from "../../../dist/features/contained-agent-turn/domain/contained-turn-authority.js";
import { containedTurnIdentity } from "../../../dist/features/contained-agent-turn/domain/contained-turn-identities.js";
import {
  authorityVector,
  commandId as fixtureCommandId,
  createOperation,
  providerAccessSnapshot,
} from "../../contained-turn-kernel-fixtures.ts";

const databaseUrl = process.env.POSTGRES_DURABILITY_URL;

export const postgresTest = databaseUrl === undefined ? test.skip : test;

export const operationAuthority = (operation: ReturnType<typeof createOperation>) => Object.freeze({
  commandId: operation.commandId,
  effectId: operation.effectId,
  operationId: operation.operationId,
  scope: operation.scope,
});

export const operationForProject = (
  projectId: string,
  suffix: string,
  commandId = fixtureCommandId,
  tenantId = "tenant:postgres-durability",
) => {
  const selectedScope = Object.freeze({ projectId, tenantId });
  const selectedAccess = Object.freeze({
    ...providerAccessSnapshot,
    projectId,
    tenantId: selectedScope.tenantId,
  });
  const selectedVector = Object.freeze({
    ...authorityVector,
    providerAccessSnapshot: selectedAccess,
    scopeDigest: containedTurnScopeDigest(selectedScope),
  });
  return createOperation({
    acceptedAuthorityVector: selectedVector,
    commandId,
    effectId: containedTurnIdentity("effect", `effect:postgres:${suffix}`),
    operationId: containedTurnIdentity("operation", `operation:postgres:${suffix}`),
    providerAccessSnapshot: selectedAccess,
    scope: selectedScope,
  });
};

export const resetSchema = async (
  pool: Pool,
  targetVersion: 1 | 2 | 3 | 4 | 5 | 6 | 7 = CONTAINED_TURN_POSTGRES_SCHEMA_VERSION,
): Promise<void> => {
  await pool.query("DROP SCHEMA IF EXISTS agent_execution CASCADE");
  await applyContainedTurnPostgresSchema(pool, {
    ...(targetVersion === 4 ? { allowUnfencedV4ForTest: true as const } : {}),
    targetVersion,
  });
};

export const withPool = async (run: (pool: Pool) => Promise<void>): Promise<void> => {
  assert.ok(databaseUrl);
  const pool = new Pool({ connectionString: databaseUrl, max: 12 });
  try {await run(pool);} finally {await pool.end();}
};

export const runtimeQuery = async <Row extends import("pg").QueryResultRow = import("pg").QueryResultRow>(
  pool: Pool,
  text: string,
  values: readonly unknown[] = [],
): Promise<import("pg").QueryResult<Row>> => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('agent_execution.contained_turn_schema_version', version::text, true) FROM agent_execution.schema_migration WHERE component='contained-agent-turn'",
    );
    const result = await client.query<Row>(text, [...values]);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};
