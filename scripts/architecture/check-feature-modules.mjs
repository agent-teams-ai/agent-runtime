import { readFile, readdir, stat } from "node:fs/promises";
import { builtinModules } from "node:module";
import { dirname, extname, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";
import { parseSync } from "oxc-parser";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DEFAULT_PROFILE = "architecture/feature-module-standard/candidate-profile.json";
const PROFILE_SCHEMA = JSON.parse(await readFile(resolve(REPOSITORY_ROOT, "architecture/feature-module-standard/profile.schema.json"), "utf8"));
const validateProfileShape = new Ajv2020({ allErrors: true, strict: true }).compile(PROFILE_SCHEMA);
const ACCEPTED_DECISIONS = new Set(JSON.parse(await readFile(resolve(REPOSITORY_ROOT, "architecture/decisions/accepted-decisions.json"), "utf8")).decisions.map(({ id }) => id));
const AUTHORITY = Object.freeze({
  id: "agent-teams.feature-module-standard",
  version: "v1",
  repository: "agent-teams-ai/.github",
  path: "docs/architecture/feature-module-standard/v1.md",
  gitBlob: "d0bfff2033faf544fe65268c1dcdfd524d093015",
  sha256: "851653f96643cf0466b67ab22963661976b00de44840fa3144a48a8c054f95fa",
});
const SOURCE_EXTENSIONS = new Set([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts"]);
const LAYER_ALLOWED = Object.freeze({
  contracts: new Set(["contracts"]),
  domain: new Set(["domain"]),
  application: new Set(["domain", "application"]),
  adapters: new Set(["contracts", "domain", "application", "adapters"]),
  composition: new Set(["contracts", "domain", "application", "adapters", "composition"]),
});
const SHARED_NAMES = new Set(["shared", "common", "utils", "util", "modules", "module"]);
const NODE_BUILTINS = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));
const EXTERNAL_IMPORT_ALLOWED = Object.freeze({ contracts: false, domain: false, application: false });
const CANDIDATE_PRODUCTION_ROOTS = Object.freeze(["packages/contexts/agent-execution/src", "packages/contexts/provider-access/src"]);
const CANDIDATE_OUT_OF_SCOPE = Object.freeze(["Embedded Runtime", "Runtime Configuration", "Runtime Security", "Filesystem Custody", "Module Kit", "experiments", "tooling other than scripts/architecture/check-feature-modules.mjs"]);
const CANDIDATE_FEATURES = Object.freeze({ "runtime-installation-discovery": { root: "packages/contexts/agent-execution/src/features/runtime-installation-discovery", roles: ["contracts", "application", "adapters", "composition"] }, "contained-agent-turn": { root: "packages/contexts/agent-execution/src/features/contained-agent-turn", roles: ["contracts", "domain", "application", "adapters", "composition"] }, "contained-turn-access": { root: "packages/contexts/provider-access/src/features/contained-turn-access", roles: ["contracts", "domain", "application", "adapters", "composition"] } });

const slash = (value) => value.split(sep).join("/");
const repoPath = (root, value) => slash(relative(root, value));
const lineAt = (source, offset) => source.slice(0, Math.max(0, offset ?? 0)).split("\n").length;
const issue = (code, path, line, message) => ({ code, path: slash(path), line, message });
const compareText = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const compareIssues = (left, right) =>
  compareText(left.path, right.path) || left.line - right.line || compareText(left.code, right.code) || compareText(left.message, right.message);

const filesBelow = async (root) => {
  const found = [];
  const visit = async (directory) => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") {return;}
      throw error;
    }
    entries.sort((left, right) => compareText(left.name, right.name));
    for (const entry of entries) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) {await visit(path);}
      else if (entry.isFile() && SOURCE_EXTENSIONS.has(extname(entry.name))) {found.push(path);}
    }
  };
  await visit(root);
  return found;
};

const literalValue = (node) => {
  if (!node || typeof node !== "object") {return;}
  if (typeof node.value === "string") {return node.value;}
  if (typeof node.raw === "string" && /^(['"]).*\1$/s.test(node.raw)) {return node.raw.slice(1, -1);}
  if (node.type === "TSLiteralType") {return literalValue(node.literal);}
  return;
};

const makeImportRecord = (node, specifierNode, kind, syntax, { source, nonliteral = false }) => ({
  specifier: literalValue(specifierNode),
  kind,
  syntax,
  nonliteral,
  line: lineAt(source, specifierNode?.start ?? node.start),
});

const isTypeOnlyDeclaration = (node, property) =>
  node[property] === "type" || Boolean(node.specifiers?.length) && node.specifiers.every((specifier) => specifier[property] === "type");

const callExpressionRecord = (node, source) => {
  const directRequire = node.callee?.type === "Identifier" && node.callee.name === "require";
  const requireResolve = node.callee?.type === "MemberExpression" && node.callee.object?.name === "require" && node.callee.property?.name === "resolve";
  if (!directRequire && !requireResolve) {return;}
  const argument = node.arguments?.[0];
  return makeImportRecord(node, argument, "runtime", directRequire ? "require" : "require-resolve", { source, nonliteral: literalValue(argument) === undefined });
};

const IMPORT_RECORD_READERS = Object.freeze({
  ImportDeclaration: (node, source) => makeImportRecord(node, node.source, isTypeOnlyDeclaration(node, "importKind") ? "type" : "runtime", "import", { source }),
  ExportNamedDeclaration: (node, source) => node.source && makeImportRecord(node, node.source, isTypeOnlyDeclaration(node, "exportKind") ? "type" : "runtime", "re-export", { source }),
  ExportAllDeclaration: (node, source) => makeImportRecord(node, node.source, node.exportKind === "type" ? "type" : "runtime", "re-export", { source }),
  ImportExpression: (node, source) => makeImportRecord(node, node.source, "runtime", "dynamic-import", { source, nonliteral: literalValue(node.source) === undefined }),
  TSImportType: (node, source) => makeImportRecord(node, node.source ?? node.argument, "type", "import-type", { source, nonliteral: literalValue(node.source ?? node.argument) === undefined }),
  TSImportEqualsDeclaration: (node, source) => node.moduleReference?.type === "TSExternalModuleReference" && makeImportRecord(node, node.moduleReference.expression, node.importKind === "type" ? "type" : "runtime", "import-equals", { source, nonliteral: literalValue(node.moduleReference.expression) === undefined }),
  CallExpression: callExpressionRecord,
});

const importRecords = (program, source) => {
  const records = [];
  const visit = (node) => {
    if (!node || typeof node !== "object") {return;}
    const record = IMPORT_RECORD_READERS[node.type]?.(node, source);
    if (record) {records.push(record);}
    for (const [key, value] of Object.entries(node)) {
      if (["parent", "comments", "tokens", "errors"].includes(key)) {continue;}
      if (Array.isArray(value)) {value.forEach(visit);}
      else if (value && typeof value === "object" && typeof value.type === "string") {visit(value);}
    }
  };
  visit(program);
  const unique = new Map(records.map((record) => [`${record.line}:${record.syntax}:${record.specifier ?? "?"}`, record]));
  return [...unique.values()];
};

const resolveLocalImport = (from, specifier) => {
  if (!specifier?.startsWith(".")) {return;}
  const raw = resolve(dirname(from), specifier);
  const withoutJs = raw.replace(/\.(?:mjs|cjs|js)$/, ".ts");
  return slash(withoutJs);
};

const isPathAlias = (specifier) => Boolean(
  specifier && !specifier.startsWith(".") && (
    specifier.startsWith("#")
    || specifier.startsWith("~/")
    || specifier.startsWith("@/")
    || specifier.startsWith("src/")
    || specifier.includes("/features/")
  ),
);

const profileShapeIssues = (profile, profilePath) => {
  const issues = [];
  if (!validateProfileShape(profile)) {
    for (const error of validateProfileShape.errors ?? []) {
      if (error.instancePath.startsWith("/authority") && ["const", "required"].includes(error.keyword)) {continue;}
      if (error.keyword === "if") {continue;}
      issues.push(issue("FM_PROFILE_INVALID", profilePath, 1, `${error.instancePath || "/"} ${error.message}`));
    }
  }
  return issues;
};

const governedRecordIsValid = (record) => Boolean(
  record.id
  && ACCEPTED_DECISIONS.has(record.acceptedAdr)
  && record.owner
  && record.rationale
  && record.reviewTrigger
  && !record.reviewTrigger.includes("*"),
);

const governedRecordIssues = (profile, profilePath) => ["extensions", "deviations", "exceptions"].flatMap((collection) =>
  (profile[collection] ?? [])
    .filter((record) => !governedRecordIsValid(record))
    .map(() => issue("FM_PROFILE_INVALID", profilePath, 1, `${collection} records require id, accepted ADR, owner, rationale, and a deterministic non-wildcard review trigger`)),
);

const duplicateValues = (values) => {
  const seen = new Set();
  return values.filter((value) => {
    if (seen.has(value)) {return true;}
    seen.add(value);
    return false;
  });
};

const sameValues = (actual, expected) => {
  const sortedExpected = expected.toSorted(compareText);
  return actual.length === expected.length && actual.toSorted(compareText).every((value, index) => value === sortedExpected[index]);
};

const featureIdentityIssues = (features, productionRoots, profilePath) => {
  const issues = [];
  for (const field of [features.map(({ id }) => id), features.map(({ root }) => root), features.flatMap(({ entrypoints }) => Object.values(entrypoints ?? {}))]) {
    if (duplicateValues(field).length) {issues.push(issue("FM_PROFILE_INVALID", profilePath, 1, "feature ids, roots, and entrypoints must be unique"));}
  }
  for (const feature of features) {
    const expectedRoots = productionRoots.map((root) => `${root}/features/${feature.id}`);
    if (!expectedRoots.includes(feature.root)) {issues.push(issue("FM_PROFILE_INVALID", profilePath, 1, `feature ${feature.id} root must be an exact production-root features path`));}
    if (feature.entrypoints?.public !== `${feature.root}/index.ts` || feature.entrypoints?.internal !== `${feature.root}/internal.ts`) {issues.push(issue("FM_PROFILE_INVALID", profilePath, 1, `feature ${feature.id} entrypoints must be root index.ts and internal.ts`));}
  }
  return issues;
};

const featureEdgeDeclarationIssues = (edges, featureIds, profilePath) => {
  const issues = [];
  const edgeKeys = edges.map(({ from, to }) => `${from}->${to}`);
  if (duplicateValues(edgeKeys).length) {issues.push(issue("FM_PROFILE_INVALID", profilePath, 1, "feature edge pairs must be unique"));}
  for (const edge of edges) {
    if (!featureIds.has(edge.from) || !featureIds.has(edge.to) || edge.from === edge.to) {issues.push(issue("FM_PROFILE_INVALID", profilePath, 1, `feature edge ${edge.from}->${edge.to} must connect two distinct declared features`));}
  }
  return issues;
};

const profileTopologyIssues = (profile, profilePath) => {
  const issues = [];
  const productionRoots = profile.scope?.productionRoots ?? [];
  const features = profile.features ?? [];
  const featureIds = new Set(features.map(({ id }) => id));
  const expectedAssembly = productionRoots.flatMap((root) => [`${root}/index.ts`, `${root}/composition.ts`]);
  if (!sameValues(profile.moduleRoles ?? [], Object.keys(LAYER_ALLOWED))) {issues.push(issue("FM_PROFILE_INVALID", profilePath, 1, "moduleRoles must declare the five standard roles exactly"));}
  if (!sameValues(profile.assemblyFiles ?? [], expectedAssembly)) {issues.push(issue("FM_PROFILE_INVALID", profilePath, 1, "assemblyFiles must contain only index.ts and composition.ts for each production root"));}
  issues.push(...featureIdentityIssues(features, productionRoots, profilePath));
  issues.push(...featureEdgeDeclarationIssues(profile.featureEdges ?? [], featureIds, profilePath));
  return issues;
};

const candidateScopeIssues = (profile, profilePath) => {
  const issues = [];
  if (!sameValues(profile.scope.productionRoots, CANDIDATE_PRODUCTION_ROOTS)) {
    issues.push(issue("FM_PROFILE_INVALID", profilePath, 1, "candidate production roots must match the reviewed Agent Execution and Provider Access scope exactly"));
  }
  if (!sameValues(profile.scope.outOfScope, CANDIDATE_OUT_OF_SCOPE)) {
    issues.push(issue("FM_PROFILE_INVALID", profilePath, 1, "candidate out-of-scope modules must match the reviewed exclusions exactly"));
  }
  if (!sameValues(profile.features.map(({ id }) => id), Object.keys(CANDIDATE_FEATURES))) {
    issues.push(issue("FM_PROFILE_INVALID", profilePath, 1, "candidate features must match the three reviewed feature identities exactly"));
  }
  for (const feature of profile.features) {
    const expected = CANDIDATE_FEATURES[feature.id];
    if (expected && feature.root !== expected.root) {
      issues.push(issue("FM_PROFILE_INVALID", profilePath, 1, `candidate feature ${feature.id} root must match the reviewed package ownership exactly`));
    }
    if (expected && !sameValues(feature.roles, expected.roles)) {
      issues.push(issue("FM_PROFILE_INVALID", profilePath, 1, `candidate feature ${feature.id} roles must match the reviewed scope exactly`));
    }
  }
  return issues;
};

const profileArrayIssues = (profile, profilePath) => {
  const issues = [];
  for (const field of ["productionRoots", "outOfScope"]) {
    if (!Array.isArray(profile.scope?.[field])) {issues.push(issue("FM_PROFILE_INVALID", profilePath, 1, `scope.${field} must be an array`));}
  }
  for (const field of ["moduleRoles", "features", "assemblyFiles", "featureEdges", "extensions", "deviations", "exceptions"]) {
    if (!Array.isArray(profile[field])) {issues.push(issue("FM_PROFILE_INVALID", profilePath, 1, `${field} must be an array`));}
  }
  return issues;
};

const validateProfile = (profile, profilePath, enforceCandidateScope) => {
  const issues = profileShapeIssues(profile, profilePath);
  if (issues.length) {return issues;}
  for (const [key, value] of Object.entries(AUTHORITY)) {
    if (profile.authority?.[key] !== value) {issues.push(issue("FM_INVALID_AUTHORITY", profilePath, 1, `authority.${key} must equal ${value}`));}
  }
  if (profile.schemaVersion !== 1 || !["candidate", "active"].includes(profile.status)) {
    issues.push(issue("FM_PROFILE_INVALID", profilePath, 1, "schemaVersion must be 1 and status must be candidate or active"));
  }
  issues.push(...profileArrayIssues(profile, profilePath));
  issues.push(...governedRecordIssues(profile, profilePath));
  if (profile.status === "active" && !ACCEPTED_DECISIONS.has(profile.activation?.authority?.acceptedAdr)) {
    issues.push(issue("FM_PROFILE_INVALID", profilePath, 1, "active status requires activation authority from an accepted ADR"));
  }
  issues.push(...profileTopologyIssues(profile, profilePath));
  if (enforceCandidateScope) {issues.push(...candidateScopeIssues(profile, profilePath));}
  const governedPaths = [
    ...(profile.scope?.productionRoots ?? []),
    ...(profile.assemblyFiles ?? []),
    ...(profile.features ?? []).flatMap((feature) => [feature.root, feature.entrypoints?.public, feature.entrypoints?.internal]),
  ];
  if (governedPaths.some((path) => typeof path === "string" && path.includes("*"))) {issues.push(issue("FM_PROFILE_INVALID", profilePath, 1, "scope, feature, assembly, and entrypoint paths must be exact and cannot contain wildcards"));}
  return issues;
};

const featureForPath = (features, path) => features.find((feature) => path === feature.root || path.startsWith(`${feature.root}/`));
const layerForPath = (feature, path) => path.slice(feature.root.length + 1).split("/")[0];
const hasUndeclaredSharedName = (path) => path.split("/").some((segment) => SHARED_NAMES.has(segment));

const detectCycles = (edges, edgeLocations, kind) => {
  const adjacency = new Map();
  for (const edge of edges.filter((candidate) => candidate.kinds.includes(kind))) {
    const targets = adjacency.get(edge.from) ?? [];
    targets.push(edge.to);
    adjacency.set(edge.from, targets.toSorted());
  }
  const cyclic = new Set();
  const visit = (node, stack, active) => {
    if (active.has(node)) {
      const start = stack.indexOf(node);
      const cycle = stack.slice(start);
      for (let index = 0; index < cycle.length; index += 1) {cyclic.add(`${cycle[index]}->${cycle[(index + 1) % cycle.length]}`);}
      return;
    }
    active.add(node); stack.push(node);
    for (const target of adjacency.get(node) ?? []) {visit(target, stack, active);}
    stack.pop(); active.delete(node);
  };
  for (const node of [...adjacency.keys()].toSorted()) {visit(node, [], new Set());}
  return [...cyclic].flatMap((key) => (edgeLocations.get(`${kind}:${key}`) ?? []).map((location) => issue(
    kind === "type" ? "FM_TYPE_CYCLE" : "FM_RUNTIME_CYCLE", location.path, location.line, `${kind} feature edge ${key} participates in a cycle`,
  )));
};

const readProfile = async (absoluteProfile, profilePath) => {
  try { return { profile: JSON.parse(await readFile(absoluteProfile, "utf8")), issues: [] }; }
  catch (error) { return { issues: [issue("FM_PROFILE_INVALID", profilePath, 1, `cannot read profile: ${error.message}`)] }; }
};

const collectProductionFiles = async (absoluteRoot, productionRoots) => {
  const files = [];
  for (const productionRoot of productionRoots) {files.push(...await filesBelow(resolve(absoluteRoot, productionRoot)));}
  return files;
};

const readLocalPackageImports = async (absoluteRoot, productionRoots) => {
  const names = new Set(), targets = new Map();
  for (const productionRoot of productionRoots) {
    try {
      const { name } = JSON.parse(await readFile(resolve(absoluteRoot, productionRoot, "../package.json"), "utf8"));
      if (name) {names.add(name); targets.set(name, `${productionRoot}/index.ts`); targets.set(`${name}/composition`, `${productionRoot}/composition.ts`);}
    } catch (error) { if (error?.code !== "ENOENT") {throw error;} }
  }
  return { names, targets };
};

const assemblyStructureIssues = (assemblyFiles, allPaths) => assemblyFiles
  .filter((path) => !allPaths.includes(path))
  .map((path) => issue("FM_ASSEMBLY_MISSING", path, 1, "declared package assembly file is missing"));

const featureStructureIssues = async (feature, allPaths, absoluteRoot) => {
  const issues = [];
  for (const [visibility, entrypoint] of Object.entries(feature.entrypoints ?? {})) {
    try { if (!(await stat(resolve(absoluteRoot, entrypoint))).isFile()) {throw new Error("not a file");} }
    catch { issues.push(issue("FM_ENTRYPOINT_MISSING", entrypoint, 1, `${feature.id} ${visibility} entrypoint is missing`)); }
  }
  const featureFiles = allPaths.filter((path) => path.startsWith(`${feature.root}/`));
  for (const role of feature.roles ?? []) {
    const layerFiles = featureFiles.filter((path) => layerForPath(feature, path) === role);
    let hasSubstance = false;
    for (const path of layerFiles) {
      const source = await readFile(resolve(absoluteRoot, path), "utf8");
      try {
        const parsed = parseSync(path, source);
        const body = parsed.program?.body ?? [];
        if (parsed.errors?.length || body.some((node) => !(
          node.type === "EmptyStatement"
          || node.type === "ImportDeclaration"
          || node.type === "ExportAllDeclaration"
          || node.type === "ExportNamedDeclaration" && !node.declaration
        ))) {hasSubstance = true;}
      } catch { hasSubstance = true; }
    }
    if (!hasSubstance) {issues.push(issue("FM_EMPTY_LAYER", `${feature.root}/${role}`, 1, `${feature.id} declares empty or placeholder-only ${role} layer`));}
  }
  return issues;
};

const ownershipIssues = (path, sourceFeature, isAssembly, profile) => {
  if (!sourceFeature && !isAssembly) {
    const segment = path.match(/(?:^|\/)src\/([^/]+)/)?.[1] ?? "unknown";
    return [issue(hasUndeclaredSharedName(path) ? "FM_UNDECLARED_OWNERSHIP" : "FM_BEHAVIOR_OUTSIDE_FEATURE", path, 1, `production source is neither a declared feature nor assembly: ${segment}`)];
  }
  if (!sourceFeature || Object.values(sourceFeature.entrypoints).includes(path)) {return [];}
  const relativeFeaturePath = path.slice(sourceFeature.root.length + 1);
  const layer = layerForPath(sourceFeature, path);
  const knownLayer = (profile.moduleRoles ?? []).includes(layer) && (sourceFeature.roles ?? []).includes(layer);
  if (!knownLayer) {return [issue(hasUndeclaredSharedName(relativeFeaturePath) ? "FM_UNDECLARED_OWNERSHIP" : "FM_UNDECLARED_MODULE", path, 1, `${sourceFeature.id} does not declare module role ${layer}`)];}
  if (hasUndeclaredSharedName(relativeFeaturePath)) {return [issue("FM_UNDECLARED_OWNERSHIP", path, 1, `${sourceFeature.id} uses an undeclared shared/common/utils/module owner`)];}
  return [];
};

const parseFileImports = async (absoluteFile, path) => {
  const source = await readFile(absoluteFile, "utf8");
  let parsed;
  try { parsed = parseSync(path, source); }
  catch (error) { return { imports: [], issues: [issue("FM_PARSE_FAILURE", path, 1, `parser rejected source: ${error.message}`)] }; }
  if (!parsed.errors?.length) {return { imports: importRecords(parsed.program, source), issues: [], program: parsed.program, source };}
  return {
    imports: [],
    issues: parsed.errors.map((error) => issue("FM_PARSE_FAILURE", path, lineAt(source, error.labels?.[0]?.start ?? error.start), String(error.message ?? error))),
  };
};

const assemblyGrammarIssues = ({ isAssembly, path, sourceFeature, program, source }) => {
  if (!program || !(isAssembly || Object.values(sourceFeature?.entrypoints ?? {}).includes(path))) {return [];}
  const invalid = (program.body ?? []).filter((node) => !(
    node.type === "ImportDeclaration"
    || node.type === "ExportAllDeclaration"
    || node.type === "EmptyStatement"
    || node.type === "ExportNamedDeclaration" && !node.declaration
  ));
  return invalid.map((node) => issue(
    "FM_INLINE_BEHAVIOR",
    path,
    lineAt(source, node.start),
    `${isAssembly ? "package assembly" : "feature entrypoint"} files may contain only imports and re-exports`,
  ));
};

const assemblyImportIssues = ({ path, imported, targetPath, targetFeature }) => {
  const visibility = posix.basename(path) === "index.ts" ? "public" : "internal";
  if (targetFeature.entrypoints[visibility] === targetPath) {return [];}
  return [issue("FM_FEATURE_DEEP_IMPORT", path, imported.line, `assembly ${posix.basename(path)} must use the curated ${targetFeature.id} ${visibility} entrypoint, not ${targetPath}`)];
};

const sameFeatureImportIssues = ({ path, imported, targetPath, sourceFeature }) => {
  const sourceLayer = layerForPath(sourceFeature, path);
  const targetLayer = layerForPath(sourceFeature, targetPath);
  if (!LAYER_ALLOWED[sourceLayer] || LAYER_ALLOWED[sourceLayer].has(targetLayer)) {return [];}
  return [issue("FM_INVALID_LAYER_DIRECTION", path, imported.line, `${sourceLayer} cannot depend on ${targetLayer}`)];
};

const publicEntrypointIssues = ({ path, imported, targetPath, sourceFeature, targetFeature }) => {
  if (path !== sourceFeature?.entrypoints.public) {return [];}
  const exposesOwnContract = sourceFeature.id === targetFeature.id && layerForPath(sourceFeature, targetPath) === "contracts";
  if (exposesOwnContract) {return [];}
  return [issue("FM_PUBLIC_ENTRYPOINT_EXPORT", path, imported.line, `${sourceFeature.id} public entrypoint may expose only its own contracts`)];
};

const internalEntrypointIssues = ({ path, imported, sourceFeature, targetFeature }) => {
  if (path !== sourceFeature?.entrypoints.internal || sourceFeature.id === targetFeature.id) {return [];}
  return [issue("FM_INTERNAL_ENTRYPOINT_EXPORT", path, imported.line, `${sourceFeature.id} internal entrypoint may expose only its own feature` )];
};

const recordObservedEdge = ({ key, imported, path, observedEdges, edgeLocations }) => {
  const kinds = observedEdges.get(key) ?? new Set();
  kinds.add(imported.kind);
  observedEdges.set(key, kinds);
  const locationKey = `${imported.kind}:${key}`;
  const locations = edgeLocations.get(locationKey) ?? [];
  locations.push({ path, line: imported.line });
  edgeLocations.set(locationKey, locations);
};

const unusedEdgeIssues = (declaredEdges, observedEdges, profilePath) => [...declaredEdges].flatMap(([key, kinds]) =>
  [...kinds]
    .filter((kind) => !observedEdges.get(key)?.has(kind))
    .map((kind) => issue("FM_UNUSED_EDGE", profilePath, 1, `${kind} edge ${key} is declared but not observed`)),
);

const crossFeatureImportIssues = (context) => {
  const { path, imported, targetPath, sourceFeature, targetFeature, declaredEdges } = context;
  const issues = [];
  const sourceLayer = layerForPath(sourceFeature, path);
  if (sourceLayer === "domain" || sourceLayer === "application") {issues.push(issue("FM_INVALID_LAYER_DIRECTION", path, imported.line, `${sourceLayer} cannot depend on another feature's public transport contracts`));}
  if (targetFeature.entrypoints.public !== targetPath) {issues.push(issue("FM_FEATURE_DEEP_IMPORT", path, imported.line, `${sourceFeature.id} must use the curated ${targetFeature.id} public entrypoint`));}
  const key = `${sourceFeature.id}->${targetFeature.id}`;
  if (!declaredEdges.get(key)?.has(imported.kind)) {issues.push(issue("FM_UNDECLARED_EDGE", path, imported.line, `${imported.kind} edge ${key} is not declared`));}
  recordObservedEdge({ ...context, key });
  return issues;
};

const nonLocalImportIssues = ({ imported, isAssembly, path, sourceFeature }) => {
  const sourceLayer = sourceFeature && layerForPath(sourceFeature, path);
  if (NODE_BUILTINS.has(imported.specifier) && Object.hasOwn(EXTERNAL_IMPORT_ALLOWED, sourceLayer)) {
    return [issue("FM_NODE_BUILTIN_IMPORT", path, imported.line, `${sourceLayer} cannot import Node builtin ${imported.specifier}`)];
  }
  if (sourceFeature && Object.hasOwn(EXTERNAL_IMPORT_ALLOWED, sourceLayer) && !EXTERNAL_IMPORT_ALLOWED[sourceLayer]) {
    return [issue("FM_EXTERNAL_IMPORT", path, imported.line, `${sourceLayer} cannot import external module ${imported.specifier}`)];
  }
  if (isAssembly || Object.values(sourceFeature?.entrypoints ?? {}).includes(path)) {
    return [issue("FM_ASSEMBLY_IMPORT_TARGET", path, imported.line, "assembly and entrypoint imports must target declared feature entrypoints or owned feature layers")];
  }
  return [];
};

const outsideFeatureImportIssues = ({ imported, isAssembly, path, sourceFeature, targetPath, productionRoots }) => {
  if (!sourceFeature && !isAssembly) {return [];}
  const isRepositoryLocal = !targetPath.startsWith("../");
  const isGovernedLocal = productionRoots.some((root) => targetPath === root || targetPath.startsWith(`${root}/`));
  return [issue(
    isAssembly ? "FM_ASSEMBLY_IMPORT_TARGET" : "FM_UNDECLARED_LOCAL_DEPENDENCY",
    path,
    imported.line,
    `${imported.specifier} resolves ${isGovernedLocal || isRepositoryLocal ? "outside the declared feature" : "outside the repository"}`,
  )];
};

const inspectImport = (context) => {
  const { absoluteFile, absoluteRoot, features, isAssembly, sourceFeature, path, imported, localPackageImports, productionRoots } = context;
  if (imported.nonliteral) {return [issue("FM_NONLITERAL_LOADING", path, imported.line, `${imported.syntax} requires a string literal`)];}
  if (isPathAlias(imported.specifier)) {return [issue("FM_PATH_ALIAS_IMPORT", path, imported.line, `path alias imports cannot bypass feature boundaries: ${imported.specifier}`)];}
  const localPackageName = [...localPackageImports.names].find((name) => imported.specifier === name || imported.specifier.startsWith(`${name}/`));
  if (localPackageName && !localPackageImports.targets.has(imported.specifier)) {return [issue("FM_PATH_ALIAS_IMPORT", path, imported.line, `undeclared local package subpath cannot bypass feature boundaries: ${imported.specifier}`)];}
  const packageTargetPath = localPackageImports.targets.get(imported.specifier); const target = resolveLocalImport(slash(absoluteFile), imported.specifier);
  if (!target && !packageTargetPath) {return nonLocalImportIssues(context);}
  const targetPath = packageTargetPath ?? repoPath(absoluteRoot, target);
  const targetFeature = featureForPath(features, targetPath);
  if (!targetFeature) {return outsideFeatureImportIssues({ ...context, targetPath, productionRoots });}
  const importContext = { ...context, targetPath, targetFeature };
  if (isAssembly) {return assemblyImportIssues(importContext);}
  if (!sourceFeature) {return [];}
  const entrypointIssues = [...publicEntrypointIssues(importContext), ...internalEntrypointIssues(importContext)];
  if (sourceFeature.id === targetFeature.id) {return [...entrypointIssues, ...sameFeatureImportIssues(importContext)];}
  return [...entrypointIssues, ...crossFeatureImportIssues(importContext)];
};

export const checkFeatureModules = async ({ root = REPOSITORY_ROOT, profilePath = DEFAULT_PROFILE, requiredStatus } = {}) => {
  const absoluteRoot = resolve(root);
  const absoluteProfile = resolve(absoluteRoot, profilePath);
  const loaded = await readProfile(absoluteProfile, profilePath);
  if (!loaded.profile) {return loaded.issues;}
  const { profile } = loaded;
  const issues = validateProfile(profile, profilePath, absoluteRoot === REPOSITORY_ROOT);
  if (issues.some((candidate) => candidate.code === "FM_PROFILE_INVALID")) {return issues.toSorted(compareIssues);}
  if (requiredStatus && profile.status !== requiredStatus) {issues.push(issue("FM_PROFILE_STATUS", profilePath, 1, `profile status must be ${requiredStatus}`));}

  const features = (profile.features ?? []).map((feature) => ({ ...feature, root: slash(feature.root) }));
  const assemblyFiles = new Set(profile.assemblyFiles ?? []);
  const declaredEdges = new Map((profile.featureEdges ?? []).map((edge) => [`${edge.from}->${edge.to}`, new Set(edge.kinds)]));
  const observedEdges = new Map();
  const edgeLocations = new Map();
  const allFiles = await collectProductionFiles(absoluteRoot, profile.scope.productionRoots ?? []);
  const localPackageImports = await readLocalPackageImports(absoluteRoot, profile.scope.productionRoots ?? []);
  const allPaths = allFiles.map((path) => repoPath(absoluteRoot, path));
  issues.push(...assemblyStructureIssues(profile.assemblyFiles ?? [], allPaths));

  for (const feature of features) {
    issues.push(...await featureStructureIssues(feature, allPaths, absoluteRoot));
  }

  for (const absoluteFile of allFiles) {
    const path = repoPath(absoluteRoot, absoluteFile);
    const sourceFeature = featureForPath(features, path);
    const isAssembly = assemblyFiles.has(path);
    issues.push(...ownershipIssues(path, sourceFeature, isAssembly, profile));
    const parsed = await parseFileImports(absoluteFile, path);
    issues.push(...parsed.issues);
    issues.push(...assemblyGrammarIssues({ isAssembly, path, sourceFeature, program: parsed.program, source: parsed.source }));
    for (const imported of parsed.imports) {issues.push(...inspectImport({ absoluteFile, absoluteRoot, features, isAssembly, sourceFeature, path, imported, declaredEdges, observedEdges, edgeLocations, localPackageImports, productionRoots: profile.scope.productionRoots ?? [] }));}
  }
  const observed = [...observedEdges].map(([key, kinds]) => { const [from, to] = key.split("->"); return { from, to, kinds: [...kinds] }; });
  issues.push(...unusedEdgeIssues(declaredEdges, observedEdges, profilePath));
  issues.push(...detectCycles(observed, edgeLocations, "runtime"), ...detectCycles(observed, edgeLocations, "type"));
  return issues.toSorted(compareIssues);
};

export const formatIssues = (issues) => issues.map((entry) => `${entry.path}:${entry.line} ${entry.code} ${entry.message}`).join("\n");

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const profileIndex = process.argv.indexOf("--profile"), rootIndex = process.argv.indexOf("--root");
  const profilePath = profileIndex >= 0 ? process.argv[profileIndex + 1] : DEFAULT_PROFILE, root = rootIndex >= 0 ? process.argv[rootIndex + 1] : REPOSITORY_ROOT;
  const requiredStatus = process.argv.includes("--require-active") ? "active" : undefined;
  const issues = await checkFeatureModules({ profilePath, requiredStatus, root });
  if (issues.length) {
    process.stdout.write(`${formatIssues(issues)}\n\nFeature Module Standard ${requiredStatus ?? "candidate"}: ${issues.length} diagnostic(s). No conformance claim.\n`);
    process.exitCode = process.argv.includes("--allow-diagnostics") ? 0 : 1;
  } else if (requiredStatus) {process.stdout.write("Feature Module Standard active: 0 diagnostics.\n");}
  else {process.stdout.write("Feature Module Standard candidate: 0 diagnostics. Activation remains a separate reviewed change.\n");}
}
