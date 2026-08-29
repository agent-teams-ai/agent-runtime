import { readFile, readdir, stat } from "node:fs/promises";
import { builtinModules } from "node:module";
import { dirname, extname, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { parseSync } from "oxc-parser";

import { ACCEPTED_DECISIONS, STRUCTURAL_CODES, applyGovernedRecords, validateProfile } from "./feature-module-profile.mjs";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
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

const memberName = (node) => node?.property?.name ?? literalValue(node?.property);
const isNamedIdentifier = (node, name) => node?.type === "Identifier" && node.name === name;
const isMemberCall = (node, object, property) => node?.type === "MemberExpression" && isNamedIdentifier(node.object, object) && memberName(node) === property;

const loadingSyntax = (callee, loadingAliases) => {
  if (isNamedIdentifier(callee, "require")) {return "require";}
  if (isMemberCall(callee, "require", "resolve")) {return "require-resolve";}
  if (isMemberCall(callee, "module", "require")) {return "module-require";}
  if (callee?.type === "Identifier" && loadingAliases.loaders.has(callee.name)) {return "create-require";}
  if (callee?.type === "CallExpression" && callee.callee?.type === "Identifier" && loadingAliases.factories.has(callee.callee.name)) {return "create-require";}
  return;
};

const callExpressionRecord = (node, source, loadingAliases = { factories: new Set(), loaders: new Set() }) => {
  const syntax = loadingSyntax(node.callee, loadingAliases);
  if (!syntax) {return;}
  const argument = node.arguments?.[0];
  return makeImportRecord(node, argument, "runtime", syntax, { source, nonliteral: literalValue(argument) === undefined });
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

const walkAst = (node, visitor) => {
  if (!node || typeof node !== "object") {return;}
  visitor(node);
  for (const [key, value] of Object.entries(node)) {
    if (["parent", "comments", "tokens", "errors"].includes(key)) {continue;}
    if (Array.isArray(value)) {value.forEach((item) => walkAst(item, visitor));}
    else if (value && typeof value === "object" && typeof value.type === "string") {walkAst(value, visitor);}
  }
};

const createRequireAliases = (program) => {
  const factories = new Set(), namespaces = new Set(), loaders = new Set();
  walkAst(program, (node) => {
    if (node.type !== "ImportDeclaration" || literalValue(node.source) !== "node:module") {return;}
    for (const specifier of node.specifiers ?? []) {
      if (specifier.type === "ImportNamespaceSpecifier") {namespaces.add(specifier.local?.name);}
      if (specifier.type === "ImportSpecifier" && (specifier.imported?.name ?? specifier.imported?.value) === "createRequire") {factories.add(specifier.local?.name);}
    }
  });
  walkAst(program, (node) => {
    if (node.type !== "VariableDeclarator" || node.id?.type !== "Identifier" || node.init?.type !== "CallExpression") {return;}
    const directFactory = node.init.callee?.type === "Identifier" && factories.has(node.init.callee.name);
    const namespaceFactory = node.init.callee?.type === "MemberExpression" && namespaces.has(node.init.callee.object?.name) && memberName(node.init.callee) === "createRequire";
    if (directFactory || namespaceFactory) {loaders.add(node.id.name);}
  });
  return { factories, loaders };
};

const importRecords = (program, source) => {
  const records = [];
  const loadingAliases = createRequireAliases(program);
  const visit = (node) => {
    if (!node || typeof node !== "object") {return;}
    const reader = IMPORT_RECORD_READERS[node.type];
    const record = node.type === "CallExpression" ? reader?.(node, source, loadingAliases) : reader?.(node, source);
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
  const names = new Set(), targets = new Map(), aliases = new Set(), issues = [];
  for (const productionRoot of productionRoots) {
    const packageRoot = resolve(absoluteRoot, productionRoot, "..");
    try {
      const { name, imports = {} } = JSON.parse(await readFile(resolve(packageRoot, "package.json"), "utf8"));
      if (name) {names.add(name); targets.set(name, `${productionRoot}/index.ts`); targets.set(`${name}/composition`, `${productionRoot}/composition.ts`);}
      Object.keys(imports).forEach((alias) => aliases.add(alias));
    } catch (error) {
      if (error?.code !== "ENOENT") {issues.push(issue("FM_PROFILE_INVALID", repoPath(absoluteRoot, resolve(packageRoot, "package.json")), 1, `cannot parse package aliases: ${error.message}`));}
    }
    try {
      const visited = new Set();
      const readAliases = async (configPath) => {
        if (visited.has(configPath)) {return;}
        visited.add(configPath);
        const tsconfig = JSON.parse(await readFile(configPath, "utf8"));
        Object.keys(tsconfig.compilerOptions?.paths ?? {}).forEach((alias) => aliases.add(alias));
        if (typeof tsconfig.extends === "string" && tsconfig.extends.startsWith(".")) {
          const extended = resolve(dirname(configPath), tsconfig.extends);
          await readAliases(extname(extended) ? extended : `${extended}.json`);
        }
      };
      await readAliases(resolve(packageRoot, "tsconfig.json"));
    } catch (error) {
      if (error?.code !== "ENOENT") {issues.push(issue("FM_PROFILE_INVALID", repoPath(absoluteRoot, resolve(packageRoot, "tsconfig.json")), 1, `cannot parse alias configuration: ${error.message}`));}
    }
  }
  return { names, targets, aliases, issues };
};

const aliasMatches = (specifier, alias) => alias.includes("*")
  ? specifier.startsWith(alias.slice(0, alias.indexOf("*"))) && specifier.endsWith(alias.slice(alias.indexOf("*") + 1))
  : specifier === alias;

const curatedPackageExports = (exports) => {
  if (!exports || Object.keys(exports).toSorted(compareText).join(",") !== ".,./composition") {return false;}
  const matches = (entry, stem) => entry
    && Object.keys(entry).toSorted(compareText).join(",") === "import,types"
    && entry.types === `./dist/${stem}.d.ts`
    && entry.import === `./dist/${stem}.js`;
  return matches(exports["."], "index") && matches(exports["./composition"], "composition");
};

const packagePolicyIssues = async (absoluteRoot, productionRoots, features) => {
  const issues = [];
  for (const productionRoot of productionRoots) {
    const packageRoot = resolve(absoluteRoot, productionRoot, "..");
    const packagePath = repoPath(absoluteRoot, resolve(packageRoot, "package.json"));
    try {
      const packageJson = JSON.parse(await readFile(resolve(packageRoot, "package.json"), "utf8"));
      if (!curatedPackageExports(packageJson.exports)) {
        issues.push(issue("FM_PACKAGE_EXPORT_MAP", packagePath, 1, "package exports must expose only the public and composition assembly files"));
      }
    } catch (error) {
      issues.push(issue("FM_PACKAGE_EXPORT_MAP", packagePath, 1, `package export map cannot be verified: ${error.message}`));
    }

    const packageFiles = await filesBelow(packageRoot);
    const packageFeatures = features.filter((feature) => feature.root.startsWith(`${productionRoot}/features/`));
    for (const absoluteTest of packageFiles.filter((path) => /\.(?:test|spec)\.(?:[cm]?[jt]sx?)$/u.test(path) && !/[\\/](?:dist|node_modules|\.cache)[\\/]/u.test(path))) {
      const testPath = repoPath(absoluteRoot, absoluteTest);
      const source = await readFile(absoluteTest, "utf8");
      let imports = [];
      try { imports = importRecords(parseSync(testPath, source).program, source); } catch { imports = []; }
      const importedPaths = imports.flatMap(({ specifier }) => {
        const target = resolveLocalImport(slash(absoluteTest), specifier);
        return target ? [repoPath(absoluteRoot, target)] : [];
      }).map((path) => path.replace(`${repoPath(absoluteRoot, packageRoot)}/dist/features/`, `${productionRoot}/features/`));
      const misplacedFeature = packageFeatures.find((feature) => !testPath.startsWith(`${feature.root}/`) && (
        packageFeatures.length === 1
        || posix.basename(testPath).includes(feature.id)
        || importedPaths.some((path) => path.startsWith(`${feature.root}/`))
      ));
      if (misplacedFeature) {issues.push(issue("FM_TEST_PLACEMENT", testPath, 1, `${misplacedFeature.id} tests must be colocated with their feature`));}
    }
  }
  return issues;
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
  const readmePath = `${feature.root}/README.md`;
  try {
    const readme = await readFile(resolve(absoluteRoot, readmePath), "utf8");
    if (!/^Owner:\s+\S.+$/mu.test(readme)) {issues.push(issue("FM_README_OWNERSHIP", readmePath, 1, `${feature.id} README must declare a non-empty Owner`));}
  } catch { issues.push(issue("FM_README_OWNERSHIP", readmePath, 1, `${feature.id} must declare README ownership`)); }
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

const inspectImport = (context) => {
  const { absoluteFile, absoluteRoot, features, isAssembly, sourceFeature, path, imported, localPackageImports, productionRoots } = context;
  if (imported.nonliteral) {return [issue("FM_NONLITERAL_LOADING", path, imported.line, `${imported.syntax} requires a string literal`)];}
  if (isPathAlias(imported.specifier) || [...localPackageImports.aliases].some((alias) => aliasMatches(imported.specifier, alias))) {return [issue("FM_PATH_ALIAS_IMPORT", path, imported.line, `path alias imports cannot bypass feature boundaries: ${imported.specifier}`)];}
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

export const checkFeatureModules = async ({ root = REPOSITORY_ROOT, profilePath = DEFAULT_PROFILE, requiredStatus, acceptedDecisions = ACCEPTED_DECISIONS } = {}) => {
  const absoluteRoot = resolve(root);
  const absoluteProfile = resolve(absoluteRoot, profilePath);
  const loaded = await readProfile(absoluteProfile, profilePath);
  if (!loaded.profile) {return loaded.issues;}
  const { profile } = loaded;
  const issues = validateProfile(profile, profilePath, absoluteRoot === REPOSITORY_ROOT, acceptedDecisions);
  if (issues.some((candidate) => candidate.code === "FM_PROFILE_INVALID")) {return issues.toSorted(compareIssues);}
  if (requiredStatus && profile.status !== requiredStatus) {issues.push(issue("FM_PROFILE_STATUS", profilePath, 1, `profile status must be ${requiredStatus}`));}

  const features = (profile.features ?? []).map((feature) => ({ ...feature, root: slash(feature.root) }));
  const assemblyFiles = new Set(profile.assemblyFiles ?? []);
  const declaredEdges = new Map((profile.featureEdges ?? []).map((edge) => [`${edge.from}->${edge.to}`, new Set(edge.kinds)]));
  const observedEdges = new Map();
  const edgeLocations = new Map();
  const allFiles = await collectProductionFiles(absoluteRoot, profile.scope.productionRoots ?? []);
  const localPackageImports = await readLocalPackageImports(absoluteRoot, profile.scope.productionRoots ?? []);
  issues.push(...localPackageImports.issues);
  const allPaths = allFiles.map((path) => repoPath(absoluteRoot, path));
  issues.push(...assemblyStructureIssues(profile.assemblyFiles ?? [], allPaths));

  for (const feature of features) {
    issues.push(...await featureStructureIssues(feature, allPaths, absoluteRoot));
  }
  issues.push(...await packagePolicyIssues(absoluteRoot, profile.scope.productionRoots ?? [], features));

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
  return applyGovernedRecords(profile, issues, profilePath).toSorted(compareIssues);
};

export const formatIssues = (issues) => issues.map((entry) => `${entry.path}:${entry.line} ${entry.code} ${entry.message}`).join("\n");

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const profileIndex = process.argv.indexOf("--profile"), rootIndex = process.argv.indexOf("--root");
  const profilePath = profileIndex >= 0 ? process.argv[profileIndex + 1] : DEFAULT_PROFILE, root = rootIndex >= 0 ? process.argv[rootIndex + 1] : REPOSITORY_ROOT;
  const requiredStatus = process.argv.includes("--require-active") ? "active" : undefined;
  const issues = await checkFeatureModules({ profilePath, requiredStatus, root });
  if (issues.length) {
    process.stdout.write(`${formatIssues(issues)}\n\nFeature Module Standard ${requiredStatus ?? "candidate"}: ${issues.length} diagnostic(s). No conformance claim.\n`);
    let profileStatus;
    try { profileStatus = JSON.parse(await readFile(resolve(root, profilePath), "utf8")).status; } catch { profileStatus = undefined; }
    const candidateOnlyAllowance = process.argv.includes("--allow-diagnostics")
      && !requiredStatus
      && profileStatus === "candidate"
      && !issues.some(({ code }) => STRUCTURAL_CODES.has(code));
    process.exitCode = candidateOnlyAllowance ? 0 : 1;
  } else if (requiredStatus) {process.stdout.write("Feature Module Standard active: 0 diagnostics.\n");}
  else {process.stdout.write("Feature Module Standard candidate: 0 diagnostics. Activation remains a separate reviewed change.\n");}
}
