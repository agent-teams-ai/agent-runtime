import type { ContainedTurnProviderBinding } from "../../../contracts/contained-agent-turn.js";
import type {
  HostCustodyLaunchPlan,
  HostCustodyLaunchPlanResolver,
} from "./custodied-provider-process.js";

export interface StaticHostCustodyLaunchPlan {
  readonly plan: HostCustodyLaunchPlan;
  readonly providerBinding: ContainedTurnProviderBinding;
}

const bindingKey = (binding: ContainedTurnProviderBinding): string => JSON.stringify([
  binding.provider,
  binding.adapterRevision,
  binding.binaryRevision,
  binding.capabilityManifestRevision,
  binding.credentialBindingDigest,
  binding.providerRouteRef,
]);

const authorityKey = (
  binding: ContainedTurnProviderBinding,
  intentMode: HostCustodyLaunchPlan["intentMode"],
): string => JSON.stringify([bindingKey(binding), intentMode]);

const snapshotPlan = (plan: HostCustodyLaunchPlan): HostCustodyLaunchPlan => Object.freeze({
  arguments: Object.freeze([...plan.arguments]),
  binaryRevision: plan.binaryRevision,
  containmentProfile: plan.containmentProfile,
  environment: Object.freeze({ ...plan.environment }),
  executablePath: plan.executablePath,
  executableSha256: plan.executableSha256,
  intentMode: plan.intentMode,
  privateRootPath: plan.privateRootPath,
  ...(plan.privatePathEnvironmentKeys === undefined ? {} : {
    privatePathEnvironmentKeys: Object.freeze([...plan.privatePathEnvironmentKeys]),
  }),
  provider: plan.provider,
  spawnMode: plan.spawnMode ?? "eager",
});

export const createStaticHostCustodyLaunchPlanResolver = (
  records: readonly StaticHostCustodyLaunchPlan[],
): HostCustodyLaunchPlanResolver => {
  const byBinding = new Map<string, HostCustodyLaunchPlan>();
  for (const record of records) {
    const key = authorityKey(record.providerBinding, record.plan.intentMode);
    if (byBinding.has(key)) {throw new Error("duplicate Host Custody launch authority");}
    if (record.plan.provider !== record.providerBinding.provider || record.plan.binaryRevision !== record.providerBinding.binaryRevision) {
      throw new Error("Host Custody launch plan conflicts with its provider binding");
    }
    byBinding.set(key, snapshotPlan(record.plan));
  }
  const resolver: HostCustodyLaunchPlanResolver = {
    async resolve(input) {
      return byBinding.get(authorityKey(input.providerBinding, input.intentMode));
    },
  };
  return Object.freeze(resolver);
};
