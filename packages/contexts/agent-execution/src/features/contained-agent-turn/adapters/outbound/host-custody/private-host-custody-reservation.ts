import { constants } from "node:fs";
import { open } from "node:fs/promises";

import type {
  HostCustodyLaunchPlan,
  HostCustodyLaunchPlanResolver,
  HostCustodyReservationInput,
} from "./custodied-provider-process.js";
import type { LiveCustody } from "./node-provider-process-custody-state.js";

const snapshotPlan = (plan: HostCustodyLaunchPlan): HostCustodyLaunchPlan => Object.freeze({
  ...plan,
  arguments: Object.freeze([...plan.arguments]),
  environment: Object.freeze({ ...plan.environment }),
  ...(plan.privatePathEnvironmentKeys === undefined ? {} : {
    privatePathEnvironmentKeys: Object.freeze([...plan.privatePathEnvironmentKeys]),
  }),
});

export const bindPrivateHostCustodyReservation = async (
  input: HostCustodyReservationInput,
): Promise<Readonly<{ readonly launchPlans: HostCustodyLaunchPlanResolver; readonly plan: HostCustodyLaunchPlan }>> => {
  const authority = input.workspaceAuthority;
  if (authority.canonicalPath !== input.workspaceRef || authority.identity.mountId.length === 0) {
    throw new TypeError("Host Custody workspace authority path mismatch");
  }
  const descriptor = await open(authority.descriptorPath, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    const observed = await descriptor.stat({ bigint: true });
    if (!observed.isDirectory() || observed.dev !== authority.identity.dev || observed.ino !== authority.identity.ino) {
      throw new TypeError("Host Custody workspace descriptor identity mismatch");
    }
  } finally {
    await descriptor.close();
  }
  const plan = snapshotPlan(input.launchPlan);
  let consumed = false;
  const launchPlans: HostCustodyLaunchPlanResolver = Object.freeze({
    resolve: (candidate: Parameters<HostCustodyLaunchPlanResolver["resolve"]>[0]) => {
      if (consumed || candidate.workspaceRef !== input.workspaceRef || candidate.intentMode !== input.intentMode ||
          candidate.providerBinding.provider !== input.providerBinding.provider ||
          candidate.providerBinding.adapterRevision !== input.providerBinding.adapterRevision ||
          candidate.providerBinding.binaryRevision !== input.providerBinding.binaryRevision ||
          candidate.providerBinding.capabilityManifestRevision !== input.providerBinding.capabilityManifestRevision ||
          candidate.providerBinding.credentialBindingDigest !== input.providerBinding.credentialBindingDigest ||
          candidate.providerBinding.providerRouteRef !== input.providerBinding.providerRouteRef) {
        return Promise.reject(new TypeError("Host Custody private launch plan identity mismatch"));
      }
      consumed = true;
      return Promise.resolve(plan);
    },
  });
  return Object.freeze({ launchPlans, plan });
};

export const assertReservedWorkspaceAuthority = (live: LiveCustody): void => {
  const expected = live.workspaceAuthority;
  const observed = live.workspace;
  if (expected === undefined || observed === undefined || observed.dev !== expected.identity.dev ||
      observed.ino !== expected.identity.ino) {
    throw new TypeError("Host Custody reservation observed a replacement workspace");
  }
};
