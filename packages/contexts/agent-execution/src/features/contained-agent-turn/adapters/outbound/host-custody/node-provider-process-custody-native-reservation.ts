import type { ProviderProcessCustodyPort, HostCustodyReservationInput } from "./custodied-provider-process.js";
import type { LiveCustody } from "./node-provider-process-custody-state.js";
import { inputIdentity, sha256 } from "./host-custody-launch.js";
import { privateReservationIdentity } from "./node-provider-process-custody-replay.js";
import { inspectNativeHostCustodyExecutionLease, inspectNativeHostCustodyReservationAuthority, isNativeHostCustodyWorkspaceAuthority } from "./native-host-custody-workspace-authority.js";
import { inspectDarwinNativeExecutionLease as inspectDarwinNativeLeaseFacts } from "./darwin-attempt-owner-selection.js";

export const assertDarwinNativeHostGenerationBinding = (
  leaseHostGenerationBinding: string,
  hostLifecycleGenerationSha256: string,
): void => {
  if (leaseHostGenerationBinding !== hostLifecycleGenerationSha256) {
    throw new TypeError("Native execution lease belongs to another Host generation");
  }
};
export function inspectNodeCustodyReservation(input: Parameters<ProviderProcessCustodyPort["open"]>[0] | HostCustodyReservationInput, hostGeneration: string): {
  nativeAuthority: Parameters<typeof inspectNativeHostCustodyExecutionLease>[0] | undefined;
  native: ReturnType<typeof inspectNativeHostCustodyReservationAuthority> | undefined;
  nativeLease: ReturnType<typeof inspectNativeHostCustodyExecutionLease> | undefined;
  identitySha256: string;
} {
  const baseIdentitySha256 = inputIdentity(input);
  const workspaceAuthority = "workspaceAuthority" in input ? input.workspaceAuthority : undefined;
  const nativeAuthority = workspaceAuthority !== undefined && isNativeHostCustodyWorkspaceAuthority(workspaceAuthority)
    ? workspaceAuthority : undefined;
  const native = nativeAuthority === undefined ? undefined : inspectNativeHostCustodyReservationAuthority(nativeAuthority, input);
  const nativeLease = nativeAuthority === undefined ? undefined : inspectNativeHostCustodyExecutionLease(nativeAuthority);
  if (nativeLease !== undefined) {
    assertDarwinNativeHostGenerationBinding(
      inspectDarwinNativeLeaseFacts(nativeLease).hostGenerationBinding,
      hostGeneration,
    );
  }
  const identitySha256 = native !== undefined
    ? sha256(`${baseIdentitySha256}:${nativeAuthority!.canonicalPath}:${nativeAuthority!.identity.dev}:${nativeAuthority!.identity.ino}`)
    : "workspaceAuthority" in input
    ? privateReservationIdentity(input)
    : baseIdentitySha256;
  return {nativeAuthority, native, nativeLease, identitySha256};
}

export function assertNativeBoundReservation(reserved: LiveCustody): void {
  const facts = reserved.nativeWorkspaceFacts;
  if (facts === undefined || reserved.workspace?.dev !== facts.workspace.dev || reserved.workspace.ino !== facts.workspace.ino ||
      reserved.workspaceRef !== facts.workspace.path || reserved.privatePaths?.root.dev !== facts.privateRoot.dev ||
      reserved.privatePaths.root.ino !== facts.privateRoot.ino || reserved.plan?.environment.TMPDIR !== facts.tmpDir.path ||
      reserved.plan.environment.CODEX_HOME !== facts.codexHome.path || reserved.plan.environment.HOME !== facts.privateRoot.path ||
      reserved.plan.environment.PATH !== "/usr/bin:/bin") {
    throw new TypeError("Native launch plan differs from prepared roots");
  }
  assertNativeEnvironmentRoots(reserved, facts);
}

function assertNativeEnvironmentRoots(reserved: LiveCustody, facts: NonNullable<LiveCustody["nativeWorkspaceFacts"]>): void {
  if (reserved.privatePaths!.byEnvironmentKey.HOME?.dev !== facts.privateRoot.dev ||
      reserved.privatePaths!.byEnvironmentKey.HOME?.ino !== facts.privateRoot.ino ||
      reserved.privatePaths!.byEnvironmentKey.CODEX_HOME?.dev !== facts.codexHome.dev ||
      reserved.privatePaths!.byEnvironmentKey.CODEX_HOME?.ino !== facts.codexHome.ino ||
      reserved.privatePaths!.byEnvironmentKey.TMPDIR?.dev !== facts.tmpDir.dev ||
      reserved.privatePaths!.byEnvironmentKey.TMPDIR?.ino !== facts.tmpDir.ino) {
    throw new TypeError("Native launch plan differs from prepared roots");
  }
}
