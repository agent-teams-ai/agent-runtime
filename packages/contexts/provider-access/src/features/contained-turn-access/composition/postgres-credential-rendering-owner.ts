import { createPostgresMaterializationRepository } from "../adapters/outbound/postgres/materialization-postgres-repository.js";
import type { MaterializationPostgresPool, MaterializationPostgresTimeouts } from "../adapters/outbound/postgres/materialization-postgres-transactions.js";
import { createSha256DispatchConsumptionDigest } from "../adapters/outbound/sha256-dispatch-consumption-digest.js";
import type { CredentialGenerationAcquisition, CredentialRenderingOwner, CredentialRenderingSelection } from "../adapters/outbound/credential-rendering-contracts.js";
import { createContainedTurnCredentialRenderingOwner } from "./credential-rendering-owner-factory.js";
import { createMaterializationBindingRepository } from "../adapters/outbound/postgres/materialization-binding-repository.js";
import { createContainedTurnProviderAccessFeature } from "./feature-module-factory.js";
import type { ContainedTurnProviderAccessFeatureApi } from "../contracts/contained-turn-provider-access.js";

/**
 * Private PA store/render assembly for one operation. PA supplies its exact selection
 * and acquisition adapter. The caller owns the borrowed pool; migration and head
 * updates are explicit owner control actions, never request-driven effects.
 */
export const createPostgresCredentialRenderingOwner = (pool: MaterializationPostgresPool,
  selection: CredentialRenderingSelection, acquisition?: CredentialGenerationAcquisition,
  timeouts?: Partial<MaterializationPostgresTimeouts>) => {
  const store = createPostgresMaterializationRepository(pool, timeouts);
  let rendering: CredentialRenderingOwner | undefined;
  let providerAccess: ContainedTurnProviderAccessFeatureApi;
  try {
    rendering = createContainedTurnCredentialRenderingOwner(selection, {
      digest: createSha256DispatchConsumptionDigest(), repository: store.repository,
    }, acquisition);
    const {tenantId, projectId, provider, scopeDigest} = selection.binding;
    providerAccess = createContainedTurnProviderAccessFeature({bindingRepository:
      createMaterializationBindingRepository(store.observeBinding, {tenantId, projectId, provider, scopeDigest})});
  } catch (error) {try {rendering?.dispose();} finally {store.dispose();} throw error;}
  const capturedRendering = rendering;
  return Object.freeze({
    providerAccess,
    owner: Object.freeze<CredentialRenderingOwner>({
      authorization: capturedRendering.authorization,
      rendering: capturedRendering.rendering,
      dispose() {try {capturedRendering.dispose();} finally {store.dispose();}},
    }),
    control: Object.freeze({migrate: store.migrate, replaceBinding: store.replaceBinding}),
  });
};
