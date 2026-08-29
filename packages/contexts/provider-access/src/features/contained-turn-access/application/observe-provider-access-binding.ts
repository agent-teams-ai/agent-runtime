import type {
  ProviderAccessBindingObservation,
  ProviderAccessBindingRepository,
} from "./ports/outbound/provider-access-binding-repository.js";
import {
  snapshotProviderAccessBinding,
  type ProviderAccessProviderValue,
  type ProviderAccessScopeValue,
} from "../domain/provider-access-binding.js";

/** Converts an untrusted repository result into a fresh, bounded domain observation. */
export const observeCanonicalProviderAccessBinding = async (
  repository: ProviderAccessBindingRepository,
  input: { readonly provider: ProviderAccessProviderValue; readonly scope: ProviderAccessScopeValue },
): Promise<ProviderAccessBindingObservation> => {
  try {
    const observation = await repository.observeExact(input);
    if (observation === null || typeof observation !== "object") {
      return Object.freeze({ kind: "indeterminate" });
    }
    if (observation.kind === "not_found" || observation.kind === "indeterminate") {
      return Object.freeze({ kind: observation.kind });
    }
    if (observation.kind !== "found" || !("record" in observation)) {
      return Object.freeze({ kind: "indeterminate" });
    }
    return Object.freeze({
      kind: "found",
      record: snapshotProviderAccessBinding(observation.record),
    });
  } catch {
    return Object.freeze({ kind: "indeterminate" });
  }
};
