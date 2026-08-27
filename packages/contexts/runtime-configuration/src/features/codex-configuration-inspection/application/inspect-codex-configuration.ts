import { createHash, createHmac } from "node:crypto";

import type {
  CodexConfigurationDiagnostic,
  CodexConfigurationSource,
  CodexConfigurationSourceObservation,
  InspectCodexConfiguration,
  InspectCodexConfigurationInput,
  InspectCodexConfigurationResult,
  PortableCodexSettingKey,
  PortableCodexSettingObservation,
} from "../contracts/codex-configuration-inspection.js";
import type { CodexTomlParser } from "./ports/outbound/codex-toml-parser.js";
import type { ConfigurationSourceReader } from "./ports/outbound/configuration-source-reader.js";

interface BoundSource extends CodexConfigurationSource {
  readonly sourceRef: string;
}

interface PreparedSource extends BoundSource {
  readonly document: Readonly<Record<string, unknown>>;
}

interface SourceBindingPlan {
  readonly duplicateKinds: ReadonlySet<"user" | "workspace">;
  readonly sources: readonly BoundSource[];
}

interface InspectionCollections {
  readonly diagnostics: CodexConfigurationDiagnostic[];
  readonly effective: Map<PortableCodexSettingKey, PortableCodexSettingObservation>;
  readonly safeProjectionBySource: Map<string, Map<PortableCodexSettingKey, string>>;
  readonly sourceObservations: CodexConfigurationSourceObservation[];
}

interface InspectionDependencies {
  readonly parser: CodexTomlParser;
  readonly sourceIdentityKey: Uint8Array;
  readonly sourceReader: ConfigurationSourceReader;
}

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
const sourceRanks = { user: 10, workspace: 20 } as const;
const supportedReasoningEfforts = new Set(["minimal", "low", "medium", "high", "xhigh"]);
const supportedPersonalities = new Set(["none", "friendly", "pragmatic", "concise"]);
const supportedModelIdentifier =
  /^(?:gpt-[A-Za-z0-9][A-Za-z0-9._-]{0,63}|o[1-9][A-Za-z0-9._-]{0,63})$/u;
const secretShape = /(api[_-]?key|credential|oauth|password|secret|token)/i;
const secretValueShape =
  /(?:\bBearer\s+\S+|\bAKIA[A-Z0-9]{16}\b|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b|\b(?:github_pat_|gh[pousr]_|npm_|sk-|xox[baprs]-)[A-Za-z0-9_-]{12,}|\b[A-Za-z0-9_]{32,}\b|-----BEGIN [A-Z ]*PRIVATE KEY-----)/iu;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const compareText = (left: string, right: string): number =>
  left === right ? 0 : left < right ? -1 : 1;

const createSourceRef = (
  identityKey: Uint8Array,
  identityScope: string,
  kind: string,
  canonicalPath: string,
): string =>
  `codex-config-source:${createHmac("sha256", identityKey)
    .update(`${identityScope}\0${kind}\0${canonicalPath}`)
    .digest("hex")}`;

const semanticDigest = (
  settings: ReadonlyMap<PortableCodexSettingKey, string> | undefined,
): string => {
  const projection = [...(settings?.entries() ?? [])].toSorted(([left], [right]) =>
    compareText(left, right),
  );
  return `sha256:${createHash("sha256").update(JSON.stringify(projection)).digest("hex")}`;
};

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

const bindSources = (
  input: InspectCodexConfigurationInput,
  identityKey: Uint8Array,
  diagnostics: CodexConfigurationDiagnostic[],
): SourceBindingPlan => {
  const duplicateKinds = new Set<"user" | "workspace">();
  for (const kind of ["user", "workspace"] as const) {
    if (input.sources.filter(source => source.kind === kind).length > 1) {
      duplicateKinds.add(kind);
      diagnostics.push({ code: "source_precedence_conflict", setting: kind });
    }
  }
  const sources = input.sources
    .map(source => ({
      ...source,
      sourceRef: createSourceRef(
        identityKey,
        input.identityScope,
        source.kind,
        source.canonicalPath,
      ),
    }))
    .toSorted(
      (left, right) =>
        sourceRanks[left.kind] - sourceRanks[right.kind] ||
        compareText(left.sourceRef, right.sourceRef),
    );
  return { duplicateKinds, sources };
};

const createApplySettings = (collections: InspectionCollections) =>
  (document: Readonly<Record<string, unknown>>, source: PreparedSource): void => {
    const safeProjection =
      collections.safeProjectionBySource.get(source.sourceRef) ?? new Map();
    collections.safeProjectionBySource.set(source.sourceRef, safeProjection);
    for (const key of Object.keys(document).toSorted()) {
      if (key === "profiles") {
        continue;
      }
      const value = document[key];
      if (!portableKeys.has(key as PortableCodexSettingKey)) {
        const code = diagnosticForSetting(key);
        collections.diagnostics.push({
          code,
          sourceRef: source.sourceRef,
          ...(code === "unknown_setting_ignored" || code === "secret_setting_ignored"
            ? {}
            : { setting: key }),
        });
        continue;
      }
      if (typeof value !== "string" || value.length === 0) {
        collections.diagnostics.push({
          code: "setting_type_unsupported",
          setting: key,
          sourceRef: source.sourceRef,
        });
        continue;
      }
      if (secretValueShape.test(value)) {
        collections.diagnostics.push({
          code: "secret_setting_ignored",
          sourceRef: source.sourceRef,
        });
        continue;
      }
      const portableKey = key as PortableCodexSettingKey;
      if (!isSupportedPortableValue(portableKey, value)) {
        collections.diagnostics.push({
          code: "setting_value_unsupported",
          setting: key,
          sourceRef: source.sourceRef,
        });
        continue;
      }
      collections.effective.set(portableKey, {
        key: portableKey,
        sourceRef: source.sourceRef,
        value,
      });
      safeProjection.set(portableKey, value);
    }
  };

const malformedDiagnostic = (
  kind: "bom" | "invalid-utf8" | "malformed",
): CodexConfigurationDiagnostic["code"] => {
  if (kind === "bom") {
    return "config_bom_rejected";
  }
  if (kind === "invalid-utf8") {
    return "config_invalid_utf8";
  }
  return "config_parse_failed";
};

const prepareSources = async (
  dependencies: InspectionDependencies,
  input: InspectCodexConfigurationInput,
  binding: SourceBindingPlan,
  collections: InspectionCollections,
  signal?: AbortSignal,
): Promise<readonly PreparedSource[]> => {
  const preparedSources: PreparedSource[] = [];
  for (const source of binding.sources) {
    signal?.throwIfAborted();
    if (binding.duplicateKinds.has(source.kind)) {
      collections.sourceObservations.push({
        displayPath: source.displayPath,
        kind: source.kind,
        sourceRef: source.sourceRef,
        status: "rejected",
      });
      continue;
    }
    if (source.observationEpoch !== input.observationEpoch) {
      collections.diagnostics.push({
        code: "source_epoch_stale",
        sourceRef: source.sourceRef,
      });
      collections.sourceObservations.push({
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
      source.authorizedFileIdentity,
      source.custodyRoot,
      signal === undefined ? undefined : { signal },
    );
    if (read.kind !== "read") {
      if (read.kind !== "missing") {
        collections.diagnostics.push({
          code: read.kind === "too-large" ? "config_too_large" : "config_unreadable",
          sourceRef: source.sourceRef,
        });
      }
      collections.sourceObservations.push({
        displayPath: source.displayPath,
        kind: source.kind,
        sourceRef: source.sourceRef,
        status: read.kind === "missing" ? "missing" : "unreadable",
      });
      continue;
    }
    const parsed = dependencies.parser.parse(read.bytes);
    if (parsed.kind !== "parsed") {
      collections.diagnostics.push({
        code: malformedDiagnostic(parsed.kind),
        sourceRef: source.sourceRef,
      });
      collections.sourceObservations.push({
        displayPath: source.displayPath,
        kind: source.kind,
        sourceRef: source.sourceRef,
        status: "malformed",
      });
      continue;
    }
    preparedSources.push({ ...source, document: parsed.document });
  }
  return preparedSources;
};

const applyPreparedSources = (
  preparedSources: readonly PreparedSource[],
  nativeProfile: string | undefined,
  collections: InspectionCollections,
): void => {
  const applySettings = createApplySettings(collections);
  for (const source of preparedSources) {
    applySettings(source.document, source);
  }
  let selectedProfileFound = false;
  if (nativeProfile !== undefined) {
    for (const source of preparedSources) {
      const profiles = Object.hasOwn(source.document, "profiles")
        ? source.document.profiles
        : undefined;
      const selected =
        isRecord(profiles) && Object.hasOwn(profiles, nativeProfile)
          ? profiles[nativeProfile]
          : undefined;
      if (isRecord(selected)) {
        selectedProfileFound = true;
        applySettings(selected, source);
      }
    }
    if (!selectedProfileFound) {
      collections.diagnostics.push({ code: "profile_missing" });
    }
  }
  for (const source of preparedSources) {
    collections.sourceObservations.push({
      displayPath: source.displayPath,
      kind: source.kind,
      semanticDigest: semanticDigest(
        collections.safeProjectionBySource.get(source.sourceRef),
      ),
      sourceRef: source.sourceRef,
      status: "applied",
    });
  }
};

const buildResult = (collections: InspectionCollections): InspectCodexConfigurationResult => ({
  diagnostics: collections.diagnostics.toSorted((left, right) =>
    compareText(
      `${left.code}:${left.sourceRef ?? ""}:${left.setting ?? ""}`,
      `${right.code}:${right.sourceRef ?? ""}:${right.setting ?? ""}`,
    ),
  ),
  settings: [...collections.effective.values()].toSorted((left, right) =>
    compareText(left.key, right.key),
  ),
  sources: collections.sourceObservations.toSorted((left, right) =>
    compareText(left.sourceRef, right.sourceRef),
  ),
});

const executeInspection = async (
  dependencies: InspectionDependencies,
  identityKey: Uint8Array,
  input: InspectCodexConfigurationInput,
  signal?: AbortSignal,
): Promise<InspectCodexConfigurationResult> => {
  if (input.identityScope.length === 0) {
    throw new TypeError("identityScope must not be empty");
  }
  const collections: InspectionCollections = {
    diagnostics: [],
    effective: new Map(),
    safeProjectionBySource: new Map(),
    sourceObservations: [],
  };
  const bound = bindSources(input, identityKey, collections.diagnostics);
  const preparedSources = await prepareSources(
    dependencies,
    input,
    bound,
    collections,
    signal,
  );
  applyPreparedSources(preparedSources, input.nativeProfile, collections);
  return buildResult(collections);
};

export const createInspectCodexConfiguration = (
  dependencies: InspectionDependencies,
): InspectCodexConfiguration => {
  if (dependencies.sourceIdentityKey.byteLength < 32) {
    throw new TypeError("sourceIdentityKey must contain at least 32 bytes");
  }
  const identityKey = Uint8Array.from(dependencies.sourceIdentityKey);
  return {
    execute: (input, options) =>
      executeInspection(dependencies, identityKey, input, options?.signal),
  };
};
