import { readFile, realpath, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, posix, relative, resolve } from "node:path";

import { parseTree } from "jsonc-parser";

import { CHECKER_LIMITS, createDiagnosticCollector, overflowIssue } from "./feature-module-limits.mjs";

import {
  filesystemIdentityIssue,
  inspectRepositoryPath,
  portableRepositoryPath,
  resolveIndexedPath,
  resolveRelativeSpecifier,
} from "./feature-module-paths.mjs";

const stableConfigIssue = (issue, path, message) => issue("FM_UNSUPPORTED_CONFIG", path, 1, message);
const configMessage = "TypeScript configuration or an extends parent is missing, unreadable, or unsupported";
const FOUNDATION_PRESET = "@agent-teams/engineering-foundation/presets/typescript/node.json";
const FOUNDATION_NAME = "@agent-teams/engineering-foundation";
const FOUNDATION_VERSION = "0.20.0";
const requireFromHere = createRequire(import.meta.url);
const compareText = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const slash = (value) => String(value).replaceAll("\\", "/");
const outsideRoot = (value) => value === ".." || value.startsWith("../") || value.startsWith("/");
const oneWildcard = (value) => (value.match(/\*/gu) ?? []).length <= 1;
const portableTargetPattern = (value) => portableRepositoryPath(value.replace("*", "__feature_wildcard__"));
const canonicalPackageName = (value) => typeof value === "string"
  && value.length > 0
  && value === value.trim()
  && value === value.normalize("NFC")
  && !/[\\\s]/u.test(value);
const canonicalOwnerDocument = (value) => typeof value === "string" && /^ADR-[0-9]{4}$/u.test(value);

const hasDuplicateJsonKey = (node) => {
  if (node?.type === "object") {
    const seen = new Set();
    for (const property of node.children ?? []) {
      const [key, value] = property.children ?? [];
      if (property.type !== "property" || typeof key?.value !== "string" || !value || seen.has(key.value)) {return true;}
      seen.add(key.value);
      if (hasDuplicateJsonKey(value)) {return true;}
    }
  } else if (node?.type === "array" && (node.children ?? []).some(hasDuplicateJsonKey)) {return true;}
  return false;
};

export const parseDeterministicJson = (source) => {
  if (typeof source !== "string" || source.startsWith("\uFEFF") || source.includes("\0")) {throw new SyntaxError("invalid JSON source");}
  const errors = [], tree = parseTree(source, errors, {
    allowEmptyContent: false,
    allowTrailingComma: false,
    disallowComments: true,
  });
  if (!tree || errors.length || hasDuplicateJsonKey(tree)) {throw new SyntaxError("invalid JSON source");}
  return JSON.parse(source);
};

const readJson = async (root, path, optional = false, budget = { bytes: 0, files: 0 }) => {
  const inspected = await inspectRepositoryPath(root, path, { optional });
  if (!inspected.ok) {return { ...inspected };}
  if (budget.files >= CHECKER_LIMITS.configFiles || inspected.metadata.size > CHECKER_LIMITS.sourceFileBytes
    || budget.bytes + inspected.metadata.size > CHECKER_LIMITS.configBytes) {return { ok: false, path, overflow: true };}
  budget.files += 1; budget.bytes += inspected.metadata.size;
  try {return { ok: true, value: parseDeterministicJson(await readFile(inspected.absolutePath, "utf8")), path };}
  catch {return { ok: false, path, invalid: true };}
};

const relativeConfigPath = (configPath, declaration) => {
  if (typeof declaration !== "string" || !declaration || declaration !== declaration.normalize("NFC")) {return;}
  const normalized = slash(declaration);
  if (!(normalized.startsWith("./") || normalized.startsWith("../"))) {return;}
  let target = posix.normalize(posix.join(posix.dirname(configPath), normalized));
  if (outsideRoot(target)) {return;}
  if (!posix.extname(target)) {target = `${target}.json`;}
  return target;
};

const aliasRule = (configPath, alias, targets) => {
  if (typeof alias !== "string" || !alias || alias !== alias.normalize("NFC") || !oneWildcard(alias)
    || !Array.isArray(targets) || targets.length !== 1 || typeof targets[0] !== "string" || !targets[0]
    || targets[0] !== targets[0].normalize("NFC") || targets[0].includes("\\") || !oneWildcard(targets[0])
    || (alias.match(/\*/gu) ?? []).length !== (targets[0].match(/\*/gu) ?? []).length) {return;}
  const normalized = slash(targets[0]);
  const relativeTarget = normalized.startsWith("./") ? normalized.slice(2) : normalized;
  if (!portableTargetPattern(relativeTarget)) {return;}
  const target = posix.normalize(posix.join(posix.dirname(configPath), relativeTarget));
  if (outsideRoot(target)) {return;}
  return { pattern: alias, target };
};

const ownAliasRules = (config, configPath, issues, issue) => {
  const paths = config.compilerOptions?.paths;
  if (paths === undefined) {return new Map();}
  if (!paths || typeof paths !== "object" || Array.isArray(paths)) {
    issues.push(stableConfigIssue(issue, configPath, configMessage)); return new Map();
  }
  const rules = new Map();
  for (const [alias, targets] of Object.entries(paths).toSorted(([left], [right]) => compareText(left, right))) {
    const rule = aliasRule(configPath, alias, targets);
    if (!rule) {issues.push(stableConfigIssue(issue, configPath, configMessage)); continue;}
    rules.set(alias, rule);
  }
  return rules;
};

const containedPath = (root, path) => {
  const candidate = relative(root, path);
  return candidate === "" || candidate !== ".." && !candidate.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(candidate);
};

const externalPresetPath = async (path, packageRoot, active) => {
  const canonicalPath = await realpath(path);
  if (!containedPath(packageRoot, canonicalPath) || active.has(canonicalPath)) {throw new Error("unsupported preset path");}
  return canonicalPath;
};

const consumeExternalPresetBudget = async (canonicalPath, active, budget) => {
  const metadata = await stat(canonicalPath);
  if (active.size >= CHECKER_LIMITS.traversalDepth || budget.files >= CHECKER_LIMITS.configFiles
    || metadata.size > CHECKER_LIMITS.sourceFileBytes || budget.bytes + metadata.size > CHECKER_LIMITS.configBytes) {
    throw new Error("preset configuration limit exceeded");
  }
  budget.files += 1; budget.bytes += metadata.size;
};

const externalPresetParents = async (canonicalPath) => {
  const config = JSON.parse(await readFile(canonicalPath, "utf8"));
  if (!config || typeof config !== "object" || Array.isArray(config)
    || config.compilerOptions?.baseUrl !== undefined || config.compilerOptions?.paths !== undefined) {
    throw new Error("unsupported preset configuration");
  }
  return Array.isArray(config.extends) ? config.extends : config.extends === undefined ? [] : [config.extends];
};

const inspectExternalPresetParents = async (parents, canonicalPath, packageRoot, active, budget) => {
  for (const parent of parents) {
    if (typeof parent !== "string" || !(parent.startsWith("./") || parent.startsWith("../"))) {throw new Error("unsupported preset extends");}
    await externalPresetConfig(resolve(dirname(canonicalPath), parent), packageRoot, active, budget);
  }
};

const externalPresetConfig = async (path, packageRoot, active = new Set(), budget = { bytes: 0, files: 0 }) => {
  const canonicalPath = await externalPresetPath(path, packageRoot, active);
  await consumeExternalPresetBudget(canonicalPath, active, budget);
  active.add(canonicalPath);
  try {
    const parents = await externalPresetParents(canonicalPath);
    await inspectExternalPresetParents(parents, canonicalPath, packageRoot, active, budget);
  } finally {active.delete(canonicalPath);}
};

const inspectFoundationPreset = async (context, configPath) => {
  try {
    const manifestPath = await realpath(requireFromHere.resolve(`${FOUNDATION_NAME}/package.json`));
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    if (manifest.name !== FOUNDATION_NAME || manifest.version !== FOUNDATION_VERSION) {throw new Error("unexpected preset authority");}
    const packageRoot = dirname(manifestPath), presetPath = requireFromHere.resolve(FOUNDATION_PRESET);
    await externalPresetConfig(presetPath, packageRoot);
  } catch {context.issues.push(stableConfigIssue(context.issue, configPath, configMessage));}
};

const loadedTsconfig = async (context, configPath, optional) => {
  const loaded = await readJson(context.root, configPath, optional, context.configBudget);
  if (!loaded.ok) {
    if (loaded.overflow) {context.issues.push(overflowIssue(context.issue, "configuration"));}
    else if (loaded.identity) {context.issues.push(filesystemIdentityIssue(context.issue, configPath));}
    else if (!(optional && loaded.missing)) {context.issues.push(stableConfigIssue(context.issue, configPath, configMessage));}
    return;
  }
  const config = loaded.value;
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    context.issues.push(stableConfigIssue(context.issue, configPath, configMessage));
    return;
  }
  return config;
};

const inspectTsconfig = async (context, configPath, optional, visited = new Set(), active = new Set()) => {
  if (active.size >= CHECKER_LIMITS.traversalDepth) {
    context.issues.push(overflowIssue(context.issue, "configuration depth"));
    return new Map();
  }
  if (active.has(configPath)) {
    context.issues.push(stableConfigIssue(context.issue, configPath, "cyclic TypeScript extends configuration is unsupported"));
    return new Map();
  }
  if (visited.has(configPath)) {return new Map();}
  visited.add(configPath); active.add(configPath);
  const config = await loadedTsconfig(context, configPath, optional);
  if (!config) {active.delete(configPath); return new Map();}
  if (config.compilerOptions?.baseUrl !== undefined) {
    context.issues.push(stableConfigIssue(context.issue, configPath, "compilerOptions.baseUrl is unsupported by the feature boundary checker"));
  }
  const rules = new Map(), parents = Array.isArray(config.extends) ? config.extends : config.extends === undefined ? [] : [config.extends];
  for (const parent of parents) {
    if (parent === FOUNDATION_PRESET) {await inspectFoundationPreset(context, configPath); continue;}
    const parentPath = relativeConfigPath(configPath, parent);
    if (!parentPath) {context.issues.push(stableConfigIssue(context.issue, configPath, configMessage)); continue;}
    const inherited = await inspectTsconfig(context, parentPath, false, visited, active);
    for (const [key, value] of inherited) {rules.set(key, value);}
    if (context.issues.result().some(({ code }) => code === "FM_CHECKER_OVERFLOW")) {break;}
  }
  for (const [key, value] of ownAliasRules(config, configPath, context.issues, context.issue)) {rules.set(key, value);}
  active.delete(configPath);
  return rules;
};

const stringLeaves = (value) => {
  if (typeof value === "string") {return [value];}
  if (Array.isArray(value)) {return value.flatMap(stringLeaves);}
  if (value && typeof value === "object") {return Object.values(value).flatMap(stringLeaves);}
  return [];
};

const packageTarget = (packageRoot, productionRoot, value) => {
  const leaves = [...new Set(stringLeaves(value))];
  if (leaves.length !== 1 || !leaves[0].startsWith("./") || leaves[0] !== leaves[0].normalize("NFC")
    || leaves[0].includes("\\") || !oneWildcard(leaves[0])) {return;}
  const relativeTarget = slash(leaves[0]).slice(2);
  if (!portableTargetPattern(relativeTarget)) {return;}
  const normalized = posix.normalize(posix.join(packageRoot, relativeTarget));
  if (outsideRoot(normalized)) {return;}
  const distPrefix = packageRoot ? `${packageRoot}/dist/` : "dist/";
  return normalized.startsWith(distPrefix) ? `${productionRoot}/${normalized.slice(distPrefix.length)}` : normalized;
};

const packageImportRules = ({ packageJson, packageRoot, productionRoot, issues, issue, packagePath }) => {
  const imports = packageJson.imports ?? {};
  if (!imports || typeof imports !== "object" || Array.isArray(imports)) {
    issues.push(stableConfigIssue(issue, packagePath, "package imports configuration is unsupported")); return new Map();
  }
  const rules = new Map();
  for (const [pattern, value] of Object.entries(imports).toSorted(([left], [right]) => compareText(left, right))) {
    const target = packageTarget(packageRoot, productionRoot, value);
    if (!pattern.startsWith("#") || pattern === "#" || pattern.startsWith("#/") || !oneWildcard(pattern) || !target
      || (pattern.match(/\*/gu) ?? []).length !== (target.match(/\*/gu) ?? []).length) {
      issues.push(stableConfigIssue(issue, packagePath, "package imports configuration is unsupported")); continue;
    }
    rules.set(pattern, { pattern, target });
  }
  return rules;
};

const exportedTarget = (packageJson, key, packageRoot, productionRoot) => packageTarget(
  packageRoot,
  productionRoot,
  packageJson.exports?.[key]?.import,
);

const matchesRule = (specifier, rule) => {
  const star = rule.pattern.indexOf("*");
  if (star < 0) {return specifier === rule.pattern ? "" : undefined;}
  const prefix = rule.pattern.slice(0, star), suffix = rule.pattern.slice(star + 1);
  return specifier.startsWith(prefix) && specifier.endsWith(suffix)
    ? specifier.slice(prefix.length, specifier.length - suffix.length || undefined)
    : undefined;
};

const applyRules = (specifier, rules) => {
  const matched = [...rules.values()]
    .map((rule) => ({ rule, capture: matchesRule(specifier, rule) }))
    .filter(({ capture }) => capture !== undefined)
    .toSorted((left, right) => right.rule.pattern.length - left.rule.pattern.length || compareText(left.rule.pattern, right.rule.pattern));
  if (!matched.length) {return;}
  if (matched.length > 1 && matched[0].rule.pattern.length === matched[1].rule.pattern.length
    && matched[0].rule.target !== matched[1].rule.target) {return { ambiguous: true };}
  const { rule, capture } = matched[0];
  return { target: rule.target.replace("*", capture) };
};

const owningPackage = (packages, fromPath) => packages
  .filter(({ packageRoot, productionRoot }) => !packageRoot || fromPath === packageRoot || fromPath.startsWith(`${packageRoot}/`) || fromPath.startsWith(`${productionRoot}/`))
  .toSorted((left, right) => right.packageRoot.length - left.packageRoot.length)[0];

const translateDistPath = (ownedPackage, value) => {
  if (!ownedPackage) {return value;}
  const prefix = ownedPackage.packageRoot ? `${ownedPackage.packageRoot}/dist/` : "dist/";
  return value.startsWith(prefix) ? `${ownedPackage.productionRoot}/${value.slice(prefix.length)}` : value;
};

const configuredResolver = (packages, names, index) => (fromPath, specifier, resolutionIndex = index) => {
  const relativeResult = resolveRelativeSpecifier(fromPath, specifier, resolutionIndex);
  const ownedPackage = owningPackage(packages, fromPath);
  if (relativeResult.kind === "local") {
    const translated = translateDistPath(ownedPackage, relativeResult.path), indexed = resolveIndexedPath(translated, resolutionIndex);
    return indexed.ok ? { kind: "local", path: indexed.path } : { kind: "invalid", identity: true };
  }
  if (relativeResult.kind === "invalid") {return relativeResult;}
  if (typeof specifier !== "string") {return { kind: "invalid", identity: true };}
  if (specifier.startsWith("#")) {
    const result = ownedPackage && applyRules(specifier, ownedPackage.imports);
    if (!result || result.ambiguous) {return { kind: "invalid", alias: true };}
    const indexed = resolveIndexedPath(result.target, resolutionIndex, { requireExisting: true });
    return indexed.ok ? { kind: "local", path: indexed.path, alias: true } : { kind: "invalid", identity: true, alias: true };
  }
  const aliasResult = ownedPackage && applyRules(specifier, ownedPackage.aliases);
  if (aliasResult) {
    if (aliasResult.ambiguous) {return { kind: "invalid", alias: true };}
    const indexed = resolveIndexedPath(aliasResult.target, resolutionIndex, { requireExisting: true });
    return indexed.ok ? { kind: "local", path: indexed.path, alias: true } : { kind: "invalid", identity: true, alias: true };
  }
  const selfTarget = names.get(specifier);
  if (selfTarget) {
    const indexed = resolveIndexedPath(selfTarget, resolutionIndex, { requireExisting: true });
    return indexed.ok ? { kind: "local", path: indexed.path, self: true } : { kind: "invalid", identity: true, self: true };
  }
  if ([...names.keys()].some((name) => specifier.startsWith(`${name}/`))) {return { kind: "invalid", alias: true };}
  return { kind: "external" };
};

export const readLocalPackageImports = async ({ root, productionRoots, issue, pathIndex }) => {
  const names = new Map(), findings = createDiagnosticCollector(issue), packageMetadata = new Map(), packages = [];
  const configBudget = { bytes: 0, files: 0 };
  const context = { root, issues: findings, issue, configBudget };
  for (const productionRoot of productionRoots) {
    const parent = posix.dirname(productionRoot), packageRoot = parent === "." ? "" : parent;
    const packagePath = posix.join(packageRoot, "package.json");
    const loaded = await readJson(root, packagePath, false, configBudget);
    if (!loaded.ok) {
      findings.push(loaded.overflow ? overflowIssue(issue, "configuration")
        : loaded.identity ? filesystemIdentityIssue(issue, packagePath)
          : issue("FM_PROFILE_INVALID", packagePath, 1, "package metadata cannot be read or parsed deterministically"));
      continue;
    }
    const packageJson = loaded.value, name = packageJson?.name;
    if (!packageJson || typeof packageJson !== "object" || Array.isArray(packageJson)) {
      findings.push(issue("FM_PROFILE_INVALID", packagePath, 1, "package metadata cannot be read or parsed deterministically")); continue;
    }
    const imports = packageImportRules({ packageJson, packageRoot, productionRoot, issues: findings, issue, packagePath });
    const aliases = await inspectTsconfig(context, posix.join(packageRoot, "tsconfig.json"), true);
    const ownedPackage = { packageRoot, productionRoot, imports, aliases, packageJson };
    packages.push(ownedPackage);
    const architecture = packageJson.agentTeamsArchitecture, ownerDocument = architecture?.ownerDocument;
    packageMetadata.set(productionRoot, { name, ownerDocument });
    if (!canonicalPackageName(name)
      || architecture?.role !== "bounded-context"
      || !canonicalOwnerDocument(ownerDocument)) {
      findings.push(issue("FM_PROFILE_INVALID", packagePath, 1, "owned packages require a canonical name, bounded-context role, and ADR owner document"));
    } else if (names.has(name)) {
      findings.push(stableConfigIssue(issue, packagePath, "package names must be unique canonical values"));
    } else {
      const rootTarget = exportedTarget(packageJson, ".", packageRoot, productionRoot) ?? `${productionRoot}/index.ts`;
      const compositionTarget = exportedTarget(packageJson, "./composition", packageRoot, productionRoot) ?? `${productionRoot}/composition.ts`;
      names.set(name, rootTarget); names.set(`${name}/composition`, compositionTarget);
    }
  }
  return {
    issues: findings.result(),
    packageMetadata,
    packages,
    names: new Set(packages.map(({ packageJson }) => packageJson.name).filter(Boolean)),
    targets: names,
    resolve: configuredResolver(packages, names, pathIndex),
  };
};
