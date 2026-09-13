import { readFile } from "node:fs/promises";
import { posix } from "node:path";

import { parseSync } from "oxc-parser";

import { importRecords, literalValue } from "./feature-module-imports.mjs";
import { CHECKER_LIMITS, createDiagnosticCollector, overflowIssue } from "./feature-module-limits.mjs";
import {
  createPathIndex,
  FILESYSTEM_IDENTITY_CODE,
  inspectRepositoryPath,
  inventoryRepositoryFiles,
  portableRepositoryPath,
  repositoryPath,
} from "./feature-module-paths.mjs";

const SOURCE_EXTENSIONS = new Set([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts"]);
const TEST_FILE = /(?:^|\/)[^/]+\.(?:test|spec)\.(?:[cm]?[jt]sx?)$/u;
const compareText = (left, right) => left < right ? -1 : left > right ? 1 : 0;

const EXPORT_STEMS = Object.freeze({ ".": "index", "./composition": "composition" });

const curatedPackageExports = (exports, curated) => {
  if (!exports || !curated?.length) {return false;}
  if (Object.keys(exports).toSorted(compareText).join(",") !== [...curated].toSorted(compareText).join(",")) {return false;}
  const matches = (entry, stem) => entry
    && Object.keys(entry).toSorted(compareText).join(",") === "import,types"
    && entry.types === `./dist/${stem}.d.ts`
    && entry.import === `./dist/${stem}.js`;
  return curated.every((key) => matches(exports[key], EXPORT_STEMS[key]));
};

const importBindingNames = (program, sourceSpecifier) => (program.body ?? [])
  .filter((node) => node.type === "ImportDeclaration" && literalValue(node.source) === sourceSpecifier)
  .flatMap((node) => (node.specifiers ?? []).map((specifier) => specifier.type === "ImportNamespaceSpecifier"
    ? "*"
    : specifier.imported?.name ?? specifier.imported?.value ?? "default"));

const readProgram = async (context, path) => {
  const inspected = await inspectRepositoryPath(context.root, path);
  if (!inspected.ok || inspected.metadata.size > CHECKER_LIMITS.sourceFileBytes) {return;}
  try {
    const source = await readFile(inspected.absolutePath, "utf8"), parsed = parseSync(path, source);
    return parsed.errors?.length ? undefined : { program: parsed.program, source };
  } catch {return;}
};

const sourceNodeFeature = (node, context) => {
  if (!["ImportDeclaration", "ExportNamedDeclaration", "ExportAllDeclaration"].includes(node.type)) {return;}
  const sourceSpecifier = literalValue(node.source);
  if (!sourceSpecifier) {return;}
  const resolved = context.localPackageImports.resolve(context.assemblyPath, sourceSpecifier);
  return resolved.kind === "local" && context.featureForPath(context.features, resolved.path);
};

const recordSourceNode = (node, targetFeature, locals, bindings) => {
  if (node.type === "ExportAllDeclaration") {bindings.set("*", targetFeature.id); return;}
  for (const specifier of node.specifiers ?? []) {
    if (node.type === "ImportDeclaration" && specifier.local?.name) {locals.set(specifier.local.name, targetFeature.id);}
    const exported = specifier.exported?.name ?? specifier.exported?.value ?? specifier.local?.name ?? specifier.local?.value;
    if (node.type === "ExportNamedDeclaration" && exported) {bindings.set(exported, targetFeature.id);}
  }
};

const assemblyFeatureBindings = async (context, assemblyPath) => {
  const bindings = new Map(), locals = new Map(), parsed = await readProgram(context, assemblyPath);
  if (!parsed) {return bindings;}
  for (const node of parsed.program.body ?? []) {
    const targetFeature = sourceNodeFeature(node, { ...context, assemblyPath });
    if (targetFeature) {recordSourceNode(node, targetFeature, locals, bindings);}
  }
  for (const node of parsed.program.body ?? []) {
    if (node.type !== "ExportNamedDeclaration" || node.source) {continue;}
    for (const specifier of node.specifiers ?? []) {
      const local = specifier.local?.name ?? specifier.local?.value;
      const exported = specifier.exported?.name ?? specifier.exported?.value ?? local;
      if (locals.has(local) && exported) {bindings.set(exported, locals.get(local));}
    }
  }
  return bindings;
};

const readTestImports = async (context, absoluteTest) => {
  const testPath = repositoryPath(context.root, absoluteTest);
  let source, parsed;
  try {
    source = await readFile(absoluteTest, "utf8");
    parsed = parseSync(testPath, source);
  } catch {
    return { testPath, issues: [context.issue("FM_PARSE_FAILURE", testPath, 1, "test cannot be parsed deterministically")] };
  }
  if (parsed.errors?.length) {
    const issues = parsed.errors.slice(0, CHECKER_LIMITS.diagnostics - 1).map(() => context.issue(
      "FM_PARSE_FAILURE",
      testPath,
      1,
      "test cannot be parsed deterministically",
    ));
    if (parsed.errors.length >= CHECKER_LIMITS.diagnostics) {issues.push(overflowIssue(context.issue, "parse diagnostic"));}
    return {
      testPath,
      issues,
      overflow: parsed.errors.length >= CHECKER_LIMITS.diagnostics,
    };
  }
  const imports = importRecords(parsed.program, source, parsed.comments);
  const remaining = CHECKER_LIMITS.imports - context.testImportBudget.imports;
  const overflow = imports.overflow || imports.length > remaining;
  const retained = imports.slice(0, Math.max(0, remaining));
  context.testImportBudget.imports += retained.length;
  const issues = retained
    .filter(({ nonliteral }) => nonliteral)
    .filter((imported) => !packageArchitectureToolingImport(context, testPath, imported))
    .map((imported) => context.issue("FM_NONLITERAL_LOADING", testPath, imported.line, `${imported.syntax} requires a string literal`));
  if (overflow) {issues.push(overflowIssue(context.issue, "test import"));}
  return { imports: retained.filter(({ nonliteral }) => !nonliteral), program: parsed.program, testPath, issues, overflow };
};

const bindingFeatures = (program, imported, bindings) => {
  if (!bindings || !bindings.size) {return [];}
  const names = importBindingNames(program, imported.specifier);
  if (!names.length || names.includes("*")) {return [...new Set(bindings.values())];}
  const matched = names.flatMap((name) => bindings.has(name) ? [bindings.get(name)] : bindings.has("*") ? [bindings.get("*")] : []);
  return matched.length ? [...new Set(matched)] : [...new Set(bindings.values())];
};

const invalidResolutionIssue = (context, sourcePath, imported, resolved) => context.issue(
  resolved.alias ? "FM_PATH_ALIAS_IMPORT" : FILESYSTEM_IDENTITY_CODE,
  sourcePath,
  imported.line,
  resolved.alias ? `configured import cannot resolve to one owned source: ${imported.specifier}` : "import target must have one canonical, repository-contained identity",
);

// A test may consume another governed module exactly where production code may:
// through a curated assembly entry of a module its owner declares an edge to.
// Anything else that leaves the package stays a resolution failure, so a
// nonexistent path or a reach into a sibling module's internals still fails.
const declaredModuleConsumption = (context, resolved) => {
  if (resolved.self !== true || typeof resolved.path !== "string") {return false;}
  // A package export map names the emitted specifier, so the resolved target can
  // still carry the build-output extension.
  const targetPath = resolved.path.replace(/\.js$/u, ".ts");
  const modules = [...context.declaredModules.values()];
  const owner = modules.find(({ sourceRoot }) => sourceRoot === context.productionRoot);
  const target = modules
    .filter(({ sourceRoot }) => targetPath === sourceRoot || targetPath.startsWith(`${sourceRoot}/`))
    .toSorted((left, right) => right.sourceRoot.length - left.sourceRoot.length)[0];
  if (!owner || !target || owner.id === target.id) {return false;}
  const curated = target.curatedExports.map((entry) => `${target.sourceRoot}/${entry === "." ? "index.ts" : "composition.ts"}`);
  return curated.includes(targetPath) && Boolean(context.declaredModuleEdges?.has(`${owner.id}->${target.id}`));
};

const detectedSourceFeatures = async (context, parsed, visited) => {
  const detected = new Set(), direct = new Set(), issues = [];
  let overflow = false;
  for (const imported of parsed.imports ?? []) {
    const resolved = context.localPackageImports.resolve(parsed.testPath, imported.specifier, context.packagePathIndex);
    if (declaredModuleConsumption(context, resolved)) {continue;}
    if (packageArchitectureToolingLoad(context, parsed.testPath, imported.specifier)) {continue;}
    if (resolved.kind === "invalid") {
      issues.push(invalidResolutionIssue(context, parsed.testPath, imported, resolved));
      continue;
    }
    if (resolved.kind !== "local") {continue;}
    const absoluteTarget = context.packageFilesByPath.get(resolved.path);
    if (!absoluteTarget) {
      issues.push(invalidResolutionIssue(context, parsed.testPath, imported, { identity: true }));
      continue;
    }
    const directFeature = context.featureForPath(context.packageFeatures, resolved.path);
    if (directFeature) {detected.add(directFeature.id); direct.add(directFeature.id); continue;}
    if (context.assemblyBindings.has(resolved.path)) {
      for (const id of bindingFeatures(parsed.program, imported, context.assemblyBindings.get(resolved.path))) {detected.add(id);}
      continue;
    }
    if (visited.has(resolved.path)) {continue;}
    visited.add(resolved.path);
    const helper = await readTestImports(context, absoluteTarget);
    issues.push(...helper.issues);
    if (helper.overflow) {overflow = true; break;}
    if (!helper.program) {continue;}
    const nested = await detectedSourceFeatures(context, helper, visited);
    for (const id of nested.detected) {detected.add(id);}
    for (const id of nested.direct) {direct.add(id);}
    issues.push(...nested.issues);
    if (nested.overflow) {overflow = true; break;}
  }
  return { detected, direct, issues, overflow };
};

const ARCHITECTURE_TOOLING = /^scripts\/architecture\/[^/]+\.mjs$/u;
const separators = (value) => String(value).replaceAll("\\", "/");

// Package-owned tests may load repo architecture tooling as an external
// helper. The specifier must be a string literal relative path whose
// canonical repository identity is exactly `scripts/architecture/*.mjs`.
// Feature tests, production sources, and any other repo-script path stay
// on the ordinary filesystem-identity failure.
const packageArchitectureToolingLoad = (context, sourcePath, specifier) => {
  const owner = declaredTestOwner(sourcePath, context.packageRoot, context.packageFeatures);
  if (owner?.kind !== "package") {return false;}
  if (typeof specifier !== "string" || specifier !== specifier.normalize("NFC") || specifier.includes("\0")) {
    return false;
  }
  const normalized = separators(specifier);
  if (!(normalized.startsWith("./") || normalized.startsWith("../"))) {return false;}
  const source = portableRepositoryPath(sourcePath);
  if (!source) {return false;}
  const target = posix.normalize(posix.join(posix.dirname(source), normalized));
  if (target === ".." || target.startsWith("../")) {return false;}
  const canonical = portableRepositoryPath(target);
  return Boolean(canonical && canonical === target && ARCHITECTURE_TOOLING.test(canonical));
};

// Foundation classifies a computed `import()` as a dynamic runtime reference,
// which is what keeps package tests from creating a root-package cycle. The
// only string literal in that expression must still be the repo-relative
// architecture tooling path, so a computed loader cannot hide a feature import.
const packageArchitectureToolingImport = (context, sourcePath, imported) => {
  const owner = declaredTestOwner(sourcePath, context.packageRoot, context.packageFeatures);
  if (owner?.kind !== "package" || imported.syntax !== "dynamic-import") {return false;}
  return imported.specifierLiterals?.length === 1 && ARCHITECTURE_TOOLING.test(imported.specifierLiterals[0]);
};

const declaredTestOwner = (testPath, packageRoot, packageFeatures) => {
  const colocated = packageFeatures.find((feature) => testPath.startsWith(`${feature.root}/`));
  if (colocated) {return { kind: "feature", id: colocated.id };}
  const prefix = packageRoot ? `${packageRoot}/` : "";
  if (testPath.startsWith(`${prefix}tests/package/`)) {return { kind: "package" };}
  const match = testPath.match(new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}tests/features/([^/]+)/`, "u"));
  return match && packageFeatures.some(({ id }) => id === match[1]) ? { kind: "feature", id: match[1] } : undefined;
};

const testOwnershipIssues = (context, testPath, detected, direct) => {
  const owner = declaredTestOwner(testPath, context.packageRoot, context.packageFeatures);
  if (owner?.kind === "package") {
    return direct.size
      ? [context.issue("FM_TEST_PLACEMENT", testPath, 1, "package tests must exercise features through curated package assembly surfaces")]
      : [];
  }
  if (!owner) {return [context.issue("FM_TEST_PLACEMENT", testPath, 1, "test must have one declared feature owner or be placed under tests/package")];}
  if (!detected.size || detected.size === 1 && detected.has(owner.id)) {return [];}
  return [context.issue("FM_TEST_PLACEMENT", testPath, 1, `${owner.id} test imports must resolve only to its declared feature owner`)];
};

const packageTestIssues = async (context, packageFiles) => {
  const findings = createDiagnosticCollector(context.issue), tests = packageFiles
    .filter((absolutePath) => TEST_FILE.test(repositoryPath(context.root, absolutePath)))
    .toSorted((left, right) => compareText(repositoryPath(context.root, left), repositoryPath(context.root, right)));
  for (const absoluteTest of tests) {
    const parsed = await readTestImports(context, absoluteTest);
    findings.add(parsed.issues);
    if (parsed.overflow) {break;}
    if (!parsed.program) {continue;}
    const detected = await detectedSourceFeatures(context, parsed, new Set([parsed.testPath]));
    findings.add(detected.issues);
    findings.add(testOwnershipIssues(context, parsed.testPath, detected.detected, detected.direct));
    if (detected.overflow || findings.result().some(({ code }) => code === "FM_CHECKER_OVERFLOW")) {break;}
  }
  return findings.result();
};

const packageIssues = async (context, productionRoot) => {
  context = { ...context, productionRoot };
  const parent = posix.dirname(productionRoot), packageRoot = parent === "." ? "" : parent;
  const packagePath = posix.join(packageRoot, "package.json");
  const ownedPackage = context.localPackageImports.packages.find((candidate) => candidate.productionRoot === productionRoot);
  const curated = context.declaredModules.get(productionRoot)?.curatedExports;
  const issues = curatedPackageExports(ownedPackage?.packageJson?.exports, curated) ? []
    : [context.issue("FM_PACKAGE_EXPORT_MAP", packagePath, 1, `package exports must expose only the curated assembly files declared for this module: ${(curated ?? []).join(" ")}`)];
  const inventory = await inventoryRepositoryFiles({
    root: context.root,
    startPath: packageRoot,
    extensions: SOURCE_EXTENSIONS,
    issue: context.issue,
    excludedDirectories: new Set([".cache", ".git", "dist", "node_modules"]),
    budget: context.testScanBudget,
    maxEntries: CHECKER_LIMITS.traversalEntries,
    maxDepth: CHECKER_LIMITS.traversalDepth,
    maxFiles: CHECKER_LIMITS.files,
    maxFileBytes: CHECKER_LIMITS.sourceFileBytes,
    maxSourceBytes: CHECKER_LIMITS.sourceBytes,
    maxIssues: CHECKER_LIMITS.diagnostics,
  });
  issues.push(...inventory.issues);
  if (inventory.overflow) {issues.push(overflowIssue(context.issue, "test source scan")); return issues;}
  const productionPrefix = `${productionRoot}/`, colocatedTests = context.productionFiles
    .filter((path) => repositoryPath(context.root, path).startsWith(productionPrefix) && TEST_FILE.test(repositoryPath(context.root, path)));
  const packageFiles = [...new Set([...inventory.files, ...colocatedTests])];
  const packageFilesByPath = new Map(packageFiles.map((absolutePath) => [repositoryPath(context.root, absolutePath), absolutePath]));
  const packagePathIndex = createPathIndex(packageFilesByPath.keys());
  const packageFeatures = context.features.filter((feature) => feature.root.startsWith(`${productionRoot}/features/`));
  const assemblyBindings = new Map();
  for (const assemblyPath of [`${productionRoot}/index.ts`, `${productionRoot}/composition.ts`]) {
    assemblyBindings.set(assemblyPath, await assemblyFeatureBindings({ ...context, features: packageFeatures }, assemblyPath));
  }
  issues.push(...await packageTestIssues({ ...context, packageRoot, packageFeatures, assemblyBindings, packageFilesByPath, packagePathIndex }, packageFiles));
  return issues;
};

export const packagePolicyIssues = async (context) => {
  const findings = createDiagnosticCollector(context.issue);
  const testScanBudget = { entries: 0, files: 0, sourceBytes: 0 };
  const testImportBudget = { imports: 0 };
  for (const productionRoot of context.productionRoots) {
    const candidates = await packageIssues({ ...context, testImportBudget, testScanBudget }, productionRoot);
    findings.add(candidates);
    if (candidates.some(({ code }) => code === "FM_CHECKER_OVERFLOW")) {break;}
  }
  return findings.result();
};
