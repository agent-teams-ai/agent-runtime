import type { PortableCodexSettingKey } from "../../contracts/codex-configuration-inspection.js";
import {
  codexConfigurationSemanticClassifierContract,
  type CodexConfigurationSemanticClassification,
  type CodexConfigurationSemanticClassifier,
} from "../../application/ports/outbound/codex-configuration-semantic-classifier.js";
import { isSecretShapedValue } from "../../application/safe-semantic-boundary.js";

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
]);
const supportedPersonalities = new Set(["none", "friendly", "pragmatic"]);
const supportedModelIdentifier = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
const secretShape = /(api[_-]?key|credential|oauth|password|secret|token)/i;

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
    return supportedModelIdentifier.test(value);
  }
  if (key === "model_reasoning_effort") {
    return supportedReasoningEfforts.has(value);
  }
  return supportedPersonalities.has(value);
};

export const createCodexConfigurationSemanticClassifierV1 =
  (): CodexConfigurationSemanticClassifier => Object.freeze({
    contract: codexConfigurationSemanticClassifierContract,
    revision: "codex-0.134-semantic-classifier/2",
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
        if (isSecretShapedValue(value)) {
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
