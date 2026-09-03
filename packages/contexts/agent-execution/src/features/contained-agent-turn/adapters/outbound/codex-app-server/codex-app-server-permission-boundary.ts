import { createHash } from "node:crypto";
import { lstatSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

import {
  codexNotificationMethod,
  codexStringField,
  isCodexRecord,
  type CodexJsonRecord,
} from "./codex-app-server-jsonl.js";
import {
  CODEX_APP_SERVER_LINUX_X64_TUPLE,
  CODEX_PERMISSION_PROFILE_ID,
  validateCodexAppServerUserAgent,
  type CodexAppServerPlatformTuple,
} from "./codex-app-server-platform-tuple.js";

export {
  CODEX_APP_SERVER_ADAPTER_REVISION,
  CODEX_APP_SERVER_BINDINGS_SHA256,
  CODEX_APP_SERVER_SCHEMA_SHA256,
  CODEX_APP_SERVER_VERSION,
  CODEX_CAPABILITY_MANIFEST_REVISION,
  CODEX_PERMISSION_PROFILE_ID,
} from "./codex-app-server-platform-tuple.js";

/** Linux aliases retained for provider-local compatibility; new code consumes the selected tuple. */
export const CODEX_APP_SERVER_BINARY_REVISION = CODEX_APP_SERVER_LINUX_X64_TUPLE.binaryRevision;
export const CODEX_APP_SERVER_BINARY_SHA256 = CODEX_APP_SERVER_LINUX_X64_TUPLE.binarySha256;

export const codexContainedThreadConfig = (): CodexJsonRecord => ({
  features: {
    apps: false, browser_use: false, computer_use: false, image_generation: false,
    multi_agent: false, multi_agent_v2: false, plugins: false, remote_plugin: false,
  },
});

export type CodexContainedTurnMode = "analysis" | "workspace-write";

export const codexThreadSandbox = (mode: CodexContainedTurnMode): "read-only" | "workspace-write" =>
  mode === "analysis" ? "read-only" : "workspace-write";

export const codexTurnSandboxPolicy = (
  mode: CodexContainedTurnMode,
  workspaceRef: string,
): Readonly<CodexJsonRecord> => mode === "analysis"
  ? Object.freeze({ networkAccess: false, type: "readOnly" })
  : Object.freeze({
    excludeSlashTmp: true,
    excludeTmpdirEnvVar: true,
    networkAccess: false,
    type: "workspaceWrite",
    writableRoots: Object.freeze([workspaceRef]),
  });

export const codexEffectiveTurnPolicyDigest = (
  boundary: CodexAppServerPermissionBoundary,
  mode: CodexContainedTurnMode,
): string => `sha256:${createHash("sha256").update(canonicalCodexJson({
  basePolicyDigest: boundary.effectivePolicyDigest,
  mode,
  sandboxPolicy: codexTurnSandboxPolicy(mode, boundary.workspaceRef),
})).digest("hex")}`;

export interface CodexDirectoryIdentity {
  readonly device: number;
  readonly inode: number;
  readonly path: string;
}

const normalizedAbsoluteDirectory = (
  name: string,
  value: string,
  requirePrivateOwnership: boolean,
): { readonly identity: CodexDirectoryIdentity; readonly path: string } => {
  if (!isAbsolute(value) || resolve(value) !== value) {
    throw new TypeError(`${name} must be a normalized absolute path`);
  }
  if (value === "/") {throw new TypeError(`${name} must not be the filesystem root`);}
  const link = lstatSync(value);
  if (!link.isDirectory() || link.isSymbolicLink()) {throw new TypeError(`${name} must be a non-symlink directory`);}
  if (realpathSync(value) !== value) {throw new TypeError(`${name} must be canonical`);}
  const directory = statSync(value);
  if (!directory.isDirectory()) {throw new TypeError(`${name} must be a directory`);}
  if (!Number.isSafeInteger(directory.dev) || !Number.isSafeInteger(directory.ino)) {
    throw new TypeError(`${name} filesystem identity cannot be represented without ambiguity`);
  }
  if ((directory.mode & 0o022) !== 0) {throw new TypeError(`${name} must not be shared-group or world-writable`);}
  if (requirePrivateOwnership) {
    if (typeof process.getuid !== "function" || directory.uid !== process.getuid()) {
      throw new TypeError(`${name} must be owned by the current process user`);
    }
    if ((directory.mode & 0o077) !== 0) {throw new TypeError(`${name} must have mode 0700 or more restrictive`);}
  }
  return {
    identity: Object.freeze({ device: directory.dev, inode: directory.ino, path: value }),
    path: value,
  };
};

export const validateCodexDirectoryIdentity = (
  name: string,
  expected: CodexDirectoryIdentity,
  requirePrivateOwnership = true,
): void => {
  const current = normalizedAbsoluteDirectory(name, expected.path, requirePrivateOwnership).identity;
  if (current.device !== expected.device || current.inode !== expected.inode) {
    throw new TypeError(`${name} changed filesystem identity after validation`);
  }
};

const contains = (parent: string, candidate: string): boolean => {
  const path = relative(parent, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
};

export const canonicalCodexJson = (value: unknown): string => {
  if (value === undefined) {throw new TypeError("canonical JSON rejects undefined");}
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new TypeError("canonical JSON rejects non-finite numbers");
  }
  if (typeof value === "bigint" || typeof value === "function" || typeof value === "symbol") {
    throw new TypeError(`canonical JSON rejects ${typeof value}`);
  }
  if (Array.isArray(value)) {return `[${value.map(canonicalCodexJson).join(",")}]`;}
  if (value !== null && typeof value === "object") {
    if (Object.getPrototypeOf(value) !== Object.prototype) {
      throw new TypeError("canonical JSON rejects non-plain objects");
    }
    return `{${Object.entries(value as Record<string, unknown>)
      .toSorted(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalCodexJson(nested)}`)
      .join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) {throw new TypeError("canonical JSON rejects non-serializable values");}
  return encoded;
};

export interface CodexAppServerPermissionBoundary {
  readonly codexHome: string;
  readonly codexHomeIdentity: CodexDirectoryIdentity;
  readonly effectivePolicyDigest: string;
  readonly permissionProfile: Readonly<{
    readonly extends: ":workspace";
    readonly file_system: Readonly<{
      readonly entries: readonly Readonly<{ readonly access: "deny"; readonly path: string }>[];
    }>;
    readonly network: Readonly<{ readonly enabled: false }>;
  }>;
  readonly permissionProfileId: typeof CODEX_PERMISSION_PROFILE_ID;
  readonly workspaceRef: string;
  readonly workspaceIdentity: CodexDirectoryIdentity;
}

export const createCodexAppServerPermissionBoundary = (input: {
  readonly codexHome: string;
  readonly workspaceRef: string;
}): CodexAppServerPermissionBoundary => {
  const privateHome = normalizedAbsoluteDirectory("codexHome", input.codexHome, true);
  const workspace = normalizedAbsoluteDirectory("workspaceRef", input.workspaceRef, false);
  const codexHome = privateHome.path;
  const workspaceRef = workspace.path;
  if (contains(codexHome, workspaceRef) || contains(workspaceRef, codexHome)) {
    throw new TypeError("Codex private home and workspace must be disjoint");
  }
  const permissionProfile = Object.freeze({
    extends: ":workspace" as const,
    file_system: Object.freeze({
      entries: Object.freeze([Object.freeze({ access: "deny" as const, path: codexHome })]),
    }),
    network: Object.freeze({ enabled: false as const }),
  });
  const policyPreimage = Object.freeze({
    permissionProfile,
    permissionProfileId: CODEX_PERMISSION_PROFILE_ID,
    schema: "agent-runtime/codex-contained-permission-policy/v1",
    workspaceRef,
  });
  return Object.freeze({
    codexHome,
    codexHomeIdentity: privateHome.identity,
    effectivePolicyDigest: `sha256:${createHash("sha256").update(canonicalCodexJson(policyPreimage)).digest("hex")}`,
    permissionProfile,
    permissionProfileId: CODEX_PERMISSION_PROFILE_ID,
    workspaceRef,
    workspaceIdentity: workspace.identity,
  });
};

export const isExactCodexPermissionProfile = (
  actual: unknown,
  boundary: CodexAppServerPermissionBoundary,
): boolean => {
  return normalizeCodexProviderPermissionProfile(actual, boundary) !== undefined;
};

/**
 * Codex's config/read response is not the same shape as our internal policy.
 * Keep that wire translation in this adapter and
 * accept only the exact 0.150.1 response shape.  In particular, do not
 * silently accept new provider fields: a changed policy shape must fail
 * closed until it is qualified.
 */
const CODEX_PROVIDER_NETWORK_KEYS = [
  "allow_local_binding", "allow_upstream_proxy", "dangerously_allow_all_unix_sockets",
  "dangerously_allow_non_loopback_proxy", "domains", "enable_socks5", "enable_socks5_udp",
  "enabled", "mitm", "mode", "proxy_url", "socks_url", "unix_sockets",
] as const;

const normalizeCodexProviderPermissionProfile = (
  actual: unknown,
  boundary: CodexAppServerPermissionBoundary,
): CodexAppServerPermissionBoundary["permissionProfile"] | undefined => {
  if (!isCodexRecord(actual) || !hasExactKeys(actual, [
    "description", "extends", "filesystem", "network", "workspace_roots",
  ]) || actual.description !== null || actual.extends !== boundary.permissionProfile.extends
    || actual.workspace_roots !== null || !isCodexRecord(actual.filesystem)
    || !isCodexRecord(actual.network)) {return undefined;}

  const filesystem = actual.filesystem;
  if (!hasExactKeys(filesystem, [boundary.codexHome, "glob_scan_max_depth"])
    || filesystem[boundary.codexHome] !== "deny" || filesystem.glob_scan_max_depth !== null) {
    return undefined;
  }
  const network = actual.network;
  if (!hasExactKeys(network, CODEX_PROVIDER_NETWORK_KEYS)
    || network.enabled !== false
    || CODEX_PROVIDER_NETWORK_KEYS.some(key => key !== "enabled" && network[key] !== null)) {
    return undefined;
  }
  return boundary.permissionProfile;
};

/** User layers retain raw TOML fields; effective config materializes nullable defaults. */
const isExactCodexUserPermissionProfile = (
  actual: unknown,
  boundary: CodexAppServerPermissionBoundary,
): boolean => isCodexRecord(actual) && hasExactKeys(actual, ["extends", "filesystem", "network"])
  && actual.extends === boundary.permissionProfile.extends
  && isCodexRecord(actual.filesystem) && hasExactKeys(actual.filesystem, [boundary.codexHome])
  && actual.filesystem[boundary.codexHome] === "deny"
  && isCodexRecord(actual.network) && hasExactKeys(actual.network, ["enabled"])
  && actual.network.enabled === false;

const evidenceError = (message: string): Error => new Error(`Codex permission evidence rejected: ${message}`);

const hasExactKeys = (value: CodexJsonRecord, keys: readonly string[]): boolean =>
  Object.getPrototypeOf(value) === Object.prototype
  && Reflect.ownKeys(value).every(key => typeof key === "string")
  && Reflect.ownKeys(value).length === keys.length
  && Object.keys(value).toSorted().join("\0") === [...keys].toSorted().join("\0")
  && Object.values(Object.getOwnPropertyDescriptors(value)).every(descriptor =>
    descriptor.enumerable === true && "value" in descriptor);

export const validateCodexInitializeEvidence = (
  result: unknown,
  boundary: CodexAppServerPermissionBoundary,
  platformTuple: CodexAppServerPlatformTuple,
): void => {
  if (!isCodexRecord(result)
    || !hasExactKeys(result, ["codexHome", "platformFamily", "platformOs", "userAgent"])
    || result.codexHome !== boundary.codexHome
    || result.platformFamily !== platformTuple.platformFamily
    || result.platformOs !== platformTuple.platformOs) {
    throw evidenceError("initialization does not match the pinned candidate runtime tuple");
  }
  try {validateCodexAppServerUserAgent(result.userAgent, platformTuple);}
  catch {throw evidenceError("initialization does not match the pinned candidate runtime tuple");}
};

const layerType = (layer: CodexJsonRecord): string | undefined =>
  isCodexRecord(layer.name) ? codexStringField(layer.name, "type") : undefined;

const exactLayerName = (name: CodexJsonRecord, type: string): boolean => {
  if (type === "packagedDefaults" || type === "system") {
    return hasExactKeys(name, ["file", "type"]) && typeof name.file === "string";
  }
  if (type === "user") {
    return hasExactKeys(name, ["file", "profile", "type"])
      && typeof name.file === "string" && (name.profile === null || typeof name.profile === "string");
  }
  return type === "sessionFlags" && hasExactKeys(name, ["type"]);
};

const hasExactOrigin = (
  origins: CodexJsonRecord,
  keys: readonly string[],
  expectedType: string,
  expectedFile?: string,
): boolean => keys.some(key => {
  const metadata = origins[key];
  if (!isCodexRecord(metadata) || !hasExactKeys(metadata, ["name", "version"])
    || typeof metadata.version !== "string" || !isCodexRecord(metadata.name)
    || metadata.name.type !== expectedType || !exactLayerName(metadata.name, expectedType)) {return false;}
  return expectedFile === undefined || metadata.name.file === expectedFile;
});

const validateUserLayer = (
  layer: CodexJsonRecord,
  boundary: CodexAppServerPermissionBoundary,
  expectedConfigFile: string,
): void => {
  const name = layer.name as CodexJsonRecord;
  const layerProfiles = (layer.config as CodexJsonRecord).permissions;
  if (name.file !== expectedConfigFile || name.profile !== null || !isCodexRecord(layerProfiles)
    || !isExactCodexUserPermissionProfile(layerProfiles[boundary.permissionProfileId], boundary)) {
    throw evidenceError("user config layer substituted the permission policy");
  }
};

const isActiveConfigLayer = (
  value: unknown,
): value is CodexJsonRecord & { config: CodexJsonRecord; name: CodexJsonRecord; version: string } =>
  isCodexRecord(value) && hasExactKeys(value, ["config", "name", "version",
    ...(Object.hasOwn(value, "disabledReason") ? ["disabledReason"] : [])])
  && isCodexRecord(value.config) && isCodexRecord(value.name) && typeof value.version === "string"
  && (!Object.hasOwn(value, "disabledReason") || value.disabledReason === null);

const validateCodexConfigLayers = (
  layers: readonly unknown[],
  boundary: CodexAppServerPermissionBoundary,
): void => {
  const expectedConfigFile = `${boundary.codexHome}/config.toml`;
  let packagedLayerCount = 0;
  let emptySystemLayerCount = 0;
  let userLayerCount = 0;
  let sessionLayerCount = 0;
  for (const value of layers) {
    if (!isActiveConfigLayer(value)) {
      throw evidenceError("config layer is malformed");
    }
    const type = layerType(value);
    if (type === undefined || !exactLayerName(value.name, type)) {
      throw evidenceError("config layer name is malformed");
    }
    if (type === "user") {
      validateUserLayer(value, boundary, expectedConfigFile);
      userLayerCount += 1;
    } else if (type === "sessionFlags") {
      if (value.config.default_permissions !== boundary.permissionProfileId) {
        throw evidenceError("launch flag did not select the permission profile");
      }
      sessionLayerCount += 1;
    } else if (type === "packagedDefaults") {
      packagedLayerCount += 1;
    } else if (type === "system" && value.name.file === "/etc/codex/config.toml"
      && hasExactKeys(value.config, [])) {
      // 0.150.1 includes this empty layer even when the system file is absent.
      // Any system policy remains unqualified; never silently ignore its contents.
      emptySystemLayerCount += 1;
    } else {
      throw evidenceError("config contains an unqualified or unknown effective layer");
    }
  }
  if (packagedLayerCount > 1 || emptySystemLayerCount > 1
    || packagedLayerCount + emptySystemLayerCount === 0 || userLayerCount !== 1 || sessionLayerCount !== 1) {
    throw evidenceError("effective config layers are absent or non-unique");
  }
};

export const validateCodexConfigEvidence = (
  result: unknown,
  boundary: CodexAppServerPermissionBoundary,
): void => {
  if (!isCodexRecord(result) || !hasExactKeys(result, ["config", "layers", "origins"])
    || !isCodexRecord(result.config)
    || !isCodexRecord(result.origins) || !Array.isArray(result.layers)) {
    throw evidenceError("config/read evidence is incomplete");
  }
  const profiles = result.config.permissions;
  if (result.config.default_permissions !== boundary.permissionProfileId || !isCodexRecord(profiles)
    || !isExactCodexPermissionProfile(profiles[boundary.permissionProfileId], boundary)) {
    throw evidenceError("effective permission policy does not match the launch boundary");
  }
  validateCodexConfigLayers(result.layers, boundary);
  for (const metadata of Object.values(result.origins)) {
    if (!isCodexRecord(metadata) || !hasExactKeys(metadata, ["name", "version"])
      || typeof metadata.version !== "string" || !isCodexRecord(metadata.name)) {
      throw evidenceError("config origin metadata is malformed");
    }
    const type = codexStringField(metadata.name, "type");
    if (type === undefined || !exactLayerName(metadata.name, type)) {
      throw evidenceError("config origin layer name is malformed");
    }
  }
  const expectedConfigFile = `${boundary.codexHome}/config.toml`;
  const permissionOriginKeys = Object.keys(result.origins).filter(key =>
    key === "permissions" || key === `permissions.${boundary.permissionProfileId}`
      || key.startsWith(`permissions.${boundary.permissionProfileId}.`));
  if (!hasExactOrigin(result.origins, ["default_permissions"], "sessionFlags")
    || !hasExactOrigin(result.origins, permissionOriginKeys, "user", expectedConfigFile)) {
    throw evidenceError("config provenance is incomplete");
  }
};

export const validateCodexPermissionProfileEvidence = (
  result: unknown,
  boundary: CodexAppServerPermissionBoundary,
): void => {
  if (!isCodexRecord(result) || !hasExactKeys(result, ["data", "nextCursor"])
    || !Array.isArray(result.data) || result.nextCursor !== null
    || result.data.some(value => !isCodexRecord(value)
      || !hasExactKeys(value, ["allowed", "description", "id"])
      || typeof value.id !== "string" || typeof value.allowed !== "boolean"
      || (value.description !== null && typeof value.description !== "string"))) {
    throw evidenceError("permission profile list is incomplete");
  }
  const selected = result.data.filter(value => isCodexRecord(value) && value.id === boundary.permissionProfileId);
  const summary = selected[0];
  if (selected.length !== 1 || summary === undefined || summary.allowed !== true
    || !("description" in summary) || (summary.description !== null && typeof summary.description !== "string")
    || !hasExactKeys(summary, ["allowed", "description", "id"])) {
    throw evidenceError("permission profile is absent, duplicate, or disallowed");
  }
};

export const observeCodexActiveProfileEvidence = (
  message: CodexJsonRecord,
  threadId: string,
  boundary: CodexAppServerPermissionBoundary,
  mode: CodexContainedTurnMode,
): boolean => {
  const method = codexNotificationMethod(message);
  if (method !== "thread/settings/updated") {
    if (method === "thread/started" || method === "thread/status/changed") {return false;}
    throw evidenceError("unexpected pre-turn notification");
  }
  if (!isCodexRecord(message.params) || message.params.threadId !== threadId
    || !isCodexRecord(message.params.threadSettings)) {
    throw evidenceError("active permission provenance identity is invalid");
  }
  const settings = message.params.threadSettings;
  const active = settings.activePermissionProfile;
  if (settings.cwd !== boundary.workspaceRef || settings.approvalPolicy !== "never" || !isCodexRecord(active)
    || !hasExactKeys(active, ["extends", "id"])
    || active.id !== boundary.permissionProfileId || active.extends !== boundary.permissionProfile.extends
    || canonicalCodexJson(settings.sandboxPolicy) !== canonicalCodexJson(
      codexTurnSandboxPolicy(mode, boundary.workspaceRef),
    )) {
    throw evidenceError("active permission provenance does not match the qualified profile");
  }
  return true;
};
