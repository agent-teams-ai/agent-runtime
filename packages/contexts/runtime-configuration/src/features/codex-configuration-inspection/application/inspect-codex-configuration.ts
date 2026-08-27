import { createHash, createHmac } from "node:crypto";

import type {
  CodexConfigurationDiagnostic,
  CodexConfigurationSource,
  CodexConfigurationSourceKind,
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
  readonly rejectedSourceRefs: ReadonlySet<string>;
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
const sourceRanks: Readonly<Record<CodexConfigurationSourceKind, number>> = {
  user: 10,
  "external-profile": 20,
  workspace: 30,
};
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
    return supportedModelIdentifiers.has(value);
  }
  if (key === "model_reasoning_effort") {
    return supportedReasoningEfforts.has(value);
  }
  return supportedPersonalities.has(value);
};

const rejectSources = (
  conflicting: readonly BoundSource[],
  setting: string,
  rejectedSourceRefs: Set<string>,
  reportedConflicts: Set<string>,
  diagnostics: CodexConfigurationDiagnostic[],
): void => {
  for (const source of conflicting) {
    rejectedSourceRefs.add(source.sourceRef);
  }
  if (!reportedConflicts.has(setting)) {
    reportedConflicts.add(setting);
    diagnostics.push({ code: "source_precedence_conflict", setting });
  }
};

const duplicateSourceGroups = (
  sources: readonly BoundSource[],
): readonly (readonly BoundSource[])[] => {
  const sourcesByRef = new Map<string, BoundSource[]>();
  for (const source of sources) {
    const matching = sourcesByRef.get(source.sourceRef) ?? [];
    matching.push(source);
    sourcesByRef.set(source.sourceRef, matching);
  }
  return [...sourcesByRef.values()].filter(matching => matching.length > 1);
};

const hasValidSourceMetadata = (source: BoundSource): boolean =>
  (source.kind === "user" &&
    source.profileName === undefined && source.workspaceLayer === undefined) ||
  (source.kind === "external-profile" &&
    source.workspaceLayer === undefined &&
    typeof source.profileName === "string" && source.profileName.length > 0) ||
  (source.kind === "workspace" && source.profileName === undefined);

const hasValidWorkspaceOrder = (sources: readonly BoundSource[]): boolean =>
  sources.every(source =>
    Number.isSafeInteger(source.workspaceLayer) && (source.workspaceLayer ?? -1) >= 0,
  ) && new Set(sources.map(source => source.workspaceLayer)).size === sources.length;

const bindSources = (
  input: InspectCodexConfigurationInput,
  identityKey: Uint8Array,
  diagnostics: CodexConfigurationDiagnostic[],
): SourceBindingPlan => {
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
        (right.kind === "workspace" ? (right.workspaceLayer ?? 0) : 0) -
          (left.kind === "workspace" ? (left.workspaceLayer ?? 0) : 0) ||
        compareText(left.sourceRef, right.sourceRef),
    );
  const rejectedSourceRefs = new Set<string>();
  const reportedConflicts = new Set<string>();
  for (const matching of duplicateSourceGroups(sources)) {
    rejectSources(
      matching,
      matching[0]?.kind ?? "source",
      rejectedSourceRefs,
      reportedConflicts,
      diagnostics,
    );
  }

  const userSources = sources.filter(source => source.kind === "user");
  if (userSources.length > 1) {
    rejectSources(
      userSources,
      "user",
      rejectedSourceRefs,
      reportedConflicts,
      diagnostics,
    );
  }

  const workspaceSources = sources.filter(source => source.kind === "workspace");
  if (workspaceSources.length > 1 && !hasValidWorkspaceOrder(workspaceSources)) {
    rejectSources(
      workspaceSources,
      "workspace",
      rejectedSourceRefs,
      reportedConflicts,
      diagnostics,
    );
  }

  for (const source of sources) {
    if (!hasValidSourceMetadata(source)) {
      rejectSources(
        [source],
        source.kind,
        rejectedSourceRefs,
        reportedConflicts,
        diagnostics,
      );
    } else if (
      source.kind === "external-profile" && source.profileName !== input.nativeProfile
    ) {
      rejectedSourceRefs.add(source.sourceRef);
    }
  }

  const selectedProfiles = sources.filter(source =>
    source.kind === "external-profile" &&
    source.profileName === input.nativeProfile &&
    !rejectedSourceRefs.has(source.sourceRef),
  );
  if (selectedProfiles.length > 1) {
    rejectSources(
      selectedProfiles,
      "external-profile",
      rejectedSourceRefs,
      reportedConflicts,
      diagnostics,
    );
  }
  if (
    input.nativeProfile !== undefined &&
    selectedProfiles.every(source => rejectedSourceRefs.has(source.sourceRef))
  ) {
    diagnostics.push({ code: "profile_missing" });
  }
  return { rejectedSourceRefs, sources };
};

const createApplySettings = (collections: InspectionCollections) =>
  (document: Readonly<Record<string, unknown>>, source: PreparedSource): void => {
    const safeProjection =
      collections.safeProjectionBySource.get(source.sourceRef) ?? new Map();
    collections.safeProjectionBySource.set(source.sourceRef, safeProjection);
    for (const key of Object.keys(document).toSorted()) {
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
    if (binding.rejectedSourceRefs.has(source.sourceRef)) {
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
      if (
        read.kind === "missing" &&
        source.kind === "external-profile" &&
        source.profileName === input.nativeProfile
      ) {
        collections.diagnostics.push({ code: "profile_missing" });
      } else if (read.kind !== "missing") {
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
  collections: InspectionCollections,
): void => {
  const applySettings = createApplySettings(collections);
  for (const source of preparedSources) {
    applySettings(source.document, source);
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
  const bindingDiagnostics: CodexConfigurationDiagnostic[] = [];
  const bound = bindSources(input, identityKey, bindingDiagnostics);
  if (input.dialect !== "codex-0.134") {
    collections.diagnostics.push({ code: "configuration_dialect_unsupported" });
    for (const source of bound.sources) {
      collections.sourceObservations.push({
        displayPath: source.displayPath,
        kind: source.kind,
        sourceRef: source.sourceRef,
        status: "rejected",
      });
    }
    return buildResult(collections);
  }
  collections.diagnostics.push(...bindingDiagnostics);
  const preparedSources = await prepareSources(
    dependencies,
    input,
    bound,
    collections,
    signal,
  );
  applyPreparedSources(preparedSources, collections);
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
