import type { ProviderAccessBindingRepository } from "../../application/ports/outbound/provider-access-binding-repository.js";
import {
  providerAccessBindingKey,
  snapshotProviderAccessBinding,
  type ProviderAccessBindingRecord,
} from "../../domain/provider-access-binding.js";

export const createStaticProviderAccessBindingRepository = (
  records: readonly ProviderAccessBindingRecord[],
): ProviderAccessBindingRepository => {
  const byKey = new Map<string, ProviderAccessBindingRecord>();
  for (const source of records) {
    const record = snapshotProviderAccessBinding(source);
    const key = providerAccessBindingKey(record.tenantId, record.projectId, record.provider);
    if (byKey.has(key)) {throw new Error("duplicate Provider Access binding authority");}
    byKey.set(key, record);
  }
  const repository: ProviderAccessBindingRepository = {
    async find(input) {
      return byKey.get(providerAccessBindingKey(input.tenantId, input.projectId, input.provider));
    },
  };
  return Object.freeze(repository);
};
