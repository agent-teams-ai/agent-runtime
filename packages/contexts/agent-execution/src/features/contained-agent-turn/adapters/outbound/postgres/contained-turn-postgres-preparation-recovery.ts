import type { ContainedTurnKernelOperationStore } from "../../../application/ports/outbound/contained-turn-ports.js";
import type { ContainedTurnDispatchPreparation } from "../../../domain/contained-turn-dispatch-preparation.js";
import type { ContainedTurnKernelOperation } from "../../../domain/contained-turn-kernel-model.js";
import {
  CONTAINED_TURN_PREPARATION_CODEC_VERSION,
  decodeContainedTurnPreparation,
} from "./contained-turn-preparation-codec.js";
import { ContainedTurnStateQuarantineError } from "./contained-turn-state-codec.js";
import type { ContainedTurnPostgresOperationRepository } from "./contained-turn-postgres-operation-repository.js";
import type { ContainedTurnPostgresTransactions } from "./contained-turn-postgres-transactions.js";

interface PreparationRecoveryRow {
  readonly operation_id: string;
  readonly preparation_token: string;
  readonly state: unknown;
  readonly state_codec_version: number;
  readonly state_digest: string | null;
}

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
      const rows = await client.query<PreparationRecoveryRow>(
        `SELECT p.operation_id,p.preparation_token,p.state,p.state_codec_version,p.state_digest
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
            AND (((p.state_codec_version = 2 OR p.state_codec_version = $4) AND (p.state #>> '{payload,kind}') = ANY($3::text[]))
                 OR (p.state_codec_version = 1 AND (p.state #>> '{kind}') = ANY($3::text[]))
                 OR p.state_codec_version NOT IN (1, 2, $4))
          ORDER BY p.operation_id,p.preparation_token
          LIMIT $5`,
        [input.scope.tenantId, input.scope.projectId, kinds,
          CONTAINED_TURN_PREPARATION_CODEC_VERSION, quarantine ? 1_000 : limit],
      );
      const recoveries: Array<Readonly<{
        operation: ContainedTurnKernelOperation;
        preparation: ContainedTurnDispatchPreparation;
      }>> = [];
      for (const row of rows.rows) {
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
