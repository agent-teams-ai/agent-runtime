import { constants, openSync, closeSync, fstatSync, lstatSync, realpathSync, readFileSync, type BigIntStats } from "node:fs";
import { dirname, resolve } from "node:path";
import { darwinDigest } from "./darwin-route-durable-storage.js";

export interface DarwinExecutablePin { readonly path: string; readonly sha256: string; readonly dev: string; readonly ino: string; readonly uid: string }
const assertTrustedAncestors = (path: string): void => {
  for (let parent = dirname(path);;) {
    const s = lstatSync(parent);
    if (!s.isDirectory() || s.isSymbolicLink() || (s.mode & 0o022) !== 0 ||
        (s.uid !== 0 && s.uid !== process.getuid!())) {throw new TypeError("Darwin trusted artifact ancestor conflicts");}
    if (dirname(parent) === parent) {break;} parent = dirname(parent);
  }
};
const overlap = (a: string, b: string) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
const untrustedExecutable = (before: BigIntStats, named: BigIntStats): boolean =>
  !before.isFile() || before.nlink !== 1n || before.dev !== named.dev || before.ino !== named.ino || before.uid !== named.uid ||
        (before.uid !== 0n && before.uid !== BigInt(process.getuid!())) ||
        (before.mode & 0o022n) !== 0n || (before.mode & 0o111n) === 0n || before.size > 268_435_456n;
export const pinDarwinExecutable = (path: string, expectedSha256: string): DarwinExecutablePin => {
  if (process.platform !== "darwin" || !/^[a-f0-9]{64}$/u.test(expectedSha256) ||
      resolve(path) !== path || realpathSync(path) !== path) {throw new TypeError("Darwin native artifact pin unavailable");}
  assertTrustedAncestors(path);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd, {bigint: true}); const named = lstatSync(path, {bigint: true});
    if (untrustedExecutable(before, named)) {throw new TypeError("Darwin trusted executable conflicts");}
    const digest = darwinDigest(readFileSync(fd)); const after = fstatSync(fd, {bigint: true});
    if (digest !== expectedSha256 || before.uid !== after.uid || before.mode !== after.mode || before.size !== after.size || before.ctimeNs !== after.ctimeNs ||
        before.mtimeNs !== after.mtimeNs || realpathSync(path) !== path) {throw new TypeError("Darwin executable digest conflicts");}
    return Object.freeze({path, sha256: digest, dev: String(before.dev), ino: String(before.ino), uid: String(before.uid)});
  } finally {closeSync(fd);}
};
export const recheckDarwinExecutable = (pin: DarwinExecutablePin): void => {
  const current = pinDarwinExecutable(pin.path, pin.sha256);
  if (current.dev !== pin.dev || current.ino !== pin.ino || current.uid !== pin.uid) {throw new TypeError("Darwin executable identity changed");}
};
const literal = (path: string): string => {
  if (path.length > 1024 || resolve(path) !== path || realpathSync(path) !== path || [...path].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127 || char === '"' || char === "\\")) {
    throw new TypeError("Darwin profile path rejected");
  }
  return `"${path}"`;
};
// Fixed profile selector validation within existing Host composition, not a new
// state owner. The native file installer retains the actual descriptor/UUID.
const assertInstallationSelector = (path: string | undefined, readPaths: readonly string[],
  writePaths: readonly string[], protectedPaths: readonly string[]): void => {
  if (path !== undefined) {
    const stats = lstatSync(path, {bigint: true});
    if (!path.endsWith("/installation_id") || !readPaths.includes(dirname(path)) ||
        !stats.isFile() || stats.nlink !== 1n || stats.mode !== 0o100644n || stats.uid !== BigInt(process.getuid!()) ||
        protectedPaths.some(other => overlap(path, other)) || writePaths.some(other => overlap(dirname(path), other))) {
      throw new TypeError("Darwin installation write exception conflicts");
    }
  }
};
const issuedProjections = new WeakSet<object>();
export const isIssuedDarwinSeatbeltProjection = (value: object): boolean => issuedProjections.has(value);

export interface DarwinSeatbeltProjection {
  readonly writePaths: readonly string[];
  readonly profile: string; readonly profileSha256: string; readonly digest: string;
  readonly endpoint: Readonly<{address: "127.0.0.1"; family: "IPv4"; port: number}>;
  readonly launcher: DarwinExecutablePin; readonly observer: DarwinExecutablePin; readonly provider: DarwinExecutablePin;
}
export const createDarwinSeatbeltProjection = (input: Readonly<{
  launcher: DarwinExecutablePin; observer: DarwinExecutablePin; provider: DarwinExecutablePin;
  endpoint: DarwinSeatbeltProjection["endpoint"]; operationBinding: object;
  readPaths: readonly string[]; writePaths: readonly string[]; protectedRoot: string;
  installationPath?: string;
}>): DarwinSeatbeltProjection => {
  const endpoint = Object.freeze({...input.endpoint});
  if (endpoint.address !== "127.0.0.1" || endpoint.family !== "IPv4" || !Number.isSafeInteger(endpoint.port) ||
      endpoint.port < 1 || endpoint.port > 65535 || input.launcher.path !== "/usr/bin/sandbox-exec" ||
      input.readPaths.length > 32 || input.readPaths.includes("/") || input.writePaths.length > 8) {throw new TypeError("Darwin route projection rejected");}
  const protectedPaths = [input.protectedRoot, input.launcher.path, input.observer.path, input.provider.path];
  for (const path of input.writePaths) {
    if (protectedPaths.some(protectedPath => overlap(path, protectedPath)) || path === "/" || path === "/tmp") {
      throw new TypeError("Darwin profile writable authority conflicts");
    }
  }
  assertInstallationSelector(input.installationPath, input.readPaths, input.writePaths, protectedPaths);
  // Operation-specific subset of ROOT-INERT-BASELINE's demonstrated bootstrap
  // operations. Diagnostic blanket filesystem and exec grants are not retained.
  const mappedSystemPaths = ["/Library/Apple/System/Library/Frameworks", "/Library/Apple/System/Library/PrivateFrameworks",
    "/Library/Apple/usr/lib", "/System/Library/Extensions", "/System/Library/Frameworks",
    "/System/Library/PrivateFrameworks", "/System/Library/SubFrameworks",
    "/System/iOSSupport/System/Library/Frameworks", "/System/iOSSupport/System/Library/PrivateFrameworks",
    "/System/iOSSupport/System/Library/SubFrameworks", "/usr/lib"];
  // Fixed protected system selectors may be absent on a particular OS; unlike
  // captured operation names they do not require filesystem canonicalization.
  const bootstrap = ["(allow sysctl-read)",
    '(allow file-read-data (literal "/"))',
    '(allow system-mac-syscall (mac-policy-name "vnguard"))',
    '(allow system-mac-syscall (require-all (mac-policy-name "Sandbox") (mac-syscall-number 67)))',
    '(allow file-read* file-write-data (literal "/dev/null"))',
    '(allow file-read-metadata file-test-existence (literal "/") (literal "/etc") (literal "/tmp") (literal "/var") (literal "/private/etc/localtime"))',
    '(allow file-read-metadata file-test-existence (path-ancestors "/System/Volumes/Data/private"))',
    ...mappedSystemPaths.map(path => `(allow file-map-executable (subpath "${path}"))`),
    `(allow file-map-executable (literal ${literal(input.provider.path)}))`,
    ...[...new Set([...input.readPaths, ...input.writePaths, input.provider.path])]
      .map(path => `(allow file-read-metadata file-test-existence (path-ancestors ${literal(path)}))`),
  ];
  // Inline -p avoids a separately mutable profile file and its cleanup debt.
  const profile = ["(version 1)", "(deny default)",
    `(allow process-exec (literal ${literal(input.provider.path)}))`,
    ...bootstrap,
    ...(input.installationPath === undefined ? [] : [`(allow file-write-data (literal ${literal(input.installationPath)}))`]),
    ...input.readPaths.map(path => `(allow file-read* (subpath ${literal(path)}))`),
    ...input.writePaths.map(path => `(allow file-read* file-write* (subpath ${literal(path)}))`),
    `(allow file-read* (literal ${literal(input.provider.path)}))`,
    `(allow network-outbound (require-all (remote tcp "localhost:${endpoint.port}") (socket-domain AF_INET)))`,
    "(deny process-fork)", "(deny network-inbound)",
    `(deny file-read* file-write* (subpath ${literal(input.protectedRoot)}))`,
  ].join("\n");
  const profileSha256 = darwinDigest(profile);
  const digest = darwinDigest(JSON.stringify(["darwin-seatbelt-launch/v1", input.operationBinding,
    endpoint, input.launcher, input.observer, input.provider, profileSha256,
    {profileArgument: "-p", providerDescriptors: [0, 1, 2], controlDescriptor: "absent", environment: "finalized-plan"}]));
  const projection = Object.freeze({profile, profileSha256, digest, endpoint, writePaths: Object.freeze([...input.writePaths]),
    launcher: Object.freeze({...input.launcher}), observer: Object.freeze({...input.observer}), provider: Object.freeze({...input.provider})});
  issuedProjections.add(projection); return projection;
};
