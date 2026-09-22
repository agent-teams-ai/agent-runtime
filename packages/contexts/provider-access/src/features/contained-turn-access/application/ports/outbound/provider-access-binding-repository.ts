import type {
  ProviderAccessBindingRecord,
  ProviderAccessProviderValue,
  ProviderAccessScopeValue,
} from "../../../domain/provider-access-binding.js";

export type ProviderAccessBindingObservation =
  | { readonly kind: "found"; readonly record: ProviderAccessBindingRecord }
  | { readonly kind: "indeterminate" }
  | { readonly kind: "not_found" };

export interface ProviderAccessBindingRepository {
  /** Returns only a detached, frozen Provider Access-owned canonical projection. */
  observeExact(input: {
    readonly provider: ProviderAccessProviderValue;
    readonly scope: ProviderAccessScopeValue;
  }): Promise<ProviderAccessBindingObservation>;
}

/** Exact current owner facts admitted at the trusted composition boundary. */
export interface ContainedTurnProviderAccessBindingSnapshot {
  readonly accessRef: string;
  readonly availability: "available" | "unavailable";
  readonly credentialBindingDigest: string;
  readonly credentialBindingRef: string;
  readonly credentialGeneration: number;
  readonly projectId: string;
  readonly provider: "claude" | "codex";
  readonly providerAccountRef: string;
  readonly providerRouteRef: string;
  readonly revision: number;
  readonly revocation: "active" | "revoked";
  readonly tenantId: string;
}

export type ContainedTurnProviderAccessBindingObservation =
  | { readonly kind: "found"; readonly record: ContainedTurnProviderAccessBindingSnapshot }
  | { readonly kind: "indeterminate" }
  | { readonly kind: "not_found" };

export interface ContainedTurnProviderAccessRepository {
  observeExact(input: { readonly provider: "claude" | "codex";
    readonly scope: { readonly projectId: string; readonly tenantId: string } }):
    Promise<ContainedTurnProviderAccessBindingObservation>;
}
