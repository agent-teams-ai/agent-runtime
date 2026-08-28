import {
  CLAUDE_CODE_CONFIGURATION_BUDGETS,
  CLAUDE_CODE_EFFORT_VALUES,
  CLAUDE_CODE_MODEL_ALIASES,
  CLAUDE_CODE_SETTINGS_DIALECT,
  type ClaudeCodeConfigurationDiagnosticCode,
  type ClaudeCodeEffort,
  type ClaudeCodeModelAlias,
} from "../../contracts/claude-code-configuration-inspection.js";
import {
  claudeCodeConfigurationSemanticClassifierContract,
  type ClaudeCodeConfigurationSemanticClassifier,
  type PortableClaudeCodeDefinition,
} from "../../application/ports/outbound/claude-code-configuration-semantic-classifier.js";

const modelAliases = new Set<string>(CLAUDE_CODE_MODEL_ALIASES);
const effortValues = new Set<string>(CLAUDE_CODE_EFFORT_VALUES);
const portableKeys = new Set(["model", "effortLevel"]);
const transparentContainers = new Set(["env"]);
const routeKeys = new Set([
  "ANTHROPIC_BASE_URL", "ANTHROPIC_BEDROCK_BASE_URL", "ANTHROPIC_CUSTOM_HEADERS",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL", "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_FOUNDRY_BASE_URL",
  "ANTHROPIC_MODEL", "ANTHROPIC_SMALL_FAST_MODEL", "ANTHROPIC_VERTEX_BASE_URL",
  "AWS_REGION", "AWS_PROFILE", "CLAUDE_CODE_SKIP_BEDROCK_AUTH",
  "CLAUDE_CODE_SKIP_FOUNDRY_AUTH", "CLAUDE_CODE_SKIP_VERTEX_AUTH",
  "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_FOUNDRY", "CLAUDE_CODE_USE_VERTEX",
  "CLOUD_ML_REGION", "CLOUD_ML_PROJECT_ID", "modelOverrides",
]);
const securityKeys = new Set([
  "allowManagedHooksOnly", "allowManagedMcpServersOnly", "disableAllHooks",
  "disableBypassPermissionsMode", "permissions", "sandbox",
]);
const executableKeys = new Set([
  "apiKeyHelper", "enabledPlugins", "hooks", "mcpServers", "outputStyle",
  "plugins", "statusLine",
]);
const credentialName = /(?:api[_-]?key|auth[_-]?token|credential|oauth|password|private[_-]?key)/iu;
const secretName = /(?:secret|token)/iu;
const secretValue = /(?:api[_-]?key|credential|oauth|password|secret|token|\bBearer\s+\S+|\bAKIA[A-Z0-9]{16}\b|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b|\b(?:github_pat_|gh[pousr]_|glpat-|npm_|sk-|xox[baprs]-)[A-Za-z0-9_-]{12,}|\b[A-Za-z0-9_]{32,}\b|-----BEGIN [A-Z ]*PRIVATE KEY-----)/iu;
const routeValue = /(?:^claude-[a-z0-9]|(?:^|[.:/])anthropic(?:[.:/]|$)|^arn:aws:bedrock:|^https?:\/\/|bedrock|vertex|foundry|gateway)/iu;

const classifyName = (key: string): ClaudeCodeConfigurationDiagnosticCode => {
  if (credentialName.test(key)) {
    return "credential_material_rejected";
  }
  if (secretName.test(key)) {
    return "secret_setting_rejected";
  }
  if (routeKeys.has(key)) {
    return "provider_route_deferred";
  }
  if (securityKeys.has(key)) {
    return "setting_value_unsupported";
  }
  if (executableKeys.has(key)) {
    return "setting_value_unsupported";
  }
  return "setting_value_unsupported";
};

const classifyString = (value: string): ClaudeCodeConfigurationDiagnosticCode | undefined => {
  if (secretValue.test(value)) {
    return "secret_setting_rejected";
  }
  if (routeValue.test(value)) {
    return "provider_route_deferred";
  }
  return undefined;
};

const scanNonportableValue = (
  value: unknown,
  diagnostics: Set<ClaudeCodeConfigurationDiagnosticCode>,
  signal?: AbortSignal,
): void => {
  signal?.throwIfAborted();
  if (typeof value === "string") {
    if (value.length > CLAUDE_CODE_CONFIGURATION_BUDGETS.classifierValueLength) {
      diagnostics.add("setting_value_unsupported");
      return;
    }
    const code = classifyString(value);
    if (code !== undefined) diagnostics.add(code);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) scanNonportableValue(item, diagnostics, signal);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const key of Object.keys(value).toSorted()) {
    signal?.throwIfAborted();
    const nested = (value as Readonly<Record<string, unknown>>)[key];
    diagnostics.add(classifyName(key));
    // Values identified by a sensitive name remain opaque so rotations cannot
    // alter diagnostics or any other output at this boundary.
    if (!credentialName.test(key) && !secretName.test(key) && !routeKeys.has(key)) {
      scanNonportableValue(nested, diagnostics, signal);
    }
  }
};

const classifyPortable = (
  key: "model" | "effortLevel",
  value: unknown,
  definitions: PortableClaudeCodeDefinition[],
  diagnostics: Set<ClaudeCodeConfigurationDiagnosticCode>,
  tainted: Set<"model" | "effortLevel">,
): void => {
  if (typeof value !== "string" || value.length === 0) {
    diagnostics.add("setting_type_unsupported");
    tainted.add(key);
    return;
  }
  const unsafe = classifyString(value);
  if (unsafe !== undefined) {
    diagnostics.add(unsafe);
    tainted.add(key);
    return;
  }
  if (value.length > CLAUDE_CODE_CONFIGURATION_BUDGETS.classifierValueLength) {
    diagnostics.add("setting_value_unsupported");
    tainted.add(key);
    return;
  }
  const supported = key === "model" ? modelAliases.has(value) : effortValues.has(value);
  if (!supported) {
    diagnostics.add("setting_value_unsupported");
    tainted.add(key);
    return;
  }
  definitions.push(key === "model"
    ? { key, value: value as ClaudeCodeModelAlias }
    : { key, value: value as ClaudeCodeEffort });
};

export const createClaudeCodeConfigurationSemanticClassifierV1 =
  (): ClaudeCodeConfigurationSemanticClassifier => Object.freeze({
    contract: claudeCodeConfigurationSemanticClassifierContract,
    revision: "claude-code-settings-2026-08-28-semantic-classifier/1",
    classify(
      dialect: typeof CLAUDE_CODE_SETTINGS_DIALECT,
      data: Readonly<Record<string, unknown>>,
      options?: { readonly signal?: AbortSignal },
    ) {
      if (dialect !== CLAUDE_CODE_SETTINGS_DIALECT) {
        return { definitions: [], diagnostics: [], definedPortableKeys: [], taintedPortableKeys: [] };
      }
      const definitions: PortableClaudeCodeDefinition[] = [];
      const diagnostics = new Set<ClaudeCodeConfigurationDiagnosticCode>();
      const defined = new Set<"model" | "effortLevel">();
      const tainted = new Set<"model" | "effortLevel">();
      for (const key of Object.keys(data).toSorted()) {
        options?.signal?.throwIfAborted();
        const value = data[key];
        if (portableKeys.has(key)) {
          const portableKey = key as "model" | "effortLevel";
          defined.add(portableKey);
          classifyPortable(portableKey, value, definitions, diagnostics, tainted);
          continue;
        }
        if (transparentContainers.has(key)) {
          scanNonportableValue(value, diagnostics, options?.signal);
          continue;
        }
        diagnostics.add(classifyName(key));
        if (!credentialName.test(key) && !secretName.test(key) && !routeKeys.has(key)) {
          scanNonportableValue(value, diagnostics, options?.signal);
        }
      }
      options?.signal?.throwIfAborted();
      return {
        definitions: definitions.toSorted((left, right) => left.key < right.key ? -1 : 1),
        diagnostics: [...diagnostics].toSorted().map(code => ({ code })),
        definedPortableKeys: [...defined].toSorted(),
        taintedPortableKeys: [...tainted].toSorted(),
      };
    },
    supportsDialect: (dialect: string) => dialect === CLAUDE_CODE_SETTINGS_DIALECT,
  });
