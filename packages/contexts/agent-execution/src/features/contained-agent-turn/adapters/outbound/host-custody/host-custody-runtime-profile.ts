import { HostCustodyUnsupportedError, type HostCustodyContainmentProfile } from "./custodied-provider-process.js";
import type { OperationResidueAuthorityFactory } from "./host-custody-cgroup-v2.js";

export interface ProcessCustodyRuntimeProfile {
  readonly containmentProfile: HostCustodyContainmentProfile;
  readonly platform: string;
  readonly residueAuthorityFactory: OperationResidueAuthorityFactory;
}

export const assertRuntimeProfilePlatform = (profile: ProcessCustodyRuntimeProfile): void => {
  const expected = profile.containmentProfile === "strict-linux-cgroup-v2" ? "linux" : "darwin";
  if (profile.platform !== expected) {
    throw new HostCustodyUnsupportedError("platform-profile-unavailable");
  }
};
