import type {
  ProviderAccessBindingObservation,
  ProviderAccessBindingRepository,
} from "./ports/outbound/provider-access-binding-repository.js";
import {
  exactProviderAccessDataRecord,
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
    if (observation === null || typeof observation !== "object" || Array.isArray(observation)) {
      return Object.freeze({ kind: "indeterminate" });
    }
    let kindDescriptor: PropertyDescriptor | undefined;
    try { kindDescriptor = Object.getOwnPropertyDescriptor(observation, "kind"); } catch { /* fail closed below */ }
    if (kindDescriptor === undefined || !("value" in kindDescriptor)) { return Object.freeze({ kind: "indeterminate" }); }
    if (kindDescriptor.value === "not_found" || kindDescriptor.value === "indeterminate") {
      const data = exactProviderAccessDataRecord("binding observation", observation, ["kind"]);
      return Object.freeze({ kind: data.kind as "indeterminate" | "not_found" });
    }
    if (kindDescriptor.value !== "found") { return Object.freeze({ kind: "indeterminate" }); }
    const data = exactProviderAccessDataRecord("binding observation", observation, ["kind", "record"]);
    return Object.freeze({
      kind: "found",
      record: snapshotProviderAccessBinding(data.record as never),
    });
  } catch {
    return Object.freeze({ kind: "indeterminate" });
  }
};
