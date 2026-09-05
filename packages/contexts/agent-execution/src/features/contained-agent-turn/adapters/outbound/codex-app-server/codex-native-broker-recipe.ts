import { types } from "node:util";
import type { CodexAppServerPermissionBoundary } from "./codex-app-server-permission-boundary.js";
import { assertIssuedCodexPermissionBoundary } from "./codex-native-broker-boundary.js";
import { DISABLED_CODEX_FEATURES, codexNativeConfigDefaults } from "./codex-app-server-config-defaults.js";

export const CODEX_LOCAL_BROKER_CAPABILITY_ENV = "AR_PRIVATE_BROKER_CAPABILITY";
export const CODEX_NATIVE_BROKER_DISABLED_FEATURES = Object.freeze([
  ...DISABLED_CODEX_FEATURES, "unbounded_connection_retries", "enable_request_compression",
]);
export const CODEX_NATIVE_CATALOG_SHA256 = "eb0d7b9a5dcaf103895c5f8a14c16b269df46e039b375a55ba97f6238542d2ed";
export const CODEX_NATIVE_CATALOG_BYTES = 424117;

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
const rejected = (): TypeError => new TypeError("Codex native broker recipe rejected");

/** Descriptor-only reading, never serialization of inputs that may hold secrets. */
export const snapshotCodexNativeInput = (input: unknown, keys: readonly string[], optional: readonly string[] = []): Record<string, unknown> => {
  if (typeof input !== "object" || input === null || types.isProxy(input)
    || Object.getPrototypeOf(input) !== Object.prototype) {throw rejected();}
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const actual = Reflect.ownKeys(descriptors);
  if (keys.some(key => !Object.hasOwn(descriptors, key))
    || actual.some(key => typeof key !== "string" || (!keys.includes(key) && !optional.includes(key)))) {
    throw rejected();
  }
  return Object.fromEntries((actual as string[]).map(key => {
    const descriptor = descriptors[key];
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {throw rejected();}
    return [key, descriptor.value];
  }));
};

const endpoint = (input: unknown): string => {
  if (typeof input !== "string" || input.length > 128) {throw rejected();}
  // Parse the original spelling, without URL normalization accepting traversal,
  // numeric aliases, credentials, escapes, whitespace, query or fragments.
  const match = /^http:\/\/((?:\d{1,3}\.){3}\d{1,3}):([1-9]\d{0,4})\/backend-api\/codex$/u.exec(input);
  if (match === null || match[0] !== input) {throw rejected();}
  const octets = match[1]!.split(".").map(Number);
  if (octets.join(".") !== match[1] || octets.some(value => value > 255)
    || Number(match[2]) > 65535
    || !(octets[0] === 10 || (octets[0] === 172 && octets[1]! >= 16 && octets[1]! <= 31)
      || (octets[0] === 192 && octets[1] === 168))) {throw rejected();}
  return input;
};

/** Pure: the Host supplies an already-created boundary; no filesystem allocation,
 * endpoint allocation, credential lookup or preparation occurs here.
 */
export const createCodexNativeBrokerRecipe = (input: {
  readonly boundary: CodexAppServerPermissionBoundary;
  readonly endpoint: string;
  readonly profile: "codex-chatgpt";
}): CodexNativeBrokerRecipe => {
  const data = snapshotCodexNativeInput(input, ["boundary", "endpoint", "profile"]);
  const boundary = data.boundary as CodexAppServerPermissionBoundary;
  assertIssuedCodexPermissionBoundary(boundary);
  if (data.profile !== "codex-chatgpt") {throw rejected();}
  const recipe: CodexNativeBrokerRecipe = Object.freeze({
    kind: "codex-native-broker-config/v1", profile: "codex-chatgpt",
    endpoint: endpoint(data.endpoint), catalogPath: `${boundary.codexHome}/models.json`,
    catalogSha256: CODEX_NATIVE_CATALOG_SHA256,
  });
  boundaries.set(recipe, boundary);
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
  if (codexNativeBrokerBoundary(recipe) !== boundary) {throw rejected();}
};

export const codexNativeBrokerUserOverrides = (recipe: CodexNativeBrokerRecipe) => {
  codexNativeBrokerBoundary(recipe);
  return {
    model_provider: "ar_broker", model: "gpt-5.4", model_catalog_json: recipe.catalogPath,
    cli_auth_credentials_store: "file", allow_login_shell: false,
    shell_environment_policy: { exclude: [CODEX_LOCAL_BROKER_CAPABILITY_ENV] },
    model_providers: { ar_broker: {
      name: "OpenAI", base_url: recipe.endpoint, wire_api: "responses",
      requires_openai_auth: false, env_key: CODEX_LOCAL_BROKER_CAPABILITY_ENV,
      supports_websockets: false, supports_standalone_web_search: false,
      request_max_retries: 0, stream_max_retries: 0, http_headers: { version: "0.150.1" },
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
  return `model_provider = "ar_broker"
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
http_headers = { version = "0.150.1" }
[analytics]
enabled = false
[otel]
exporter = "none"
trace_exporter = "none"
metrics_exporter = "none"
[permissions.agent-runtime-contained-v1]
extends = ${quote(boundary.permissionProfile.extends)}
[permissions.agent-runtime-contained-v1.filesystem]
${quote(boundary.codexHome)} = "deny"
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
