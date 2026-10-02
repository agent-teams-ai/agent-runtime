import {createOrdinarySecurityGrantOwner, type OrdinarySecurityOwner} from "../application/ordinary-security-owner.js";
import {createPostgresOrdinarySecurityGrantStore, newOrdinarySecurityId, ordinarySecurityDigest, type OrdinarySecurityOwnerOptions} from "../adapters/outbound/postgres/ordinary-security-owner.js";
export type {OrdinarySecurityOwner, OrdinarySecurityGrant, OrdinarySecurityObservation} from "../application/ordinary-security-owner.js";
export type {OrdinarySecurityScope, OrdinarySecurityInput, OrdinarySecurityPolicy, OrdinarySecurityAuthority, OrdinarySecuritySettlement} from "../domain/ordinary-security-policy.js";
export type {OrdinarySecurityOwnerOptions};
/** Genuine Runtime Security policy/consumption owner over the Postgres grant store, additive to the V1 containment authority. */
export const createOrdinarySecurityOwner = (options: OrdinarySecurityOwnerOptions): OrdinarySecurityOwner => {
  const store = createPostgresOrdinarySecurityGrantStore(options);
  const owner = createOrdinarySecurityGrantOwner({store, allowedScope: options.allowedScope, policy: options.policy, now: Date.now, newId: newOrdinarySecurityId, digest: ordinarySecurityDigest});
  return Object.freeze({
    ...owner,
    migrate: () => store.migrate(),
    async dispose() {await owner.dispose(); await store.close();},
  });
};
