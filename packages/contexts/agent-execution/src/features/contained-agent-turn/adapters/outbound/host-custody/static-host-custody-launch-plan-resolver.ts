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

const snapshotPlan = (plan: HostCustodyLaunchPlan): HostCustodyLaunchPlan => Object.freeze({
  arguments: Object.freeze([...plan.arguments]),
  binaryRevision: plan.binaryRevision,
  containmentProfile: plan.containmentProfile,
  environment: Object.freeze({ ...plan.environment }),
  executablePath: plan.executablePath,
  executableSha256: plan.executableSha256,
  provider: plan.provider,
});

export const createStaticHostCustodyLaunchPlanResolver = (
  records: readonly StaticHostCustodyLaunchPlan[],
): HostCustodyLaunchPlanResolver => {
  const byBinding = new Map<string, HostCustodyLaunchPlan>();
  for (const record of records) {
    const key = bindingKey(record.providerBinding);
    if (byBinding.has(key)) {throw new Error("duplicate Host Custody launch authority");}
    if (record.plan.provider !== record.providerBinding.provider || record.plan.binaryRevision !== record.providerBinding.binaryRevision) {
      throw new Error("Host Custody launch plan conflicts with its provider binding");
    }
    byBinding.set(key, snapshotPlan(record.plan));
  }
  const resolver: HostCustodyLaunchPlanResolver = {
    async resolve(input) {
      return byBinding.get(bindingKey(input.providerBinding));
    },
  };
  return Object.freeze(resolver);
};
