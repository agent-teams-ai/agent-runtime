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
  observeExact(input: {
    readonly provider: ProviderAccessProviderValue;
    readonly scope: ProviderAccessScopeValue;
  }): Promise<ProviderAccessBindingObservation>;
}
