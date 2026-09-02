import type { PoolClient } from "pg";

import type { ContainedTurnScope } from "../../../domain/contained-turn-authority.js";
import type { ContainedTurnOperationId } from "../../../domain/contained-turn-identities.js";
import type { ContainedTurnKernelOperation } from "../../../domain/contained-turn-kernel-model.js";
import { validateContainedTurnOperation } from "../../../domain/contained-turn-validation.js";
import {
  CONTAINED_TURN_POSTGRES_JSON_BUDGET,
  ContainedTurnStateBudgetError,
  decodeContainedTurnState,
  encodeContainedTurnState,
} from "./contained-turn-state-codec.js";

interface OperationRow {
  readonly command_fingerprint: string;
  readonly command_id: string;
  readonly effect_id: string;
  readonly operation_id: string;
  readonly project_id: string;
  readonly revision: string;
  readonly state: unknown;
  readonly state_within_budget: boolean;
  readonly state_codec_version: number;
  readonly state_digest: string;
  readonly tenant_id: string;
  readonly terminal: boolean;
}

interface OutputRow {
  readonly cursor: number;
  readonly output_kind: string;
  readonly output_text: string;
}

interface ProofRow {
  readonly receipt_kind: string;
  readonly receipt_ref: string;
}

const operationFromRow = (row: OperationRow): ContainedTurnKernelOperation => {
  if (!row.state_within_budget) {throw new ContainedTurnStateBudgetError();}
  const operation = decodeContainedTurnState(row.state, row.state_digest, row.state_codec_version);
  if (operation.operationId !== row.operation_id || operation.scope.tenantId !== row.tenant_id ||
      operation.scope.projectId !== row.project_id || operation.commandId !== row.command_id ||
      operation.commandFingerprint !== row.command_fingerprint || operation.effectId !== row.effect_id ||
      operation.revision !== Number(row.revision) ||
      (operation.terminal.kind === "final") !== row.terminal) {
    throw new Error("contained turn authoritative PostgreSQL row mismatch");
  }
  return operation;
};

const validateProjections = (
  operation: ContainedTurnKernelOperation,
  outputs: readonly OutputRow[],
  proofs: readonly ProofRow[],
): void => {
  if (outputs.length !== operation.output.chunks.length || proofs.length !== operation.proofs.length) {
    throw new Error("contained turn PostgreSQL projection cardinality mismatch");
  }
  for (const [index, chunk] of operation.output.chunks.entries()) {
    const output = outputs[index];
    if (output?.cursor !== chunk.cursor || output.output_kind !== chunk.kind ||
        output.output_text !== chunk.text) {
      throw new Error("contained turn PostgreSQL output projection mismatch");
    }
  }
  const proofById = new Map(proofs.map(proof => [proof.receipt_ref, proof.receipt_kind]));
  for (const proof of operation.proofs) {
    if (proofById.get(proof.proofId) !== proof.kind) {
      throw new Error("contained turn PostgreSQL proof projection mismatch");
    }
  }
};

export class ContainedTurnPostgresOperationRepository {
  async #authoritativeRow(
    client: PoolClient,
    operationId: string,
    lock: boolean,
    scope?: ContainedTurnScope,
  ): Promise<OperationRow | undefined> {
    const scopePredicate = scope === undefined ? "" : " AND tenant_id = $2 AND project_id = $3";
    const result = await client.query<OperationRow>(
      `SELECT operation_id, tenant_id, project_id, command_id, command_fingerprint, effect_id,
              revision::text,
              CASE WHEN octet_length(state::text) <= ${String(CONTAINED_TURN_POSTGRES_JSON_BUDGET.maximumSerializedBytes)}
                THEN state END AS state,
              octet_length(state::text) <= ${String(CONTAINED_TURN_POSTGRES_JSON_BUDGET.maximumSerializedBytes)} AS state_within_budget,
              state_codec_version, state_digest, terminal
         FROM agent_execution.contained_turn_operation_v1
        WHERE operation_id = $1${scopePredicate}${lock ? " FOR UPDATE" : ""}`,
      scope === undefined ? [operationId] : [operationId, scope.tenantId, scope.projectId],
    );
    return result.rows[0];
  }

  public async load(
    client: PoolClient,
    operationId: string,
    lock = false,
    scope?: ContainedTurnScope,
  ): Promise<ContainedTurnKernelOperation | undefined> {
    const row = await this.#authoritativeRow(client, operationId, lock, scope);
    if (row === undefined) {return undefined;}
    const operation = operationFromRow(row);
    const [outputs, proofs] = await Promise.all([
      client.query<OutputRow>(
        "SELECT cursor, output_kind, output_text FROM agent_execution.contained_turn_output_v1 WHERE operation_id = $1 ORDER BY cursor",
        [operationId],
      ),
      client.query<ProofRow>(
        "SELECT receipt_kind, receipt_ref FROM agent_execution.contained_turn_receipt_v1 WHERE operation_id = $1 ORDER BY receipt_ref",
        [operationId],
      ),
    ]);
    validateProjections(operation, outputs.rows, proofs.rows);
    return operation;
  }

  public async project(
    client: PoolClient,
    previous: ContainedTurnKernelOperation | undefined,
    next: ContainedTurnKernelOperation,
  ): Promise<void> {
    const previousChunks = previous?.output.chunks ?? [];
    for (const chunk of next.output.chunks.slice(previousChunks.length)) {
      await client.query(
        "INSERT INTO agent_execution.contained_turn_output_v1(operation_id, cursor, output_kind, output_text) VALUES ($1,$2,$3,$4)",
        [next.operationId, chunk.cursor, chunk.kind, chunk.text],
      );
    }
    const previousProofIds = new Set(previous?.proofs.map(proof => proof.proofId));
    for (const proof of next.proofs) {
      if (!previousProofIds.has(proof.proofId)) {
        await client.query(
          "INSERT INTO agent_execution.contained_turn_receipt_v1(operation_id, receipt_kind, receipt_ref) VALUES ($1,$2,$3)",
          [next.operationId, proof.kind, proof.proofId],
        );
      }
    }
  }

  public async persist(
    client: PoolClient,
    previous: ContainedTurnKernelOperation,
    next: ContainedTurnKernelOperation,
  ): Promise<void> {
    validateContainedTurnOperation(next, { previous });
    const encoded = encodeContainedTurnState(next);
    const result = await client.query(
      "UPDATE agent_execution.contained_turn_operation_v1 SET revision=$3,state=$4::jsonb,state_codec_version=$5,state_digest=$6,terminal=$7 WHERE operation_id=$1 AND revision=$2",
      [next.operationId, previous.revision, next.revision, encoded.json, encoded.codecVersion,
        encoded.digest, next.terminal.kind === "final"],
    );
    if (result.rowCount !== 1) {throw new Error("contained turn PostgreSQL revision fence failed");}
    await this.project(client, previous, next);
  }

  public async rebuildProjections(
    client: PoolClient,
    input: Readonly<{ operationId: ContainedTurnOperationId; scope: ContainedTurnScope }>,
  ): Promise<ContainedTurnKernelOperation | undefined> {
    const row = await this.#authoritativeRow(client, input.operationId, true, input.scope);
    if (row === undefined) {return undefined;}
    const operation = operationFromRow(row);
    await client.query(
      "DELETE FROM agent_execution.contained_turn_output_v1 WHERE operation_id=$1",
      [operation.operationId],
    );
    await client.query(
      "DELETE FROM agent_execution.contained_turn_receipt_v1 WHERE operation_id=$1",
      [operation.operationId],
    );
    await this.project(client, undefined, operation);
    return operation;
  }
}
