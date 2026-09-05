import assert from "node:assert/strict";
import test from "node:test";

import type { Pool } from "pg";

import { CONTAINED_TURN_POSTGRES_MIGRATIONS } from "../../../dist/features/contained-agent-turn/adapters/outbound/postgres/contained-turn-postgres-schema.js";
import { decodeContainedTurnState, encodeContainedTurnState } from "../../../dist/features/contained-agent-turn/adapters/outbound/postgres/contained-turn-state-codec.js";
import { PostgresContainedTurnOperationStore } from "../../../dist/features/contained-agent-turn/adapters/outbound/postgres/postgres-contained-turn-operation-store.js";
import { containedTurnIdentity } from "../../../dist/features/contained-agent-turn/domain/contained-turn-identities.js";
import type { ContainedTurnKernelOperation } from "../../../dist/features/contained-agent-turn/domain/contained-turn-kernel-model.js";
import { containedTurnOutputWriteAuthority } from "../../../dist/features/contained-agent-turn/domain/contained-turn-output-authority.js";
import { mutateContainedTurnOperation } from "../../../dist/features/contained-agent-turn/domain/contained-turn-transitions.js";
import { createActiveOperation } from "../../contained-turn-kernel-fixtures.ts";

type AppendInput = Parameters<PostgresContainedTurnOperationStore["appendOutput"]>[0];

const rows = (values: readonly unknown[] = []) => ({ rowCount: values.length, rows: values });

const appendInput = (operation: ContainedTurnKernelOperation): AppendInput => ({
  authority: {
    commandId: operation.commandId,
    effectId: operation.effectId,
    operationId: operation.operationId,
    scope: operation.scope,
  },
  expectedCursor: operation.output.chunks.length,
  expectedRevision: operation.revision,
  output: { cursor: operation.output.chunks.length, kind: "assistant", text: "canonical output" },
  outputAuthority: containedTurnOutputWriteAuthority(operation),
});

// Database-free adapter tests: run the real transaction, repository, codecs and
// domain predicate against a scripted Pool. No connection URL is read or used.
const outputStore = (
  initial: ContainedTurnKernelOperation = createActiveOperation(),
  lostCommit?: "before_commit" | "after_commit",
) => {
  let durable = initial;
  let current = initial;
  let outputs = initial.output.chunks;
  let proofs = initial.proofs;
  let inTransaction = false;
  let locked = false;
  let loseCommit = lostCommit;
  let writes = 0;
  const statements: string[] = [];
  const released: boolean[] = [];
  const client = {
    async query(sql: string, values: readonly unknown[] = []) {
      statements.push(sql);
      if (sql.startsWith("BEGIN")) {
        assert.equal(inTransaction, false);
        inTransaction = true;
        locked = false;
        current = durable;
        outputs = durable.output.chunks;
        proofs = durable.proofs;
        return rows();
      }
      assert.equal(inTransaction, true);
      if (sql === "COMMIT" || sql === "ROLLBACK") {
        inTransaction = false;
        if (sql === "COMMIT") {
          assert.deepEqual(outputs, current.output.chunks);
          assert.deepEqual(proofs, current.proofs);
          if (loseCommit !== "before_commit") {durable = current;}
          if (loseCommit !== undefined) {
            loseCommit = undefined;
            throw new Error("synthetic commit acknowledgement loss");
          }
        }
        return rows();
      }
      if (sql.includes("FROM agent_execution.schema_migration")) {
        return rows([{
          migration_digest: CONTAINED_TURN_POSTGRES_MIGRATIONS.at(-1)?.digest,
          version: CONTAINED_TURN_POSTGRES_MIGRATIONS.length,
        }]);
      }
      if (sql.startsWith("SELECT set_config(") || sql.startsWith("SELECT pg_advisory_xact_lock_shared(")) {
        return rows();
      }
      if (sql.includes("FROM agent_execution.contained_turn_operation_v1")) {
        assert.match(sql, /WHERE operation_id = \$1 AND tenant_id = \$2 AND project_id = \$3/u);
        if (values[0] !== current.operationId || values[1] !== current.scope.tenantId ||
            values[2] !== current.scope.projectId) {return rows();}
        locked = sql.endsWith(" FOR UPDATE");
        const encoded = encodeContainedTurnState(current);
        return rows([{
          command_fingerprint: current.commandFingerprint,
          command_id: current.commandId,
          effect_id: current.effectId,
          operation_id: current.operationId,
          project_id: current.scope.projectId,
          revision: String(current.revision),
          state: JSON.parse(encoded.json),
          state_bytes: Buffer.byteLength(encoded.json),
          state_codec_version: encoded.codecVersion,
          state_digest: encoded.digest,
          state_within_budget: true,
          tenant_id: current.scope.tenantId,
          terminal: current.terminal.kind === "final",
        }]);
      }
      if (sql.includes("AS output_count")) {
        return rows([{
          output_bytes: String(Buffer.byteLength(JSON.stringify(outputs))),
          output_count: String(outputs.length),
          receipt_bytes: String(Buffer.byteLength(JSON.stringify(proofs))),
          receipt_count: String(proofs.length),
        }]);
      }
      if (sql.includes("SELECT cursor, output_kind")) {
        return rows(outputs.map(chunk => ({
          cursor: chunk.cursor, output_kind: chunk.kind, output_text: chunk.text,
        })));
      }
      if (sql.includes("SELECT receipt_kind,")) {
        return rows(proofs.map(proof => ({ receipt_kind: proof.kind, receipt_ref: proof.proofId })));
      }
      assert.equal(locked, true, "persistence requires the scoped row lock");
      if (sql.startsWith("UPDATE agent_execution.contained_turn_operation_v1")) {
        assert.match(sql, /WHERE operation_id=\$1 AND revision=\$2$/u);
        assert.equal(values[0], current.operationId);
        assert.equal(values[1], current.revision);
        current = decodeContainedTurnState(JSON.parse(values[3] as string), values[5] as string, values[4] as number);
        writes += 1;
        return { rowCount: 1, rows: [] };
      }
      if (sql.startsWith("INSERT INTO agent_execution.contained_turn_output_v1")) {
        assert.equal(values[0], current.operationId);
        outputs = [...outputs, { cursor: values[1] as number, kind: "assistant", text: values[3] as string }];
        assert.equal(values[2], "assistant");
        return { rowCount: 1, rows: [] };
      }
      throw new Error("unexpected output-store test query");
    },
    release(discard = false) {released.push(discard);},
  };
  const pool = { connect: async () => client } as unknown as Pool;
  return {
    initial,
    released,
    statements,
    store: new PostgresContainedTurnOperationStore({ pool }),
    durable: () => durable,
    writes: () => writes,
  };
};

for (const field of ["writerFence", "executionGenerationId"] as const) {
  test(`PostgreSQL output append rejects a foreign ${field} at the current revision and cursor`, async () => {
    const fixture = outputStore();
    const input = appendInput(fixture.initial);
    const foreign = field === "writerFence"
      ? containedTurnIdentity("writer_fence", "writer-fence:foreign")
      : containedTurnIdentity("execution_generation", "execution-generation:foreign");
    const rejected = await fixture.store.appendOutput({
      ...input,
      outputAuthority: { ...input.outputAuthority, [field]: foreign },
    });
    assert.deepEqual(rejected, { current: fixture.initial, kind: "stale" });
    assert.deepEqual(fixture.durable(), fixture.initial);
    assert.equal(fixture.writes(), 0);
    assert.equal(fixture.statements.some(sql => sql.startsWith("INSERT")), false);
    assert.equal(JSON.stringify(rejected).includes(foreign), false);

    const applied = await fixture.store.appendOutput(input);
    assert.equal(applied.kind, "applied");
    assert.equal(fixture.durable().revision, input.expectedRevision + 1);
    assert.deepEqual(fixture.durable().output.chunks, [input.output]);
    const replay = await fixture.store.appendOutput(input);
    assert.deepEqual(replay, { current: fixture.durable(), kind: "stale" });
    assert.equal(fixture.writes(), 1);
  });
}

test("PostgreSQL output authority remains current after append and replay cannot duplicate output", async () => {
  const fixture = outputStore();
  const input = appendInput(fixture.initial);
  assert.equal((await fixture.store.appendOutput(input)).kind, "applied");
  const advanced = fixture.durable();
  for (const expected of [
    { expectedCursor: 1, expectedRevision: input.expectedRevision },
    { expectedCursor: 0, expectedRevision: advanced.revision },
  ]) {
    assert.deepEqual(await fixture.store.appendOutput({ ...input, ...expected }), {
      current: advanced, kind: "stale",
    });
  }
  const next = { ...appendInput(advanced), outputAuthority: input.outputAuthority };
  assert.equal((await fixture.store.appendOutput(next)).kind, "applied");
  assert.deepEqual(fixture.durable().output.chunks, [input.output, next.output]);
  assert.equal(fixture.writes(), 2);
  assert.deepEqual(await fixture.store.read(input.authority), fixture.durable());
});

test("PostgreSQL output append rejects contradictions in every output authority field", async () => {
  const fixture = outputStore();
  const input = appendInput(fixture.initial);
  for (const [field, value] of Object.entries(input.outputAuthority)) {
    const outputAuthority = {
      ...input.outputAuthority,
      [field]: typeof value === "number" ? value + 1 : `${value}:foreign`,
    };
    assert.deepEqual(await fixture.store.appendOutput({ ...input, outputAuthority }), {
      current: fixture.initial, kind: "stale",
    }, field);
  }
  assert.equal(fixture.writes(), 0);
  assert.deepEqual(fixture.durable(), fixture.initial);
});

test("PostgreSQL output append validates the complete closed authority without raw error details", async () => {
  const fixture = outputStore();
  const input = appendInput(fixture.initial);
  const { writerFence: _writerFence, ...missingFence } = input.outputAuthority;
  for (const authority of [
    missingFence,
    { ...input.outputAuthority, rawDetail: "synthetic-private-authority-detail" },
  ]) {
    await assert.rejects(fixture.store.appendOutput({
      ...input, outputAuthority: authority as AppendInput["outputAuthority"],
    }), {
      name: "ContainedTurnInvariantError",
      message: "output write authority must be an exact closed record",
    });
  }
  assert.equal(fixture.writes(), 0);
  assert.deepEqual(fixture.durable(), fixture.initial);
  assert.equal(fixture.statements.filter(sql => sql === "ROLLBACK").length, 2);
});

for (const field of ["tenantId", "projectId"] as const) {
  test(`PostgreSQL output append hides a foreign ${field} before inspecting authority`, async () => {
    const fixture = outputStore();
    const input = appendInput(fixture.initial);
    const rejected = await fixture.store.appendOutput({
      ...input,
      authority: { ...input.authority, scope: { ...input.authority.scope, [field]: "foreign-scope" } },
      expectedCursor: -1,
      expectedRevision: -1,
      outputAuthority: {} as AppendInput["outputAuthority"],
    });
    assert.deepEqual(rejected, { kind: "not_found" });
    assert.equal(fixture.writes(), 0);
    assert.deepEqual(fixture.durable(), fixture.initial);
    assert.equal(fixture.statements.some(sql => sql.includes("AS output_count")), false);
  });
}

test("PostgreSQL output append classifies authority against the locked current operation", async () => {
  const initial = createActiveOperation();
  const input = appendInput(initial);
  const fenced = mutateContainedTurnOperation(initial, {
    evidenceId: containedTurnIdentity("evidence", "evidence:output-continuity-lost"),
    kind: "record_reconciliation_debt",
    source: "store_commit",
  });
  const fixture = outputStore(fenced);
  assert.deepEqual(await fixture.store.appendOutput({ ...input, expectedRevision: fenced.revision }), {
    current: fenced, kind: "stale",
  });
  assert.equal(fixture.writes(), 0);
  assert.deepEqual(fixture.durable(), fenced);
});

for (const lostCommit of ["before_commit", "after_commit"] as const) {
  test(`PostgreSQL output append preserves indeterminate ${lostCommit} reconciliation and replay`, async () => {
    const fixture = outputStore(createActiveOperation(), lostCommit);
    const input = appendInput(fixture.initial);
    const result = await fixture.store.appendOutput(input);
    assert.equal(result.kind, "indeterminate");
    if (result.kind !== "indeterminate") {assert.fail("expected indeterminate output commit");}
    assert.deepEqual(result.debtOperation, fixture.durable());
    assert.equal(fixture.durable().reconciliation.kind, "required");
    assert.deepEqual(fixture.durable().output.chunks, lostCommit === "after_commit" ? [input.output] : []);
    assert.equal(fixture.durable().operationCutoff.kind, "closed");
    assert.deepEqual(fixture.released, [true, false]);
    assert.equal(fixture.writes(), 2);
    assert.deepEqual(await fixture.store.appendOutput(input), { current: fixture.durable(), kind: "stale" });
    assert.equal(fixture.writes(), 2);
  });
}
