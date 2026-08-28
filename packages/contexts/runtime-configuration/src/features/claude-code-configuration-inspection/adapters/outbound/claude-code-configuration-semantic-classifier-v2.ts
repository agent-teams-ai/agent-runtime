import {
  CLAUDE_CODE_CONFIGURATION_BUDGETS, CLAUDE_CODE_EFFORT_VALUES,
  CLAUDE_CODE_MODEL_ALIASES, CLAUDE_CODE_MODEL_DEFAULT, CLAUDE_CODE_PROVIDER_ROUTE_KEYS,
  CLAUDE_CODE_SETTINGS_DIALECT, type ClaudeCodeConfigurationDiagnosticCode,
  type ClaudeCodeEffort, type ClaudeCodeModelAlias,
} from "../../contracts/claude-code-configuration-inspection.js";
import {
  claudeCodeConfigurationSemanticClassifierContract,
  type ClaudeCodeConfigurationSemanticClassifier, type DeferredClaudeCodeDefinition,
  type PortableClaudeCodeDefinition,
} from "../../application/ports/outbound/claude-code-configuration-semantic-classifier.js";

const modelAliases: ReadonlySet<string> = new Set(CLAUDE_CODE_MODEL_ALIASES);
const effortValues: ReadonlySet<string> = new Set(CLAUDE_CODE_EFFORT_VALUES);
const routeKeys = new Set<string>(CLAUDE_CODE_PROVIDER_ROUTE_KEYS.map(entry => entry.key));
const transparentContainers = new Set(["env"]);
const securityOrExecutableKeys = new Set([
  "allowManagedHooksOnly", "allowManagedMcpServersOnly", "apiKeyHelper", "disableAllHooks",
  "disableBypassPermissionsMode", "enabledPlugins", "hooks", "mcpServers", "outputStyle",
  "permissions", "plugins", "sandbox", "statusLine",
]);
const credentialName = /(?:api[_-]?key|auth[_-]?token|credential|oauth|password|private[_-]?key)/iu;
const secretName = /(?:secret|token)/iu;
const secretValue = /(?:api[_-]?key|credential|oauth|password|secret|token|\bBearer\s+\S+|\bAKIA[A-Z0-9]{16}\b|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b|\b(?:github_pat_|gh[pousr]_|glpat-|npm_|sk-|xox[baprs]-)[A-Za-z0-9_-]{12,}|\b[A-Za-z0-9_]{32,}\b|-----BEGIN [A-Z ]*PRIVATE KEY-----)/iu;
const exactModelName = /^claude-[a-z0-9]+(?:-[a-z0-9]+)*(?:\[1m\])?$/u;
const providerDeployment = /(?:^arn:(?:aws|aws-us-gov|aws-cn):bedrock:|^https?:\/\/|^(?:[a-z]{2}(?:-[a-z]+)?|global)\.anthropic\.|^anthropic\.claude-|(?:^|[.:/])anthropic(?:[.:/]|$)|bedrock|vertex|foundry|gateway)/iu;
const controlBearing = (value: string): boolean =>
  [...value].some(character => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint < 32 || codePoint === 127);
  });

const isModelAlias = (value: string): value is ClaudeCodeModelAlias => modelAliases.has(value);
const isEffort = (value: string): value is ClaudeCodeEffort => effortValues.has(value);

interface Context {
  readonly definitions: PortableClaudeCodeDefinition[];
  readonly deferredObservations: DeferredClaudeCodeDefinition[];
  readonly diagnostics: Set<ClaudeCodeConfigurationDiagnosticCode>;
  readonly tainted: Set<"model" | "effortLevel">;
}

const classifyName = (key: string): ClaudeCodeConfigurationDiagnosticCode => {
  if (credentialName.test(key)) {return "credential_material_rejected";}
  if (secretName.test(key)) {return "secret_setting_rejected";}
  if (routeKeys.has(key)) {return "provider_route_deferred";}
  if (securityOrExecutableKeys.has(key)) {return "setting_value_unsupported";}
  return "setting_value_unsupported";
};

const scanNonportableValue = (
  value: unknown, diagnostics: Set<ClaudeCodeConfigurationDiagnosticCode>, signal?: AbortSignal,
): void => {
  signal?.throwIfAborted();
  if (typeof value === "string") {
    if (secretValue.test(value)) {diagnostics.add("secret_setting_rejected");}
    else if (value.length > CLAUDE_CODE_CONFIGURATION_BUDGETS.classifierValueLength || controlBearing(value)) {
      diagnostics.add("setting_value_unsupported");
    } else if (providerDeployment.test(value)) {diagnostics.add("provider_route_deferred");}
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {scanNonportableValue(item, diagnostics, signal);}
    return;
  }
  if (typeof value !== "object" || value === null) {return;}
  for (const key of Object.keys(value).toSorted()) {
    signal?.throwIfAborted();
    const nested = (value as Readonly<Record<string, unknown>>)[key];
    diagnostics.add(classifyName(key));
    if (!credentialName.test(key) && !secretName.test(key) && !routeKeys.has(key)) {
      scanNonportableValue(nested, diagnostics, signal);
    }
  }
};

const reject = (
  key: "model" | "effortLevel", context: Context,
  code: "secret_setting_rejected" | "setting_type_unsupported" | "setting_value_unsupported",
): void => { context.diagnostics.add(code); context.tainted.add(key); };

const classifyModel = (value: unknown, context: Context): void => {
  if (typeof value !== "string" || value.length === 0) {reject("model", context, "setting_type_unsupported"); return;}
  if (value.length > CLAUDE_CODE_CONFIGURATION_BUDGETS.classifierValueLength || controlBearing(value)) {
    reject("model", context, "setting_value_unsupported"); return;
  }
  if (secretValue.test(value)) {reject("model", context, "secret_setting_rejected"); return;}
  if (value === CLAUDE_CODE_MODEL_DEFAULT) {
    context.definitions.push({ key: "model", selection: { kind: "provider-default" } });
  } else if (isModelAlias(value)) {
    context.definitions.push({ key: "model", selection: { kind: "alias", value } });
  } else if (exactModelName.test(value)) {
    context.definitions.push({ key: "model", selection: { kind: "exact-name", value } });
  } else {
    context.deferredObservations.push({
      form: providerDeployment.test(value) ? "provider-deployment" : "unclassified-selector",
      key: "model", status: "deferred",
    });
  }
};

const classifyEffort = (value: unknown, context: Context): void => {
  if (typeof value !== "string" || value.length === 0) {reject("effortLevel", context, "setting_type_unsupported"); return;}
  if (value.length > CLAUDE_CODE_CONFIGURATION_BUDGETS.classifierValueLength ||
      controlBearing(value)) {
    reject("effortLevel", context, "setting_value_unsupported"); return;
  }
  if (secretValue.test(value)) {reject("effortLevel", context, "secret_setting_rejected"); return;}
  if (!isEffort(value)) {reject("effortLevel", context, "setting_value_unsupported"); return;}
  context.definitions.push({ key: "effortLevel", value });
};

export const createClaudeCodeConfigurationSemanticClassifierV2 =
  (): ClaudeCodeConfigurationSemanticClassifier => {
    const classifier: ClaudeCodeConfigurationSemanticClassifier = {
    contract: claudeCodeConfigurationSemanticClassifierContract,
    revision: "claude-code-settings-2026-08-28-semantic-classifier/2",
    classify(dialect, data, options) {
      if (dialect !== CLAUDE_CODE_SETTINGS_DIALECT) {
        return { definitions: [], deferredObservations: [], diagnostics: [], definedPortableKeys: [], taintedPortableKeys: [] };
      }
      const definitions: PortableClaudeCodeDefinition[] = [];
      const deferredObservations: DeferredClaudeCodeDefinition[] = [];
      const diagnostics = new Set<ClaudeCodeConfigurationDiagnosticCode>();
      const defined = new Set<"model" | "effortLevel">();
      const tainted = new Set<"model" | "effortLevel">();
      const context: Context = { definitions, deferredObservations, diagnostics, tainted };
      for (const key of Object.keys(data).toSorted()) {
        options?.signal?.throwIfAborted();
        const value = data[key];
        if (key === "model" || key === "effortLevel") {
          defined.add(key);
          if (key === "model") {classifyModel(value, context);} else {classifyEffort(value, context);}
        } else if (transparentContainers.has(key)) {
          scanNonportableValue(value, diagnostics, options?.signal);
        } else {
          diagnostics.add(classifyName(key));
          if (!credentialName.test(key) && !secretName.test(key) && !routeKeys.has(key)) {
            scanNonportableValue(value, diagnostics, options?.signal);
          }
        }
      }
      options?.signal?.throwIfAborted();
      return {
        definitions: definitions.toSorted((left, right) => left.key < right.key ? -1 : 1),
        deferredObservations: Object.freeze(deferredObservations.map(item => Object.freeze(item))),
        diagnostics: [...diagnostics].toSorted().map(code => ({ code })),
        definedPortableKeys: [...defined].toSorted(), taintedPortableKeys: [...tainted].toSorted(),
      };
    },
    supportsDialect: (dialect: string) => dialect === CLAUDE_CODE_SETTINGS_DIALECT,
    };
    return Object.freeze(classifier);
  };
