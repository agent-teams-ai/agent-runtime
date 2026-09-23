import { createPostgresMaterializationRepository, type MaterializationPostgresOwner } from "../adapters/outbound/postgres/materialization-postgres-repository.js";
import { createMaterializationBindingRepository } from "../adapters/outbound/postgres/materialization-binding-repository.js";
import type { MaterializationPostgresPool, MaterializationPostgresTimeouts } from "../adapters/outbound/postgres/materialization-postgres-transactions.js";
import { createContainedTurnProviderAccessFeature } from "./feature-module-factory.js";

export interface PostgresCurrentProviderAccessOwner {
  readonly providerAccess: ReturnType<typeof createContainedTurnProviderAccessFeature>;
  dispose(): void;
}

/** Shared current resolver, independent of any operation's rendering/custody lifetime. */
export const createPostgresCurrentProviderAccess = (pool: MaterializationPostgresPool,
  selection: MaterializationPostgresOwner, timeouts?: Partial<MaterializationPostgresTimeouts>): Readonly<PostgresCurrentProviderAccessOwner> => {
  const store = createPostgresMaterializationRepository(pool, timeouts);
  return Object.freeze({providerAccess: createContainedTurnProviderAccessFeature({bindingRepository:
    createMaterializationBindingRepository(store.observeBinding, selection)}), dispose: store.dispose});
};
