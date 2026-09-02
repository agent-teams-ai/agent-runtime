import type { PoolClient } from "pg";

import type { ContainedTurnScope } from "../../../domain/contained-turn-authority.js";
import type {
  ContainedTurnEvidenceId,
  ContainedTurnOperationId,
} from "../../../domain/contained-turn-identities.js";
import type { ContainedTurnKernelOperation } from "../../../domain/contained-turn-kernel-model.js";
import { mutateContainedTurnOperation } from "../../../domain/contained-turn-transitions.js";
import { validateContainedTurnOperation } from "../../../domain/contained-turn-validation.js";
import {
  CONTAINED_TURN_POSTGRES_JSON_BUDGET,
  CONTAINED_TURN_POSTGRES_MATERIALIZATION_BUDGET,
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
  readonly state_bytes: number;
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

interface ProjectionMetadataRow {
  readonly output_bytes: string;
  readonly output_count: string;
  readonly receipt_bytes: string;
  readonly receipt_count: string;
}

const safeCount = (value: string): number => {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {throw new ContainedTurnStateBudgetError();}
  return parsed;
};

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
  public async attachPreparationQuarantineDebt(
    client: PoolClient,
    input: Readonly<{
      evidenceId: ContainedTurnEvidenceId;
      operationId: string;
      scope: ContainedTurnScope;
    }>,
  ): Promise<ContainedTurnKernelOperation> {
    const current = await this.load(client, input.operationId, true, input.scope);
    if (current === undefined) {
      throw new Error("dispatch preparation quarantine operation disappeared");
    }
    if (current.reconciliation.kind === "required" &&
        current.reconciliation.evidenceIds.includes(input.evidenceId)) {
      return current;
    }
    const debt = mutateContainedTurnOperation(current, {
      evidenceId: input.evidenceId,
      kind: "record_reconciliation_debt",
      source: "dispatch_authority",
    });
    await this.persist(client, current, debt);
    return debt;
  }

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
              octet_length(state::text) AS state_bytes,
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
    const metadata = await client.query<ProjectionMetadataRow>(
      `SELECT
         (SELECT count(*)::text FROM agent_execution.contained_turn_output_v1 WHERE operation_id=$1) AS output_count,
         (SELECT COALESCE(sum(octet_length(output_text) + octet_length(output_kind) + 4),0)::text
            FROM agent_execution.contained_turn_output_v1 WHERE operation_id=$1) AS output_bytes,
         (SELECT count(*)::text FROM agent_execution.contained_turn_receipt_v1 WHERE operation_id=$1) AS receipt_count,
         (SELECT COALESCE(sum(octet_length(receipt_ref) + octet_length(receipt_kind)),0)::text
            FROM agent_execution.contained_turn_receipt_v1 WHERE operation_id=$1) AS receipt_bytes`,
      [operationId],
    );
    const projection = metadata.rows[0];
    if (projection === undefined) {throw new Error("contained turn PostgreSQL projection metadata missing");}
    const outputCount = safeCount(projection.output_count);
    const receiptCount = safeCount(projection.receipt_count);
    const materializedBytes = row.state_bytes + safeCount(projection.output_bytes) +
      safeCount(projection.receipt_bytes);
    if (outputCount !== operation.output.chunks.length || receiptCount !== operation.proofs.length) {
      throw new Error("contained turn PostgreSQL projection cardinality mismatch");
    }
    if (!Number.isSafeInteger(materializedBytes) ||
        materializedBytes > CONTAINED_TURN_POSTGRES_MATERIALIZATION_BUDGET.maximumBatchBytes) {
      throw new ContainedTurnStateBudgetError();
    }
    const [outputs, proofs] = await Promise.all([
      client.query<OutputRow>(
        `SELECT cursor, output_kind,
                CASE WHEN octet_length(output_text) <= $3 THEN output_text END AS output_text
           FROM agent_execution.contained_turn_output_v1
          WHERE operation_id = $1 ORDER BY cursor LIMIT $2`,
        [operationId, outputCount + 1,
          CONTAINED_TURN_POSTGRES_MATERIALIZATION_BUDGET.maximumBatchBytes],
      ),
      client.query<ProofRow>(
        `SELECT receipt_kind,
                CASE WHEN octet_length(receipt_ref) <= $3 THEN receipt_ref END AS receipt_ref
           FROM agent_execution.contained_turn_receipt_v1
          WHERE operation_id = $1 ORDER BY receipt_ref LIMIT $2`,
        [operationId, receiptCount + 1,
          CONTAINED_TURN_POSTGRES_MATERIALIZATION_BUDGET.maximumBatchBytes],
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
