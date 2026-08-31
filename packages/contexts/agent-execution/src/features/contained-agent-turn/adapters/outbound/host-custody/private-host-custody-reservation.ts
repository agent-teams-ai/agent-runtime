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
  assertLaunchDescriptor(descriptor: number): void;
  close(): void;
}

const observeHostCustodyMountIdentity = (descriptor: number): string => {
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

type MountObservationPhase = "launch" | "reservation";
interface PrivateReservationTestHooks {
  readonly descriptorLifecycle?: (event: "closed" | "opened") => void;
  readonly mountIdentity?: (observation: Readonly<{
    readonly actualMountId: string;
    readonly phase: MountObservationPhase;
  }>) => string;
}
const testHooks = new WeakMap<object, PrivateReservationTestHooks>();

/** Test-only seam: callbacks receive observations, never descriptor or path authority. */
export const privateHostCustodyReservationTestSupport = Object.freeze({
  install(owner: object, hooks: PrivateReservationTestHooks): void {
    testHooks.set(owner, Object.freeze({ ...hooks }));
  },
});

const mountIdentity = (
  owner: object,
  phase: MountObservationPhase,
  descriptor: number,
): string => {
  const actualMountId = observeHostCustodyMountIdentity(descriptor);
  return testHooks.get(owner)?.mountIdentity?.(Object.freeze({ actualMountId, phase })) ?? actualMountId;
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
  if (!observed.isDirectory() || observed.dev !== expected.identity.dev || observed.ino !== expected.identity.ino) {
    throw new TypeError("Host Custody retained workspace identity mismatch");
  }
};

export const bindPrivateHostCustodyReservation = async (
  input: HostCustodyReservationInput,
  owner: object,
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
  testHooks.get(owner)?.descriptorLifecycle?.("opened");
  let descriptorOwned = true;
  const closeDescriptor = (): void => {
    if (!descriptorOwned) {return;}
    descriptorOwned = false;
    closeSync(descriptor);
    testHooks.get(owner)?.descriptorLifecycle?.("closed");
  };
  try {
    const observed = fstatSync(descriptor, { bigint: true });
    if (!observed.isDirectory() || observed.dev !== authority.identity.dev || observed.ino !== authority.identity.ino ||
        mountIdentity(owner, "reservation", descriptor) !== authority.identity.mountId) {
      throw new TypeError("Host Custody workspace descriptor identity mismatch");
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
    const retainedWorkspaceAuthority: RetainedHostCustodyWorkspaceAuthority = Object.freeze({
      assertLaunchDescriptor(launchDescriptor: number) {
        const launchObservation = fstatSync(launchDescriptor, { bigint: true });
        if (!launchObservation.isDirectory() || launchObservation.dev !== authority.identity.dev ||
            launchObservation.ino !== authority.identity.ino ||
            mountIdentity(owner, "launch", launchDescriptor) !== authority.identity.mountId) {
          throw new TypeError("Host Custody launch workspace identity mismatch");
        }
      },
      close: closeDescriptor,
      descriptor,
      descriptorPath: `/proc/self/fd/${descriptor}`,
      identity: authority.identity,
    });
    return Object.freeze({ launchPlans, plan, retainedWorkspaceAuthority });
  } catch (error) {closeDescriptor(); throw error;}
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
