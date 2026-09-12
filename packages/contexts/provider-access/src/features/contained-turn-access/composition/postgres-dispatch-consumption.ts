import { createPostgresDispatchConsumptionRepository } from "../adapters/outbound/postgres/dispatch-postgres-repository.js";
import type { MaterializationPostgresPool, MaterializationPostgresTimeouts } from "../adapters/outbound/postgres/materialization-postgres-transactions.js";
import { createSha256DispatchConsumptionDigest } from "../adapters/outbound/sha256-dispatch-consumption-digest.js";
import { createContainedTurnDispatchConsumptionV1 } from "./dispatch-consumption-v1-factory.js";

/** Private trusted PA composition. Pool lifetime belongs to the embedding owner. */
export const createPostgresDispatchConsumption = (pool: MaterializationPostgresPool,
  timeouts?: Partial<MaterializationPostgresTimeouts>) => {
  const owner = createPostgresDispatchConsumptionRepository(pool, timeouts);
  return Object.freeze({
    dispatchConsumption: createContainedTurnDispatchConsumptionV1({repository: owner.repository, digest: createSha256DispatchConsumptionDigest()}),
    control: Object.freeze({...owner.control, migrate: owner.migrate}),
    dispose: owner.dispose,
  });
};
