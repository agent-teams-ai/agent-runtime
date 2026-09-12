import { readFile } from "node:fs/promises";

import { parseDeterministicJson } from "./feature-module-config.mjs";
import { CHECKER_LIMITS } from "./feature-module-limits.mjs";
import { inspectRepositoryPath } from "./feature-module-paths.mjs";

// Activation is only real while both root gates still run the fixture suite and
// the active checker in that exact order, so removing or reordering them fails.
export const activeGateIssues = async ({ profile, root, issue }) => {
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

