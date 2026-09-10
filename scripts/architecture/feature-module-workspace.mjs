import { readFile } from "node:fs/promises";

import { parseDeterministicJson } from "./feature-module-config.mjs";
import { CHECKER_LIMITS, overflowIssue } from "./feature-module-limits.mjs";
import { filesystemIdentityIssue, inspectRepositoryPath, inventoryChildDirectories } from "./feature-module-paths.mjs";

const compareText = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const sameKeys = (actual, expected) => actual.length === expected.length
  && actual.toSorted(compareText).every((value, index) => value === expected.toSorted(compareText)[index]);

// Every package that physically exists in a declared workspace container must be
// classified by the profile. A new production module therefore fails the gate
// until a reviewed change gives it a role and an adoption state.
export const workspaceClassificationIssues = async ({ profile, root, issue, budget = { entries: 0 } }) => {
  const declaredRoots = new Set(profile.scope.productionModules.map(({ moduleRoot }) => moduleRoot));
  const issues = [];
  for (const container of profile.scope.workspaceContainers) {
    const inventory = await inventoryChildDirectories({ root, startPath: container, issue, budget, maxEntries: CHECKER_LIMITS.traversalEntries });
    issues.push(...inventory.issues);
    if (inventory.overflow) {issues.push(overflowIssue(issue, "workspace entry")); break;}
    for (const directory of inventory.directories) {
      if (declaredRoots.has(directory)) {continue;}
      const manifestPath = `${directory}/package.json`;
      const manifest = await inspectRepositoryPath(root, manifestPath, { optional: true });
      if (manifest.missing) {continue;}
      issues.push(manifest.ok
        ? issue("FM_UNCLASSIFIED_MODULE", manifestPath, 1, "production package is not classified by a declared production module")
        : filesystemIdentityIssue(issue, manifestPath));
    }
  }
  return issues;
};

const readManifest = async (root, manifestPath) => {
  const inspected = await inspectRepositoryPath(root, manifestPath);
  if (!inspected.ok) {return { identity: true };}
  if (inspected.metadata.size > CHECKER_LIMITS.sourceFileBytes) {return { overflow: true };}
  try {return { manifest: parseDeterministicJson(await readFile(inspected.absolutePath, "utf8")) };}
  catch {return {};}
};

// A pending module is excluded from the checked tree, so the full package policy
// never reads it. Its declaration is still compared with its real manifest, which
// keeps the classification a statement about the current repository rather than a
// future-state promise. Active modules keep the richer package policy instead.
export const pendingModuleManifestIssues = async ({ profile, root, issue }) => {
  const issues = [];
  for (const declared of profile.scope.productionModules.filter(({ adoption }) => adoption === "pending")) {
    const manifestPath = declared.moduleRoot === "." ? "package.json" : `${declared.moduleRoot}/package.json`;
    const loaded = await readManifest(root, manifestPath);
    if (loaded.overflow) {issues.push(overflowIssue(issue, "configuration")); continue;}
    if (loaded.identity) {issues.push(filesystemIdentityIssue(issue, manifestPath)); continue;}
    const manifest = loaded.manifest;
    const architecture = manifest?.agentTeamsArchitecture;
    const exportKeys = manifest?.exports && typeof manifest.exports === "object" && !Array.isArray(manifest.exports)
      ? Object.keys(manifest.exports)
      : undefined;
    if (manifest?.name !== declared.packageName
      || architecture?.role !== declared.role
      || architecture?.ownerDocument !== declared.ownerDocument
      || !exportKeys
      || !sameKeys(exportKeys, declared.curatedExports)) {
      issues.push(issue("FM_PROFILE_INVALID", manifestPath, 1, `pending module ${declared.id} must carry its declared package name, role, owner document, and curated export keys`));
    }
  }
  return issues;
};
