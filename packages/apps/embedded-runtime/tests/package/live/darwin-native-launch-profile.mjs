import { createHash } from "node:crypto";

const sha256 = bytes => createHash("sha256").update(Buffer.from(bytes, "utf8")).digest("hex");

// AE_IMAGE_* role indices from
// packages/contexts/agent-execution/.../host-custody/native/darwin-attempt-owner-protocol.h:
//   0 HELPER (= the native-owner binary itself, self-re-exec'd with --preexec
//     after dropping to the unprivileged uid/gid), 1 SANDBOX (/usr/bin/sandbox-exec),
//   2 PROVIDER (codex), 3 HOST, 4 PROFILE (this file), 5 HOST_ENTRYPOINT, 6 HOST_PEER_ADDON.
// darwin-attempt-owner-child.c's spawn_child() launches:
//   sandbox-exec -f <this profile> -D WORKSPACE=<op workspace> -D PRIVATE=<envelope>/private
//     -D BROKER_PORT=<port> <native-owner path> --preexec
// ae_native_preexec() then execve()s straight into the codex path from the root
// -supplied manifest, inheriting this same sandbox confinement (seatbelt
// confinement persists across execve). So this one static, build-time-pinned
// profile must cover both the brief self-reexec/handshake step AND the whole
// codex app-server process's runtime filesystem/network footprint.
//
// The bootstrap allow-list below (sysctl-read, vnguard/mac-syscall 67, /dev/null,
// path metadata, dyld-shared-cache framework paths) is copied verbatim from the
// already-reviewed per-operation profile in ./darwin-seatbelt-launch-projection.ts
// (createDarwinSeatbeltProjection) -- it is the same minimum every sandboxed
// Darwin launch in this codebase needs just to start a dynamically-linked
// executable at all, confirmed empirically here (see below) by first
// reproducing the exact "deny default" SIGABRT this repo's other profile
// generator already works around.
//
// Empirical validation performed (disposable, no real credentials/network):
// `sandbox-exec -f <profile> -D WORKSPACE=... -D PRIVATE=... -D BROKER_PORT=...
//   <codex> --version` printed "codex-cli 0.153.4" under confinement;
// `<native-owner> ` (bare) and `<native-owner> --preexec` (both without the real
//   owner-supplied FDs) exec'd successfully under confinement and then failed
//   closed exactly as their own source dictates outside a real launch (exit 78
//   / 126, no side effects -- read darwin-attempt-owner-main.c/-child.c before
//   trusting this claim again after any native source change);
// executing an unpinned binary (/bin/cat, /usr/bin/touch) under the same
//   profile was refused with "Operation not permitted" (exit 71), confirming
//   deny-default actually holds and this isn't accidentally permissive.
//
// Known limitation, not resolved here: SBPL's (param "KEY") cannot be
// concatenated into a `(remote tcp "host:port")` literal (tested: `(remote tcp
// "localhost:$(BROKER_PORT)")` fails to parse -- "invalid port in network
// address"), so network-outbound is scoped to `localhost:*` (any loopback TCP
// port, matching the operational broker's own localhost-only binding) rather
// than the exact single broker port. This is a real, deliberate precision gap
// versus the per-operation dynamic profile's exact-port binding; loopback-only
// is still a hard boundary against any non-local network egress.
const BOOTSTRAP = [
  "(allow sysctl-read)",
  '(allow file-read-data (literal "/"))',
  '(allow system-mac-syscall (mac-policy-name "vnguard"))',
  '(allow system-mac-syscall (require-all (mac-policy-name "Sandbox") (mac-syscall-number 67)))',
  '(allow file-read* file-write-data (literal "/dev/null"))',
  '(allow file-read-metadata file-test-existence (literal "/") (literal "/etc") (literal "/tmp") (literal "/var") (literal "/private/etc/localtime"))',
  '(allow file-read-metadata file-test-existence (path-ancestors "/System/Volumes/Data/private"))',
  ...[
    "/Library/Apple/System/Library/Frameworks", "/Library/Apple/System/Library/PrivateFrameworks",
    "/Library/Apple/usr/lib", "/System/Library/Extensions", "/System/Library/Frameworks",
    "/System/Library/PrivateFrameworks", "/System/Library/SubFrameworks",
    "/System/iOSSupport/System/Library/Frameworks", "/System/iOSSupport/System/Library/PrivateFrameworks",
    "/System/iOSSupport/System/Library/SubFrameworks", "/usr/lib",
  ].map(path => `(allow file-map-executable (subpath "${path}"))`),
];

const literal = path => {
  if (typeof path !== "string" || path.length === 0 || path.length > 1024 || !path.startsWith("/") ||
      [...path].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127 || char === '"' || char === "\\")) {
    throw new TypeError("Darwin native launch profile path rejected");
  }
  return `"${path}"`;
};

/** Static, build-time-pinned seatbelt profile for the root-native launch chain
 * (native-owner self-reexec --preexec, then codex). Per-operation workspace/
 * private/broker-port values are bound later via `sandbox-exec -D` parameters,
 * never baked into this file, so the file itself is deterministic and
 * reviewable independent of any operation. */
export const createDarwinNativeLaunchProfile = (input) => {
  const nativeOwnerPath = input?.nativeOwnerPath, codexPath = input?.codexPath;
  literal(nativeOwnerPath); literal(codexPath);
  const profile = ["(version 1)", "(deny default)",
    ...BOOTSTRAP,
    `(allow process-exec (literal ${literal(nativeOwnerPath)}))`,
    `(allow file-map-executable (literal ${literal(nativeOwnerPath)}))`,
    `(allow file-read* (literal ${literal(nativeOwnerPath)}))`,
    `(allow process-exec (literal ${literal(codexPath)}))`,
    `(allow file-map-executable (literal ${literal(codexPath)}))`,
    `(allow file-read* (literal ${literal(codexPath)}))`,
    '(allow file-read* (subpath (param "WORKSPACE")))',
    '(allow file-read* file-write* (subpath (param "PRIVATE")))',
    '(allow file-read-metadata file-test-existence (path-ancestors (param "WORKSPACE")))',
    '(allow file-read-metadata file-test-existence (path-ancestors (param "PRIVATE")))',
    '(allow network-outbound (require-all (remote tcp "localhost:*") (socket-domain AF_INET)))',
    "(deny process-fork)", "(deny network-inbound)",
  ].join("\n");
  return Object.freeze({ profile, profileSha256: sha256(profile) });
};
