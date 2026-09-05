import assert from "node:assert/strict";
import type { Pool } from "pg";
import { CONTAINED_TURN_POSTGRES_MIGRATIONS } from "../../../../dist/features/contained-agent-turn/adapters/outbound/postgres/contained-turn-postgres-schema.js";

type Row = Record<string, any>;
type Tables = Record<"namespaces" | "intents" | "guards" | "operations" | "outputs" | "proofs" | "preparations", Row[]>;
const empty = (): Tables => ({ namespaces: [], intents: [], guards: [], operations: [], outputs: [], proofs: [], preparations: [] });
const scoped = (row: Row, values: readonly unknown[]) => row.tenant_id === values[0] && row.project_id === values[1];
const result = (rows: Row[] = [], rowCount = rows.length) => ({ rows: structuredClone(rows), rowCount });
const encoded = (state: string, version: number, digest: string, budget = 4_000_000) => ({
  state: JSON.parse(state), state_bytes: Buffer.byteLength(state), state_codec_version: version,
  state_digest: digest, state_within_budget: Buffer.byteLength(state) <= budget,
});

const operationQuery = (working: Tables, sql: string, values: any[], requireLock: (scope: readonly unknown[]) => void) => {
  if (sql.startsWith("INSERT INTO agent_execution.contained_turn_operation_v1")) {
    requireLock(values.slice(1, 3));
    if (working.operations.some(row => row.tenant_id === values[1] && row.project_id === values[2] && row.command_id === values[3])) {return result();}
    working.operations.push({ operation_id: values[0], tenant_id: values[1], project_id: values[2], command_id: values[3], command_fingerprint: values[4], effect_id: values[5], revision: String(values[6]), ...encoded(values[7], values[8], values[9]), terminal: false });
    return result([{ operation_id: values[0] }]);
  }
  if (sql.startsWith("SELECT operation_id FROM agent_execution.contained_turn_operation_v1")) {
    return result(working.operations.filter(row => scoped(row, values) && row.command_id === values[2]));
  }
  if (sql.startsWith("SELECT operation_id, tenant_id")) {
    return result(working.operations.filter(row => row.operation_id === values[0] && (values.length === 1 || row.tenant_id === values[1] && row.project_id === values[2])));
  }
  if (sql.startsWith("UPDATE agent_execution.contained_turn_operation_v1")) {
    const row = working.operations.find(item => item.operation_id === values[0] && item.revision === String(values[1]));
    if (!row) {return result();}
    const next = JSON.parse(values[3]).payload;
    if (next.dispatch.kind === "claimed" && row.state.payload.dispatch.kind !== "claimed") {requireLock([row.tenant_id, row.project_id]);}
    Object.assign(row, { revision: String(values[2]), ...encoded(values[3], values[4], values[5]), terminal: values[6] });
    return result([], 1);
  }
  if (sql.startsWith("SELECT (SELECT count(*)::text")) {
    const outputs = working.outputs.filter(row => row.operation_id === values[0]);
    const proofs = working.proofs.filter(row => row.operation_id === values[0]);
    return result([{ output_count: String(outputs.length), output_bytes: "0", receipt_count: String(proofs.length), receipt_bytes: "0" }]);
  }
  if (sql.startsWith("INSERT INTO agent_execution.contained_turn_receipt_v1")) {
    working.proofs.push({ operation_id: values[0], receipt_kind: values[1], receipt_ref: values[2] }); return result([], 1);
  }
  if (sql.startsWith("INSERT INTO agent_execution.contained_turn_output_v1")) {
    working.outputs.push({ operation_id: values[0], cursor: values[1], output_kind: values[2], output_text: values[3] }); return result([], 1);
  }
  if (sql.startsWith("SELECT cursor, output_kind")) {return result(working.outputs.filter(row => row.operation_id === values[0]));}
  if (sql.startsWith("SELECT receipt_kind,")) {return result(working.proofs.filter(row => row.operation_id === values[0]));}
  return;
};

const intentQuery = (working: Tables, sql: string, values: any[], requireLock: (scope: readonly unknown[]) => void) => {
  if (sql.startsWith("SELECT authority_digest,command_fingerprint,operation_id")) {
    requireLock(values);
    return result(working.intents.filter(row => scoped(row, values) && row.command_id === values[2]));
  }
  if (sql.includes("FROM agent_execution.contained_turn_intent_guard_v1")) {
    requireLock(values);
    const column = sql.includes("prevention_command_id=$3") ? "prevention_command_id" : "command_id";
    return result(working.guards.filter(row => scoped(row, values) && row[column] === values[2]));
  }
  if (sql.startsWith("INSERT INTO agent_execution.contained_turn_intent_v1")) {
    requireLock(values);
    assert.ok(!working.intents.some(row => scoped(row, values) && row.command_id === values[2]));
    working.intents.push({ tenant_id: values[0], project_id: values[1], command_id: values[2], command_fingerprint: values[3], authority_digest: values[4], operation_id: values[5] ?? null });
    return result([], 1);
  }
  if (sql.startsWith("INSERT INTO agent_execution.contained_turn_intent_guard_v1")) {
    requireLock(values);
    assert.ok(!working.guards.some(row => scoped(row, values) && (row.command_id === values[2] || row.prevention_command_id === values[3])));
    working.guards.push({ tenant_id: values[0], project_id: values[1], command_id: values[2], prevention_command_id: values[3], ...encoded(values[5], values[4], values[6], 16_384) });
    return result([], 1);
  }
  return;
};

const preparationQuery = (working: Tables, sql: string, values: any[]) => {
  if (sql.startsWith("SELECT count(*)::text AS count")) {return result([{ count: String(working.preparations.filter(row => row.operation_id === values[0]).length) }]);}
  if (sql.startsWith("INSERT INTO agent_execution.contained_turn_dispatch_preparation_v1")) {
    working.preparations.push({ operation_id: values[0], preparation_token: values[1], ...encoded(values[3], values[2], values[4]) }); return result([], 1);
  }
  if (sql.includes("FROM agent_execution.contained_turn_dispatch_preparation_v1")) {
    return result(working.preparations.filter(row => row.operation_id === values[0] && row.preparation_token === values[1]));
  }
  if (sql.startsWith("UPDATE agent_execution.contained_turn_dispatch_preparation_v1")) {
    const row = working.preparations.find(item => item.operation_id === values[0] && item.preparation_token === values[1]);
    assert.ok(row); Object.assign(row, encoded(values[2], values[3], values[4])); return result([], 1);
  }
  return;
};

/** SQL boundary double, not an operation model or PostgreSQL durability proof.
 * Transactions run in a deterministic serial schedule; every guard-sensitive
 * write additionally requires the production namespace lock in that transaction.
 * Unknown SQL fails so a production query cannot silently bypass the fixture.
 */
export class IntentGuardSqlFixture {
  tables = empty();
  readonly statements: string[] = [];
  loseNextGuardCommit: "before" | "after" | undefined;
  #tail: Promise<void> = Promise.resolve();

  restore(tables: Tables): void {this.tables = structuredClone(tables);}
  readonly pool = { connect: async () => {
    let release: (() => void) | undefined;
    let working: Tables | undefined;
    let lockedScope: readonly unknown[] | undefined;
    let insertedGuard = false;
    const finish = () => {working = undefined; release?.(); release = undefined;};
    const query = async (raw: string, values: any[] = []) => {
      const sql = raw.replace(/\s+/gu, " ").trim();
      this.statements.push(sql);
      if (sql.startsWith("BEGIN")) {
        const previous = this.#tail;
        this.#tail = new Promise<void>(resolve => {release = resolve;});
        await previous;
        working = structuredClone(this.tables);
        return result();
      }
      assert.ok(working, "SQL must be enclosed in a transaction");
      if (sql === "COMMIT") {
        const loss = insertedGuard ? this.loseNextGuardCommit : undefined;
        if (insertedGuard) {this.loseNextGuardCommit = undefined;}
        if (loss !== "before") {this.tables = working;}
        finish();
        if (loss !== undefined) {throw new Error("synthetic lost COMMIT acknowledgement");}
        return result();
      }
      if (sql === "ROLLBACK") {finish(); return result();}
      if (sql.startsWith("SELECT set_config") || sql.startsWith("SELECT pg_advisory_xact_lock_shared")) {return result();}
      if (sql.startsWith("SELECT version, migration_digest")) {
        return result([{ version: 7, migration_digest: CONTAINED_TURN_POSTGRES_MIGRATIONS[6]!.digest }]);
      }
      const requireLock = (scope: readonly unknown[]) => assert.deepEqual(lockedScope, scope.slice(0, 2), "intent writes must hold the scoped namespace lock");
      if (sql.startsWith("INSERT INTO agent_execution.contained_turn_intent_namespace_v1")) {
        if (!working.namespaces.some(row => scoped(row, values))) {
          working.namespaces.push({ tenant_id: values[0], project_id: values[1], authority_digest: values[2] });
        }
        return result([], 1);
      }
      if (sql.startsWith("SELECT authority_digest FROM agent_execution.contained_turn_intent_namespace_v1")) {
        assert.ok(sql.endsWith("FOR UPDATE")); lockedScope = values.slice(0, 2);
        return result(working.namespaces.filter(row => scoped(row, values)));
      }
      const intentResult = intentQuery(working, sql, values, requireLock);
      if (intentResult !== undefined) {
        insertedGuard ||= sql.startsWith("INSERT INTO agent_execution.contained_turn_intent_guard_v1");
        return intentResult;
      }
      const operationResult = operationQuery(working, sql, values, requireLock);
      if (operationResult !== undefined) {return operationResult;}
      const preparationResult = preparationQuery(working, sql, values);
      if (preparationResult !== undefined) {return preparationResult;}
      throw new Error(`unimplemented SQL fixture statement: ${sql}`);
    };
    return { query, release: finish };
  } } as unknown as Pool;
}
