import type { OrdinaryPaBinding, OrdinaryPaBrokerRequest, OrdinaryPaDisposition, OrdinaryPaGrantRecord, OrdinaryPaRequestOutcome, OrdinaryPaSnapshot } from "../../../domain/ordinary-provider-access.js";

export type OrdinaryPaInsertGrantResult =
  | { readonly kind: "inserted"; readonly snapshot: OrdinaryPaSnapshot }
  | { readonly kind: "rejected" };

/**
 * Durable ordinary grant and broker request journal. Every method throws `OrdinaryPaUnavailable`
 * when the store cannot prove the outcome, and no implementation retries or reads back by itself.
 * A lost COMMIT acknowledgement therefore always surfaces as a throw; only the owner may read back,
 * and only after `retire` or `settle`.
 */
export interface OrdinaryPaGrantStore {
  /**
   * One-shot: exactly one successful insert per binding, forever, even after settlement.
   * Resolves `rejected` when the binding already has a grant or the store clock refuses the expiry window.
   * A throw (including an unknown COMMIT) must be treated as a refusal; no second grant is ever issued.
   */
  insertGrant(grant: OrdinaryPaGrantRecord): Promise<OrdinaryPaInsertGrantResult>;
  /** Resolves `undefined` for an unknown binding and throws for a stored row that disagrees with `binding`. */
  observe(binding: OrdinaryPaBinding): Promise<OrdinaryPaSnapshot | undefined>;
  /** Idempotent: a repeat returns the first `retiredAt`. Throws while any started request is not ended. */
  retire(binding: OrdinaryPaBinding, retiredAt: string): Promise<OrdinaryPaSnapshot>;
  /** Throws before retirement. The same disposition is idempotent and keeps the first `settlementId`; another one throws. */
  settle(binding: OrdinaryPaBinding, disposition: OrdinaryPaDisposition, settlementId: string): Promise<OrdinaryPaSnapshot>;
  /** Resolves the new request sequence: monotonic, one request in flight, at most 64, unique body digest. */
  beginRequest(binding: OrdinaryPaBinding, request: OrdinaryPaBrokerRequest): Promise<number>;
  /** Only the newest started request can end, and only once; anything else throws. */
  endRequest(binding: OrdinaryPaBinding, sequence: number, outcome: OrdinaryPaRequestOutcome): Promise<void>;
}
