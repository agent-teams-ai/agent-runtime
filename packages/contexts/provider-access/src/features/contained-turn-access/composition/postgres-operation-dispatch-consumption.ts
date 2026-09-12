import type { MaterializationPostgresPool, MaterializationPostgresTimeouts } from "../adapters/outbound/postgres/materialization-postgres-transactions.js";
import { createPostgresOperationDispatchStore } from "../adapters/outbound/postgres/dispatch-operation-store.js";
import type { PaDispatchIssuanceSelection } from "../adapters/outbound/dispatch-operation-contracts.js";
import { createOperationDispatchConsumption } from "./operation-dispatch-consumption.js";

/**
 * Private v2 owner. The pool is borrowed; synchronous construction performs no I/O.
 *
 * Bootstrap: control.migrate(), independently replace the actual materialization
 * binding, then control.provisionIssuance(). The immutable selection belongs to
 * PA/operator composition, never to an AE dispatch request. Reconstruct with the
 * same selection; a different payload at the same scoped issuanceRef is refused.
 *
 * AE calls dispatchConsumption.publishAndConsumeForDispatch(prepared, request)
 * only on its acknowledged acceptance path. PaAcceptedPreparation is a trusted
 * private handoff, not database proof. PA verifies its PA projection and request
 * digests; AE remains responsible for acceptance COMMIT, the complete vector,
 * acceptance proof, intent/constraints digests, and the final fresh claim.
 *
 * Publication and consumption are separate acknowledged transactions. An
 * uncertain publication returns indeterminate without consumption. An exact
 * later invocation can read back immutable publication/outcome evidence; it
 * never extends the issuance window or allocates a new request identity.
 *
 * The dispatchConsumption object also retains the three V1 method signatures:
 * consumeForDispatch, observeDispatchConsumption, settleDispatchConsumption.
 * They use only v2 storage here. The legacy createPostgresDispatchConsumption
 * factory and its global v1 history retain their old meaning and are not read,
 * migrated, or promoted into v2 grants. Never expose either private control to
 * an ordinary runtime handle. Credential rendering is still operation-scoped.
 */
export const createPostgresOperationDispatchConsumption = (pool: MaterializationPostgresPool,
  selection: PaDispatchIssuanceSelection, timeouts?: Partial<MaterializationPostgresTimeouts>) => {
  const persistence = createPostgresOperationDispatchStore(pool, timeouts);
  const owner = createOperationDispatchConsumption(persistence.store, selection);
  return Object.freeze({dispatchConsumption: owner.dispatchConsumption,
    control: Object.freeze({...owner.control, migrate: persistence.migrate}), dispose: persistence.dispose});
};
