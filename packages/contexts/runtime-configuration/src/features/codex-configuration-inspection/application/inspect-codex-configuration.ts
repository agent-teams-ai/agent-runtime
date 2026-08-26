import { createHash } from "node:crypto";

import type {
  CodexConfigurationDiagnostic,
  CodexConfigurationSourceObservation,
  InspectCodexConfiguration,
  InspectCodexConfigurationResult,
  PortableCodexSettingKey,
  PortableCodexSettingObservation,
} from "../contracts/codex-configuration-inspection.js";
import type { CodexTomlParser } from "./ports/outbound/codex-toml-parser.js";
import type { ConfigurationSourceReader } from "./ports/outbound/configuration-source-reader.js";

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
const secretShape = /(api[_-]?key|credential|oauth|password|secret|token)/i;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const compareText = (left: string, right: string): number =>
  left === right ? 0 : left < right ? -1 : 1;

const diagnosticForSetting = (
  key: string,
): CodexConfigurationDiagnostic["code"] => {
  if (secretShape.test(key)) {
    return "secret_setting_ignored";
  }
  if (securityOwned.has(key)) {
    return "security_setting_deferred";
  }
  if (providerAccessOwned.has(key)) {
    return "provider_access_setting_deferred";
  }
  if (executableResources.has(key)) {
    return "executable_setting_deferred";
  }
  return "unknown_setting_ignored";
};

export const createInspectCodexConfiguration = (dependencies: {
  readonly parser: CodexTomlParser;
  readonly sourceReader: ConfigurationSourceReader;
}): InspectCodexConfiguration => ({
  async execute(input, options): Promise<InspectCodexConfigurationResult> {
    const diagnostics: CodexConfigurationDiagnostic[] = [];
    const sourceObservations: CodexConfigurationSourceObservation[] = [];
    const effective = new Map<PortableCodexSettingKey, PortableCodexSettingObservation>();
    const sources = [...input.sources].toSorted(
      (left, right) =>
        left.precedence - right.precedence ||
        compareText(left.sourceRef, right.sourceRef),
    );

    const applySettings = (
      document: Readonly<Record<string, unknown>>,
      sourceRef: string,
    ): void => {
      for (const key of Object.keys(document).toSorted()) {
        if (key === "profiles") {
          continue;
        }
        const value = document[key];
        if (portableKeys.has(key as PortableCodexSettingKey)) {
          if (typeof value === "string" && value.length > 0) {
            const portableKey = key as PortableCodexSettingKey;
            effective.set(portableKey, { key: portableKey, sourceRef, value });
          } else {
            diagnostics.push({
              code: "setting_type_unsupported",
              setting: key,
              sourceRef,
            });
          }
          continue;
        }
        const code = diagnosticForSetting(key);
        diagnostics.push({
          code,
          sourceRef,
          ...(code === "unknown_setting_ignored" || code === "secret_setting_ignored"
            ? {}
            : { setting: key }),
        });
      }
    };

    for (const source of sources) {
      options?.signal?.throwIfAborted();
      if (source.observationEpoch !== input.observationEpoch) {
        diagnostics.push({ code: "source_epoch_stale", sourceRef: source.sourceRef });
        sourceObservations.push({
          displayPath: source.displayPath,
          kind: source.kind,
          sourceRef: source.sourceRef,
          status: "stale",
        });
        continue;
      }

      const read = await dependencies.sourceReader.read(
        source.absolutePath,
        source.canonicalPath,
        options,
      );
      if (read.kind !== "read") {
        const code =
          read.kind === "too-large" ? "config_too_large" : "config_unreadable";
        if (read.kind !== "missing") {
          diagnostics.push({ code, sourceRef: source.sourceRef });
        }
        sourceObservations.push({
          displayPath: source.displayPath,
          kind: source.kind,
          sourceRef: source.sourceRef,
          status: read.kind === "missing" ? "missing" : "unreadable",
        });
        continue;
      }

      const contentDigest = `sha256:${createHash("sha256").update(read.bytes).digest("hex")}`;
      const parsed = dependencies.parser.parse(read.bytes);
      if (parsed.kind !== "parsed") {
        const code =
          parsed.kind === "bom"
            ? "config_bom_rejected"
            : parsed.kind === "invalid-utf8"
              ? "config_invalid_utf8"
              : "config_parse_failed";
        diagnostics.push({ code, sourceRef: source.sourceRef });
        sourceObservations.push({
          contentDigest,
          displayPath: source.displayPath,
          kind: source.kind,
          sourceRef: source.sourceRef,
          status: "malformed",
        });
        continue;
      }

      applySettings(parsed.document, source.sourceRef);
      if (input.nativeProfile !== undefined) {
        const profiles = parsed.document.profiles;
        const selected = isRecord(profiles) ? profiles[input.nativeProfile] : undefined;
        if (isRecord(selected)) {
          applySettings(selected, source.sourceRef);
        } else {
          diagnostics.push({ code: "profile_missing", sourceRef: source.sourceRef });
        }
      }
      sourceObservations.push({
        contentDigest,
        displayPath: source.displayPath,
        kind: source.kind,
        sourceRef: source.sourceRef,
        status: "applied",
      });
    }

    return {
      diagnostics: diagnostics.toSorted((left, right) =>
        compareText(
          `${left.code}:${left.sourceRef}:${left.setting ?? ""}`,
          `${right.code}:${right.sourceRef}:${right.setting ?? ""}`,
        ),
      ),
      settings: [...effective.values()].toSorted((left, right) =>
        compareText(left.key, right.key),
      ),
      sources: sourceObservations.toSorted((left, right) =>
        compareText(left.sourceRef, right.sourceRef),
      ),
    };
  },
});
