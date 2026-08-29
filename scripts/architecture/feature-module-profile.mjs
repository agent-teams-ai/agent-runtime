import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const PROFILE_SCHEMA = JSON.parse(await readFile(resolve(REPOSITORY_ROOT, "architecture/feature-module-standard/profile.schema.json"), "utf8"));
const validateProfileShape = new Ajv2020({ allErrors: true, strict: true }).compile(PROFILE_SCHEMA);
const ACCEPTED_DECISION_RECORDS = JSON.parse(await readFile(resolve(REPOSITORY_ROOT, "architecture/decisions/accepted-decisions.json"), "utf8")).decisions;
export const ACCEPTED_DECISIONS = new Map(ACCEPTED_DECISION_RECORDS.map(({ id, path }) => [id, path]));
export const STRUCTURAL_CODES = new Set([
  "FM_ASSEMBLY_MISSING",
  "FM_ENTRYPOINT_MISSING",
  "FM_INLINE_BEHAVIOR",
  "FM_INVALID_AUTHORITY",
  "FM_NONLITERAL_LOADING",
  "FM_PACKAGE_EXPORT_MAP",
  "FM_PARSE_FAILURE",
  "FM_PROFILE_INVALID",
  "FM_PROFILE_STATUS",
  "FM_README_OWNERSHIP",
  "FM_TEST_PLACEMENT",
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
const CANDIDATE_PRODUCTION_ROOTS = Object.freeze(["packages/contexts/agent-execution/src", "packages/contexts/provider-access/src"]);
const CANDIDATE_OUT_OF_SCOPE = Object.freeze(["Embedded Runtime", "Runtime Configuration", "Runtime Security", "Filesystem Custody", "Module Kit", "experiments", "tooling other than scripts/architecture/check-feature-modules.mjs"]);
const CANDIDATE_FEATURES = Object.freeze({ "runtime-installation-discovery": { root: "packages/contexts/agent-execution/src/features/runtime-installation-discovery", roles: ["contracts", "application", "adapters", "composition"] }, "contained-agent-turn": { root: "packages/contexts/agent-execution/src/features/contained-agent-turn", roles: STANDARD_ROLES }, "contained-turn-access": { root: "packages/contexts/provider-access/src/features/contained-turn-access", roles: STANDARD_ROLES } });
const GOVERNABLE_CODES = new Set(["FM_PACKAGE_EXPORT_MAP", "FM_README_OWNERSHIP", "FM_TEST_PLACEMENT"]);

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
  record.id
  && acceptedDecisions.has(record.acceptedAdr)
  && record.owner
  && record.rationale
  && record.reviewTrigger
  && !record.reviewTrigger.includes("*")
  && record.diagnostics?.length
  && record.diagnostics.every(({ code, path, line }) => /^FM_[A-Z0-9_]+$/.test(code) && path && !path.includes("*") && Number.isInteger(line) && line > 0),
);

const governedRecordIssues = (profile, profilePath, acceptedDecisions) => ["extensions", "deviations", "exceptions"].flatMap((collection) =>
  (profile[collection] ?? [])
    .filter((record) => !governedRecordIsValid(record, acceptedDecisions))
    .map(() => issue("FM_PROFILE_INVALID", profilePath, 1, `${collection} records require exact diagnostics, an accepted ADR, owner, rationale, and a deterministic non-wildcard review trigger`)),
);

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
  const issues = [], edgeKeys = edges.map(({ from, to }) => `${from}->${to}`);
  if (duplicateValues(edgeKeys).length) {issues.push(issue("FM_PROFILE_INVALID", profilePath, 1, "feature edge pairs must be unique"));}
  for (const edge of edges) {
    if (!featureIds.has(edge.from) || !featureIds.has(edge.to) || edge.from === edge.to) {issues.push(issue("FM_PROFILE_INVALID", profilePath, 1, `feature edge ${edge.from}->${edge.to} must connect two distinct declared features`));}
  }
  return issues;
};

const profileTopologyIssues = (profile, profilePath) => {
  const issues = [], productionRoots = profile.scope.productionRoots, features = profile.features;
  const featureIds = new Set(features.map(({ id }) => id));
  const expectedAssembly = productionRoots.flatMap((root) => [`${root}/index.ts`, `${root}/composition.ts`]);
  if (!sameValues(profile.moduleRoles, STANDARD_ROLES)) {issues.push(issue("FM_PROFILE_INVALID", profilePath, 1, "moduleRoles must declare the five standard roles exactly"));}
  if (!sameValues(profile.assemblyFiles, expectedAssembly)) {issues.push(issue("FM_PROFILE_INVALID", profilePath, 1, "assemblyFiles must contain only index.ts and composition.ts for each production root"));}
  issues.push(...featureIdentityIssues(features, productionRoots, profilePath));
  issues.push(...featureEdgeDeclarationIssues(profile.featureEdges, featureIds, profilePath));
  return issues;
};

const candidateScopeIssues = (profile, profilePath) => {
  const issues = [];
  if (!sameValues(profile.scope.productionRoots, CANDIDATE_PRODUCTION_ROOTS)) {issues.push(issue("FM_PROFILE_INVALID", profilePath, 1, "candidate production roots must match the reviewed Agent Execution and Provider Access scope exactly"));}
  if (!sameValues(profile.scope.outOfScope, CANDIDATE_OUT_OF_SCOPE)) {issues.push(issue("FM_PROFILE_INVALID", profilePath, 1, "candidate out-of-scope modules must match the reviewed exclusions exactly"));}
  if (!sameValues(profile.features.map(({ id }) => id), Object.keys(CANDIDATE_FEATURES))) {issues.push(issue("FM_PROFILE_INVALID", profilePath, 1, "candidate features must match the three reviewed feature identities exactly"));}
  for (const feature of profile.features) {
    const expected = CANDIDATE_FEATURES[feature.id];
    if (expected && feature.root !== expected.root) {issues.push(issue("FM_PROFILE_INVALID", profilePath, 1, `candidate feature ${feature.id} root must match the reviewed package ownership exactly`));}
    if (expected && !sameValues(feature.roles, expected.roles)) {issues.push(issue("FM_PROFILE_INVALID", profilePath, 1, `candidate feature ${feature.id} roles must match the reviewed scope exactly`));}
  }
  return issues;
};

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
  if (!sameValues(authority.governedRecords, governedRecordKeys(profile))) {issues.push(issue("FM_PROFILE_INVALID", profilePath, 1, "active authority must name every extension, deviation, and exception exactly"));}
  return issues;
};

const profileHasWildcardPath = (profile) => [
  ...profile.scope.productionRoots,
  ...profile.assemblyFiles,
  ...profile.features.flatMap((feature) => [feature.root, feature.entrypoints.public, feature.entrypoints.internal]),
].some((path) => path.includes("*"));

export const validateProfile = (profile, profilePath, enforceCandidateScope, acceptedDecisions) => {
  const issues = profileShapeIssues(profile, profilePath);
  if (issues.length) {return issues;}
  for (const [key, value] of Object.entries(AUTHORITY)) {
    if (profile.authority[key] !== value) {issues.push(issue("FM_INVALID_AUTHORITY", profilePath, 1, `authority.${key} must equal ${value}`));}
  }
  issues.push(...governedRecordIssues(profile, profilePath, acceptedDecisions));
  issues.push(...activeProfileIssues(profile, profilePath, acceptedDecisions));
  issues.push(...profileTopologyIssues(profile, profilePath));
  if (enforceCandidateScope) {issues.push(...candidateScopeIssues(profile, profilePath));}
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
