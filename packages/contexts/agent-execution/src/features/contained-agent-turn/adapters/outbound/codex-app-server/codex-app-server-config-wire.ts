import {codexProtocolPaths} from "./codex-docker-path-projection.js";
import { createHash } from "node:crypto";
import { types as utilTypes } from "node:util";

import { codexDisabledFeatures, codexNativeConfigDefaults, DISABLED_CODEX_FEATURES } from "./codex-app-server-config-defaults.js";
import type { CodexAppServerPermissionBoundary } from "./codex-app-server-permission-boundary.js";

import {
  assertCodexNativeBrokerBoundary, codexNativeBrokerUserOverrides, codexNativeBrokerEffectiveOverrides,
  CODEX_NATIVE_BROKER_DISABLED_FEATURES, CODEX_NATIVE_BROKER_USER_LEAVES,
  type CodexNativeBrokerRecipe,
} from "./codex-native-broker-recipe.js";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type RecordValue = { [key: string]: Json };
const rejected = (reason: string): Error => new Error(`Codex permission evidence rejected: ${reason}`);

const dataProperty = (descriptors: Record<string, PropertyDescriptor>, key: string): unknown => {
  const descriptor = descriptors[key];
  if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
    throw rejected("config wire has a missing or non-data property");
  }
  return descriptor.value;
};

const snapshotArray = (
  descriptors: Record<string, PropertyDescriptor>,
  keyCount: number,
  child: (value: unknown) => Json,
): Json[] => {
  const length = descriptors.length?.value;
  if (!Number.isSafeInteger(length) || length < 0 || length > 256 || keyCount !== length + 1) {
    throw rejected("config wire has a sparse or extended array");
  }
  const result: Json[] = [];
  for (let index = 0; index < length; index += 1) {result.push(child(dataProperty(descriptors, String(index))));}
  return result;
};

/** Snapshot only inert, bounded JSON. Check proxies before reflection and data
 * descriptors before reading any value, including array entries and layer names.
 * Duplicate decoded JSON keys are rejected earlier by BoundedCodexJsonLineReader.
 */
const snapshotWire = (input: unknown): Json => {
  let remaining = 2048;
  const ancestors = new Set<object>();
  const visit = (value: unknown, depth: number): Json => {
    if (--remaining < 0 || depth > 16) {throw rejected("config wire exceeds structural bounds");}
    if (value === null || typeof value === "boolean" || typeof value === "string") {return value;}
    if (typeof value === "number" && Number.isFinite(value)) {return value;}
    if (typeof value !== "object" || utilTypes.isProxy(value) || ancestors.has(value)) {
      throw rejected("config wire must contain only inert JSON");
    }
    const array = Array.isArray(value);
    if (Object.getPrototypeOf(value) !== (array ? Array.prototype : Object.prototype)) {
      throw rejected("config wire has a non-plain container");
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.length > 256 || keys.some(key => typeof key !== "string" || key.length > 4096)) {
      throw rejected("config wire has malformed keys");
    }
    ancestors.add(value);
    try {
      if (array) {
        return snapshotArray(descriptors, keys.length, nested => visit(nested, depth + 1));
      }
      const result: RecordValue = {};
      for (const key of keys as string[]) {
        Object.defineProperty(result, key, {
          enumerable: true, value: visit(dataProperty(descriptors, key), depth + 1),
        });
      }
      return result;
    } finally {ancestors.delete(value);}
  };
  return visit(input, 0);
};

const record = (value: Json | undefined): value is RecordValue =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// Only called on our expected data or the fully guarded snapshot. Sort as Rust
// fingerprint.rs does, so version checks bind the exact raw layer contents.
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) {return `[${value.map(canonical).join(",")}]`;}
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value).toSorted(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
      .map(([key, nested]) => `${JSON.stringify(key)}:${canonical(nested)}`).join(",")}}`;
  }
  return JSON.stringify(value);
};
// Compare inert snapshots structurally; rejected wire values (including any
// echoed capability) are never serialized into comparisons or diagnostics.
const equal = (actual: unknown, expected: unknown): boolean => {
  if (actual === expected) {return true;}
  if (Array.isArray(actual) && Array.isArray(expected)) {
    return actual.length === expected.length && actual.every((value, index) => equal(value, expected[index]));
  }
  if (typeof actual !== "object" || actual === null || Array.isArray(actual)
    || typeof expected !== "object" || expected === null || Array.isArray(expected)) {return false;}
  const a = actual as Record<string, unknown>; const b = expected as Record<string, unknown>;
  return Object.keys(a).length === Object.keys(b).length
    && Object.keys(a).every(key => Object.hasOwn(b, key) && equal(a[key], b[key]));
};
const exact = (actual: unknown, expected: unknown, reason: string): void => {
  if (!equal(actual, expected)) {throw rejected(reason);}
};
const version = (config: unknown): string =>
  `sha256:${createHash("sha256").update(canonical(config)).digest("hex")}`;

const userProfile = (boundary: CodexAppServerPermissionBoundary) => ({
  extends: boundary.intentMode === "analysis" ? ":read-only" : ":workspace",
  filesystem: { [codexProtocolPaths(boundary).codexHome]: "deny", ":tmpdir": "read", ":slash_tmp": "read" },
  network: { enabled: false },
});

const effectiveProfile = (boundary: CodexAppServerPermissionBoundary) => ({
  description: null,
  extends: userProfile(boundary).extends,
  workspace_roots: null,
  filesystem: { ...userProfile(boundary).filesystem, glob_scan_max_depth: null },
  network: {
    enabled: false, proxy_url: null, enable_socks5: null, socks_url: null,
    enable_socks5_udp: null, allow_upstream_proxy: null,
    dangerously_allow_non_loopback_proxy: null, dangerously_allow_all_unix_sockets: null,
    mode: null, domains: null, unix_sockets: null, allow_local_binding: null, mitm: null,
  },
});

export const isExactCodexPermissionProfile = (
  actual: unknown,
  boundary: CodexAppServerPermissionBoundary,
): boolean => {
  try {return equal(snapshotWire(actual), effectiveProfile(boundary));}
  catch {return false;}
};

/** Current permission-only recipe, not a general Config schema. Every observed
 * default, feature, layer and leaf origin is validated before accepting evidence.
 * The optional private native recipe is a second exact mode, never an allowlist.
 * No reduced synthetic schema or project/managed policy is admitted.
 * Permission-only has a Linux analysis capture; its workspace-write and Darwin
 * coverage stays synthetic. Native broker has separate Linux captures for both
 * intents. Existing tuple selection/qualification stays upstream.
 */
export const validateCodexConfigEvidence = (
  input: unknown,
  boundary: CodexAppServerPermissionBoundary,
  nativeBrokerRecipe?: CodexNativeBrokerRecipe,
): void => {
  if (nativeBrokerRecipe !== undefined) {assertCodexNativeBrokerBoundary(nativeBrokerRecipe, boundary);}
  const result = snapshotWire(input);
  if (!record(result) || !record(result.config) || !record(result.origins) || !Array.isArray(result.layers)) {
    throw rejected("config/read evidence is incomplete");
  }
  const actualLayers = result.layers;
  const profileId = boundary.permissionProfileId;
  const disabledFeatures = nativeBrokerRecipe === undefined ? DISABLED_CODEX_FEATURES : CODEX_NATIVE_BROKER_DISABLED_FEATURES;
  const sessionConfig = { default_permissions: profileId, features: nativeBrokerRecipe === undefined
    ? codexDisabledFeatures() : Object.fromEntries(disabledFeatures.map(key => [key, false])) };
  const userConfig = {
    ...(nativeBrokerRecipe === undefined ? {} : codexNativeBrokerUserOverrides(nativeBrokerRecipe)),
    permissions: { [profileId]: userProfile(boundary) },
  };
  const session = { name: { type: "sessionFlags" }, version: version(sessionConfig) };
  const user = {
    name: { type: "user", file: `${codexProtocolPaths(boundary).codexHome}/config.toml`, profile: null },
    version: version(userConfig),
  };
  // Native all_layers_high_to_low order; exact cardinality also rejects duplicates.
  const expectedLayers = [
    { ...session, config: sessionConfig },
    { ...user, config: userConfig },
    { name: { type: "system", file: "/etc/codex/config.toml" }, version: version({}), config: {} },
  ];
  const layers = expectedLayers.map((expected, index) => {
    const actual = actualLayers[index];
    // Generated JSON Schema permits omission or null. Non-null is never active evidence.
    return record(actual) && Object.hasOwn(actual, "disabledReason")
      ? { ...expected, disabledReason: null } : expected;
  });
  exact(result.layers, layers, "config layers differ from the exact launch recipe or version");

  // Do not parse dotted paths: native filesystem path segments can themselves
  // contain dots. Exact opaque key membership excludes aliases and malformed leaves.
  const permissionPrefix = `permissions.${profileId}`;
  const userLeaves = [
    ...(nativeBrokerRecipe === undefined ? [] : CODEX_NATIVE_BROKER_USER_LEAVES),
    `${permissionPrefix}.extends`, `${permissionPrefix}.network.enabled`,
    ...[codexProtocolPaths(boundary).codexHome, ":tmpdir", ":slash_tmp"].map(path => `${permissionPrefix}.filesystem.${path}`),
  ];
  const sessionLeaves = ["default_permissions", ...disabledFeatures.map(feature =>
    feature === "multi_agent_v2" ? "features.multi_agent_v2.enabled" : `features.${feature}`)];
  const origins = Object.fromEntries([
    ...userLeaves.map(key => [key, user]), ...sessionLeaves.map(key => [key, session]),
  ]);
  exact(result.origins, origins, "config leaf origins do not match unique exact layer names and versions");
  exact(result.config, {
    ...codexNativeConfigDefaults(),
    ...(nativeBrokerRecipe === undefined ? {} : codexNativeBrokerEffectiveOverrides(nativeBrokerRecipe)),
    default_permissions: profileId,
    permissions: { [profileId]: effectiveProfile(boundary) },
  }, nativeBrokerRecipe === undefined ? "effective config differs from the exact native permission-only defaults"
    : "effective config differs from the exact native broker defaults");
  exact(Object.keys(result).toSorted(), ["config", "layers", "origins"], "config/read has unknown fields");
};
