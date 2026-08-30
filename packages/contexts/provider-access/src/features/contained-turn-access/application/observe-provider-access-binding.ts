import type {
  ProviderAccessBindingObservation,
  ProviderAccessBindingRepository,
} from "./ports/outbound/provider-access-binding-repository.js";
import type { ProviderAccessProviderValue, ProviderAccessScopeValue } from "../domain/provider-access-binding.js";

/** Observes the canonical projection guaranteed by the outbound port boundary. */
export const observeCanonicalProviderAccessBinding = async (
  repository: ProviderAccessBindingRepository,
  input: { readonly provider: ProviderAccessProviderValue; readonly scope: ProviderAccessScopeValue },
): Promise<ProviderAccessBindingObservation> => {
  try {
    return await repository.observeExact(input);
  } catch {
    return Object.freeze({ kind: "indeterminate" });
  }
};
