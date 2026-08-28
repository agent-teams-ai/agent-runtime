import { createHash, createHmac } from "node:crypto";

import {
  CLAUDE_CODE_CONFIGURATION_BUDGETS,
  CLAUDE_CODE_SETTINGS_DIALECT,
  type ClaudeCodeConfigurationDiagnostic,
  type ClaudeCodeConfigurationSource,
  type ClaudeCodeConfigurationSourceKind,
  type ClaudeCodeSourceObservation,
  type InspectClaudeCodeConfiguration,
  type InspectClaudeCodeConfigurationInput,
  type InspectClaudeCodeConfigurationResult,
  type PortableClaudeCodeIntent,
} from "../contracts/claude-code-configuration-inspection.js";
import type { ClaudeCodeJsonParser } from "./ports/outbound/claude-code-json-parser.js";
import {
  claudeCodeConfigurationSemanticClassifierContract,
  type ClaudeCodeConfigurationSemanticClassifier,
  type PortableClaudeCodeDefinition,
} from "./ports/outbound/claude-code-configuration-semantic-classifier.js";
import type { ClaudeCodeConfigurationSourceReader } from "./ports/outbound/claude-code-configuration-source-reader.js";
import {
  normalizeParsedClaudeCodeDocument,
  validateClaudeCodeJsonParseResult,
  validateClaudeCodeSemanticClassification,
} from "./safe-semantic-boundary.js";

interface Dependencies {
  readonly parser: ClaudeCodeJsonParser;
  readonly semanticClassifier: ClaudeCodeConfigurationSemanticClassifier;
  readonly sourceIdentityKey: Uint8Array;
  readonly sourceReader: ClaudeCodeConfigurationSourceReader;
}

type BoundSource = ClaudeCodeConfigurationSource & {
  readonly structurallyRejected: boolean;
  readonly sourceRef: string;
};

type AuthorizedBoundSource = Extract<BoundSource, { readonly access: "authorized" }>;

interface EvaluatedSource {
  readonly definitions: ReadonlyMap<"model" | "effortLevel", PortableClaudeCodeDefinition>;
  readonly grossTaint: boolean;
  readonly source: BoundSource;
  readonly taintedKeys: ReadonlySet<"model" | "effortLevel">;
}

interface SourceEvaluationContext {
  readonly dependencies: Dependencies;
  readonly diagnostics: ClaudeCodeConfigurationDiagnostic[];
  readonly input: InspectClaudeCodeConfigurationInput;
  readonly observations: ClaudeCodeSourceObservation[];
  readonly signal?: AbortSignal;
}

interface RejectedSourceDetails {
  readonly code?: ClaudeCodeConfigurationDiagnostic["code"];
  readonly grossTaint?: boolean;
  readonly status: ClaudeCodeSourceObservation["status"];
}

const sourceRanks: Readonly<Record<ClaudeCodeConfigurationSourceKind, number>> = {
  user: 1, "shared-project": 2, "project-local": 3,
};

const safeDisplayPaths: Readonly<Record<ClaudeCodeConfigurationSourceKind, string>> = Object.freeze({
  user: "$HOME/.claude/settings.json",
  "shared-project": "$WORKSPACE/.claude/settings.json",
  "project-local": "$WORKSPACE/.claude/settings.local.json",
});

const compareText = (left: string, right: string): number => left === right ? 0 : left < right ? -1 : 1;

const sourceRef = (
  key: Uint8Array,
  scope: string,
  source: ClaudeCodeConfigurationSource,
): string => `claude-config-source:${createHmac("sha256", key)
  .update(`${scope}\0${source.kind}`)
  .digest("hex")}`;

const validSource = (source: ClaudeCodeConfigurationSource): boolean =>
  source.access !== "authorized" ||
  (source.absolutePath.length > 0 && source.canonicalPath.length > 0 &&
    source.custodyRoot.absolutePath.length > 0 &&
    source.custodyRoot.canonicalPath.length > 0);

const bindSources = (
  input: InspectClaudeCodeConfigurationInput,
  identityKey: Uint8Array,
): { readonly diagnostics: readonly ClaudeCodeConfigurationDiagnostic[]; readonly sources: readonly BoundSource[] } => {
  const allSources = input.sources.map(source => ({
    ...source,
    displayPath: safeDisplayPaths[source.kind],
    structurallyRejected: false,
    sourceRef: sourceRef(identityKey, input.identityScope, source),
  })).toSorted((left, right) =>
    sourceRanks[left.kind] - sourceRanks[right.kind] ||
    compareText(left.sourceRef, right.sourceRef) || compareText(left.displayPath, right.displayPath));
  const tooManySources = allSources.length > CLAUDE_CODE_CONFIGURATION_BUDGETS.sourceSlots;
  const sources = allSources.slice(0, CLAUDE_CODE_CONFIGURATION_BUDGETS.sourceSlots);
  const rejected = new Set<BoundSource>();
  const byKind = new Map<ClaudeCodeConfigurationSourceKind, BoundSource[]>();
  const byCanonicalPath = new Map<string, BoundSource[]>();
  for (const source of sources) {
    const matchingKind = byKind.get(source.kind) ?? [];
    matchingKind.push(source);
    byKind.set(source.kind, matchingKind);
    if (source.access === "authorized") {
      const matchingPath = byCanonicalPath.get(source.canonicalPath) ?? [];
      matchingPath.push(source);
      byCanonicalPath.set(source.canonicalPath, matchingPath);
    }
    if (!validSource(source)) {rejected.add(source);}
  }
  for (const group of [...byKind.values(), ...byCanonicalPath.values()]) {
    if (group.length > 1) {
      for (const source of group) {
        rejected.add(source);
      }
    }
  }
  if (tooManySources) {
    for (const source of sources) {rejected.add(source);}
  }
  const bound = sources.map(source => ({
    ...source,
    structurallyRejected: rejected.has(source),
  }));
  return {
    diagnostics: bound.filter(source => source.structurallyRejected).map(source =>
      Object.freeze({ code: "source_untrusted" as const, safeRef: source.sourceRef })),
    sources: bound,
  };
};

const semanticDigest = (
  definitions: ReadonlyMap<"model" | "effortLevel", PortableClaudeCodeDefinition>,
  dialect: string,
  classifier: ClaudeCodeConfigurationSemanticClassifier,
): string => {
  const settings = [...definitions.values()]
    .map(definition => [definition.key, definition.value] as const)
    .toSorted(([left], [right]) => compareText(left, right));
  const preimage = {
    classifierContract: classifier.contract,
    classifierRevision: classifier.revision,
    dialect,
    digestSchema: "claude-code-configuration-semantic-digest/v1",
    settings,
  };
  return `claude-code-configuration-semantic-digest/v1:sha256:${createHash("sha256")
    .update(JSON.stringify(preimage)).digest("hex")}`;
};

const readFailureDiagnostic = (
  status: "stale" | "too-large" | "unreadable",
): ClaudeCodeConfigurationDiagnostic["code"] =>
  status === "stale" ? "source_epoch_stale" :
    status === "too-large" ? "config_too_large" : "config_unreadable";

const normalizeReadResult = (value: unknown):
  | { readonly bytes: Uint8Array; readonly status: "read" }
  | { readonly status: "missing" | "stale" | "too-large" | "unreadable" }
  | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value) ||
      Object.getOwnPropertySymbols(value).length > 0) {return undefined;}
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (!Object.values(descriptors).every(descriptor =>
    descriptor.enumerable === true && "value" in descriptor &&
    descriptor.get === undefined && descriptor.set === undefined)) {return undefined;}
  const status = descriptors["status"]?.value;
  if (status === "read" && Object.keys(descriptors).length === 2 &&
      descriptors["bytes"]?.value instanceof Uint8Array) {
    return { bytes: Uint8Array.from(descriptors["bytes"].value), status };
  }
  if ((status === "missing" || status === "stale" || status === "too-large" || status === "unreadable") &&
      Object.keys(descriptors).length === 1) {return { status };}
  return undefined;
};

const rejectedEvaluation = (
  source: BoundSource,
  grossTaint = true,
): EvaluatedSource => ({
  definitions: new Map(), grossTaint, source, taintedKeys: new Set(),
});

const observeRejectedSource = (
  context: SourceEvaluationContext,
  source: BoundSource,
  details: RejectedSourceDetails,
): EvaluatedSource => {
  if (details.code !== undefined) {
    context.diagnostics.push({ code: details.code, safeRef: source.sourceRef });
  }
  context.observations.push(Object.freeze({
    displayPath: source.displayPath, kind: source.kind,
    sourceRef: source.sourceRef, status: details.status,
  }));
  return rejectedEvaluation(source, details.grossTaint);
};

const rejectUnavailableSource = (
  context: SourceEvaluationContext,
  source: BoundSource,
): EvaluatedSource | undefined => {
  if (source.structurallyRejected) {
    return observeRejectedSource(context, source, { status: "rejected" });
  }
  if (source.access !== "authorized") {
    return observeRejectedSource(
      context,
      source,
      {
        code: source.access === "untrusted" ? "source_untrusted" : "source_epoch_stale",
        status: source.access === "stale" ? "stale" : "rejected",
      },
    );
  }
  if (source.observationEpoch !== context.input.observationEpoch) {
    return observeRejectedSource(context, source, {
      code: "source_epoch_stale", status: "stale",
    });
  }
  return undefined;
};

const readSource = async (
  context: SourceEvaluationContext,
  source: AuthorizedBoundSource,
): Promise<ReturnType<typeof normalizeReadResult>> => {
  try {
    return normalizeReadResult(await context.dependencies.sourceReader.read(
      source,
      CLAUDE_CODE_CONFIGURATION_BUDGETS.bytesPerSource,
      context.signal === undefined ? undefined : { signal: context.signal },
    ));
  } catch {
    context.signal?.throwIfAborted();
    return undefined;
  }
};

const evaluateReadFailure = (
  context: SourceEvaluationContext,
  source: BoundSource,
  read: Exclude<NonNullable<ReturnType<typeof normalizeReadResult>>, { readonly status: "read" }> | undefined,
): EvaluatedSource => {
  if (read === undefined) {
    return observeRejectedSource(context, source, {
      code: "config_unreadable", status: "unreadable",
    });
  }
  const code = read.status === "missing" ? undefined : readFailureDiagnostic(read.status);
  return observeRejectedSource(
    context,
    source,
    {
      ...(code === undefined ? {} : { code }),
      grossTaint: read.status !== "missing",
      status: read.status === "too-large" ? "unreadable" : read.status,
    },
  );
};

const parseSource = (
  context: SourceEvaluationContext,
  bytes: Uint8Array,
) => {
  try {
    return validateClaudeCodeJsonParseResult(context.dependencies.parser.parse(
      bytes,
      context.signal === undefined ? undefined : { signal: context.signal },
    )) ?? { diagnostic: "config_parse_failed" as const, status: "rejected" as const };
  } catch {
    return { diagnostic: "config_parse_failed" as const, status: "rejected" as const };
  }
};

const classifySource = (
  context: SourceEvaluationContext,
  document: Readonly<Record<string, unknown>>,
) => {
  try {
    return validateClaudeCodeSemanticClassification(
      context.dependencies.semanticClassifier.classify(
        context.input.dialect,
        document,
        context.signal === undefined ? undefined : { signal: context.signal },
      ),
    );
  } catch {
    context.signal?.throwIfAborted();
    return;
  }
};

const evaluateSource = async (
  context: SourceEvaluationContext,
  source: BoundSource,
): Promise<EvaluatedSource> => {
  context.signal?.throwIfAborted();
  const unavailable = rejectUnavailableSource(context, source);
  if (unavailable !== undefined) {return unavailable;}
  if (source.access !== "authorized") {
    return observeRejectedSource(context, source, { status: "rejected" });
  }

  const read = await readSource(context, source);
  context.signal?.throwIfAborted();
  if (read?.status !== "read") {return evaluateReadFailure(context, source, read);}

  const parsed = parseSource(context, read.bytes);
  context.signal?.throwIfAborted();
  if (parsed.status !== "parsed") {
    return observeRejectedSource(context, source, {
      code: parsed.diagnostic, status: "malformed",
    });
  }
  const document = normalizeParsedClaudeCodeDocument(parsed.data);
  if (document === undefined) {
    return observeRejectedSource(context, source, {
      code: "config_parse_failed", status: "malformed",
    });
  }
  const classification = classifySource(context, document);
  context.signal?.throwIfAborted();
  if (classification === undefined) {
    return observeRejectedSource(context, source, {
      code: "config_parse_failed", status: "malformed",
    });
  }
  const definitionMap = new Map(classification.definitions.map(definition => [definition.key, definition]));
  for (const diagnostic of classification.diagnostics) {
    if (context.diagnostics.length >= CLAUDE_CODE_CONFIGURATION_BUDGETS.diagnostics) {break;}
    context.diagnostics.push({ code: diagnostic.code, safeRef: source.sourceRef });
  }
  context.observations.push(Object.freeze({
    displayPath: source.displayPath, kind: source.kind,
    semanticDigest: semanticDigest(
      definitionMap, context.input.dialect, context.dependencies.semanticClassifier,
    ),
    sourceRef: source.sourceRef, status: "applied",
  }));
  return {
    definitions: definitionMap, grossTaint: false, source,
    taintedKeys: new Set(classification.taintedPortableKeys),
  };
};

const evaluateSources = async (
  context: SourceEvaluationContext,
  sources: readonly BoundSource[],
): Promise<readonly EvaluatedSource[]> => {
  const evaluated: EvaluatedSource[] = [];
  for (const source of sources) {evaluated.push(await evaluateSource(context, source));}
  return evaluated;
};

const resolveIntent = (evaluated: readonly EvaluatedSource[]): readonly PortableClaudeCodeIntent[] => {
  const output: PortableClaudeCodeIntent[] = [];
  for (const key of ["effortLevel", "model"] as const) {
    for (const source of evaluated.toReversed()) {
      if (source.grossTaint || source.taintedKeys.has(key)) {break;}
      const definition = source.definitions.get(key);
      if (definition !== undefined) {
        output.push(Object.freeze({ key, sourceRef: source.source.sourceRef, value: definition.value }) as PortableClaudeCodeIntent);
        break;
      }
    }
  }
  return Object.freeze(output);
};

const buildResult = (
  diagnostics: readonly ClaudeCodeConfigurationDiagnostic[],
  portableIntent: readonly PortableClaudeCodeIntent[],
  sources: readonly ClaudeCodeSourceObservation[],
): InspectClaudeCodeConfigurationResult => Object.freeze({
  diagnostics: Object.freeze(diagnostics.toSorted((left, right) =>
    compareText(`${left.code}:${left.safeRef ?? ""}`, `${right.code}:${right.safeRef ?? ""}`))
    .map(diagnostic => Object.freeze({ ...diagnostic }))),
  portableIntent,
  sources: Object.freeze(sources.toSorted((left, right) =>
    sourceRanks[left.kind] - sourceRanks[right.kind] || compareText(left.sourceRef, right.sourceRef) ||
    compareText(left.displayPath, right.displayPath))),
});

export const createInspectClaudeCodeConfiguration = (
  dependencies: Dependencies,
): InspectClaudeCodeConfiguration => {
  if (dependencies.semanticClassifier.contract !== claudeCodeConfigurationSemanticClassifierContract ||
      !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/u.test(dependencies.semanticClassifier.revision)) {
    throw new TypeError("semanticClassifier must implement the versioned contract");
  }
  if (dependencies.sourceIdentityKey.byteLength < 32) {
    throw new TypeError("sourceIdentityKey must contain at least 32 bytes");
  }
  const identityKey = Uint8Array.from(dependencies.sourceIdentityKey);
  return Object.freeze({
    async execute(
      input: InspectClaudeCodeConfigurationInput,
      options?: { readonly signal?: AbortSignal },
    ) {
      options?.signal?.throwIfAborted();
      if (input.identityScope.length === 0 || input.observationEpoch.length === 0) {
        throw new TypeError("identityScope and observationEpoch must not be empty");
      }
      const binding = bindSources(input, identityKey);
      const diagnostics = [...binding.diagnostics];
      const observations: ClaudeCodeSourceObservation[] = [];
      if (input.dialect !== CLAUDE_CODE_SETTINGS_DIALECT ||
          !dependencies.semanticClassifier.supportsDialect(input.dialect)) {
        diagnostics.push({ code: "configuration_dialect_unsupported" });
        for (const source of binding.sources) {observations.push(Object.freeze({
          displayPath: source.displayPath, kind: source.kind, sourceRef: source.sourceRef, status: "rejected",
        }));}
        return buildResult(diagnostics, Object.freeze([]), observations);
      }
      const evaluated = await evaluateSources({
        dependencies,
        diagnostics,
        input,
        observations,
        ...(options?.signal === undefined ? {} : { signal: options.signal }),
      }, binding.sources);
      options?.signal?.throwIfAborted();
      return buildResult(diagnostics, resolveIntent(evaluated), observations);
    },
  });
};
