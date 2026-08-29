import type { ProviderAccessProvider } from "../../../contracts/contained-turn-provider-access.js";
import type { ProviderAccessBindingRecord } from "../../../domain/provider-access-binding.js";

export interface ProviderAccessBindingRepository {
  find(input: {
    readonly projectId: string;
    readonly provider: ProviderAccessProvider;
    readonly tenantId: string;
  }): Promise<ProviderAccessBindingRecord | undefined>;
}
