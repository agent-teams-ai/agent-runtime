import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";

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

export interface RetainedHostCustodyWorkspaceAuthority {
  readonly descriptor: number;
  readonly descriptorPath: string;
  readonly identity: HostCustodyReservationInput["workspaceAuthority"]["identity"];
  close(): void;
}

export type HostCustodyMountIdentityObserver = (descriptor: number) => string;

export const observeHostCustodyMountIdentity: HostCustodyMountIdentityObserver = descriptor => {
  const fdinfo = openSync(`/proc/self/fdinfo/${descriptor}`, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const buffer = Buffer.allocUnsafe(4_097);
    const bytesRead = readSync(fdinfo, buffer, 0, buffer.length, 0);
    if (bytesRead > 4_096) {throw new TypeError("Host Custody workspace mount identity is unavailable");}
    const matches = [...buffer.subarray(0, bytesRead).toString("utf8").matchAll(/^mnt_id:\s*(\d+)$/gmu)];
    if (matches.length !== 1 || matches[0]?.[1] === undefined) {
      throw new TypeError("Host Custody workspace mount identity is unavailable");
    }
    return matches[0][1];
  } finally {closeSync(fdinfo);}
};

export const closeRetainedWorkspaceAuthority = (live: LiveCustody): void => {
  live.retainedWorkspaceAuthority?.close();
};

export const assertRetainedWorkspaceAuthority = (live: LiveCustody): void => {
  const retained = live.retainedWorkspaceAuthority;
  const expected = live.workspaceAuthority;
  if (retained === undefined || expected === undefined) {
    throw new TypeError("Host Custody retained workspace authority is unavailable");
  }
  const observed = fstatSync(retained.descriptor, { bigint: true });
  if (!observed.isDirectory() || observed.dev !== expected.identity.dev || observed.ino !== expected.identity.ino ||
      live.mountIdentityObserver(retained.descriptor) !== expected.identity.mountId) {
    throw new TypeError("Host Custody retained workspace identity mismatch");
  }
};

export const bindPrivateHostCustodyReservation = async (
  input: HostCustodyReservationInput,
  mountIdentityObserver: HostCustodyMountIdentityObserver = observeHostCustodyMountIdentity,
): Promise<Readonly<{
  readonly launchPlans: HostCustodyLaunchPlanResolver;
  readonly plan: HostCustodyLaunchPlan;
  readonly retainedWorkspaceAuthority: RetainedHostCustodyWorkspaceAuthority;
}>> => {
  const authority = input.workspaceAuthority;
  if (authority.canonicalPath !== input.workspaceRef || authority.identity.mountId.length === 0) {
    throw new TypeError("Host Custody workspace authority path mismatch");
  }
  const descriptor = openSync(authority.descriptorPath, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    const observed = fstatSync(descriptor, { bigint: true });
    if (!observed.isDirectory() || observed.dev !== authority.identity.dev || observed.ino !== authority.identity.ino ||
        mountIdentityObserver(descriptor) !== authority.identity.mountId) {
      throw new TypeError("Host Custody workspace descriptor identity mismatch");
    }
  } catch (error) {closeSync(descriptor); throw error;}
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
  let closed = false;
  const retainedWorkspaceAuthority: RetainedHostCustodyWorkspaceAuthority = Object.freeze({
    close() {if (!closed) {closed = true; closeSync(descriptor);}},
    descriptor,
    descriptorPath: `/proc/self/fd/${descriptor}`,
    identity: authority.identity,
  });
  return Object.freeze({ launchPlans, plan, retainedWorkspaceAuthority });
};

export const assertReservedWorkspaceAuthority = (live: LiveCustody): void => {
  const expected = live.workspaceAuthority;
  const observed = live.workspace;
  if (expected === undefined || observed === undefined || observed.dev !== expected.identity.dev ||
      observed.ino !== expected.identity.ino) {
    throw new TypeError("Host Custody reservation observed a replacement workspace");
  }
  assertRetainedWorkspaceAuthority(live);
};
