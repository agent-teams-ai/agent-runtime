import type {OrdinarySecurityGrantRecord, OrdinarySecurityKey, OrdinarySecuritySettlement} from "../../domain/ordinary-security-policy.js";
/** The commit was sent but its outcome is unknown; the owner may read back, the store never does. */
export class OrdinarySecurityCommitUnknownError extends Error {constructor() {super("ORDINARY_SECURITY_COMMIT_UNKNOWN"); this.name = "OrdinarySecurityCommitUnknownError";}}
/** The database could not be used (not committed, closed, timed out or aborted). */
export class OrdinarySecurityStoreUnavailableError extends Error {constructor() {super("ORDINARY_SECURITY_DATABASE_UNAVAILABLE"); this.name = "OrdinarySecurityStoreUnavailableError";}}
export type OrdinarySecurityInsertResult = {readonly kind: "inserted" | "existing"; readonly record: OrdinarySecurityGrantRecord};
export type OrdinarySecurityStoreSettleResult = {readonly kind: "settled" | "already"; readonly settlement: OrdinarySecuritySettlement} | {readonly kind: "conflict" | "missing"};
/**
 * Durable storage for consumed Runtime Security grants. A method that fails with
 * `OrdinarySecurityCommitUnknownError` or `OrdinarySecurityStoreUnavailableError`
 * may be answered by the owner with one `observe`; any other failure is a refusal
 * and must not be read back.
 */
export interface OrdinarySecurityGrantStore {
  /** Stores the record unless one exists for its key; `existing` returns the stored record unchanged. */
  insertIfAbsent(record: OrdinarySecurityGrantRecord): Promise<OrdinarySecurityInsertResult>;
  observe(key: OrdinarySecurityKey): Promise<OrdinarySecurityGrantRecord | undefined>;
  /** Idempotent for the same disposition; `conflict` for another one or for a settlement of a different grant. */
  settle(key: OrdinarySecurityKey, settlement: OrdinarySecuritySettlement): Promise<OrdinarySecurityStoreSettleResult>;
}
