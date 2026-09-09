/** This private bridge has no issuer of root admission. In particular it takes
 * no caller digest, FD, PID, UID credential, receipt ID or "trusted" boolean.
 * Encoding/decoding a command is data handling and confers no authority.
 * The future root-owned composition must capture exclusive endpoints and
 * retained launch/route, artifact/result, workspace and private-owner callbacks
 * before a positive transport can be added in a separately reviewed change.
 * Child birth/actual wait status/preexec-applied/stream seal must be native
 * authenticated events; helper death cannot be mapped to guardianExit.
 */
export const darwinAttemptOwnerAdmission = (): Readonly<{
  status: "unavailable";
  missing: readonly string[];
}> => Object.freeze({
  status: "unavailable",
  missing: Object.freeze([
    "exact-root-launcher-and-immutable-manifest-loader-ancestor-capture",
    "exclusive-root-reserved-numeric-uid-and-gid-with-permanent-tombstones",
    "isolated-root-created-channel-to-retained-host-owner-capabilities",
    "qualified-native-preexec-singlechild-identity-and-ipc-policy",
    "authenticated-distinct-owner-child-birth-and-child-exit-stream-events",
    "existing-workspace-receipt-owner-and-artifact-owner-integration",
  ]),
});
