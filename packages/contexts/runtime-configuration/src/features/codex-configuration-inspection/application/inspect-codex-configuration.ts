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
import {
  codexConfigurationSemanticClassifierContract,
  type CodexConfigurationSemanticClassifier,
} from "./ports/outbound/codex-configuration-semantic-classifier.js";
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
  readonly semanticClassifier: CodexConfigurationSemanticClassifier;
  readonly sourceIdentityKey: Uint8Array;
  readonly sourceReader: ConfigurationSourceReader;
}

const sourceRanks: Readonly<Record<CodexConfigurationSourceKind, number>> = {
  user: 10,
  "external-profile": 20,
  workspace: 30,
};

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
  const sourcesByCanonicalPath = new Map<string, BoundSource[]>();
  for (const source of sources) {
    const matching = sourcesByCanonicalPath.get(source.canonicalPath) ?? [];
    matching.push(source);
    sourcesByCanonicalPath.set(source.canonicalPath, matching);
  }
  return [...sourcesByCanonicalPath.values()].filter(matching => matching.length > 1);
};

const duplicateSourceSetting = (sources: readonly BoundSource[]): string =>
  new Set(sources.map(source => source.kind)).size === 1
    ? (sources[0]?.kind ?? "source") : "source";

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
      duplicateSourceSetting(matching),
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

const createApplySettings = (
  classifier: CodexConfigurationSemanticClassifier,
  dialect: string,
  collections: InspectionCollections,
) =>
  (document: Readonly<Record<string, unknown>>, source: PreparedSource): void => {
    const safeProjection =
      collections.safeProjectionBySource.get(source.sourceRef) ?? new Map();
    collections.safeProjectionBySource.set(source.sourceRef, safeProjection);
    const classification = classifier.classify(dialect, document);
    for (const diagnostic of classification.diagnostics) {
      collections.diagnostics.push({
        ...diagnostic,
        sourceRef: source.sourceRef,
      });
    }
    for (const setting of classification.settings) {
      collections.effective.set(setting.key, {
        key: setting.key,
        sourceRef: source.sourceRef,
        value: setting.value,
      });
      safeProjection.set(setting.key, setting.value);
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
  classifier: CodexConfigurationSemanticClassifier,
  dialect: string,
  collections: InspectionCollections,
): void => {
  const applySettings = createApplySettings(classifier, dialect, collections);
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
  if (!dependencies.semanticClassifier.supportsDialect(input.dialect)) {
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
  applyPreparedSources(
    preparedSources,
    dependencies.semanticClassifier,
    input.dialect,
    collections,
  );
  return buildResult(collections);
};

export const createInspectCodexConfiguration = (
  dependencies: InspectionDependencies,
): InspectCodexConfiguration => {
  if (
    dependencies.semanticClassifier.contract !==
      codexConfigurationSemanticClassifierContract ||
    dependencies.semanticClassifier.revision.length === 0
  ) {
    throw new TypeError("semanticClassifier must implement the versioned contract");
  }
  if (dependencies.sourceIdentityKey.byteLength < 32) {
    throw new TypeError("sourceIdentityKey must contain at least 32 bytes");
  }
  const identityKey = Uint8Array.from(dependencies.sourceIdentityKey);
  return {
    execute: (input, options) =>
      executeInspection(dependencies, identityKey, input, options?.signal),
  };
};
