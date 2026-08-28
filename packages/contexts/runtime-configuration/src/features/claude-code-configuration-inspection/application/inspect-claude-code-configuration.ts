import { createHash, createHmac } from "node:crypto";

import {
  CLAUDE_CODE_CONFIGURATION_BUDGETS, CLAUDE_CODE_OBSERVED_SOURCE_PLAN_CONTRACT,
  CLAUDE_CODE_SETTINGS_DIALECT, type ClaudeCodeConfigurationDiagnostic,
  type ClaudeCodeConfigurationSource, type ClaudeCodeDeferredModelObservation,
  type ClaudeCodeSourceObservation, type InspectClaudeCodeConfiguration,
  type InspectClaudeCodeConfigurationInput, type InspectClaudeCodeConfigurationResult,
  type ObservedPortableClaudeCodeIntent, type TrustedClaudeCodeObservedSourcePlan,
} from "../contracts/claude-code-configuration-inspection.js";
import type { ClaudeCodeJsonParser } from "./ports/outbound/claude-code-json-parser.js";
import {
  claudeCodeConfigurationSemanticClassifierContract,
  type ClaudeCodeConfigurationSemanticClassifier, type DeferredClaudeCodeDefinition,
  type PortableClaudeCodeDefinition,
} from "./ports/outbound/claude-code-configuration-semantic-classifier.js";
import type { ClaudeCodeConfigurationSourceReader } from "./ports/outbound/claude-code-configuration-source-reader.js";
import {
  normalizeParsedClaudeCodeDocument, validateClaudeCodeJsonParseResult,
  validateClaudeCodeSemanticClassification,
} from "./safe-semantic-boundary.js";

interface Dependencies {
  readonly parser: ClaudeCodeJsonParser;
  readonly semanticClassifier: ClaudeCodeConfigurationSemanticClassifier;
  readonly sourceIdentityKey: Uint8Array;
  readonly sourceReader: ClaudeCodeConfigurationSourceReader;
}

type BoundSource = ClaudeCodeConfigurationSource & { readonly sourceRef: string };

interface EvaluatedSource {
  readonly bytesRead: number;
  readonly deferredObservations: readonly DeferredClaudeCodeDefinition[];
  readonly definitions: readonly PortableClaudeCodeDefinition[];
  readonly observation: ClaudeCodeSourceObservation;
}

const compareText = (left: string, right: string): number => left === right ? 0 : left < right ? -1 : 1;
const identifier = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/u;
const opaqueToken = /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,127}$/u;
const roles = new Set(["user", "shared-project", "project-local"]);
const selectionBases = new Set([
  "home-default", "claude-config-dir", "session-primary-working-directory", "repository-root",
  "main-worktree-root", "legacy-starting-directory", "caller-explicit", "static-preview",
]);
const exactObjectKeys = (value: unknown, allowed: readonly string[], required = allowed): boolean =>
  typeof value === "object" && value !== null && !Array.isArray(value) &&
  Object.getOwnPropertySymbols(value).length === 0 &&
  Object.keys(value).every(key => allowed.includes(key)) && required.every(key => Object.hasOwn(value, key));

const hmac = (key: Uint8Array, domain: string, value: unknown): string =>
  `${domain}:hmac-sha256:${createHmac("sha256", key).update(JSON.stringify(value)).digest("hex")}`;

const collectorPreimage = (plan: TrustedClaudeCodeObservedSourcePlan) => ({
  bundleId: plan.collector.bundleId, id: plan.collector.id,
  observationEpoch: plan.collector.observationEpoch,
  platform: plan.collector.platform, version: plan.collector.version,
});

const topologyPreimage = (plan: TrustedClaudeCodeObservedSourcePlan) => ({
  claim: plan.claim,
  collector: collectorPreimage(plan),
  contract: plan.contract,
  roots: plan.roots.map(root => ({
    absolutePath: root.absolutePath, canonicalPath: root.canonicalPath, rootId: root.rootId,
  })).toSorted((left, right) => compareText(left.rootId, right.rootId)),
  sources: plan.sources.map(source => ({
    access: source.access,
    ...(source.access === "authorized" ? {
      absolutePath: source.absolutePath, canonicalPath: source.canonicalPath,
      custodyRootRef: source.custodyRoot.rootId,
    } : { custodyRootRef: source.custodyRootRef }),
    locationClaims: [...(source.locationClaims ?? [])].toSorted(), observationEpoch: source.observationEpoch,
    role: source.role, selectionBasis: source.selectionBasis, sourceId: source.sourceId,
    trust: source.trust,
  })).toSorted((left, right) => compareText(left.sourceId, right.sourceId)),
});

const safeDisplayPath = (source: ClaudeCodeConfigurationSource): string =>
  `$CLAUDE_OBSERVED/${source.role}/${source.selectionBasis}/settings.json`;

const pathValid = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 &&
  value.length <= CLAUDE_CODE_CONFIGURATION_BUDGETS.pathLength && !value.includes("\0") && value.startsWith("/");

const pathWithin = (root: string, candidate: string): boolean =>
  root === "/" ? candidate.startsWith("/") : candidate === root || candidate.startsWith(`${root}/`);

type PlanDiagnostic = ClaudeCodeConfigurationDiagnostic["code"];

const validateCollector = (collector: TrustedClaudeCodeObservedSourcePlan["collector"]): PlanDiagnostic | undefined => {
  if (!exactObjectKeys(collector, ["bundleId", "id", "observationEpoch", "platform", "version"])) {
    return "source_plan_invalid";
  }
  if (collector.platform !== "darwin") {return "source_plan_invalid";}
  const identifiers = [collector.id, collector.version, collector.observationEpoch, collector.bundleId];
  return identifiers.every(value => identifier.test(value)) ? undefined : "source_plan_invalid";
};

const collectRootIds = (
  roots: TrustedClaudeCodeObservedSourcePlan["roots"],
): { readonly diagnostic?: PlanDiagnostic; readonly rootIds: ReadonlySet<string> } => {
  const rootIds = new Set<string>();
  for (const root of roots) {
    if (!exactObjectKeys(root, ["absolutePath", "canonicalPath", "rootId"])) {
      return { diagnostic: "source_plan_invalid", rootIds };
    }
    if (!identifier.test(root.rootId) || rootIds.has(root.rootId)) {
      return { diagnostic: "source_plan_invalid", rootIds };
    }
    if (!pathValid(root.absolutePath) || !pathValid(root.canonicalPath)) {
      return { diagnostic: "source_plan_invalid", rootIds };
    }
    rootIds.add(root.rootId);
  }
  return { rootIds };
};

const sourceShapeValid = (source: ClaudeCodeConfigurationSource): boolean => {
  const required = ["access", "displayPath", "observationEpoch", "role", "selectionBasis", "sourceId", "trust"];
  return source.access === "authorized"
    ? exactObjectKeys(source, [...required, "absolutePath", "authorizedFileIdentity", "canonicalPath", "custodyRoot", "locationClaims"],
      [...required, "absolutePath", "canonicalPath", "custodyRoot"])
    : exactObjectKeys(source, [...required, "custodyRootRef", "locationClaims"], [...required, "custodyRootRef"]);
};

const validateSourceEvidence = (
  source: ClaudeCodeConfigurationSource,
  observationEpoch: string,
  sourceIds: Set<string>,
): PlanDiagnostic | undefined => {
  if (!sourceShapeValid(source) || typeof source.displayPath !== "string") {return "source_plan_invalid";}
  if (source.displayPath.length > CLAUDE_CODE_CONFIGURATION_BUDGETS.pathLength) {return "source_plan_invalid";}
  if (source.locationClaims !== undefined && !Array.isArray(source.locationClaims)) {return "source_plan_invalid";}
  if (!identifier.test(source.sourceId) || sourceIds.has(source.sourceId)) {return "source_plan_invalid";}
  if (source.observationEpoch !== observationEpoch) {return "source_plan_invalid";}
  const claims = source.locationClaims ?? [];
  if (claims.length > CLAUDE_CODE_CONFIGURATION_BUDGETS.locationClaimsPerSource) {return "source_plan_invalid";}
  if (new Set(claims).size !== claims.length || claims.some(claim => !identifier.test(claim))) {
    return "source_plan_invalid";
  }
  sourceIds.add(source.sourceId);
  return undefined;
};

const validateSourceSemantics = (source: ClaudeCodeConfigurationSource): PlanDiagnostic | undefined => {
  if (!roles.has(source.role) || !selectionBases.has(source.selectionBasis)) {return "source_plan_unsupported";}
  if (!["user", "workspace-trusted", "workspace-untrusted"].includes(source.trust)) {
    return "source_plan_unsupported";
  }
  if (!["authorized", "rejected", "stale", "untrusted"].includes(source.access)) {
    return "source_plan_unsupported";
  }
  if ((source.role === "user") !== (source.trust === "user")) {return "source_plan_invalid";}
  if (source.access === "authorized" && source.trust === "workspace-untrusted") {return "source_plan_invalid";}
  if ((source.access === "untrusted") !== (source.trust === "workspace-untrusted")) {
    return "source_plan_invalid";
  }
  return undefined;
};

const validateAuthorizedSource = (
  source: Extract<ClaudeCodeConfigurationSource, { readonly access: "authorized" }>,
  plan: TrustedClaudeCodeObservedSourcePlan,
  canonicalSources: Set<string>,
): PlanDiagnostic | undefined => {
  if (!exactObjectKeys(source.custodyRoot, ["absolutePath", "canonicalPath", "rootId"])) {
    return "source_plan_invalid";
  }
  if (!pathValid(source.absolutePath) || !pathValid(source.canonicalPath)) {return "source_plan_invalid";}
  if (source.authorizedFileIdentity !== undefined && !opaqueToken.test(source.authorizedFileIdentity)) {
    return "source_plan_invalid";
  }
  if (!pathWithin(source.custodyRoot.canonicalPath, source.canonicalPath)) {return "source_plan_invalid";}
  const root = plan.roots.find(item => item.rootId === source.custodyRoot.rootId);
  if (source.custodyRoot.absolutePath !== root?.absolutePath ||
      source.custodyRoot.canonicalPath !== root?.canonicalPath) {
    return "source_plan_invalid";
  }
  if (canonicalSources.has(source.canonicalPath)) {return "source_plan_invalid";}
  canonicalSources.add(source.canonicalPath);
  return undefined;
};

const validateSources = (
  plan: TrustedClaudeCodeObservedSourcePlan,
  rootIds: ReadonlySet<string>,
): PlanDiagnostic | undefined => {
  const sourceIds = new Set<string>();
  const canonicalSources = new Set<string>();
  for (const source of plan.sources) {
    const evidenceDiagnostic = validateSourceEvidence(source, plan.collector.observationEpoch, sourceIds);
    if (evidenceDiagnostic !== undefined) {return evidenceDiagnostic;}
    const semanticDiagnostic = validateSourceSemantics(source);
    if (semanticDiagnostic !== undefined) {return semanticDiagnostic;}
    const rootRef = source.access === "authorized" ? source.custodyRoot.rootId : source.custodyRootRef;
    if (!rootIds.has(rootRef)) {return "source_plan_invalid";}
    if (source.access === "authorized") {
      const authorizedDiagnostic = validateAuthorizedSource(source, plan, canonicalSources);
      if (authorizedDiagnostic !== undefined) {return authorizedDiagnostic;}
    }
  }
  return undefined;
};

const validatePlan = (plan: TrustedClaudeCodeObservedSourcePlan): PlanDiagnostic | undefined => {
  if (typeof plan !== "object" || plan === null || Array.isArray(plan)) {return "source_plan_unsupported";}
  if (plan.contract !== CLAUDE_CODE_OBSERVED_SOURCE_PLAN_CONTRACT || plan.claim !== "observed-files-only") {
    return "source_plan_unsupported";
  }
  if (!exactObjectKeys(plan, ["claim", "collector", "contract", "roots", "sources"])) {
    return "source_plan_invalid";
  }
  if (!Array.isArray(plan.roots) || !Array.isArray(plan.sources)) {return "source_plan_invalid";}
  if (plan.roots.length > CLAUDE_CODE_CONFIGURATION_BUDGETS.rootSlots ||
      plan.sources.length > CLAUDE_CODE_CONFIGURATION_BUDGETS.sourceSlots) {
    return "source_inventory_overflow";
  }
  const collectorDiagnostic = validateCollector(plan.collector);
  if (collectorDiagnostic !== undefined) {return collectorDiagnostic;}
  const roots = collectRootIds(plan.roots);
  return roots.diagnostic ?? validateSources(plan, roots.rootIds);
};

const semanticDigest = (
  definitions: readonly PortableClaudeCodeDefinition[],
  deferredObservations: readonly DeferredClaudeCodeDefinition[],
  dialect: string,
  classifier: ClaudeCodeConfigurationSemanticClassifier,
): string => {
  const settings = definitions.map(definition => definition.key === "model"
    ? [definition.key, definition.selection]
    : [definition.key, definition.value]).toSorted(([left], [right]) => compareText(String(left), String(right)));
  const preimage = {
    classifierContract: classifier.contract, classifierRevision: classifier.revision,
    deferredObservations: deferredObservations.map(item => ({ form: item.form, key: item.key, status: item.status })),
    dialect, digestSchema: "claude-code-configuration-semantic-digest/v2", settings,
  };
  return `claude-code-configuration-semantic-digest/v2:sha256:${createHash("sha256")
    .update(JSON.stringify(preimage)).digest("hex")}`;
};

const normalizeReadResult = (value: unknown):
  | { readonly bytes: Uint8Array; readonly status: "read" }
  | { readonly status: "missing" | "stale" | "too-large" | "unreadable" }
  | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value) ||
      Object.getOwnPropertySymbols(value).length > 0) {return undefined;}
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (!Object.values(descriptors).every(item => item.enumerable && "value" in item && !item.get && !item.set)) {return undefined;}
  const status = descriptors["status"]?.value;
  if (status === "read" && Object.keys(descriptors).length === 2 && descriptors["bytes"]?.value instanceof Uint8Array) {
    return { bytes: Uint8Array.from(descriptors["bytes"].value), status };
  }
  if (Object.keys(descriptors).length === 1 &&
      (status === "missing" || status === "stale" || status === "too-large" || status === "unreadable")) {
    return { status };
  }
  return undefined;
};

const statusObservation = (
  source: BoundSource, status: ClaudeCodeSourceObservation["status"], semanticDigestValue?: string,
): ClaudeCodeSourceObservation => Object.freeze({
  displayPath: safeDisplayPath(source), role: source.role, selectionBasis: source.selectionBasis,
  ...(semanticDigestValue === undefined ? {} : { semanticDigest: semanticDigestValue }),
  sourceRef: source.sourceRef, status,
});

const readSource = async (
  source: Extract<BoundSource, { readonly access: "authorized" }>,
  sourceReader: ClaudeCodeConfigurationSourceReader,
  signal?: AbortSignal,
): Promise<ReturnType<typeof normalizeReadResult>> => {
  let rawRead: unknown;
  try {
    rawRead = await sourceReader.read(
      source, CLAUDE_CODE_CONFIGURATION_BUDGETS.bytesPerSource,
      signal === undefined ? undefined : { signal },
    );
  } catch { signal?.throwIfAborted(); }
  signal?.throwIfAborted();
  return normalizeReadResult(rawRead);
};

const parseSource = (
  bytes: Uint8Array,
  parser: ClaudeCodeJsonParser,
  signal?: AbortSignal,
): { readonly data: Readonly<Record<string, unknown>> } | { readonly diagnostic: ClaudeCodeConfigurationDiagnostic["code"] } => {
  let parsed;
  try { parsed = validateClaudeCodeJsonParseResult(parser.parse(bytes, signal ? { signal } : undefined)); }
  catch { signal?.throwIfAborted(); }
  signal?.throwIfAborted();
  if (parsed?.status !== "parsed") {return { diagnostic: parsed?.diagnostic ?? "config_parse_failed" };}
  const document = normalizeParsedClaudeCodeDocument(parsed.data);
  return document === undefined ? { diagnostic: "config_parse_failed" } : { data: document };
};

const classifySource = (
  document: Readonly<Record<string, unknown>>,
  input: InspectClaudeCodeConfigurationInput,
  classifier: ClaudeCodeConfigurationSemanticClassifier,
  signal?: AbortSignal,
): ReturnType<typeof validateClaudeCodeSemanticClassification> | undefined => {
  let classification;
  try {
    classification = validateClaudeCodeSemanticClassification(classifier.classify(
      input.dialect, document, signal ? { signal } : undefined,
    ));
  } catch { signal?.throwIfAborted(); }
  signal?.throwIfAborted();
  return classification;
};

const appendClassificationDiagnostics = (
  target: ClaudeCodeConfigurationDiagnostic[],
  classification: ReturnType<typeof validateClaudeCodeSemanticClassification>,
  sourceRef: string,
): void => {
  for (const diagnostic of classification.diagnostics) {
    if (target.length < CLAUDE_CODE_CONFIGURATION_BUDGETS.diagnostics) {
      target.push({ code: diagnostic.code, safeRef: sourceRef });
    }
  }
};

const evaluateSource = async (
  source: BoundSource, input: InspectClaudeCodeConfigurationInput, dependencies: Dependencies,
  diagnostics: ClaudeCodeConfigurationDiagnostic[], signal?: AbortSignal,
): Promise<EvaluatedSource> => {
  const empty = (status: ClaudeCodeSourceObservation["status"]): EvaluatedSource =>
    ({ bytesRead: 0, definitions: [], deferredObservations: [], observation: statusObservation(source, status) });
  signal?.throwIfAborted();
  if (source.access !== "authorized") {
    const code = source.access === "untrusted" ? "source_untrusted" : "source_epoch_stale";
    diagnostics.push({ code, safeRef: source.sourceRef });
    return empty(source.access === "stale" ? "stale" : "rejected");
  }
  const read = await readSource(source, dependencies.sourceReader, signal);
  if (read?.status !== "read") {
    if (read?.status !== "missing") {
      diagnostics.push({
        code: read?.status === "stale" ? "source_epoch_stale" :
          read?.status === "too-large" ? "config_too_large" : "config_unreadable",
        safeRef: source.sourceRef,
      });
    }
    return empty(read?.status === "missing" ? "missing" : read?.status === "stale" ? "stale" : "unreadable");
  }
  const parsed = parseSource(read.bytes, dependencies.parser, signal);
  if ("diagnostic" in parsed) {
    diagnostics.push({ code: parsed.diagnostic, safeRef: source.sourceRef });
    return empty("malformed");
  }
  const classification = classifySource(parsed.data, input, dependencies.semanticClassifier, signal);
  if (classification === undefined) {
    diagnostics.push({ code: "config_parse_failed", safeRef: source.sourceRef }); return empty("malformed");
  }
  appendClassificationDiagnostics(diagnostics, classification, source.sourceRef);
  return {
    bytesRead: read.bytes.byteLength,
    deferredObservations: classification.deferredObservations,
    definitions: classification.definitions,
    observation: statusObservation(source, "applied", semanticDigest(
      classification.definitions, classification.deferredObservations,
      input.dialect, dependencies.semanticClassifier,
    )),
  };
};

interface ResultParts {
  readonly classifierRevision: string;
  readonly collectorRef: string;
  readonly diagnostics: readonly ClaudeCodeConfigurationDiagnostic[];
  readonly evaluated: readonly EvaluatedSource[];
  readonly input: InspectClaudeCodeConfigurationInput;
  readonly topologyRef: string;
}

const buildResult = (parts: ResultParts): InspectClaudeCodeConfigurationResult => {
  const { classifierRevision, collectorRef, diagnostics, evaluated, input, topologyRef } = parts;
  const deferredObservations: ClaudeCodeDeferredModelObservation[] = [];
  const observedPortableIntent: ObservedPortableClaudeCodeIntent[] = [];
  const sources = evaluated.map(item => item.observation).toSorted((a, b) => compareText(a.sourceRef, b.sourceRef));
  for (const item of evaluated) {
    for (const definition of item.definitions) {
      observedPortableIntent.push(definition.key === "model"
        ? Object.freeze({ key: "model", selection: definition.selection, sourceRef: item.observation.sourceRef })
        : Object.freeze({ key: "effortLevel", value: definition.value, sourceRef: item.observation.sourceRef }));
    }
    for (const deferred of item.deferredObservations) {
      deferredObservations.push(Object.freeze({ ...deferred, sourceRef: item.observation.sourceRef }));
    }
  }
  return Object.freeze({
    deferredObservations: Object.freeze(deferredObservations.toSorted((a, b) => compareText(a.sourceRef, b.sourceRef))),
    diagnostics: Object.freeze(diagnostics.toSorted((a, b) => compareText(`${a.code}:${a.safeRef ?? ""}`, `${b.code}:${b.safeRef ?? ""}`))
      .map(item => Object.freeze({ ...item }))),
    observedPortableIntent: Object.freeze(observedPortableIntent.toSorted((a, b) =>
      compareText(`${a.sourceRef}:${a.key}`, `${b.sourceRef}:${b.key}`))),
    sourceModel: Object.freeze({
      claim: "observed-files-only", classifierRevision,
      collectorRef, compatibility: "unqualified", contract: CLAUDE_CODE_OBSERVED_SOURCE_PLAN_CONTRACT,
      dialect: input.dialect, precedence: "not-evaluated", topologyRef,
    }),
    sources: Object.freeze(sources),
  });
};

const rejectedEvaluations = (sources: readonly BoundSource[]): readonly EvaluatedSource[] =>
  sources.map(source => ({
    bytesRead: 0, definitions: [], deferredObservations: [], observation: statusObservation(source, "rejected"),
  }));

const measureWithinBudget = async (
  sources: readonly BoundSource[],
  sourceReader: ClaudeCodeConfigurationSourceReader,
  signal?: AbortSignal,
): Promise<boolean> => {
  if (sourceReader.measure === undefined) {return true;}
  let aggregateBytes = 0;
  for (const source of sources) {
    signal?.throwIfAborted();
    if (source.access !== "authorized") {continue;}
    const measurement = await sourceReader.measure(source, signal === undefined ? undefined : { signal });
    if (measurement.status === "measured") {aggregateBytes += measurement.bytes;}
  }
  return aggregateBytes <= CLAUDE_CODE_CONFIGURATION_BUDGETS.aggregateSourceBytes;
};

const evaluateSources = async (
  sources: readonly BoundSource[],
  input: InspectClaudeCodeConfigurationInput,
  dependencies: Dependencies,
  diagnostics: ClaudeCodeConfigurationDiagnostic[],
  signal?: AbortSignal,
): Promise<readonly EvaluatedSource[] | undefined> => {
  const evaluated: EvaluatedSource[] = [];
  let aggregateBytesRead = 0;
  for (const source of sources) {
    const observation = await evaluateSource(source, input, dependencies, diagnostics, signal);
    aggregateBytesRead += observation.bytesRead;
    if (aggregateBytesRead > CLAUDE_CODE_CONFIGURATION_BUDGETS.aggregateSourceBytes) {return undefined;}
    evaluated.push(observation);
  }
  return evaluated;
};

export const createInspectClaudeCodeConfiguration = (dependencies: Dependencies): InspectClaudeCodeConfiguration => {
  if (dependencies.semanticClassifier.contract !== claudeCodeConfigurationSemanticClassifierContract ||
      !identifier.test(dependencies.semanticClassifier.revision)) {
    throw new TypeError("semanticClassifier must implement the versioned contract");
  }
  if (dependencies.sourceIdentityKey.byteLength < 32) {throw new TypeError("sourceIdentityKey must contain at least 32 bytes");}
  const key = Uint8Array.from(dependencies.sourceIdentityKey);
  const inspect: InspectClaudeCodeConfiguration = {
    async execute(input, options) {
      options?.signal?.throwIfAborted();
      if (!identifier.test(input.identityScope)) {throw new TypeError("identityScope must be a stable identifier");}
      const planDiagnostic = validatePlan(input.sourcePlan);
      const invalidTopologyRef = hmac(key, "claude-code-topology/v2", [input.identityScope, planDiagnostic ?? "invalid"]);
      if (planDiagnostic !== undefined) {
        const invalidCollectorRef = hmac(key, "claude-code-collector/v2", [input.identityScope, "unobserved"]);
        return buildResult({
          classifierRevision: dependencies.semanticClassifier.revision,
          collectorRef: invalidCollectorRef, diagnostics: [{ code: planDiagnostic }],
          evaluated: [], input, topologyRef: invalidTopologyRef,
        });
      }
      const collectorRef = hmac(key, "claude-code-collector/v2", collectorPreimage(input.sourcePlan));
      const topologyRef = hmac(key, "claude-code-topology/v2", topologyPreimage(input.sourcePlan));
      const bound = input.sourcePlan.sources.map(source => Object.freeze({
        ...source,
        sourceRef: hmac(key, "claude-code-source/v2", [input.identityScope, topologyRef, source.sourceId]),
      })).toSorted((a, b) => compareText(a.sourceId, b.sourceId));
      if (input.dialect !== CLAUDE_CODE_SETTINGS_DIALECT || !dependencies.semanticClassifier.supportsDialect(input.dialect)) {
        return buildResult({
          classifierRevision: dependencies.semanticClassifier.revision, collectorRef,
          diagnostics: [{ code: "configuration_dialect_unsupported" }],
          evaluated: rejectedEvaluations(bound), input, topologyRef,
        });
      }
      if (!await measureWithinBudget(bound, dependencies.sourceReader, options?.signal)) {
        return buildResult({
          classifierRevision: dependencies.semanticClassifier.revision, collectorRef,
          diagnostics: [{ code: "source_total_too_large" }],
          evaluated: rejectedEvaluations(bound), input, topologyRef,
        });
      }
      const diagnostics: ClaudeCodeConfigurationDiagnostic[] = [];
      const evaluated = await evaluateSources(bound, input, dependencies, diagnostics, options?.signal);
      if (evaluated === undefined) {
        return buildResult({
          classifierRevision: dependencies.semanticClassifier.revision, collectorRef,
          diagnostics: [{ code: "source_total_too_large" }],
          evaluated: rejectedEvaluations(bound), input, topologyRef,
        });
      }
      options?.signal?.throwIfAborted();
      return buildResult({
        classifierRevision: dependencies.semanticClassifier.revision, collectorRef,
        diagnostics, evaluated, input, topologyRef,
      });
    },
  };
  return Object.freeze(inspect);
};
