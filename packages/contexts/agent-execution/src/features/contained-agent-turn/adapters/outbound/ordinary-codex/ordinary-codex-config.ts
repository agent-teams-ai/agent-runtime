import {constants} from "node:fs";
import {lstat, open, realpath, writeFile, mkdir} from "node:fs/promises";
import {createHash} from "node:crypto";
import {join} from "node:path";
import type {OrdinaryProcessPort} from "../../../application/ordinary-ports.js";
import type {OrdinaryLaunchSpecification} from "../ordinary-process/node-ordinary-process.js";
import {isCodexRecord as isRecord} from "../codex-app-server/codex-app-server-jsonl.js";

export const ORDINARY_CODEX_MODEL = "gpt-5.3-codex-spark";
export const ORDINARY_CODEX_PROVIDER = "ordinary_broker";
export const ORDINARY_CODEX_PERMISSION = "ordinary-workspace";
export const ORDINARY_CODEX_CAPABILITY_ENV = "AR_ORDINARY_BROKER_CAPABILITY";
export const ORDINARY_CODEX_BINARY_SHA256 = "b973d440acac501fd2594a43e7ca9ce41e0a65b9dfb28d0d7a7837c99e1261e3";
export const ORDINARY_CODEX_DISABLED = Object.freeze([
  "apps", "hooks", "plugins", "remote_plugin", "multi_agent", "multi_agent_v2", "browser_use", "computer_use",
  "image_generation", "unbounded_connection_retries", "enable_request_compression", "remote_control", "memories",
]);
export function ordinaryCodexRefusal(): never {throw new Error("ORDINARY_CODEX_EVIDENCE_REJECTED");}

export const ordinaryJson = (value: unknown): string => {
  if (Array.isArray(value)) {return `[${value.map(ordinaryJson).join(",")}]`;}
  if (isRecord(value)) {return `{${Object.keys(value).toSorted().map(key => `${JSON.stringify(key)}:${ordinaryJson(value[key])}`).join(",")}}`;}
  return JSON.stringify(value);
};
const equal = (a: unknown, b: unknown): boolean => ordinaryJson(a) === ordinaryJson(b);

export function ordinaryCodexUserConfig(home: string, endpoint: string): Readonly<Record<string, unknown>> {
  const url = new URL(endpoint);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.username || url.password ||
      url.pathname !== "/v1" || url.search || url.hash) {ordinaryCodexRefusal();}
  return {
    model: ORDINARY_CODEX_MODEL, model_provider: ORDINARY_CODEX_PROVIDER, cli_auth_credentials_store: "file",
    default_permissions: ORDINARY_CODEX_PERMISSION, allow_login_shell: false, project_doc_max_bytes: 0,
    web_search: "disabled", shell_environment_policy: {inherit: "none", exclude: [ORDINARY_CODEX_CAPABILITY_ENV]},
    model_providers: {[ORDINARY_CODEX_PROVIDER]: {
      name: "Agent Runtime operation broker", base_url: endpoint, wire_api: "responses", requires_openai_auth: false,
      env_key: ORDINARY_CODEX_CAPABILITY_ENV, supports_websockets: false, supports_standalone_web_search: false,
      request_max_retries: 0, stream_max_retries: 0, http_headers: {version: "0.153.4"},
    }},
    analytics: {enabled: false}, otel: {exporter: "none", trace_exporter: "none", metrics_exporter: "none"},
    history: {persistence: "none"},
    permissions: {[ORDINARY_CODEX_PERMISSION]: {extends: ":workspace", filesystem: {[home]: "deny", ":tmpdir": "read", ":slash_tmp": "read"}, network: {enabled: false}}},
  };
}

// Closed, feature-local TOML writer. Only the fixed recipe above is rendered.
function toml(record: Readonly<Record<string, unknown>>, prefix: readonly string[] = []): string {
  const scalars = Object.entries(record).filter(([, value]) => !isRecord(value));
  const tables = Object.entries(record).filter(([, value]) => isRecord(value));
  return (prefix.length ? `[${prefix.map(part => JSON.stringify(part)).join(".")}]\n` : "") +
    scalars.map(([key, value]) => `${JSON.stringify(key)} = ${JSON.stringify(value)}\n`).join("") +
    tables.map(([key, value]) => toml(value as Readonly<Record<string, unknown>>, [...prefix, key])).join("");
}

/** Pin verification is read-only and precedes dispatch. Source auth is never part of this process. */
export async function verifyOrdinaryCodexExecutable(executable: string): Promise<void> {
  const uid = process.getuid?.();
  if (!uid || process.platform !== "darwin" || process.arch !== "arm64" || await realpath(executable) !== executable) {ordinaryCodexRefusal();}
  const handle = await open(executable, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.uid !== uid || (before.mode & 0o022) || !(before.mode & 0o111)) {ordinaryCodexRefusal();}
    const hash = createHash("sha256");
    for await (const bytes of handle.createReadStream({autoClose: false})) {hash.update(bytes);}
    const after = await handle.stat(); const path = await lstat(executable);
    if (hash.digest("hex") !== ORDINARY_CODEX_BINARY_SHA256 ||
        [after, path].some(stat => stat.dev !== before.dev || stat.ino !== before.ino || stat.size !== before.size ||
          stat.mtimeMs !== before.mtimeMs || stat.ctimeMs !== before.ctimeMs)) {ordinaryCodexRefusal();}
  } finally {await handle.close();}
}

export function createOrdinaryCodexLaunchRecipe(executable: string): (input: Parameters<OrdinaryProcessPort["reserve"]>[0]) => Promise<OrdinaryLaunchSpecification> {
  return async input => {
    await verifyOrdinaryCodexExecutable(executable);
    const home = input.workspace.homeDirectory;
    if (await realpath(home) !== home || performance.now() >= input.deadline) {ordinaryCodexRefusal();}
    const directory = await lstat(home);
    if (!directory.isDirectory() || directory.uid !== process.getuid?.() || directory.mode & 0o077) {ordinaryCodexRefusal();}
    const capability = input.credential.environment[ORDINARY_CODEX_CAPABILITY_ENV];
    if (Object.keys(input.credential.environment).length !== 1 || typeof capability !== "string" || !/^[a-zA-Z0-9_-]{32,128}$/u.test(capability)) {ordinaryCodexRefusal();}
    const recipe = ordinaryCodexUserConfig(home, input.credential.brokerEndpoint);
    await writeFile(join(home, "config.toml"), toml(recipe), {mode: 0o600, flag: "wx"});
    await mkdir(join(home, "tmp"), {mode: 0o700});
    return {executable, arguments: ["app-server", "--strict-config", "--listen", "stdio://", ...ORDINARY_CODEX_DISABLED.flatMap(feature => ["--disable", feature])],
      cwd: input.workspace.cwd, environment: {HOME: home, CODEX_HOME: home, TMPDIR: join(home, "tmp"), PATH: "/usr/bin:/bin",
        LANG: "en_US.UTF-8", [ORDINARY_CODEX_CAPABILITY_ENV]: capability}};
  };
}

function containsExpected(actual: unknown, expected: unknown): boolean {
  if (isRecord(expected)) {return isRecord(actual) && Object.entries(expected).every(([key, value]) => containsExpected(actual[key], value));}
  return equal(actual, expected);
}

export function validateOrdinaryCodexConfig(result: unknown, home: string): string {
  if (!isRecord(result) || !isRecord(result.config) || !Array.isArray(result.layers)) {return ordinaryCodexRefusal();}
  const config = result.config;
  const providers = config.model_providers;
  if (!isRecord(providers) || Object.keys(providers).length !== 1 || !isRecord(providers[ORDINARY_CODEX_PROVIDER]) ||
      typeof providers[ORDINARY_CODEX_PROVIDER].base_url !== "string") {return ordinaryCodexRefusal();}
  const endpoint = providers[ORDINARY_CODEX_PROVIDER].base_url;
  const expected = ordinaryCodexUserConfig(home, endpoint);
  validateEffectiveOverrides(config, expected);
  validateLayers(result.layers, expected, home);
  return endpoint;
}

function validateEffectiveOverrides(config: Record<string, unknown>, expected: Readonly<Record<string, unknown>>): void {
  const features = config.features;
  if (!containsExpected(config, expected) || !isRecord(features) ||
      !ORDINARY_CODEX_DISABLED.every(key => features[key] === false) || !equal(config.mcp_servers, {}) ||
      !equal(config.plugins, {}) || !equal(config.marketplaces, {}) || config.model_catalog_json !== null ||
      config.model_instructions_file !== null || config.developer_instructions !== null || config.instructions !== null) {ordinaryCodexRefusal();}
}

function validateLayers(layers: readonly unknown[], expected: Readonly<Record<string, unknown>>, home: string): void {
  let userLayers = 0; let flagLayers = 0;
  for (const layer of layers) {
    if (!isRecord(layer) || !isRecord(layer.name) || !isRecord(layer.config)) {ordinaryCodexRefusal();}
    if (layer.name.type === "user" && layer.name.file === join(home, "config.toml") && equal(layer.config, expected)) {userLayers += 1;}
    else if (layer.name.type === "sessionFlags" && equal(layer.config, {features: Object.fromEntries(ORDINARY_CODEX_DISABLED.map(key => [key, false]))})) {flagLayers += 1;}
    else if (!["system", "mdm"].includes(String(layer.name.type)) || !equal(layer.config, {})) {ordinaryCodexRefusal();}
  }
  if (userLayers !== 1 || flagLayers !== 1) {ordinaryCodexRefusal();}
}
