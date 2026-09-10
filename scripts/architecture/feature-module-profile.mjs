import { readFile } from "node:fs/promises";
import { dirname, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";

import { parseDeterministicJson } from "./feature-module-config.mjs";
import { portableRepositoryPath } from "./feature-module-paths.mjs";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const PROFILE_SCHEMA = parseDeterministicJson(await readFile(resolve(REPOSITORY_ROOT, "architecture/feature-module-standard/profile.schema.json"), "utf8"));
const validateProfileShape = new Ajv2020({ allErrors: true, strict: true }).compile(PROFILE_SCHEMA);
export const STRUCTURAL_CODES = new Set([
  "FM_ASSEMBLY_MISSING",
  "FM_CHECKER_OVERFLOW",
  "FM_ENTRYPOINT_MISSING",
  "FM_INLINE_BEHAVIOR",
  "FM_INVALID_AUTHORITY",
  "FM_MODULE_DEEP_IMPORT",
  "FM_MAX_LINES",
  "FM_NONLITERAL_LOADING",
  "FM_PACKAGE_EXPORT_MAP",
  "FM_PARSE_FAILURE",
  "FM_PROFILE_INVALID",
  "FM_PROFILE_STATUS",
  "FM_README_OWNERSHIP",
  "FM_TEST_PLACEMENT",
  "FM_UNCLASSIFIED_MODULE",
  "FM_UNDECLARED_MODULE_EDGE",
  "FM_UNSUPPORTED_CONFIG",
  "FM_WILDCARD_REEXPORT",
]);

// Candidate allowance is deliberately a closed list of the production
// migrations approved for this adoption lane. Ownership, authenticity,
// parsing, configuration, and structural failures are never informational.
export const CANDIDATE_MIGRATION_CODES = new Set([
  "FM_FEATURE_DEEP_IMPORT",
  "FM_INVALID_LAYER_DIRECTION",
  "FM_NODE_BUILTIN_IMPORT",
]);

const AUTHORITY = Object.freeze({
  id: "agent-teams.feature-module-standard",
  version: "v1",
  repository: "agent-teams-ai/.github",
  path: "docs/architecture/feature-module-standard/v1.md",
  gitBlob: "d0bfff2033faf544fe65268c1dcdfd524d093015",
  sha256: "851653f96643cf0466b67ab22963661976b00de44840fa3144a48a8c054f95fa",
});
const ACTIVATION_AUTHORITY = Object.freeze({
  acceptedAdr: "ADR-0013",
  decisionPath: "docs/decisions/0013-feature-module-standard-v1-candidate-adoption.md",
});
const STANDARD_ROLES = ["contracts", "domain", "application", "adapters", "composition"];
export const MODULE_ROLES = Object.freeze(["bounded-context", "host-app", "platform"]);
export const MODULE_ADOPTION_STATES = Object.freeze(["active", "pending"]);
const CURATED_EXPORT_SET = Object.freeze([".", "./composition"]);
export const REVIEWED_WORKSPACE_CONTAINERS = Object.freeze(["packages/apps", "packages/contexts", "packages/platform"]);
// Every production module that exists in the reviewed workspace is named here
// with its real role and its exact adoption state. The JSON profile must match
// this reviewed registry, so widening the governed tree is a reviewed source
// change and never a silent profile edit.
const REVIEWED_PRODUCTION_MODULES = Object.freeze([
  { id: "agent-execution", role: "bounded-context", moduleRoot: "packages/contexts/agent-execution", packageName: "@agent-teams/agent-execution", ownerDocument: "ADR-0005", curatedExports: [".", "./composition"], adoption: "active", activationAuthority: "ADR-0013" },
  { id: "embedded-runtime", role: "host-app", moduleRoot: "packages/apps/embedded-runtime", packageName: "@agent-teams/embedded-runtime", ownerDocument: "ADR-0008", curatedExports: [".", "./composition"], adoption: "pending" },
  { id: "filesystem-custody", role: "platform", moduleRoot: "packages/platform/filesystem-custody", packageName: "@agent-teams/filesystem-custody", ownerDocument: "ADR-0017", curatedExports: [".", "./composition"], adoption: "pending" },
  { id: "provider-access", role: "bounded-context", moduleRoot: "packages/contexts/provider-access", packageName: "@agent-teams/provider-access", ownerDocument: "ADR-0005", curatedExports: [".", "./composition"], adoption: "active", activationAuthority: "ADR-0013" },
  { id: "runtime-configuration", role: "bounded-context", moduleRoot: "packages/contexts/runtime-configuration", packageName: "@agent-teams/runtime-configuration", ownerDocument: "ADR-0005", curatedExports: [".", "./composition"], adoption: "pending" },
  { id: "runtime-security", role: "bounded-context", moduleRoot: "packages/contexts/runtime-security", packageName: "@agent-teams/runtime-security", ownerDocument: "ADR-0005", curatedExports: [".", "./composition"], adoption: "pending" },
]);
const REVIEWED_OUT_OF_SCOPE = Object.freeze(["Embedded Runtime", "Runtime Configuration", "Runtime Security", "Filesystem Custody", "Module Kit", "experiments", "tooling other than scripts/architecture/check-feature-modules.mjs"]);
const REVIEWED_FEATURES = Object.freeze({ "runtime-installation-discovery": { root: "packages/contexts/agent-execution/src/features/runtime-installation-discovery", roles: ["contracts", "application", "adapters", "composition"] }, "contained-agent-turn": { root: "packages/contexts/agent-execution/src/features/contained-agent-turn", roles: STANDARD_ROLES }, "contained-turn-access": { root: "packages/contexts/provider-access/src/features/contained-turn-access", roles: STANDARD_ROLES } });
const reviewedModules = (predicate) => REVIEWED_PRODUCTION_MODULES.filter(predicate);
const REVIEWED_PRODUCTION_ROOTS = Object.freeze(reviewedModules(({ adoption }) => adoption === "active").map(({ moduleRoot }) => `${moduleRoot}/src`));
const REVIEWED_MODULE_ROOTS = Object.freeze(reviewedModules(({ adoption, role }) => adoption === "active" && role !== "host-app").map(({ moduleRoot }) => moduleRoot));
const REVIEWED_APPLICATION_ROOTS = Object.freeze(reviewedModules(({ adoption, role }) => adoption === "active" && role === "host-app").map(({ moduleRoot }) => moduleRoot));
const REVIEWED_EXCLUDED_ROOTS = Object.freeze(["experiments", ...reviewedModules(({ adoption }) => adoption === "pending").map(({ moduleRoot }) => moduleRoot)]);
const LOCAL_SOURCE_EXTENSIONS = Object.freeze([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts"]);
const LOCAL_CLASSIFICATION_AUTHORITY = Object.freeze({
  acceptedAdr: "ADR-0017",
  decisionPath: "docs/decisions/0017-feature-module-production-scope-roles.md",
});
const LOCAL_MODULE_FILES = Object.freeze(["index.ts", "composition.ts"]);
const LOCAL_FEATURE_ENTRYPOINTS = Object.freeze(["index.ts", "internal.ts"]);
const LOCAL_ARCHITECTURE_DOCUMENT = "docs/architecture/feature-module-standard-v1-candidate.md";
const LOCAL_DECISIONS = Object.freeze([
  { id: ACTIVATION_AUTHORITY.acceptedAdr, path: ACTIVATION_AUTHORITY.decisionPath, owner: "architecture" },
  { id: LOCAL_CLASSIFICATION_AUTHORITY.acceptedAdr, path: LOCAL_CLASSIFICATION_AUTHORITY.decisionPath, owner: "architecture" },
]);
const GOVERNABLE_CODES = new Set(["FM_MAX_LINES", "FM_PACKAGE_EXPORT_MAP", "FM_README_OWNERSHIP", "FM_TEST_PLACEMENT"]);
const GOVERNED_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const GOVERNED_CODE_PATTERN = /^FM_[A-Z0-9_]+$/u;
const STABLE_VALUE_PATTERN = /^[!-~](?:[ -~]*[!-~])?$/u;
const GOVERNED_LIMITS = Object.freeze({ id: 120, owner: 256, rationale: 2048, reviewTrigger: 1024, diagnosticPath: 512 });

const issue = (code, path, line, message) => ({ code, path, line, message });
const compareText = (left, right) => left < right ? -1 : left > right ? 1 : 0;
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
const rootPath = (value) => value === "." || Boolean(portableRepositoryPath(value));
const canonicalModuleName = (value) => typeof value === "string"
  && value.length > 0
  && value === value.trim()
  && value === value.normalize("NFC")
  && !/[\\\s]/u.test(value);
const rooted = (root, suffix) => root === "." ? suffix : `${root}/${suffix}`;
const sourceModuleRoot = (sourceRoot) => posix.dirname(sourceRoot);
const atOrBelow = (path, root) => root === "." || path === root || path.startsWith(`${root}/`);
const stableValue = (value, maximum) => typeof value === "string"
  && value.length <= maximum
  && STABLE_VALUE_PATTERN.test(value);
const sameOrderedValues = (actual, expected) => actual.length === expected.length
  && actual.every((value, index) => value === expected[index]);
const acceptedDecisionPath = (id, path) => typeof id === "string"
  && /^ADR-[0-9]{4}$/u.test(id)
  && typeof path === "string"
  && portableRepositoryPath(path) === path
  && new RegExp(`^docs/decisions/${id.slice(4)}-[a-z0-9]+(?:-[a-z0-9]+)*\\.md$`, "u").test(path);

export function acceptedDecisionsFromRegistry(registry) {
  if (!registry || typeof registry !== "object" || Array.isArray(registry) || !Array.isArray(registry.decisions)) {return;}
  const decisions = new Map(), paths = new Set();
  for (const record of registry.decisions) {
    if (!record || typeof record !== "object" || Array.isArray(record)
      || !acceptedDecisionPath(record.id, record.path)
      || decisions.has(record.id)
      || paths.has(record.path)) {return;}
    decisions.set(record.id, record.path); paths.add(record.path);
  }
  return decisions;
}

const ACCEPTED_DECISION_REGISTRY = parseDeterministicJson(await readFile(resolve(REPOSITORY_ROOT, "architecture/decisions/accepted-decisions.json"), "utf8"));
export const ACCEPTED_DECISIONS = acceptedDecisionsFromRegistry(ACCEPTED_DECISION_REGISTRY) ?? new Map();

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

const governedRecordIsValid = (record, acceptedDecisions) => Boolean(
  stableValue(record.id, GOVERNED_LIMITS.id)
  && GOVERNED_ID_PATTERN.test(record.id)
  && acceptedDecisionPath(record.acceptedAdr, acceptedDecisions.get(record.acceptedAdr))
  && stableValue(record.owner, GOVERNED_LIMITS.owner)
  && stableValue(record.rationale, GOVERNED_LIMITS.rationale)
  && stableValue(record.reviewTrigger, GOVERNED_LIMITS.reviewTrigger)
  && !record.reviewTrigger.includes("*")
  && record.diagnostics?.length
  && record.diagnostics.every(({ code, path, line }) => GOVERNED_CODE_PATTERN.test(code)
    && stableValue(path, GOVERNED_LIMITS.diagnosticPath)
    && !path.includes("*")
    && Number.isInteger(line)
    && line > 0),
);

const governedRecordIssues = (profile, profilePath, acceptedDecisions) => ["extensions", "deviations", "exceptions"].flatMap((collection) =>
  (profile[collection] ?? [])
    .filter((record) => !governedRecordIsValid(record, acceptedDecisions))
    .map(() => issue("FM_PROFILE_INVALID", profilePath, 1, `${collection} records require a stable id, exact diagnostics, an accepted ADR, owner, rationale, and a deterministic non-wildcard review trigger`)),
);

const governedRecordIdentityIssues = (profile, profilePath) => {
  const records = ["extensions", "deviations", "exceptions"].flatMap((collection) => profile[collection] ?? []);
  const issues = [];
  if (duplicateValues(records.map(({ id }) => id)).length) {
    issues.push(issue("FM_PROFILE_INVALID", profilePath, 1, "extension, deviation, and exception ids must be globally unique"));
  }
  const diagnostics = records.flatMap((record) => record.diagnostics)
    .map(({ code, path, line }) => `${code}:${path}:${line}`);
  if (duplicateValues(diagnostics).length) {
    issues.push(issue("FM_PROFILE_INVALID", profilePath, 1, "governed diagnostics must be referenced exactly once across all records"));
  }
  return issues;
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

// A feature edge describes a relationship inside one module. A relationship
// between modules is a module edge, so a cross-module feature edge would be
// unreachable configuration rather than a permission.
const featureEdgeDeclarationIssues = (edges, features, profilePath) => {
  const issues = [], edgeKeys = edges.map(({ from, to }) => `${from}->${to}`);
  const rootOf = new Map(features.map((feature) => [feature.id, posix.dirname(posix.dirname(feature.root))]));
  if (duplicateValues(edgeKeys).length) {issues.push(issue("FM_PROFILE_INVALID", profilePath, 1, "feature edge pairs must be unique"));}
  for (const edge of edges) {
    if (!rootOf.has(edge.from) || !rootOf.has(edge.to) || edge.from === edge.to) {
      issues.push(issue("FM_PROFILE_INVALID", profilePath, 1, `feature edge ${edge.from}->${edge.to} must connect two distinct declared features`));
      continue;
    }
    if (rootOf.get(edge.from) !== rootOf.get(edge.to)) {
      issues.push(issue("FM_PROFILE_INVALID", profilePath, 1, `feature edge ${edge.from}->${edge.to} must stay inside one production module`));
    }
  }
  return issues;
};

const declaredModuleIsWellFormed = (declared, acceptedDecisions) => Boolean(
  GOVERNED_ID_PATTERN.test(declared.id)
  && MODULE_ROLES.includes(declared.role)
  && MODULE_ADOPTION_STATES.includes(declared.adoption)
  && rootPath(declared.moduleRoot)
  && declared.sourceRoot === rooted(declared.moduleRoot, "src")
  && canonicalModuleName(declared.packageName)
  && acceptedDecisionPath(declared.ownerDocument, acceptedDecisions.get(declared.ownerDocument))
  && declared.curatedExports.includes(".")
  && sameOrderedValues(declared.curatedExports, CURATED_EXPORT_SET.filter((entry) => declared.curatedExports.includes(entry)))
  && (declared.adoption === "pending"
    ? declared.activationAuthority === undefined
    : acceptedDecisionPath(declared.activationAuthority, acceptedDecisions.get(declared.activationAuthority))),
);

const productionModuleIssues = (profile, profilePath, acceptedDecisions) => {
  const modules = profile.scope.productionModules, issues = [];
  for (const field of [modules.map(({ id }) => id), modules.map(({ moduleRoot }) => moduleRoot), modules.map(({ packageName }) => packageName)]) {
    if (duplicateValues(field).length) {issues.push(issue("FM_PROFILE_INVALID", profilePath, 1, "production module ids, roots, and package names must be unique"));}
  }
  for (const declared of modules) {
    if (!declaredModuleIsWellFormed(declared, acceptedDecisions)) {
      issues.push(issue("FM_PROFILE_INVALID", profilePath, 1, `production module ${declared.id} requires a canonical identity, a known role, curated exports, an accepted owner document, and an accepted activation decision only when active`));
    }
  }
  const active = modules.filter(({ adoption }) => adoption === "active");
  const activeIds = new Set(active.map(({ id }) => id));
  const declaredIds = new Set(modules.map(({ id }) => id));
  for (const edge of profile.moduleEdges) {
    if (!declaredIds.has(edge.from) || !declaredIds.has(edge.to)) {continue;}
    if (!activeIds.has(edge.from) || !activeIds.has(edge.to)) {
      issues.push(issue("FM_PROFILE_INVALID", profilePath, 1, `module edge ${edge.from}->${edge.to} requires both modules to be active`));
    }
  }
  if (!sameValues(profile.scope.productionRoots, active.map(({ sourceRoot }) => sourceRoot))) {
    issues.push(issue("FM_PROFILE_INVALID", profilePath, 1, "production roots must be exactly the source roots of the active production modules"));
  }
  if (!profile.adoption) {return issues;}
  const pendingRoots = modules.filter(({ adoption }) => adoption === "pending").map(({ moduleRoot }) => moduleRoot);
  if (pendingRoots.some((root) => !profile.adoption.excludedRoots.includes(root))) {
    issues.push(issue("FM_PROFILE_INVALID", profilePath, 1, "every pending production module must remain an excluded root until its own reviewed activation"));
  }
  const expectedModuleRoots = active.filter(({ role }) => role !== "host-app").map(({ moduleRoot }) => moduleRoot);
  const expectedApplicationRoots = active.filter(({ role }) => role === "host-app").map(({ moduleRoot }) => moduleRoot);
  if (!sameValues(profile.adoption.moduleRoots, expectedModuleRoots) || !sameValues(profile.adoption.applicationRoots, expectedApplicationRoots)) {
    issues.push(issue("FM_PROFILE_INVALID", profilePath, 1, "active module and application roots must follow the declared production module roles"));
  }
  return issues;
};

const moduleEdgeDeclarationIssues = (edges, moduleIds, profilePath) => {
  const issues = [], keys = edges.map(({ from, to }) => `${from}->${to}`);
  if (duplicateValues(keys).length) {issues.push(issue("FM_PROFILE_INVALID", profilePath, 1, "module edge pairs must be unique"));}
  for (const edge of edges) {
    if (!moduleIds.has(edge.from) || !moduleIds.has(edge.to) || edge.from === edge.to) {
      issues.push(issue("FM_PROFILE_INVALID", profilePath, 1, `module edge ${edge.from}->${edge.to} must connect two distinct declared production modules`));
    }
  }
  return issues;
};

const profileTopologyIssues = (profile, profilePath) => {
  const issues = [], productionRoots = profile.scope.productionRoots, features = profile.features;
  const expectedAssembly = productionRoots.flatMap((root) => [`${root}/index.ts`, `${root}/composition.ts`]);
  if (!sameValues(profile.moduleRoles, STANDARD_ROLES)) {issues.push(issue("FM_PROFILE_INVALID", profilePath, 1, "moduleRoles must declare the five standard roles exactly"));}
  if (!sameValues(profile.assemblyFiles, expectedAssembly)) {issues.push(issue("FM_PROFILE_INVALID", profilePath, 1, "assemblyFiles must contain only index.ts and composition.ts for each production root"));}
  issues.push(...featureIdentityIssues(features, productionRoots, profilePath));
  issues.push(...featureEdgeDeclarationIssues(profile.featureEdges, features, profilePath));
  issues.push(...moduleEdgeDeclarationIssues(profile.moduleEdges, new Set(profile.scope.productionModules.map(({ id }) => id)), profilePath));
  return issues;
};

const sameModuleRecord = (actual, expected) => actual.id === expected.id
  && actual.role === expected.role
  && actual.moduleRoot === expected.moduleRoot
  && actual.sourceRoot === `${expected.moduleRoot}/src`
  && actual.packageName === expected.packageName
  && actual.ownerDocument === expected.ownerDocument
  && actual.adoption === expected.adoption
  && actual.activationAuthority === expected.activationAuthority
  && sameOrderedValues(actual.curatedExports, expected.curatedExports);

const reviewedModuleIssues = (profile, profilePath) => {
  const declared = profile.scope.productionModules, issues = [];
  if (declared.length !== REVIEWED_PRODUCTION_MODULES.length
    || !sameValues(declared.map(({ id }) => id), REVIEWED_PRODUCTION_MODULES.map(({ id }) => id))) {
    issues.push(issue("FM_PROFILE_INVALID", profilePath, 1, "production modules must name every reviewed workspace module exactly once"));
    return issues;
  }
  for (const expected of REVIEWED_PRODUCTION_MODULES) {
    const actual = declared.find((candidate) => candidate.id === expected.id);
    if (!sameModuleRecord(actual, expected)) {
      issues.push(issue("FM_PROFILE_INVALID", profilePath, 1, `production module ${expected.id} must match its reviewed role, identity, packaging, and adoption state exactly`));
    }
  }
  return issues;
};

const reviewedScopeIssues = (profile, profilePath) => {
  const issues = [...reviewedModuleIssues(profile, profilePath)];
  if (!sameOrderedValues(profile.scope.workspaceContainers, REVIEWED_WORKSPACE_CONTAINERS)) {issues.push(issue("FM_PROFILE_INVALID", profilePath, 1, "workspace containers must match the reviewed production package directories exactly"));}
  if (!sameValues(profile.scope.productionRoots, REVIEWED_PRODUCTION_ROOTS)) {issues.push(issue("FM_PROFILE_INVALID", profilePath, 1, "production roots must match the reviewed active module source roots exactly"));}
  if (!sameValues(profile.scope.outOfScope, REVIEWED_OUT_OF_SCOPE)) {issues.push(issue("FM_PROFILE_INVALID", profilePath, 1, "out-of-scope modules must match the reviewed exclusions exactly"));}
  if (!sameValues(profile.features.map(({ id }) => id), Object.keys(REVIEWED_FEATURES))) {issues.push(issue("FM_PROFILE_INVALID", profilePath, 1, "features must match the reviewed feature identities exactly"));}
  for (const feature of profile.features) {
    const expected = REVIEWED_FEATURES[feature.id];
    if (expected && feature.root !== expected.root) {issues.push(issue("FM_PROFILE_INVALID", profilePath, 1, `feature ${feature.id} root must match the reviewed package ownership exactly`));}
    if (expected && !sameValues(feature.roles, expected.roles)) {issues.push(issue("FM_PROFILE_INVALID", profilePath, 1, `feature ${feature.id} roles must match the reviewed scope exactly`));}
  }
  if (profile.adoption) {
    if (!sameValues(profile.adoption.moduleRoots, REVIEWED_MODULE_ROOTS)) {issues.push(issue("FM_PROFILE_INVALID", profilePath, 1, "active module roots must match the reviewed active bounded-context and platform packages exactly"));}
    if (!sameValues(profile.adoption.applicationRoots, REVIEWED_APPLICATION_ROOTS)) {issues.push(issue("FM_PROFILE_INVALID", profilePath, 1, "active application roots must match the reviewed active host applications exactly"));}
    if (!sameValues(profile.adoption.excludedRoots, REVIEWED_EXCLUDED_ROOTS)) {issues.push(issue("FM_PROFILE_INVALID", profilePath, 1, "active excluded roots must preserve every pending module and experiment exclusion exactly"));}
  }
  return issues;
};

const localExtensionIssues = (adoption, profilePath) => {
  const extensions = adoption.localExtensions, issues = [];
  if (!sameOrderedValues(extensions.language.sourceExtensions, LOCAL_SOURCE_EXTENSIONS)
    || extensions.packaging.manifest !== "package.json"
    || !sameOrderedValues(extensions.packaging.curatedExports, CURATED_EXPORT_SET)
    || extensions.transport.publicContractRole !== "contracts"
    || !sameOrderedValues(extensions.composition.moduleFiles, LOCAL_MODULE_FILES)
    || !sameOrderedValues(extensions.composition.featureEntrypoints, LOCAL_FEATURE_ENTRYPOINTS)
    || extensions.composition.syntax !== "imports-and-named-reexports-only") {
    issues.push(issue("FM_PROFILE_INVALID", profilePath, 1, "active adoption must declare the exact enforced language, packaging, transport, and composition extensions"));
  }
  return issues;
};

const localOwnershipIssues = (adoption, profilePath) => {
  const architecture = adoption.localOwnership.architectureDocument;
  const declared = adoption.localOwnership.decisionRecords;
  if (architecture.path === LOCAL_ARCHITECTURE_DOCUMENT
    && architecture.owner === "architecture"
    && declared.length === LOCAL_DECISIONS.length
    && LOCAL_DECISIONS.every((expected, index) => declared[index].id === expected.id
      && declared[index].path === expected.path
      && declared[index].owner === expected.owner)) {return [];}
  return [issue("FM_PROFILE_INVALID", profilePath, 1, "active adoption must name the exact local architecture document and both accepted ownership decisions")];
};

const moduleLayoutIssues = (profile, profilePath) => {
  const adoption = profile.adoption, layouts = adoption.abstractLayout.modules, issues = [];
  const expectedRoots = profile.scope.productionRoots.map(sourceModuleRoot);
  const layoutRoots = layouts.map(({ moduleRoot }) => moduleRoot);
  if (!sameValues(adoption.moduleRoots, expectedRoots) || !sameValues(layoutRoots, expectedRoots)) {
    issues.push(issue("FM_PROFILE_INVALID", profilePath, 1, "module roots and abstract module mappings must correspond one-to-one with production source roots"));
    return issues;
  }
  for (const sourceRoot of profile.scope.productionRoots) {
    const moduleRoot = sourceModuleRoot(sourceRoot);
    const layout = layouts.find((candidate) => candidate.moduleRoot === moduleRoot);
    const testRoot = rooted(moduleRoot, "tests");
    if (!layout
      || layout.sourceRoot !== sourceRoot
      || layout.featuresRoot !== `${sourceRoot}/features`
      || layout.moduleComposition !== `${sourceRoot}/composition.ts`
      || layout.publicEntrypoint !== `${sourceRoot}/index.ts`
      || layout.testRoot !== testRoot
      || layout.featureTestsRoot !== `${testRoot}/features`
      || layout.moduleTestsRoot !== `${testRoot}/package`) {
      issues.push(issue("FM_PROFILE_INVALID", profilePath, 1, `module ${moduleRoot} must map every central abstract layout role to its exact concrete root or file`));
    }
  }
  return issues;
};

const applicationLayoutIssues = (adoption, profilePath) => {
  const layouts = adoption.abstractLayout.applications, layoutRoots = layouts.map(({ applicationRoot }) => applicationRoot);
  const issues = [];
  if (!sameValues(layoutRoots, adoption.applicationRoots)) {
    return [issue("FM_PROFILE_INVALID", profilePath, 1, "application roots and abstract application mappings must correspond one-to-one")];
  }
  for (const layout of layouts) {
    if (!atOrBelow(layout.compositionRoot, layout.applicationRoot) || layout.compositionRoot === layout.applicationRoot) {
      issues.push(issue("FM_PROFILE_INVALID", profilePath, 1, `application ${layout.applicationRoot} composition root must be a concrete child path`));
    }
  }
  return issues;
};

const adoptionPathIssues = (profile, profilePath) => {
  const adoption = profile.adoption;
  const paths = [
    ...adoption.moduleRoots,
    ...adoption.applicationRoots,
    ...adoption.excludedRoots,
    ...adoption.abstractLayout.modules.flatMap((layout) => Object.values(layout)),
    ...adoption.abstractLayout.applications.flatMap((layout) => Object.values(layout)),
  ];
  const issues = [];
  if (paths.some((path) => !rootPath(path))) {
    issues.push(issue("FM_PROFILE_INVALID", profilePath, 1, "active adoption roots and abstract layout mappings must use canonical repository paths"));
  }
  const ownedRoots = [...adoption.moduleRoots, ...adoption.applicationRoots, ...profile.scope.productionRoots];
  if (adoption.excludedRoots.some((excluded) => ownedRoots.some((owned) => atOrBelow(owned, excluded)))) {
    issues.push(issue("FM_PROFILE_INVALID", profilePath, 1, "excluded roots cannot contain a declared module, application, or production root"));
  }
  return issues;
};

const adoptionIssues = (profile, profilePath) => profile.adoption ? [
  ...adoptionPathIssues(profile, profilePath),
  ...moduleLayoutIssues(profile, profilePath),
  ...applicationLayoutIssues(profile.adoption, profilePath),
  ...localExtensionIssues(profile.adoption, profilePath),
  ...localOwnershipIssues(profile.adoption, profilePath),
] : [];

const governedRecordKeys = (profile) => ["extensions", "deviations", "exceptions"].flatMap((collection) =>
  profile[collection].map(({ id, acceptedAdr }) => `${collection}:${id}:${acceptedAdr}`),
).toSorted(compareText);

const activeProfileIssues = (profile, profilePath, acceptedDecisions) => {
  if (profile.status !== "active") {return [];}
  const issues = [], authority = profile.activation.authority;
  const exactAuthority = authority.acceptedAdr === ACTIVATION_AUTHORITY.acceptedAdr
    && authority.decisionPath === ACTIVATION_AUTHORITY.decisionPath
    && acceptedDecisions.get(authority.acceptedAdr) === authority.decisionPath;
  if (!exactAuthority) {issues.push(issue("FM_PROFILE_INVALID", profilePath, 1, "active status requires accepted ADR-0013 at its exact governed decision path"));}
  if (authority.owner !== profile.adoption.localOwnership.architectureDocument.owner) {issues.push(issue("FM_PROFILE_INVALID", profilePath, 1, "active authority owner must match the exact local architecture owner"));}
  if (!sameValues(authority.governedRecords, governedRecordKeys(profile))) {issues.push(issue("FM_PROFILE_INVALID", profilePath, 1, "active authority must name every extension, deviation, and exception exactly"));}
  return issues;
};

const profileHasWildcardPath = (profile) => [
  ...profile.scope.productionRoots,
  ...profile.scope.workspaceContainers,
  ...profile.scope.productionModules.flatMap(({ moduleRoot, sourceRoot }) => [moduleRoot, sourceRoot]),
  ...profile.assemblyFiles,
  ...profile.features.flatMap((feature) => [feature.root, feature.entrypoints.public, feature.entrypoints.internal]),
].some((path) => path.includes("*"));

export const validateProfile = (profile, profilePath, enforceReviewedScope, acceptedDecisions) => {
  const issues = profileShapeIssues(profile, profilePath);
  if (issues.length) {return issues;}
  for (const [key, value] of Object.entries(AUTHORITY)) {
    if (profile.authority[key] !== value) {issues.push(issue("FM_INVALID_AUTHORITY", profilePath, 1, `authority.${key} must equal ${value}`));}
  }
  issues.push(...governedRecordIssues(profile, profilePath, acceptedDecisions));
  issues.push(...governedRecordIdentityIssues(profile, profilePath));
  issues.push(...activeProfileIssues(profile, profilePath, acceptedDecisions));
  issues.push(...profileTopologyIssues(profile, profilePath));
  issues.push(...productionModuleIssues(profile, profilePath, acceptedDecisions));
  issues.push(...adoptionIssues(profile, profilePath));
  if (enforceReviewedScope) {issues.push(...reviewedScopeIssues(profile, profilePath));}
  if (profileHasWildcardPath(profile)) {issues.push(issue("FM_PROFILE_INVALID", profilePath, 1, "scope, feature, assembly, and entrypoint paths must be exact and cannot contain wildcards"));}
  return issues;
};

export const applyGovernedRecords = (profile, issues, profilePath) => {
  const declared = ["extensions", "deviations", "exceptions"].flatMap((collection) =>
    profile[collection].flatMap((record) => record.diagnostics.map((diagnostic) => ({ ...diagnostic, record: `${collection}:${record.id}` }))),
  );
  const keys = declared.map(({ code, path, line }) => `${code}:${path}:${line}`);
  const result = issues.filter(({ code, path, line }) => !GOVERNABLE_CODES.has(code) || !keys.includes(`${code}:${path}:${line}`));
  for (const duplicate of duplicateValues(keys)) {result.push(issue("FM_PROFILE_INVALID", profilePath, 1, `governed diagnostic ${duplicate} is declared more than once`));}
  for (const diagnostic of declared) {
    const exact = issues.some(({ code, path, line }) => code === diagnostic.code && path === diagnostic.path && line === diagnostic.line);
    if (!GOVERNABLE_CODES.has(diagnostic.code) || !exact) {result.push(issue("FM_PROFILE_INVALID", profilePath, 1, `${diagnostic.record} does not govern an exact current diagnostic`));}
  }
  return result;
};
