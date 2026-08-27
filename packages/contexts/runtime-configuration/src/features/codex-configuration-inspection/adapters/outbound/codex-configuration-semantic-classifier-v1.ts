import type { PortableCodexSettingKey } from "../../contracts/codex-configuration-inspection.js";
import {
  codexConfigurationSemanticClassifierContract,
  type CodexConfigurationSemanticClassification,
  type CodexConfigurationSemanticClassifier,
} from "../../application/ports/outbound/codex-configuration-semantic-classifier.js";

const dialect = "codex-0.134";
const portableKeys = new Set<PortableCodexSettingKey>([
  "model",
  "model_reasoning_effort",
  "personality",
]);
const securityOwned = new Set([
  "approval_policy",
  "managed_requirements",
  "network_access",
  "permissions",
  "sandbox_mode",
  "web_search",
]);
const providerAccessOwned = new Set([
  "model_provider",
  "model_providers",
  "provider",
  "providers",
  "service_tier",
]);
const executableResources = new Set([
  "commands",
  "hooks",
  "instructions",
  "mcp_servers",
  "plugins",
  "shell_environment_policy",
  "skills",
]);
const supportedReasoningEfforts = new Set([
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
]);
const supportedPersonalities = new Set(["none", "friendly", "pragmatic"]);
const supportedModelIdentifiers = new Set([
  "gpt-5.3-codex-spark",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.5",
  "gpt-5.6",
  "gpt-5.6-codex",
  "gpt-5.6-luna",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "o1",
  "o3",
  "o3-mini",
  "o4-mini",
]);
const secretShape = /(api[_-]?key|credential|oauth|password|secret|token)/i;
const secretValueShape =
  /(?:\bBearer\s+\S+|\bAKIA[A-Z0-9]{16}\b|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b|\b(?:github_pat_|gh[pousr]_|npm_|sk-|xox[baprs]-)[A-Za-z0-9_-]{12,}|\b[A-Za-z0-9_]{32,}\b|-----BEGIN [A-Z ]*PRIVATE KEY-----)/iu;

const diagnosticForSetting = (
  key: string,
): CodexConfigurationSemanticClassification["diagnostics"][number] => {
  if (secretShape.test(key)) {
    return { code: "secret_setting_ignored" };
  }
  if (securityOwned.has(key)) {
    return { code: "security_setting_deferred", setting: key };
  }
  if (providerAccessOwned.has(key)) {
    return { code: "provider_access_setting_deferred", setting: key };
  }
  if (executableResources.has(key)) {
    return { code: "executable_setting_deferred", setting: key };
  }
  return { code: "unknown_setting_ignored" };
};

const isSupportedPortableValue = (
  key: PortableCodexSettingKey,
  value: string,
): boolean => {
  if (key === "model") {
    return supportedModelIdentifiers.has(value);
  }
  if (key === "model_reasoning_effort") {
    return supportedReasoningEfforts.has(value);
  }
  return supportedPersonalities.has(value);
};

export const createCodexConfigurationSemanticClassifierV1 =
  (): CodexConfigurationSemanticClassifier => Object.freeze({
    contract: codexConfigurationSemanticClassifierContract,
    revision: "codex-0.134-semantic-classifier/1",
    classify(
      selectedDialect: string,
      document: Readonly<Record<string, unknown>>,
    ) {
      if (selectedDialect !== dialect) {
        return { diagnostics: [], settings: [] };
      }
      const diagnostics: CodexConfigurationSemanticClassification["diagnostics"][number][] = [];
      const settings: CodexConfigurationSemanticClassification["settings"][number][] = [];
      for (const key of Object.keys(document).toSorted()) {
        const value = document[key];
        if (!portableKeys.has(key as PortableCodexSettingKey)) {
          diagnostics.push(diagnosticForSetting(key));
          continue;
        }
        if (typeof value !== "string" || value.length === 0) {
          diagnostics.push({ code: "setting_type_unsupported", setting: key });
          continue;
        }
        if (secretValueShape.test(value)) {
          diagnostics.push({ code: "secret_setting_ignored" });
          continue;
        }
        const portableKey = key as PortableCodexSettingKey;
        if (!isSupportedPortableValue(portableKey, value)) {
          diagnostics.push({ code: "setting_value_unsupported", setting: key });
          continue;
        }
        settings.push({ key: portableKey, value });
      }
      return { diagnostics, settings };
    },
    supportsDialect: (selectedDialect: string) => selectedDialect === dialect,
  });
