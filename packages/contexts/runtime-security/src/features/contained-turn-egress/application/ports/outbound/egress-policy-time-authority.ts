import type { EgressPolicyTimeSnapshotV1 } from "../../../domain/egress-policy.js";
import type { ProviderRouteAuthoritySnapshotV1 } from "../../../domain/provider-route-authority.js";

export interface EgressPolicyTimeAuthorityV1 {
  /** Synchronous joint owner check of exact route, policy/revocation and control time at emission.
   * Must reject unless both snapshots still hold in the same authority transaction. */
  consumeFirstWrite(expected: Readonly<{route: ProviderRouteAuthoritySnapshotV1;
    policy: EgressPolicyTimeSnapshotV1; issuedAt: number}>): unknown;
  resolve(): PromiseLike<EgressPolicyTimeSnapshotV1>;
  revalidateExact(expected: EgressPolicyTimeSnapshotV1): PromiseLike<Readonly<{status: "current"; observedAt: number}> |
    Readonly<{status: "rejected"}> | Readonly<{status: "indeterminate"}>>;
}
