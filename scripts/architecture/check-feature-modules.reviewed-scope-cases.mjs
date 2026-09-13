import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { ACCEPTED_DECISIONS, validateProfile } from "./feature-module-profile.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const repositoryProfilePath = "architecture/feature-module-standard/candidate-profile.json";
const repositoryProfile = async () => JSON.parse(
  await readFile(join(repositoryRoot, repositoryProfilePath), "utf8"),
);
const reviewedScopeIssues = (profile) =>
  validateProfile(profile, repositoryProfilePath, true, ACCEPTED_DECISIONS)
    .filter(({ code }) => code === "FM_PROFILE_INVALID");

test("the reviewed registry accepts the current repository profile", async () => {
  assert.deepEqual(reviewedScopeIssues(await repositoryProfile()), []);
});

// The reviewed registry is the only thing stopping a profile edit from widening
// the governed tree by itself, so every way of widening it must be rejected.
// Without these cases, deleting the enforcement call leaves the suite green.
const scopeMutations = {
  "adds an undeclared production module": (profile) => {
    profile.scope.productionModules.push({
      id: "smuggled-module", role: "bounded-context", moduleRoot: "packages/contexts/smuggled",
      sourceRoot: "packages/contexts/smuggled/src", packageName: "@agent-teams/smuggled",
      ownerDocument: "ADR-0005", curatedExports: ["."], adoption: "pending",
    });
  },
  "drops a declared production module": (profile) => {
    profile.scope.productionModules = profile.scope.productionModules
      .filter(({ id }) => id !== "runtime-security");
  },
  "renames a declared module root": (profile) => {
    const module = profile.scope.productionModules.find(({ id }) => id === "runtime-security");
    module.moduleRoot = "packages/contexts/runtime-security-renamed";
    module.sourceRoot = "packages/contexts/runtime-security-renamed/src";
  },
  "activates a pending module without the reviewed registry": (profile) => {
    const module = profile.scope.productionModules.find(({ id }) => id === "embedded-runtime");
    module.adoption = "active";
    module.activationAuthority = "ADR-0013";
  },
  "adds a workspace container": (profile) => {
    profile.scope.workspaceContainers.push("packages/tools");
  },
  "drops a workspace container": (profile) => {
    profile.scope.workspaceContainers = profile.scope.workspaceContainers
      .filter((container) => container !== "packages/platform");
  },
  "widens the production roots": (profile) => {
    profile.scope.productionRoots.push("packages/apps/embedded-runtime/src");
  },
  "moves a declared feature to another root": (profile) => {
    const feature = profile.features.find(({ id }) => id === "contained-turn-access");
    feature.root = "packages/contexts/agent-execution/src/features/contained-turn-access";
    feature.entrypoints = {
      public: `${feature.root}/index.ts`,
      internal: `${feature.root}/internal.ts`,
    };
  },
  "adds a role to a declared feature": (profile) => {
    profile.features.find(({ id }) => id === "stable-filesystem-custody").roles.push("domain");
  },
  "drops an excluded root": (profile) => {
    profile.adoption.excludedRoots = profile.adoption.excludedRoots
      .filter((root) => root !== "packages/apps/embedded-runtime");
  },
  "removes an out-of-scope entry": (profile) => {
    profile.scope.outOfScope = profile.scope.outOfScope.filter((entry) => entry !== "Module Kit");
  },
};

export const reviewedScopeCases = () => {
  for (const [name, mutate] of Object.entries(scopeMutations)) {
    test(`the reviewed registry rejects a profile that ${name}`, async () => {
      const profile = await repositoryProfile();
      mutate(profile);
      assert.ok(
        reviewedScopeIssues(profile).length > 0,
        "a profile that disagrees with the reviewed registry must be rejected",
      );
    });
  }
};

