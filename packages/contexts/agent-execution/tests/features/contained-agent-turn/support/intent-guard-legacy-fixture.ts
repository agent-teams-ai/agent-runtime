import type { Pool } from "pg";
import type { ContainedTurnKernelOperation } from "../../../../dist/features/contained-agent-turn/domain/contained-turn-kernel-model.js";
import { encodeContainedTurnState } from "../../../../dist/features/contained-agent-turn/adapters/outbound/postgres/contained-turn-state-codec.js";

/** Frozen legacy database input for migration tests, never a current acceptance path.
 * Current acceptance cannot backfill the deployment authority absent in V1-V6.
 */
export const seedLegacyIntentOperation = async (pool: Pool, operation: ContainedTurnKernelOperation, version: 3 | 4 | 6) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('agent_execution.contained_turn_schema_version', $1, true)", [String(version)]);
    const encoded = encodeContainedTurnState(operation);
    await client.query(`INSERT INTO agent_execution.contained_turn_operation_v1
      (operation_id,tenant_id,project_id,command_id,command_fingerprint,effect_id,revision,state,state_codec_version,state_digest,terminal)
      VALUES ($1,$2,$3,$4,$5,$6,0,$7::jsonb,$8,$9,false)`,
    [operation.operationId, operation.scope.tenantId, operation.scope.projectId, operation.commandId,
      operation.commandFingerprint, operation.effectId, encoded.json, encoded.codecVersion, encoded.digest]);
    for (const proof of operation.proofs) {
      await client.query("INSERT INTO agent_execution.contained_turn_receipt_v1(operation_id,receipt_kind,receipt_ref) VALUES ($1,$2,$3)", [operation.operationId, proof.kind, proof.proofId]);
    }
    await client.query("COMMIT");
  } catch (error) {await client.query("ROLLBACK"); throw error;}
  finally {client.release();}
};
