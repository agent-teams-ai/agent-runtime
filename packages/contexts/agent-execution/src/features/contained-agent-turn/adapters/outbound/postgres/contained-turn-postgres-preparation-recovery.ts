import type { ContainedTurnKernelOperationStore } from "../../../application/ports/outbound/contained-turn-ports.js";
import type { ContainedTurnDispatchPreparation } from "../../../domain/contained-turn-dispatch-preparation.js";
import type { ContainedTurnKernelOperation } from "../../../domain/contained-turn-kernel-model.js";
import {
  CONTAINED_TURN_PREPARATION_CODEC_VERSION,
  decodeContainedTurnPreparation,
} from "./contained-turn-preparation-codec.js";
import {
  CONTAINED_TURN_POSTGRES_JSON_BUDGET,
  ContainedTurnStateBudgetError,
  ContainedTurnStateQuarantineError,
} from "./contained-turn-state-codec.js";
import type { ContainedTurnPostgresOperationRepository } from "./contained-turn-postgres-operation-repository.js";
import type { ContainedTurnPostgresTransactions } from "./contained-turn-postgres-transactions.js";

interface PreparationRecoveryMetadataRow {
  readonly operation_id: string;
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

const RECOVERY_BATCH_SERIALIZED_BYTES = 9 * 1024 * 1024;

const recoveryMetadataSql = (quarantine: boolean): string =>
  `SELECT p.operation_id,p.preparation_token,p.state_codec_version,p.state_digest,
          octet_length(p.state::text) AS state_bytes
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
      AND (octet_length(p.state::text) > $6
        OR (((p.state_codec_version = 2 OR p.state_codec_version = $4) AND
             (p.state #>> '{payload,kind}') = ANY($3::text[]))
        OR (p.state_codec_version = 1 AND (p.state #>> '{kind}') = ANY($3::text[]))
        OR p.state_codec_version NOT IN (1, 2, $4)))
    ORDER BY p.operation_id,p.preparation_token
    LIMIT $5${quarantine ? " FOR UPDATE OF p,o" : ""}`;

const assertMetadataWithinBudget = (rows: readonly PreparationRecoveryMetadataRow[]): void => {
  let batchBytes = 0;
  let budgetViolated = false;
  for (const row of rows) {
    batchBytes += row.state_bytes;
    budgetViolated ||= row.state_bytes > CONTAINED_TURN_POSTGRES_JSON_BUDGET.maximumSerializedBytes ||
      batchBytes > RECOVERY_BATCH_SERIALIZED_BYTES;
  }
  if (budgetViolated) {throw new ContainedTurnStateBudgetError();}
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
      const metadata = await client.query<PreparationRecoveryMetadataRow>(
        recoveryMetadataSql(quarantine),
        [input.scope.tenantId, input.scope.projectId, kinds,
          CONTAINED_TURN_PREPARATION_CODEC_VERSION, quarantine ? 1_000 : limit,
          CONTAINED_TURN_POSTGRES_JSON_BUDGET.maximumSerializedBytes],
      );
      assertMetadataWithinBudget(metadata.rows);
      if (metadata.rows.length === 0) {return Object.freeze([]);}

      const states = await client.query<PreparationRecoveryStateRow>(
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
        [metadata.rows.map(row => row.operation_id), metadata.rows.map(row => row.preparation_token),
          metadata.rows.map(row => row.state_codec_version), metadata.rows.map(row => row.state_digest),
          metadata.rows.map(row => row.state_bytes)],
      );
      assertStableMaterialization(states.rows, input.scope);
      const recoveries: Array<Readonly<{
        operation: ContainedTurnKernelOperation;
        preparation: ContainedTurnDispatchPreparation;
      }>> = [];
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
        if (preparation.kind !== "active" && preparation.kind !== "cleanup_pending") {continue;}
        if (preparation.operationId !== row.operation_id ||
            preparation.preparationToken !== row.preparation_token) {
          throw new Error("dispatch preparation recovery row identity mismatch");
        }
        const operation = await this.operations.load(
          client, row.operation_id, false, input.scope,
        );
        if (operation === undefined) {
          throw new Error("dispatch preparation recovery operation disappeared");
        }
        recoveries.push(Object.freeze({ operation, preparation }));
        if (recoveries.length === limit) {break;}
      }
      return Object.freeze(recoveries);
    };
    return this.runtimeSchemaVersion >= 5
      ? this.transactions.write(client => recover(client, true))
      : this.transactions.read(client => recover(client, false));
  }
}
