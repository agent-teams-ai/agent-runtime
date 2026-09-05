import { createPostgresMaterializationRepository } from "../adapters/outbound/postgres/materialization-postgres-repository.js";
import type { MaterializationPostgresPool, MaterializationPostgresTimeouts } from "../adapters/outbound/postgres/materialization-postgres-transactions.js";
import { createSha256DispatchConsumptionDigest } from "../adapters/outbound/sha256-dispatch-consumption-digest.js";
import type { CredentialGenerationAcquisition, CredentialRenderingOwner, CredentialRenderingSelection } from "../adapters/outbound/credential-rendering-contracts.js";
import { createContainedTurnCredentialRenderingOwner } from "./credential-rendering-owner-factory.js";

/**
 * Private PA store/render assembly for one operation. PA supplies its exact selection
 * and acquisition adapter. The caller owns the borrowed pool; migration and head
 * updates are explicit owner control actions, never request-driven effects.
 */
export const createPostgresCredentialRenderingOwner = (pool: MaterializationPostgresPool,
  selection: CredentialRenderingSelection, acquisition?: CredentialGenerationAcquisition,
  timeouts?: Partial<MaterializationPostgresTimeouts>) => {
  const store = createPostgresMaterializationRepository(pool, timeouts);
  let rendering: CredentialRenderingOwner;
  try {
    rendering = createContainedTurnCredentialRenderingOwner(selection, {
      digest: createSha256DispatchConsumptionDigest(), repository: store.repository,
    }, acquisition);
  } catch (error) {store.dispose(); throw error;}
  return Object.freeze({
    owner: Object.freeze<CredentialRenderingOwner>({
      authorization: rendering.authorization,
      rendering: rendering.rendering,
      dispose() {try {rendering.dispose();} finally {store.dispose();}},
    }),
    control: Object.freeze({migrate: store.migrate, replaceBinding: store.replaceBinding}),
  });
};
