import { createPostgresDispatchConsumptionRepository } from "../adapters/outbound/postgres/dispatch-postgres-repository.js";
import type { MaterializationPostgresPool, MaterializationPostgresTimeouts } from "../adapters/outbound/postgres/materialization-postgres-transactions.js";
import type { DispatchPostgresControl } from "../adapters/outbound/postgres/dispatch-postgres-control.js";
import type { DispatchPostgresOwner } from "../adapters/outbound/postgres/dispatch-postgres-data.js";
import { createSha256DispatchConsumptionDigest } from "../adapters/outbound/sha256-dispatch-consumption-digest.js";
import type { ContainedTurnDispatchConsumptionV1,
  DispatchConsumptionDisposition } from "../contracts/dispatch-consumption-v1.js";
import type { DispatchConsumedReceipt, DispatchSettlementReceipt } from "../domain/dispatch-consumption.js";
import { createContainedTurnDispatchConsumptionV1 } from "./dispatch-consumption-v1-factory.js";

export type PostgresDispatchConsumptionObservation =
  | Readonly<{ receipt: DispatchConsumedReceipt; state: "consumed_pending" }>
  | Readonly<{ receipt: DispatchConsumedReceipt; state: DispatchConsumptionDisposition; settlement: DispatchSettlementReceipt }>;

export interface PostgresDispatchConsumptionOwner {
  readonly dispatchConsumption: ContainedTurnDispatchConsumptionV1;
  readonly control: Readonly<DispatchPostgresControl & {
    observeConsumption(input: DispatchPostgresOwner,
      consumptionDigest: string): Promise<PostgresDispatchConsumptionObservation | undefined>;
    migrate(): Promise<void>;
  }>;
  dispose(): void;
}

/** Trusted PA composition owner. Pool lifetime belongs to the embedding owner. */
export const createPostgresDispatchConsumption = (pool: MaterializationPostgresPool,
  timeouts?: Partial<MaterializationPostgresTimeouts>): Readonly<PostgresDispatchConsumptionOwner> => {
  const owner = createPostgresDispatchConsumptionRepository(pool, timeouts);
  return Object.freeze({
    dispatchConsumption: createContainedTurnDispatchConsumptionV1({repository: owner.repository, digest: createSha256DispatchConsumptionDigest()}),
    control: Object.freeze({...owner.control, migrate: owner.migrate}),
    dispose: owner.dispose,
  });
};
