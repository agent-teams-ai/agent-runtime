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
