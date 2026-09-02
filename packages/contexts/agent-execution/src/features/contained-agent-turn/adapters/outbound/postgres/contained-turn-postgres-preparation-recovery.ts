import type { ContainedTurnKernelOperationStore } from "../../../application/ports/outbound/contained-turn-ports.js";
import type { ContainedTurnDispatchPreparation } from "../../../domain/contained-turn-dispatch-preparation.js";
import type { ContainedTurnKernelOperation } from "../../../domain/contained-turn-kernel-model.js";
import { decodeContainedTurnPreparation } from "./contained-turn-preparation-codec.js";
import {
  CONTAINED_TURN_POSTGRES_JSON_BUDGET,
  CONTAINED_TURN_POSTGRES_MATERIALIZATION_BUDGET,
  ContainedTurnStateBudgetError,
  ContainedTurnStateQuarantineError,
} from "./contained-turn-state-codec.js";
import type { ContainedTurnPostgresOperationRepository } from "./contained-turn-postgres-operation-repository.js";
import type { ContainedTurnPostgresTransactions } from "./contained-turn-postgres-transactions.js";

interface PreparationRecoveryMetadataRow {
  readonly operation_state_bytes: number;
  readonly operation_id: string;
  readonly output_bytes: string;
  readonly receipt_bytes: string;
  readonly preparation_token: string;
  readonly state_bytes: number;
  readonly state_codec_version: number;
  readonly state_digest: string | null;
}

interface PreparationRecoveryStateRow extends PreparationRecoveryMetadataRow {
  readonly actual_operation_id: string | null;
  readonly actual_preparation_token: string | null;
  readonly actual_state_bytes: number | null;
  readonly actual_state_codec_version: number | null;
  readonly actual_state_digest: string | null;
  readonly project_id: string | null;
  readonly state: unknown;
  readonly tenant_id: string | null;
}

const RECOVERY_SCAN_BATCH_ROWS = 1_000;

const recoveryMetadataSql = (quarantine: boolean): string =>
  `SELECT p.operation_id,p.preparation_token,p.state_codec_version,p.state_digest,
          octet_length(p.state::text) AS state_bytes,
          octet_length(o.state::text) AS operation_state_bytes,
          (SELECT COALESCE(sum(octet_length(x.output_text) + octet_length(x.output_kind) + 4),0)::text
             FROM agent_execution.contained_turn_output_v1 AS x
            WHERE x.operation_id=p.operation_id) AS output_bytes,
          (SELECT COALESCE(sum(octet_length(r.receipt_ref) + octet_length(r.receipt_kind)),0)::text
             FROM agent_execution.contained_turn_receipt_v1 AS r
            WHERE r.operation_id=p.operation_id) AS receipt_bytes
     FROM agent_execution.contained_turn_dispatch_preparation_v1 AS p
     JOIN agent_execution.contained_turn_operation_v1 AS o
       ON o.operation_id = p.operation_id
     ${quarantine ? `LEFT JOIN agent_execution.contained_turn_dispatch_preparation_quarantine_v1 AS q
       ON q.operation_id = p.operation_id
      AND q.preparation_token = p.preparation_token
      AND q.observed_codec_version = p.state_codec_version
      AND q.observed_state_digest IS NOT DISTINCT FROM p.state_digest` : ""}
    WHERE o.tenant_id = $1 AND o.project_id = $2
      ${quarantine ? "AND q.operation_id IS NULL" : ""}
      AND (p.operation_id,p.preparation_token) > ($3,$4)
    ORDER BY p.operation_id,p.preparation_token
    LIMIT $5${quarantine ? " FOR UPDATE OF p,o" : ""}`;

const budgetNumber = (value: number | string): number => {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {throw new ContainedTurnStateBudgetError();}
  return parsed;
};

const assertMetadataWithinBudget = (rows: readonly PreparationRecoveryMetadataRow[]): void => {
  if (rows.length > RECOVERY_SCAN_BATCH_ROWS) {throw new ContainedTurnStateBudgetError();}
  let batchBytes = 0;
  let budgetViolated = false;
  const countedOperations = new Set<string>();
  for (const row of rows) {
    const stateBytes = budgetNumber(row.state_bytes);
    batchBytes += stateBytes;
    if (!countedOperations.has(row.operation_id)) {
      countedOperations.add(row.operation_id);
      batchBytes += budgetNumber(row.operation_state_bytes) + budgetNumber(row.output_bytes) +
        budgetNumber(row.receipt_bytes);
    }
    budgetViolated ||= stateBytes > CONTAINED_TURN_POSTGRES_JSON_BUDGET.maximumSerializedBytes ||
      budgetNumber(row.operation_state_bytes) > CONTAINED_TURN_POSTGRES_JSON_BUDGET.maximumSerializedBytes ||
      batchBytes > CONTAINED_TURN_POSTGRES_MATERIALIZATION_BUDGET.maximumBatchBytes;
  }
  if (budgetViolated) {throw new ContainedTurnStateBudgetError();}
};

const addCandidateMaterializationBytes = (
  currentBytes: number,
  row: PreparationRecoveryMetadataRow,
  countedOperations: Set<string>,
): number => {
  let nextBytes = currentBytes + budgetNumber(row.state_bytes);
  if (!countedOperations.has(row.operation_id)) {
    countedOperations.add(row.operation_id);
    nextBytes += budgetNumber(row.operation_state_bytes) + budgetNumber(row.output_bytes) +
      budgetNumber(row.receipt_bytes);
  }
  if (!Number.isSafeInteger(nextBytes) ||
      nextBytes > CONTAINED_TURN_POSTGRES_MATERIALIZATION_BUDGET.maximumBatchBytes) {
    throw new ContainedTurnStateBudgetError();
  }
  return nextBytes;
};

const assertStableMaterialization = (
  rows: readonly PreparationRecoveryStateRow[],
  scope: RecoveryInput["scope"],
): void => {
  for (const row of rows) {
    if (row.actual_operation_id !== row.operation_id ||
        row.actual_preparation_token !== row.preparation_token ||
        row.actual_state_codec_version !== row.state_codec_version ||
        row.actual_state_digest !== row.state_digest ||
        row.actual_state_bytes !== row.state_bytes ||
        row.tenant_id !== scope.tenantId || row.project_id !== scope.projectId) {
      throw new Error("dispatch preparation recovery metadata changed during materialization");
    }
  }
};

type RecoveryInput = Parameters<
  NonNullable<ContainedTurnKernelOperationStore["listDispatchPreparations"]>
>[0];

export class ContainedTurnPostgresPreparationRecovery {
  public constructor(
    private readonly operations: ContainedTurnPostgresOperationRepository,
    private readonly runtimeSchemaVersion: number,
    private readonly transactions: ContainedTurnPostgresTransactions,
  ) {}

  public async list(input: RecoveryInput) {
    const limit = input.limit ?? 100;
    const kinds = input.kinds ?? ["active", "cleanup_pending"] as const;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000 ||
        kinds.length === 0 || kinds.some(kind => kind !== "active" && kind !== "cleanup_pending")) {
      throw new TypeError("invalid dispatch preparation recovery query");
    }
    const recover = async (client: import("pg").PoolClient, quarantine: boolean) => {
      const scanMetadata = async (
        afterOperationId: string,
        afterPreparationToken: string,
      ) => client.query<PreparationRecoveryMetadataRow>(
        recoveryMetadataSql(quarantine),
        [input.scope.tenantId, input.scope.projectId, afterOperationId, afterPreparationToken,
          RECOVERY_SCAN_BATCH_ROWS],
      );
      let afterOperationId = "";
      let afterPreparationToken = "";
      while (true) {
        const metadata = await scanMetadata(afterOperationId, afterPreparationToken);
        assertMetadataWithinBudget(metadata.rows);
        const last = metadata.rows.at(-1);
        if (last !== undefined) {
          afterOperationId = last.operation_id;
          afterPreparationToken = last.preparation_token;
        }
        if (metadata.rows.length < RECOVERY_SCAN_BATCH_ROWS) {break;}
      }

      const materialize = async (metadata: readonly PreparationRecoveryMetadataRow[]) => client.query<PreparationRecoveryStateRow>(
        `WITH approved AS (
           SELECT * FROM unnest($1::text[],$2::text[],$3::integer[],$4::text[],$5::integer[])
             AS expected(operation_id,preparation_token,state_codec_version,state_digest,state_bytes)
         )
         SELECT expected.operation_id,expected.preparation_token,expected.state_codec_version,
                expected.state_digest,expected.state_bytes,
                p.operation_id AS actual_operation_id,
                p.preparation_token AS actual_preparation_token,
                p.state_codec_version AS actual_state_codec_version,
                p.state_digest AS actual_state_digest,
                octet_length(p.state::text) AS actual_state_bytes,
                o.tenant_id,o.project_id,p.state
           FROM approved AS expected
           LEFT JOIN agent_execution.contained_turn_dispatch_preparation_v1 AS p
             ON p.operation_id=expected.operation_id
            AND p.preparation_token=expected.preparation_token
           LEFT JOIN agent_execution.contained_turn_operation_v1 AS o
             ON o.operation_id=p.operation_id
          ORDER BY expected.operation_id,expected.preparation_token`,
        [metadata.map(row => row.operation_id), metadata.map(row => row.preparation_token),
          metadata.map(row => row.state_codec_version), metadata.map(row => row.state_digest),
          metadata.map(row => row.state_bytes)],
      );
      const recoveries: Array<Readonly<{
        operation: ContainedTurnKernelOperation;
        preparation: ContainedTurnDispatchPreparation;
      }>> = [];
      const operationById = new Map<string, ContainedTurnKernelOperation>();
      const countedCandidateOperations = new Set<string>();
      let candidateBytes = 0;
      afterOperationId = "";
      afterPreparationToken = "";
      while (true) {
        const metadata = await scanMetadata(afterOperationId, afterPreparationToken);
        if (metadata.rows.length === 0) {break;}
        const states = await materialize(metadata.rows);
        assertStableMaterialization(states.rows, input.scope);
        for (const row of states.rows) {
          let preparation: ContainedTurnDispatchPreparation;
          try {
            preparation = decodeContainedTurnPreparation(
              row.state, row.state_digest, row.state_codec_version,
            );
          } catch (error) {
            if (!quarantine || !(error instanceof ContainedTurnStateQuarantineError)) {throw error;}
            await client.query(
              `INSERT INTO agent_execution.contained_turn_dispatch_preparation_quarantine_v1
               (operation_id,preparation_token,observed_codec_version,observed_state_digest,
                quarantined_state,reason)
             VALUES ($1,$2,$3,$4,$5::jsonb,$6)
             ON CONFLICT (operation_id,preparation_token) DO UPDATE
               SET observed_codec_version=EXCLUDED.observed_codec_version,
                   observed_state_digest=EXCLUDED.observed_state_digest,
                   quarantined_state=EXCLUDED.quarantined_state,
                   reason=EXCLUDED.reason,
                   last_observed_at=transaction_timestamp(),
                   observation_count=agent_execution.contained_turn_dispatch_preparation_quarantine_v1.observation_count + 1`,
              [row.operation_id, row.preparation_token, row.state_codec_version,
                row.state_digest, row.state, error.reason],
            );
            continue;
          }
          if (preparation.operationId !== row.operation_id ||
              preparation.preparationToken !== row.preparation_token) {
            throw new Error("dispatch preparation recovery row identity mismatch");
          }
          if (!kinds.includes(preparation.kind as "active" | "cleanup_pending") ||
              recoveries.length === limit) {continue;}
          candidateBytes = addCandidateMaterializationBytes(
            candidateBytes, row, countedCandidateOperations,
          );
          let operation = operationById.get(row.operation_id);
          if (operation === undefined) {
            operation = await this.operations.load(client, row.operation_id, false, input.scope);
          }
          if (operation !== undefined) {operationById.set(row.operation_id, operation);}
          if (operation === undefined) {
            throw new Error("dispatch preparation recovery operation disappeared");
          }
          recoveries.push(Object.freeze({ operation, preparation }));
        }
        const last = metadata.rows.at(-1);
        if (last === undefined || metadata.rows.length < RECOVERY_SCAN_BATCH_ROWS) {break;}
        afterOperationId = last.operation_id;
        afterPreparationToken = last.preparation_token;
      }
      return Object.freeze(recoveries);
    };
    return this.runtimeSchemaVersion >= 5
      ? this.transactions.write(client => recover(client, true), true)
      : this.transactions.read(client => recover(client, false));
  }
}
