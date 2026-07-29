import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { runCommand } from "../process-execution/run-command.ts";
import type { ComparisonFixture, LegacyPreparedProfileSummary } from "./types.ts";

const helperSource = `
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [legacyRoot, fixtureRoot] = process.argv.slice(2);
if (!legacyRoot || !fixtureRoot) throw new Error("legacyRoot and fixtureRoot are required");
const home = join(fixtureRoot, "home");
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.XDG_CONFIG_HOME = join(home, ".config");
process.env.XDG_DATA_HOME = join(home, ".local", "share");
process.env.XDG_STATE_HOME = join(home, ".local", "state");
process.env.XDG_CACHE_HOME = join(home, ".cache");
process.env.CLAUDE_MULTIMODEL_DATA_HOME = join(fixtureRoot, "legacy-data");
process.env.CLAUDE_MULTIMODEL_CACHE_HOME = join(fixtureRoot, "legacy-cache");
delete process.env.OPENCODE_CONFIG;
delete process.env.OPENCODE_CONFIG_CONTENT;

const modulePath = join(legacyRoot, "src/services/opencode/OpenCodeProfileManager.ts");
const { OpenCodeProfileManager } = await import(pathToFileURL(modulePath).href);
const profile = await new OpenCodeProfileManager().prepareProfile(
  join(fixtureRoot, "workspace"),
  { includeAppMcp: false, includeManagedSubscriptionPlugins: false },
);
process.stdout.write(JSON.stringify({
  profileRootKey: profile.profileRootKey,
  profileRootPath: profile.profileRootPath,
  projectBehaviorFingerprint: profile.projectBehaviorFingerprint,
  behaviorSources: profile.behaviorSources,
  managedConfigFingerprint: profile.managedConfigFingerprint,
  managedConfig: profile.managedConfig,
  paths: {
    home: profile.homePath,
    temp: profile.tmpPath,
    xdgConfig: profile.xdgConfigHome,
    xdgData: profile.xdgDataHome,
    xdgCache: profile.xdgCacheHome,
  },
}));
`;

export const runLegacyManager = async (
  legacyRoot: string,
  fixture: ComparisonFixture,
): Promise<LegacyPreparedProfileSummary> => {
  const helperPath = join(fixture.root, "legacy-manager-helper.ts");
  await writeFile(helperPath, helperSource, { mode: 0o600 });
  const result = await runCommand("npx", {
    args: ["--yes", "bun@1.3.11", helperPath, legacyRoot, fixture.root],
    cwd: legacyRoot,
    env: { HOME: fixture.home, PATH: process.env.PATH },
    timeoutMs: 60_000,
  });
  if (result.exitCode !== 0) {
    throw new Error(`Legacy profile probe failed: ${result.stderr}`);
  }
  return JSON.parse(result.stdout) as LegacyPreparedProfileSummary;
};
