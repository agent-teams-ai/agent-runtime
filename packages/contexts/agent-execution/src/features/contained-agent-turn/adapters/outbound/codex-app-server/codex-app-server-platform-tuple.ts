import type { HostCustodyContainmentProfile } from "../host-custody/custodied-provider-process.js";

export const CODEX_APP_SERVER_VERSION = "0.150.1";
export const CODEX_APP_SERVER_PACKAGE_REVISION = "@openai/codex@0.150.1";
export const CODEX_APP_SERVER_SCHEMA_SHA256 = "8e39bf38e4b09d02ac867b1fb81447c544f8915361d60ce4da25415886ba88d3";
export const CODEX_APP_SERVER_BINDINGS_SHA256 = "a690fb0c17d752f4a9e59be327dc661ab93e6aa0b59b79f93ed6edd70c258338";
// Native permission/configuration behavior is part of the adapter contract.
// Keep the provider package, binary, and schema revisions stable while
// changing the immutable adapter identity for this qualified behavior.
export const CODEX_APP_SERVER_ADAPTER_REVISION = "codex-app-server-contained-turn:0.150.1+native-permission-config-v2";
export const CODEX_PERMISSION_PROFILE_ID = "agent-runtime-contained-v1";
export const CODEX_CAPABILITY_MANIFEST_REVISION =
  `contained-turn:v1:codex-app-server:0.150.1:schema-${CODEX_APP_SERVER_SCHEMA_SHA256}:bindings-${CODEX_APP_SERVER_BINDINGS_SHA256}:agent-runtime-contained-v1:native-permission-config-v2`;

export type CodexAppServerPlatform = "darwin" | "linux";
export type CodexAppServerArchitecture = "arm64" | "x64";

/** The complete public selection input; the canonical tuple remains adapter-private. */
export interface CodexAppServerPlatformTarget {
  readonly architecture: CodexAppServerArchitecture;
  readonly platform: CodexAppServerPlatform;
}

export interface CodexAppServerPlatformTuple {
  readonly adapterRevision: typeof CODEX_APP_SERVER_ADAPTER_REVISION;
  readonly architecture: CodexAppServerArchitecture;
  readonly binaryRevision: string;
  readonly binarySha256: string;
  readonly clientName: "agent-runtime";
  readonly containmentProfile: HostCustodyContainmentProfile;
  readonly nativePackageRevision: string;
  readonly packageRevision: typeof CODEX_APP_SERVER_PACKAGE_REVISION;
  readonly platform: CodexAppServerPlatform;
  readonly platformFamily: "unix";
  readonly platformOs: "linux" | "macos";
  readonly protocolRevision: typeof CODEX_CAPABILITY_MANIFEST_REVISION;
  readonly userAgentArchitecture: "arm64" | "x86_64";
  readonly userAgentOsName: "Mac OS" | "Ubuntu";
  readonly version: typeof CODEX_APP_SERVER_VERSION;
}

const tuple = (value: CodexAppServerPlatformTuple): CodexAppServerPlatformTuple => Object.freeze(value);

export const CODEX_APP_SERVER_LINUX_X64_TUPLE = tuple({
  adapterRevision: CODEX_APP_SERVER_ADAPTER_REVISION,
  architecture: "x64",
  binaryRevision: "@openai/codex:0.150.1+linux-x64",
  binarySha256: "abf1bb1643a79f73aa78ee627e111e02d4f8c98f25813a0cf6ce277709664386",
  clientName: "agent-runtime",
  containmentProfile: "strict-linux-cgroup-v2",
  nativePackageRevision: "@openai/codex-linux-x64@0.150.1",
  packageRevision: CODEX_APP_SERVER_PACKAGE_REVISION,
  platform: "linux",
  platformFamily: "unix",
  platformOs: "linux",
  protocolRevision: CODEX_CAPABILITY_MANIFEST_REVISION,
  userAgentArchitecture: "x86_64",
  userAgentOsName: "Ubuntu",
  version: CODEX_APP_SERVER_VERSION,
});

export const CODEX_APP_SERVER_DARWIN_ARM64_TUPLE = tuple({
  adapterRevision: CODEX_APP_SERVER_ADAPTER_REVISION,
  architecture: "arm64",
  binaryRevision: "@openai/codex:0.150.1+darwin-arm64",
  binarySha256: "a14f9a907c12c8812878b70e6b7d65f81c39ed795513e46a55817d7428c0ca6b",
  clientName: "agent-runtime",
  containmentProfile: "cooperative-darwin-posix-process-group",
  nativePackageRevision: "@openai/codex-darwin-arm64@0.150.1",
  packageRevision: CODEX_APP_SERVER_PACKAGE_REVISION,
  platform: "darwin",
  platformFamily: "unix",
  platformOs: "macos",
  protocolRevision: CODEX_CAPABILITY_MANIFEST_REVISION,
  userAgentArchitecture: "arm64",
  userAgentOsName: "Mac OS",
  version: CODEX_APP_SERVER_VERSION,
});

const TUPLES = Object.freeze([CODEX_APP_SERVER_LINUX_X64_TUPLE, CODEX_APP_SERVER_DARWIN_ARM64_TUPLE] as const);

export class CodexAppServerPlatformTupleUnsupportedError extends Error {
  public constructor() {super("No exact Codex App Server platform tuple is supported"); this.name = "CodexAppServerPlatformTupleUnsupportedError";}
}

const selectTuple = (platform: unknown, architecture: unknown): CodexAppServerPlatformTuple => {
  const selected = TUPLES.find(candidate => candidate.platform === platform && candidate.architecture === architecture);
  if (selected === undefined) {throw new CodexAppServerPlatformTupleUnsupportedError();}
  return selected;
};

export const selectCodexAppServerPlatformTuple = (input: CodexAppServerPlatformTarget): CodexAppServerPlatformTuple => {
  if (typeof input !== "object" || input === null || Object.getPrototypeOf(input) !== Object.prototype) {
    throw new CodexAppServerPlatformTupleUnsupportedError();
  }
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.length !== 2 || !Object.hasOwn(descriptors, "architecture") || !Object.hasOwn(descriptors, "platform")) {
    throw new CodexAppServerPlatformTupleUnsupportedError();
  }
  const architecture = descriptors.architecture; const platform = descriptors.platform;
  if (architecture === undefined || platform === undefined || !("value" in architecture) || !("value" in platform)
    || architecture.enumerable !== true || platform.enumerable !== true) {
    throw new CodexAppServerPlatformTupleUnsupportedError();
  }
  return selectTuple(platform.value, architecture.value);
};

export const codexAppServerTupleForBinaryRevision = (binaryRevision: string): CodexAppServerPlatformTuple => {
  const selected = TUPLES.find(candidate => candidate.binaryRevision === binaryRevision);
  if (selected === undefined) {throw new CodexAppServerPlatformTupleUnsupportedError();}
  return selected;
};

export const assertExactCodexAppServerPlatformTuple = (candidate: CodexAppServerPlatformTuple): CodexAppServerPlatformTuple => {
  if (typeof candidate !== "object" || candidate === null || Object.getPrototypeOf(candidate) !== Object.prototype) {
    throw new TypeError("Codex App Server platform tuple must be a plain record");
  }
  const descriptors = Object.getOwnPropertyDescriptors(candidate);
  const selected = selectTuple(descriptors.platform?.value, descriptors.architecture?.value);
  if (Reflect.ownKeys(descriptors).length !== Reflect.ownKeys(selected).length) {throw new TypeError("Codex App Server platform tuple has unknown fields");}
  for (const key of Object.keys(selected) as (keyof CodexAppServerPlatformTuple)[]) {
    const descriptor = descriptors[key];
    if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true
      || descriptor.value !== selected[key]) {throw new TypeError("Codex App Server platform tuple does not match its supported profile");}
  }
  return selected;
};

const USER_AGENT = /^agent-runtime\/([0-9]+\.[0-9]+\.[0-9]+) \(([^();\r\n]{1,96}); ([A-Za-z0-9_]{1,16})\) ([A-Za-z0-9._+-]{1,64}) \(agent-runtime; ([a-z0-9][a-z0-9:._+-]{0,127})\)$/u;
const OS_VERSION = /^[0-9]+(?:\.[0-9]+){1,3}$/u;

export const validateCodexAppServerUserAgent = (value: unknown, expected: CodexAppServerPlatformTuple): void => {
  if (typeof value !== "string" || value.length === 0 || value.length > 512
    || [...value].some(character => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && (codePoint <= 31 || codePoint === 127);
    })) {throw new TypeError("Codex App Server user agent is malformed");}
  const match = USER_AGENT.exec(value); const os = match?.[2]; const osPrefix = `${expected.userAgentOsName} `;
  if (match === null || match[1] !== expected.version || match[3] !== expected.userAgentArchitecture
    || match[5] !== expected.adapterRevision || os === undefined || !os.startsWith(osPrefix)
    || !OS_VERSION.test(os.slice(osPrefix.length))) {throw new TypeError("Codex App Server user agent does not match the selected tuple");}
};
