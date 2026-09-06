import { DARWIN_COOPERATIVE_CUSTODY_LIMITATIONS } from "./custodied-provider-process.js";
import {
  canonicalJson, sha256, type ExecutableObservation, type LaunchCandidate, type WorkspaceObservation,
} from "./host-custody-launch.js";

const directoryIdentity = (path: string, observation: WorkspaceObservation) => [
  path, observation.dev.toString(), observation.ino.toString(), observation.uid.toString(),
  observation.mode.toString(), observation.ctimeNs.toString(),
];

/** Fingerprint evidence only; issuance, reservation and publication own authority.
 * This mirrors the existing platform selection in launchGuardedProvider. Darwin
 * retains observations but executes canonical names, never Linux descriptor paths.
 */
export const finalHostExecutionMaterialSha256 = (
  candidate: LaunchCandidate, executable: ExecutableObservation, materialSha256: string,
): string => {
  const {plan, privatePaths} = candidate;
  if (plan.containmentProfile === "cooperative-darwin-posix-process-group") {
    return sha256(canonicalJson([materialSha256, {
      platform: "darwin",
      profile: plan.containmentProfile,
      limitations: DARWIN_COOPERATIVE_CUSTODY_LIMITATIONS,
      execution: "canonical-paths",
      executable: [plan.executablePath, executable.dev.toString(), executable.ino.toString(),
        executable.digest, executable.mode.toString(), executable.nlink.toString(), executable.size.toString(),
        executable.mtimeNs.toString(), executable.ctimeNs.toString()],
      workspace: directoryIdentity(candidate.canonicalWorkspace, candidate.workspace),
      privateRoot: directoryIdentity(privatePaths.root.path, privatePaths.root),
      environment: privatePaths.environmentKeys.map(key => [key,
        directoryIdentity(privatePaths.byEnvironmentKey[key]!.path, privatePaths.byEnvironmentKey[key]!),
      ]),
    }]));
  }
  if (plan.containmentProfile !== "strict-linux-cgroup-v2") {
    throw new TypeError("Host launch execution material profile unavailable");
  }
  // Preserve the Linux descriptor projection and its exact digest preimage.
  const privateDescriptors = new Map<string, number>();
  const environmentProjection = privatePaths.environmentKeys.map(key => {
    const path = privatePaths.byEnvironmentKey[key]!.path;
    if (!privateDescriptors.has(path)) {privateDescriptors.set(path, 6 + privateDescriptors.size);}
    return [key, path, `/proc/self/fd/${privateDescriptors.get(path)}`];
  });
  return sha256(canonicalJson([materialSha256, "/proc/self/fd/4", "/proc/self/fd/5",
    `/proc/self/fd/${6 + privateDescriptors.size}`, environmentProjection]));
};
