import { readFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import { dirname, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseSync } from "oxc-parser";

import { parseDeterministicJson, readLocalPackageImports } from "./feature-module-config.mjs";
import { importRecords } from "./feature-module-imports.mjs";
import { boundedIssueText, CHECKER_LIMITS, createDiagnosticCollector, escapedDiagnosticText, overflowIssue } from "./feature-module-limits.mjs";
import { parseFeatureReadmeMetadata } from "./feature-module-readme.mjs";
import {
  canonicalRoot,
  createPathIndex,
  FILESYSTEM_IDENTITY_CODE,
  filesystemIdentityIssue,
  inspectRepositoryPath,
  inventoryRepositoryFiles,
  portableRepositoryPath,
  repositoryPath,
  sameFilesystemIdentity,
} from "./feature-module-paths.mjs";
import { ACCEPTED_DECISIONS, CANDIDATE_MIGRATION_CODES, acceptedDecisionsFromRegistry, applyGovernedRecords, validateProfile } from "./feature-module-profile.mjs";
import { packagePolicyIssues } from "./feature-module-tests.mjs";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const REPOSITORY_IDENTITY = await canonicalRoot(REPOSITORY_ROOT);
const DEFAULT_PROFILE = "architecture/feature-module-standard/candidate-profile.json";
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

const slash = (value) => String(value).replaceAll("\\", "/");
const lineAt = (source, offset) => source.slice(0, Math.max(0, offset ?? 0)).split("\n").length;
const stableMessage = (message) => escapedDiagnosticText(String(message)
  .replace(/Require stack:[\s\S]*/gu, "dependency resolution details redacted")
  .replace(/(?:[A-Za-z]:[\\/]|\/)\S+/gu, "<path>")
  .replace(/[\r\n\t]+/gu, " "))
  .slice(0, 240);
const stableDiagnosticPath = (path) => {
  const candidate = escapedDiagnosticText(slash(String(path ?? "<path>")));
  return candidate.startsWith("/") || candidate.startsWith("//") || /^[A-Za-z]:\//u.test(candidate) || candidate === ".." || candidate.startsWith("../")
    ? "<path>"
    : candidate.slice(0, 240);
};
const issue = (code, path, line, message) => ({ code, path: stableDiagnosticPath(path), line, message: stableMessage(message) });
const compareText = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const compareIssues = (left, right) =>
  compareText(left.path, right.path) || left.line - right.line || compareText(left.code, right.code) || compareText(left.message, right.message);
const withoutIdentityConsequences = (issues) => issues.filter((entry) => entry.code !== "FM_EMPTY_LAYER" || !issues.some(
  (candidate) => candidate.code === FILESYSTEM_IDENTITY_CODE && (candidate.path === entry.path || candidate.path.startsWith(`${entry.path}/`)),
));

const isPathAlias = (specifier) => Boolean(
  specifier && !specifier.startsWith(".") && (
    specifier.startsWith("#")
    || specifier.startsWith("~/")
    || specifier.startsWith("@/")
    || specifier.startsWith("src/")
    || specifier.includes("/features/")
  ),
);

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

const readProfile = async (root, profilePath) => {
  const inspected = await inspectRepositoryPath(root, profilePath);
  if (!inspected.ok) {
    return { issues: [inspected.identity
      ? filesystemIdentityIssue(issue, profilePath)
      : issue("FM_PROFILE_INVALID", profilePath, 1, "profile cannot be read or parsed deterministically")] };
  }
  if (inspected.metadata.size > CHECKER_LIMITS.sourceFileBytes) {
    return { issues: [overflowIssue(issue, "source byte")] };
  }
  try {
    const profile = parseDeterministicJson(await readFile(inspected.absolutePath, "utf8"));
    if (!profile || typeof profile !== "object" || Array.isArray(profile)) {throw new TypeError("profile must be an object");}
    return { profile, issues: [] };
  }
  catch { return { issues: [issue("FM_PROFILE_INVALID", profilePath, 1, "profile cannot be read or parsed deterministically")] }; }
};

const collectProductionFiles = async (root, productionRoots) => {
  const files = [], issues = [], identities = new Map(), budget = { entries: 0, files: 0, sourceBytes: 0 };
  let overflow = false;
  for (const productionRoot of productionRoots) {
    const inventory = await inventoryRepositoryFiles({
      root, startPath: productionRoot, extensions: SOURCE_EXTENSIONS, issue, identities, budget,
      maxEntries: CHECKER_LIMITS.traversalEntries, maxDepth: CHECKER_LIMITS.traversalDepth,
      maxFiles: CHECKER_LIMITS.files, maxFileBytes: CHECKER_LIMITS.sourceFileBytes,
      maxSourceBytes: CHECKER_LIMITS.sourceBytes, maxIssues: CHECKER_LIMITS.diagnostics,
    });
    files.push(...inventory.files); issues.push(...inventory.issues);
    if (inventory.overflow) {overflow = true; break;}
  }
  return { files: [...new Set(files)], issues, overflow };
};

const profileFilesystemPathIssues = (profile) => {
  const paths = [
    ...profile.scope.productionRoots,
    ...profile.assemblyFiles,
    ...profile.features.flatMap((feature) => [feature.root, ...Object.values(feature.entrypoints ?? {})]),
  ];
  const issues = [], identities = new Map();
  for (const path of paths) {
    const canonical = portableRepositoryPath(path);
    if (!canonical) {issues.push(filesystemIdentityIssue(issue, path)); continue;}
    const key = canonical.normalize("NFC").toLowerCase(), previous = identities.get(key);
    if (previous && previous !== canonical) {issues.push(filesystemIdentityIssue(issue, canonical));}
    else {identities.set(key, canonical);}
  }
  return issues;
};

const assemblyStructureIssues = async (assemblyFiles, root) => {
  const issues = [];
  for (const path of assemblyFiles) {
    const inspected = await inspectRepositoryPath(root, path);
    if (!inspected.ok) {issues.push(inspected.identity
      ? filesystemIdentityIssue(issue, path)
      : issue("FM_ASSEMBLY_MISSING", path, 1, "declared package assembly file is missing"));}
    else if (inspected.metadata.size > CHECKER_LIMITS.sourceFileBytes) {issues.push(overflowIssue(issue, "source byte"));}
  }
  return issues;
};

const featureEntrypointIssues = async (feature, root) => {
  const issues = [];
  for (const [visibility, entrypoint] of Object.entries(feature.entrypoints ?? {})) {
    const inspected = await inspectRepositoryPath(root, entrypoint);
    if (!inspected.ok) {issues.push(inspected.identity
      ? filesystemIdentityIssue(issue, entrypoint)
      : issue("FM_ENTRYPOINT_MISSING", entrypoint, 1, `${feature.id} ${visibility} entrypoint is missing`));}
  }
  return issues;
};

const sourceHasSubstance = (path, source) => {
  try {
    const parsed = parseSync(path, source), body = parsed.program?.body ?? [];
    return Boolean(parsed.errors?.length || body.some((node) => !(
      node.type === "EmptyStatement"
      || node.type === "ImportDeclaration"
      || node.type === "ExportAllDeclaration"
      || node.type === "ExportNamedDeclaration" && !node.declaration
    )));
  } catch {return true;}
};

const emptyLayerIssues = async (feature, allPaths, root) => {
  const issues = [];
  const featureFiles = allPaths.filter((path) => path.startsWith(`${feature.root}/`));
  for (const role of feature.roles ?? []) {
    const layerFiles = featureFiles.filter((path) => layerForPath(feature, path) === role);
    let hasSubstance = false;
    for (const path of layerFiles) {
      const inspected = await inspectRepositoryPath(root, path);
      if (!inspected.ok) {issues.push(filesystemIdentityIssue(issue, path)); continue;}
      const source = await readFile(inspected.absolutePath, "utf8");
      if (sourceHasSubstance(path, source)) {hasSubstance = true;}
    }
    if (!hasSubstance) {issues.push(issue("FM_EMPTY_LAYER", `${feature.root}/${role}`, 1, `${feature.id} declares empty or placeholder-only ${role} layer`));}
  }
  return issues;
};

const featureReadmeIssues = async (feature, root, packageMetadata) => {
  const issues = [], readmePath = `${feature.root}/README.md`;
  const packageRoot = [...packageMetadata.keys()].find((productionRoot) => feature.root.startsWith(`${productionRoot}/features/`));
  const expected = packageMetadata.get(packageRoot);
  try {
    const inspected = await inspectRepositoryPath(root, readmePath);
    if (!inspected.ok) {
      if (inspected.identity) {return [filesystemIdentityIssue(issue, readmePath)];}
      throw new Error("missing README");
    }
    if (inspected.metadata.size > CHECKER_LIMITS.sourceFileBytes) {return [overflowIssue(issue, "README byte")];}
    const readme = await readFile(inspected.absolutePath, "utf8");
    const metadata = parseFeatureReadmeMetadata(readme);
    if (metadata.type !== "feature" || metadata.status !== "accepted" || metadata.owner !== expected?.name || metadata.owner_document !== expected?.ownerDocument) {
      issues.push(issue("FM_README_OWNERSHIP", readmePath, 1, `${feature.id} README metadata must declare type: feature, status: accepted, owner: ${expected?.name}, and owner_document: ${expected?.ownerDocument}`));
    }
  } catch { issues.push(issue("FM_README_OWNERSHIP", readmePath, 1, `${feature.id} must declare accepted feature metadata and its package owner document`)); }
  return issues;
};

const featureStructureIssues = async (feature, allPaths, root, packageMetadata) => [
  ...await featureEntrypointIssues(feature, root),
  ...await emptyLayerIssues(feature, allPaths, root),
  ...await featureReadmeIssues(feature, root, packageMetadata),
];

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

const parseFileImports = async (absoluteFile, path, resources) => {
  const source = await readFile(absoluteFile, "utf8");
  let parsed;
  try { parsed = parseSync(path, source); }
  catch { return { imports: [], issues: [issue("FM_PARSE_FAILURE", path, 1, "source cannot be parsed deterministically")] }; }
  if (!parsed.errors?.length) {
    const imports = importRecords(parsed.program, source), remaining = CHECKER_LIMITS.imports - resources.imports;
    const overflow = imports.overflow || imports.length > remaining;
    const retained = imports.slice(0, Math.max(0, remaining));
    resources.imports += retained.length;
    return { imports: retained, issues: [], program: parsed.program, source, overflow };
  }
  return {
    imports: [],
    issues: parsed.errors.slice(0, CHECKER_LIMITS.diagnostics - 1)
      .map((error) => issue("FM_PARSE_FAILURE", path, lineAt(source, error.labels?.[0]?.start ?? error.start), "source cannot be parsed deterministically")),
    overflow: parsed.errors.length >= CHECKER_LIMITS.diagnostics,
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
  const issues = invalid.map((node) => issue(
    "FM_INLINE_BEHAVIOR",
    path,
    lineAt(source, node.start),
    `${isAssembly ? "package assembly" : "feature entrypoint"} files may contain only imports and re-exports`,
  ));
  for (const node of (program.body ?? []).filter((candidate) => candidate.type === "ExportAllDeclaration")) {
    issues.push(issue("FM_WILDCARD_REEXPORT", path, lineAt(source, node.start), "assembly and feature entrypoints require curated named re-exports"));
  }
  return issues;
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

const identityCoversPath = (identityPaths, path) => identityPaths.some((candidate) =>
  candidate === path || path.startsWith(`${candidate}/`),
);

const inspectImport = (context) => {
  const { features, isAssembly, sourceFeature, path, imported, localPackageImports, productionRoots, identityPaths } = context;
  if (imported.nonliteral) {return [issue("FM_NONLITERAL_LOADING", path, imported.line, `${imported.syntax} requires a string literal`)];}
  const resolved = localPackageImports.resolve(path, imported.specifier);
  if (resolved.alias || resolved.kind === "external" && isPathAlias(imported.specifier)) {
    return [issue("FM_PATH_ALIAS_IMPORT", path, imported.line, `path alias imports cannot bypass feature boundaries: ${imported.specifier}`)];
  }
  if (resolved.kind === "invalid") {
    if (resolved.missing) {
      const targetFeature = featureForPath(features, resolved.path);
      if (!targetFeature) {return outsideFeatureImportIssues({ ...context, targetPath: resolved.path, productionRoots });}
      const declaredEntrypoint = Object.values(targetFeature.entrypoints).includes(resolved.path);
      if (declaredEntrypoint || identityCoversPath(identityPaths, resolved.path)) {return [];}
    }
    return [issue(FILESYSTEM_IDENTITY_CODE, path, imported.line, "import target must have one canonical, repository-contained identity")];
  }
  if (resolved.kind === "external") {return nonLocalImportIssues(context);}
  const targetPath = resolved.path;
  const targetFeature = featureForPath(features, targetPath);
  if (!targetFeature) {return outsideFeatureImportIssues({ ...context, targetPath, productionRoots });}
  const importContext = { ...context, targetPath, targetFeature };
  if (isAssembly) {return assemblyImportIssues(importContext);}
  if (!sourceFeature) {return [];}
  const entrypointIssues = [...publicEntrypointIssues(importContext), ...internalEntrypointIssues(importContext)];
  if (sourceFeature.id === targetFeature.id) {return [...entrypointIssues, ...sameFeatureImportIssues(importContext)];}
  return [...entrypointIssues, ...crossFeatureImportIssues(importContext)];
};

const acceptedDecisionsForRoot = async (root) => {
  if (sameFilesystemIdentity(root, REPOSITORY_IDENTITY)) {return ACCEPTED_DECISIONS;}
  try {
    const registryPath = "architecture/decisions/accepted-decisions.json";
    const inspected = await inspectRepositoryPath(root, registryPath);
    if (!inspected.ok) {return new Map();}
    if (inspected.metadata.size > CHECKER_LIMITS.sourceFileBytes) {return new Map();}
    const registry = parseDeterministicJson(await readFile(inspected.absolutePath, "utf8"));
    return acceptedDecisionsFromRegistry(registry) ?? new Map();
  } catch {return new Map();}
};

const activeGateIssues = async (profile, root) => {
  if (profile.status !== "active") {return [];}
  const manifestPath = "package.json";
  try {
    const inspected = await inspectRepositoryPath(root, manifestPath);
    if (!inspected.ok || inspected.metadata.size > CHECKER_LIMITS.sourceFileBytes) {throw new TypeError("invalid manifest");}
    const manifest = parseDeterministicJson(await readFile(inspected.absolutePath, "utf8"));
    const requiredPair = ["pnpm test:feature-modules", "pnpm architecture:feature-modules:active"];
    const invalid = ["check", "check:fast"].some((name) => {
      const steps = typeof manifest?.scripts?.[name] === "string" ? manifest.scripts[name].split(" && ") : [];
      const fixtureIndex = steps.indexOf(requiredPair[0]);
      return fixtureIndex < 0
        || steps.lastIndexOf(requiredPair[0]) !== fixtureIndex
        || steps[fixtureIndex + 1] !== requiredPair[1]
        || steps.lastIndexOf(requiredPair[1]) !== fixtureIndex + 1;
    });
    return invalid ? [issue("FM_PROFILE_INVALID", manifestPath, 1, "active status requires the active checker immediately after the fixture suite in check and check:fast")] : [];
  } catch {
    return [issue("FM_PROFILE_INVALID", manifestPath, 1, "active status requires deterministic root check and check:fast scripts")];
  }
};

export const checkFeatureModules = async ({ root = REPOSITORY_ROOT, profilePath = DEFAULT_PROFILE, requiredStatus, acceptedDecisions } = {}) => {
  const rootIdentity = await canonicalRoot(root);
  if (!rootIdentity.ok) {return [filesystemIdentityIssue(issue, "<root>")];}
  const diagnosticProfilePath = portableRepositoryPath(profilePath);
  if (!diagnosticProfilePath) {return [filesystemIdentityIssue(issue, "<profile>")];}
  const loaded = await readProfile(rootIdentity, diagnosticProfilePath);
  if (!loaded.profile) {return loaded.issues;}
  const { profile } = loaded;
  const governedDecisions = acceptedDecisions ?? await acceptedDecisionsForRoot(rootIdentity);
  const initialIssues = validateProfile(profile, diagnosticProfilePath, sameFilesystemIdentity(rootIdentity, REPOSITORY_IDENTITY), governedDecisions)
    .map((entry) => ({ ...entry, message: stableMessage(entry.message) }));
  const findings = createDiagnosticCollector(issue);
  findings.add(initialIssues);
  if (initialIssues.some((candidate) => candidate.code === "FM_PROFILE_INVALID")) {return findings.result().toSorted(compareIssues);}
  if (requiredStatus && profile.status !== requiredStatus) {findings.add([issue("FM_PROFILE_STATUS", diagnosticProfilePath, 1, `profile status must be ${requiredStatus}`)]);}
  const identityIssues = profileFilesystemPathIssues(profile);
  if (identityIssues.length) {findings.add(identityIssues); return findings.result().toSorted(compareIssues);}

  const productionRoots = profile.scope.productionRoots;
  const features = profile.features.map((feature) => ({ ...feature, root: portableRepositoryPath(feature.root) }));
  const assemblyFiles = new Set(profile.assemblyFiles);
  const declaredEdges = new Map(profile.featureEdges.map((edge) => [`${edge.from}->${edge.to}`, new Set(edge.kinds)]));
  const observedEdges = new Map();
  findings.add(await activeGateIssues(profile, rootIdentity));
  const edgeLocations = new Map();
  const inventory = await collectProductionFiles(rootIdentity, productionRoots);
  const allFiles = inventory.files;
  findings.add(inventory.issues);
  if (inventory.overflow) {findings.overflow("source scan");}
  const identityPaths = inventory.issues
    .filter(({ code }) => code === FILESYSTEM_IDENTITY_CODE)
    .map(({ path }) => path);
  const allPaths = allFiles.map((path) => repositoryPath(rootIdentity, path));
  const pathIndex = createPathIndex(allPaths);
  const localPackageImports = await readLocalPackageImports({
    root: rootIdentity,
    productionRoots,
    issue,
    pathIndex,
  });
  findings.add(localPackageImports.issues);
  findings.add(await assemblyStructureIssues(profile.assemblyFiles, rootIdentity));

  for (const feature of features) {
    findings.add(await featureStructureIssues(feature, allPaths, rootIdentity, localPackageImports.packageMetadata));
  }
  findings.add(await packagePolicyIssues({
    root: rootIdentity,
    productionRoots,
    features,
    issue,
    productionFiles: allFiles,
    localPackageImports,
    featureForPath,
  }));

  const resources = { imports: 0 };
  for (const absoluteFile of allFiles) {
    const path = repositoryPath(rootIdentity, absoluteFile);
    const sourceFeature = featureForPath(features, path);
    const isAssembly = assemblyFiles.has(path);
    findings.add(ownershipIssues(path, sourceFeature, isAssembly, profile));
    const parsed = await parseFileImports(absoluteFile, path, resources);
    findings.add(parsed.issues);
    findings.add(assemblyGrammarIssues({ isAssembly, path, sourceFeature, program: parsed.program, source: parsed.source }));
    for (const imported of parsed.imports) {findings.add(inspectImport({ features, isAssembly, sourceFeature, path, imported, declaredEdges, observedEdges, edgeLocations, localPackageImports, productionRoots, identityPaths }));}
    if (parsed.overflow) {findings.overflow("import"); break;}
  }
  const observed = [...observedEdges].map(([key, kinds]) => { const [from, to] = key.split("->"); return { from, to, kinds: [...kinds] }; });
  findings.add(unusedEdgeIssues(declaredEdges, observedEdges, diagnosticProfilePath));
  findings.add(detectCycles(observed, edgeLocations, "runtime"));
  findings.add(detectCycles(observed, edgeLocations, "type"));
  const governed = applyGovernedRecords(profile, withoutIdentityConsequences(findings.result()), diagnosticProfilePath).toSorted(compareIssues);
  return governed.filter((entry, index) => !index || compareIssues(entry, governed[index - 1]));
};

export const formatIssues = (issues) => boundedIssueText(issues, (entry) => `${stableDiagnosticPath(entry.path)}:${entry.line} ${entry.code} ${stableMessage(entry.message)}`);

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const profileIndex = process.argv.indexOf("--profile"), rootIndex = process.argv.indexOf("--root");
  const profilePath = profileIndex >= 0 ? process.argv[profileIndex + 1] : DEFAULT_PROFILE, root = rootIndex >= 0 ? process.argv[rootIndex + 1] : REPOSITORY_ROOT;
  const requiredStatus = process.argv.includes("--require-active") ? "active" : undefined;
  const issues = await checkFeatureModules({ profilePath, requiredStatus, root });
  if (issues.length) {
    process.stdout.write(`${formatIssues(issues)}\n\nFeature Module Standard ${requiredStatus ?? "candidate"}: ${issues.length} diagnostic(s). No conformance claim.\n`);
    let profileStatus;
    try {
      const rootIdentity = await canonicalRoot(root), portableProfile = portableRepositoryPath(profilePath);
      const inspected = portableProfile && await inspectRepositoryPath(rootIdentity, portableProfile);
      profileStatus = inspected?.ok ? parseDeterministicJson(await readFile(inspected.absolutePath, "utf8")).status : undefined;
    } catch { profileStatus = undefined; }
    const candidateOnlyAllowance = process.argv.includes("--allow-diagnostics")
      && !requiredStatus
      && profileStatus === "candidate"
      && issues.every(({ code }) => CANDIDATE_MIGRATION_CODES.has(code));
    process.exitCode = candidateOnlyAllowance ? 0 : 1;
  } else if (requiredStatus) {process.stdout.write("Feature Module Standard active: 0 diagnostics.\n");}
  else {process.stdout.write("Feature Module Standard candidate: 0 diagnostics. Activation remains a separate reviewed change.\n");}
}
