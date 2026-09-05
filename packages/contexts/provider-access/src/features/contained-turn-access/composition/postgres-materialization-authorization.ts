import { createPostgresMaterializationRepository } from "../adapters/outbound/postgres/materialization-postgres-repository.js";
import type { MaterializationPostgresPool, MaterializationPostgresTimeouts } from "../adapters/outbound/postgres/materialization-postgres-transactions.js";
import { createSha256DispatchConsumptionDigest } from "../adapters/outbound/sha256-dispatch-consumption-digest.js";
import { createContainedTurnCredentialMaterializationAuthorizationV1 } from "./materialization-authorization-v1-factory.js";

/** Private PA owner prerequisite. No package export or production admission promotion. */
export const createPostgresMaterializationAuthorization = (pool: MaterializationPostgresPool,
  timeouts?: Partial<MaterializationPostgresTimeouts>) => {
  const owner = createPostgresMaterializationRepository(pool, timeouts);
  return Object.freeze({
    authorization: createContainedTurnCredentialMaterializationAuthorizationV1({
      digest: createSha256DispatchConsumptionDigest(), repository: owner.repository,
    }),
    control: Object.freeze({migrate: owner.migrate, replaceBinding: owner.replaceBinding}),
    dispose: owner.dispose,
  });
};
