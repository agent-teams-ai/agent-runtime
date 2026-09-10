import { codexDarwinNativeMaterialIdentity } from "./codex-native-broker-files.js";
import { codexDarwinNativeLaunchObservation } from "./codex-app-server-permission-boundary.js";
import { inspectDarwinNativeLaunchObservation } from "../host-custody/contained-turn-kernel-custody-entrypoint.js";
import { createHash } from "node:crypto";
import { fstatSync, lstatSync, readSync, realpathSync, type BigIntStats } from "node:fs";
import {createCodexDockerPathProjection, codexProtocolHostBoundary,
  type CodexDockerPathProjection} from "./codex-docker-path-projection.js";
import { resolve } from "node:path";
import { types } from "node:util";
import type { CodexAppServerPermissionBoundary } from "./codex-app-server-permission-boundary.js";
import { assertIssuedCodexPermissionBoundary } from "./codex-native-broker-boundary.js";
import { DISABLED_CODEX_FEATURES, codexNativeConfigDefaults } from "./codex-app-server-config-defaults.js";

export const CODEX_LOCAL_BROKER_CAPABILITY_ENV = "AR_PRIVATE_BROKER_CAPABILITY";
export const CODEX_NATIVE_BROKER_DISABLED_FEATURES = Object.freeze([
  ...DISABLED_CODEX_FEATURES, "unbounded_connection_retries", "enable_request_compression",
]);
export const CODEX_NATIVE_CATALOG_SHA256 = "d7136a413cfac1b5b1686d9e0dcc5c80ca05bebed5e9fc3911376561d0ef6ee8";
export const CODEX_NATIVE_CATALOG_BYTES = 515145;

/** Native input selection only. Neither this object nor a private IP proves Host
 * listener ownership, PA/RS authority, a post-claim binding or route qualification.
 * The profile names the backend path, never native ChatGPT login or subscription
 * compatibility. No API-path variant is admitted by the two Linux captures.
 */
export interface CodexNativeBrokerRecipe {
  readonly kind: "codex-native-broker-config/v1";
  readonly profile: "codex-chatgpt";
  readonly endpoint: string;
  readonly catalogPath: string;
  readonly catalogSha256: typeof CODEX_NATIVE_CATALOG_SHA256;
}
const boundaries = new WeakMap<CodexNativeBrokerRecipe, CodexAppServerPermissionBoundary>();
const darwinStateDirectories = new WeakMap<CodexNativeBrokerRecipe, string>();
export const codexNativeBrokerDarwinStateDirectory = (recipe: CodexNativeBrokerRecipe): string | undefined => darwinStateDirectories.get(recipe);
const dockerPaths = new WeakMap<CodexNativeBrokerRecipe, CodexDockerPathProjection>();
export const codexNativeBrokerDockerPaths = (recipe: CodexNativeBrokerRecipe) => dockerPaths.get(recipe);
const rejected = (): TypeError => new TypeError("Codex native broker recipe rejected");

// Fixed private native recipe observations borrowed from DarwinCodexNativeFiles.
// The installer alone owns creation/descriptors/cleanup; this map is neither a
// credentials authority nor another lifecycle owner. No fields enter the public
// recipe. Linux has no entry and keeps its exact config and material preimage.
const darwinInstallations = new WeakMap<CodexNativeBrokerRecipe, Readonly<{fd: number; stats: BigIntStats; uuid: string}>>();
export const retainDarwinCodexInstallation = (recipe: CodexNativeBrokerRecipe, fd: number, stats: BigIntStats, uuid: string): void => {
  if (!darwinStateDirectories.has(recipe) || darwinInstallations.has(recipe) ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(uuid)) {throw rejected();}
  darwinInstallations.set(recipe, Object.freeze({fd, stats, uuid}));
  darwinCodexInstallationMaterial(recipe);
};
export const darwinCodexInstallationMaterial = (recipe: CodexNativeBrokerRecipe): readonly string[] | undefined => {
  if (!darwinStateDirectories.has(recipe)) {return undefined;}
  const native = codexDarwinNativeMaterialIdentity(recipe);
  if (native !== undefined) {return native;}
  if (codexDarwinNativeLaunchObservation(codexNativeBrokerBoundary(recipe)) !== undefined) {
    throw new TypeError("Native Codex fixed material has not been installed");
  }
  const owned = darwinInstallations.get(recipe);
  if (owned === undefined) {throw new TypeError("Darwin installation owner missing");}
  const path = `${codexNativeBrokerBoundary(recipe).codexHome}/installation_id`;
  const named = lstatSync(path, {bigint: true}); const held = fstatSync(owned.fd, {bigint: true});
  for (const current of [named, held]) {
    if (!current.isFile() || current.nlink !== 1n || current.dev !== owned.stats.dev || current.ino !== owned.stats.ino ||
        current.uid !== owned.stats.uid || current.mode !== 0o100644n || current.size !== 36n ||
        current.mtimeNs !== owned.stats.mtimeNs || current.ctimeNs !== owned.stats.ctimeNs) {throw new TypeError("Darwin installation changed");}
  }
  const bytes = Buffer.alloc(37); const count = readSync(owned.fd, bytes, 0, bytes.length, 0);
  if (count !== 36 || bytes.subarray(0, count).toString() !== owned.uuid || realpathSync(path) !== path) {
    throw new TypeError("Darwin installation bytes changed");
  }
  return Object.freeze([path, String(held.dev), String(held.ino), createHash("sha256").update(owned.uuid).digest("hex")]);
};


/** Descriptor-only reading, never serialization of inputs that may hold secrets. */
export const snapshotCodexDataRecord = (input: unknown): Record<string, unknown> => {
  if (typeof input !== "object" || input === null || types.isProxy(input)
    || Object.getPrototypeOf(input) !== Object.prototype) {throw rejected();}
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const actual = Reflect.ownKeys(descriptors);
  if (actual.some(key => typeof key !== "string")) {throw rejected();}
  return Object.fromEntries((actual as string[]).map(key => {
    const descriptor = descriptors[key];
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {throw rejected();}
    return [key, descriptor.value];
  }));
};

export const snapshotCodexNativeInput = (input: unknown, keys: readonly string[], optional: readonly string[] = []): Record<string, unknown> => {
  const data = snapshotCodexDataRecord(input);
  if (keys.some(key => !Object.hasOwn(data, key))
    || Object.keys(data).some(key => !keys.includes(key) && !optional.includes(key))) {throw rejected();}
  return data;
};

const endpoint = (input: unknown, darwinLoopback = false): string => {
  if (typeof input !== "string" || input.length > 128) {throw rejected();}
  // Parse the original spelling, without URL normalization accepting traversal,
  // numeric aliases, credentials, escapes, whitespace, query or fragments.
  const match = /^http:\/\/((?:\d{1,3}\.){3}\d{1,3}):([1-9]\d{0,4})\/backend-api\/codex$/u.exec(input);
  if (match === null || match[0] !== input) {throw rejected();}
  const octets = match[1]!.split(".").map(Number);
  if (octets.join(".") !== match[1] || octets.some(value => value > 255)
    || Number(match[2]) > 65535
    || !(darwinLoopback && match[1] === "127.0.0.1" || octets[0] === 10 || (octets[0] === 172 && octets[1]! >= 16 && octets[1]! <= 31)
      || (octets[0] === 192 && octets[1] === 168))) {throw rejected();}
  return input;
};

/** Pure: the Host supplies an already-created boundary; no filesystem allocation,
 * endpoint allocation, credential lookup or preparation occurs here.
 */
const createRecipe = (input: {
  readonly boundary: CodexAppServerPermissionBoundary;
  readonly endpoint: string;
  readonly profile: "codex-chatgpt";
  readonly dockerMounts?: Parameters<typeof createCodexDockerPathProjection>[0];
}, darwinLoopback = false): CodexNativeBrokerRecipe => {
  const data = snapshotCodexNativeInput(input, ["boundary", "endpoint", "profile"], ["dockerMounts"]);
  const boundary = data.boundary as CodexAppServerPermissionBoundary;
  assertIssuedCodexPermissionBoundary(boundary);
  if (codexDarwinNativeLaunchObservation(boundary) !== undefined && (!darwinLoopback || data.dockerMounts !== undefined)) {throw rejected();}
  if (data.profile !== "codex-chatgpt") {throw rejected();}
  const paths = data.dockerMounts === undefined ? undefined
    : createCodexDockerPathProjection(data.dockerMounts as Parameters<typeof createCodexDockerPathProjection>[0], boundary);
  const recipe: CodexNativeBrokerRecipe = Object.freeze({
    kind: "codex-native-broker-config/v1", profile: "codex-chatgpt",
    endpoint: endpoint(data.endpoint, darwinLoopback), catalogPath: `${(paths ?? boundary).codexHome}/models.json`,
    catalogSha256: CODEX_NATIVE_CATALOG_SHA256,
  });
  boundaries.set(recipe, boundary);
  if (paths !== undefined) {dockerPaths.set(recipe, paths);}
  return recipe;
};

export const createCodexNativeBrokerRecipe = (input: Parameters<typeof createRecipe>[0]): CodexNativeBrokerRecipe => createRecipe(input);

/** Private Darwin composition only; existing Docker recipe acceptance is unchanged. */
export const createDarwinCodexNativeBrokerRecipe = (input: Omit<Parameters<typeof createRecipe>[0], "dockerMounts"> & {readonly tmpDir: string}): CodexNativeBrokerRecipe => {
  if (!/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/backend-api\/codex$/u.test(input.endpoint) ||
      Object.hasOwn(input, "dockerMounts")) {throw rejected();}
  const data = snapshotCodexNativeInput(input, ["boundary", "endpoint", "profile", "tmpDir"]);
  const tmpDir = data.tmpDir;
  if (typeof tmpDir !== "string" || resolve(tmpDir) !== tmpDir || tmpDir === "/" ||
      [...tmpDir].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) {throw rejected();}
  const observation = codexDarwinNativeLaunchObservation(input.boundary);
  if (observation !== undefined && inspectDarwinNativeLaunchObservation(observation).tmpDir.path !== tmpDir) {throw rejected();}
  const recipe = createRecipe({boundary: input.boundary, endpoint: input.endpoint, profile: input.profile}, true);
  // Private Darwin recipe metadata only. The reservation validates this exact
  // name and retained directory identity; Linux recipe shape/bytes stay fixed.
  darwinStateDirectories.set(recipe, tmpDir);
  return recipe;
};

export const codexNativeBrokerBoundary = (recipe: CodexNativeBrokerRecipe): CodexAppServerPermissionBoundary => {
  const boundary = boundaries.get(recipe);
  if (boundary === undefined) {throw rejected();}
  return boundary;
};
export const assertCodexNativeBrokerBoundary = (
  recipe: CodexNativeBrokerRecipe, boundary: CodexAppServerPermissionBoundary,
): void => {
  if (codexNativeBrokerBoundary(recipe) !== codexProtocolHostBoundary(boundary)) {throw rejected();}
};

export const codexNativeBrokerUserOverrides = (recipe: CodexNativeBrokerRecipe) => {
  codexNativeBrokerBoundary(recipe);
  return {
    ...(darwinStateDirectories.has(recipe) ? {sqlite_home: darwinStateDirectories.get(recipe)!} : {}),
    model_provider: "ar_broker", model: "gpt-5.4", model_catalog_json: recipe.catalogPath,
    cli_auth_credentials_store: "file", allow_login_shell: false,
    shell_environment_policy: { exclude: [CODEX_LOCAL_BROKER_CAPABILITY_ENV] },
    model_providers: { ar_broker: {
      name: "OpenAI", base_url: recipe.endpoint, wire_api: "responses",
      requires_openai_auth: false, env_key: CODEX_LOCAL_BROKER_CAPABILITY_ENV,
      supports_websockets: false, supports_standalone_web_search: false,
      request_max_retries: 0, stream_max_retries: 0, http_headers: { version: "0.153.4" },
    } },
    analytics: { enabled: false },
    otel: { exporter: "none", trace_exporter: "none", metrics_exporter: "none" },
  };
};

export const CODEX_NATIVE_BROKER_USER_LEAVES = Object.freeze([
  "model_provider", "model", "model_catalog_json", "cli_auth_credentials_store", "allow_login_shell",
  "shell_environment_policy.exclude.0", "analytics.enabled", "otel.exporter", "otel.trace_exporter", "otel.metrics_exporter",
  ...["name", "base_url", "wire_api", "requires_openai_auth", "env_key", "supports_websockets",
    "supports_standalone_web_search", "request_max_retries", "stream_max_retries", "http_headers.version"]
    .map(key => `model_providers.ar_broker.${key}`),
]);

export const codexNativeBrokerEffectiveOverrides = (recipe: CodexNativeBrokerRecipe) => {
  const user = codexNativeBrokerUserOverrides(recipe);
  const defaults = codexNativeConfigDefaults();
  return {
    ...user,
    features: {
      ...defaults.features as Record<string, unknown>,
      unbounded_connection_retries: false, enable_request_compression: false,
    },
    shell_environment_policy: { ...defaults.shell_environment_policy as Record<string, unknown>, ...user.shell_environment_policy },
    otel: { ...user.otel, tool_result: { max_bytes: 2048 }, log_user_prompt: null, environment: null,
      span_attributes: null, tracestate: null },
    model_providers: { ar_broker: {
      ...user.model_providers.ar_broker, env_key_instructions: null, experimental_bearer_token: null,
      auth: null, aws: null, query_params: null, env_http_headers: null,
      stream_idle_timeout_ms: null, websocket_connect_timeout_ms: null,
    } },
  };
};

/** Exact native TOML, with no local capability value or upstream authentication. */
export const renderCodexNativeBrokerConfig = (recipe: CodexNativeBrokerRecipe): string => {
  const boundary = codexNativeBrokerBoundary(recipe);
  const quote = JSON.stringify;
  return `${darwinStateDirectories.has(recipe) ? `sqlite_home = ${quote(darwinStateDirectories.get(recipe))}\n` : ""}model_provider = "ar_broker"
model = "gpt-5.4"
model_catalog_json = ${quote(recipe.catalogPath)}
cli_auth_credentials_store = "file"
allow_login_shell = false
shell_environment_policy = { exclude = ["AR_PRIVATE_BROKER_CAPABILITY"] }
[model_providers.ar_broker]
name = "OpenAI"
base_url = ${quote(recipe.endpoint)}
wire_api = "responses"
requires_openai_auth = false
env_key = "AR_PRIVATE_BROKER_CAPABILITY"
supports_websockets = false
supports_standalone_web_search = false
request_max_retries = 0
stream_max_retries = 0
http_headers = { version = "0.153.4" }
[analytics]
enabled = false
[otel]
exporter = "none"
trace_exporter = "none"
metrics_exporter = "none"
[permissions.agent-runtime-contained-v1]
extends = ${quote(boundary.permissionProfile.extends)}
[permissions.agent-runtime-contained-v1.filesystem]
${quote((dockerPaths.get(recipe) ?? boundary).codexHome)} = "deny"
":tmpdir" = "read"
":slash_tmp" = "read"
[permissions.agent-runtime-contained-v1.network]
enabled = false
`;
};

export const codexNativeBrokerThreadConfig = (recipe: CodexNativeBrokerRecipe) => {
  codexNativeBrokerBoundary(recipe);
  return { features: Object.fromEntries(CODEX_NATIVE_BROKER_DISABLED_FEATURES.map(key => [key, false])) };
};
