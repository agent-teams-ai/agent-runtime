import { readFile, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createEvidenceRun, writeJsonEvidence } from "../evidence/write-evidence.ts";
import { runCommand } from "../process-execution/run-command.ts";
import { createComparisonFixture } from "./create-comparison-fixture.ts";
import { evaluateTargetInvariants } from "./evaluate-target-invariants.ts";
import {
  inspectOpenCode,
  legacyInspectionEnvironment,
} from "./inspect-opencode.ts";
import { runDesktopOverlay } from "./run-desktop-overlay.ts";
import { runLegacyManager } from "./run-legacy-manager.ts";

const LEGACY_ROOT_DEFAULT =
  "/var/data/777genius--agent_teams_orchestrator/worktrees/opencode-profile-comparison";
const DESKTOP_ROOT_DEFAULT = "/var/data/workspaces/claude-team-refactor";

const gitRevision = async (root: string): Promise<string> => {
  const result = await runCommand("git", {
    args: ["rev-parse", "HEAD"],
    cwd: root,
    timeoutMs: 10_000,
  });
  if (result.exitCode !== 0) {
    throw new Error(`Unable to identify source revision for ${root}`);
  }
  return result.stdout.trim();
};

const initializeRepository = async (
  home: string,
  workspace: string,
): Promise<void> => {
  const result = await runCommand("git", {
    args: ["init", "--quiet", workspace],
    env: {
      HOME: home,
      PATH: process.env.PATH,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    },
  });
  if (result.exitCode !== 0) {
    throw new Error(`Unable to initialize comparison repository: ${result.stderr}`);
  }
};

const sourceByKind = (
  sources: readonly {
    readonly kind: string;
    readonly fingerprint: string | null;
    readonly fileCount: number;
  }[],
  kind: string,
  ordinal = 0,
) => sources.filter((source) => source.kind === kind)[ordinal];

export const runLegacyComparison = async (): Promise<void> => {
  const legacyRoot = process.env.LEGACY_AR_ROOT ?? LEGACY_ROOT_DEFAULT;
  const desktopRoot = process.env.DESKTOP_APP_ROOT ?? DESKTOP_ROOT_DEFAULT;
  const opencodeExecutable = join(process.cwd(), "node_modules", ".bin", "opencode");
  const run = await createEvidenceRun();
  const [legacyFixture, desktopFixture, targetFixture] = await Promise.all([
    createComparisonFixture(join(run.sandboxRoot, "legacy-strategy")),
    createComparisonFixture(join(run.sandboxRoot, "desktop-strategy")),
    createComparisonFixture(join(run.sandboxRoot, "target-invariants")),
  ]);
  await Promise.all(
    [legacyFixture, desktopFixture, targetFixture].map((fixture) =>
      initializeRepository(fixture.home, fixture.workspace),
    ),
  );

  const [legacyRevision, desktopRevision] = await Promise.all([
    gitRevision(legacyRoot),
    gitRevision(desktopRoot),
  ]);
  const targetBefore = await evaluateTargetInvariants(targetFixture);
  const [legacyBefore, desktopBefore, desktopJsoncCollision] =
    await Promise.all([
      runLegacyManager(legacyRoot, legacyFixture),
      runDesktopOverlay(desktopRoot, desktopFixture),
      runDesktopOverlay(desktopRoot, desktopFixture, "jsonc-mcp-marker"),
    ]);
  const [legacyInspection, desktopInspection] = await Promise.all([
    inspectOpenCode(
      opencodeExecutable,
      legacyFixture,
      legacyInspectionEnvironment(legacyBefore),
    ),
    inspectOpenCode(opencodeExecutable, desktopFixture, desktopBefore.env),
  ]);

  const desktopGlobalConfigPath = join(
    desktopFixture.xdgConfig,
    "opencode",
    "opencode.json",
  );
  const desktopGlobalConfigAfterProvider = await readFile(
    desktopGlobalConfigPath,
    "utf8",
  );
  const desktopAfterProvider = await runDesktopOverlay(
    desktopRoot,
    desktopFixture,
  );
  const globalConfigStat = await stat(desktopGlobalConfigPath);
  await utimes(
    desktopGlobalConfigPath,
    globalConfigStat.atime,
    new Date(globalConfigStat.mtimeMs + 5_000),
  );
  const desktopAfterTouch = await runDesktopOverlay(desktopRoot, desktopFixture);

  const targetGlobalConfigPath = join(
    targetFixture.xdgConfig,
    "opencode",
    "opencode.json",
  );
  const targetGlobalConfigStat = await stat(targetGlobalConfigPath);
  await utimes(
    targetGlobalConfigPath,
    targetGlobalConfigStat.atime,
    new Date(targetGlobalConfigStat.mtimeMs + 5_000),
  );
  const targetAfterTouch = await evaluateTargetInvariants(targetFixture);

  const legacyGlobalConfigPath = join(
    legacyFixture.xdgConfig,
    "opencode",
    "opencode.json",
  );
  const originalGlobalConfig = await readFile(legacyGlobalConfigPath, "utf8");
  const changedGlobalConfig = JSON.parse(originalGlobalConfig) as Record<
    string,
    unknown
  >;
  changedGlobalConfig.small_model = "opencode/changed-profile-marker";
  await writeFile(
    legacyGlobalConfigPath,
    `${JSON.stringify(changedGlobalConfig, null, 2)}\n`,
    { mode: 0o600 },
  );
  const legacyAfterContentChange = await runLegacyManager(
    legacyRoot,
    legacyFixture,
  );

  const desktopGlobalAfterProviderSource = sourceByKind(
    desktopAfterProvider.preservedSources,
    "global_config",
  );
  const desktopGlobalAfterTouch = sourceByKind(
    desktopAfterTouch.preservedSources,
    "global_config",
  );
  const desktopProjectTree = sourceByKind(
    desktopBefore.preservedSources,
    "project_opencode_dir",
  );
  const assertions = [
    {
      id: "legacy.mutable-root-reused-after-profile-content-change",
      passed:
        legacyBefore.profileRootKey === legacyAfterContentChange.profileRootKey &&
        legacyBefore.managedConfigFingerprint !==
          legacyAfterContentChange.managedConfigFingerprint,
    },
    {
      id: "legacy.safe-import-drops-global-command-and-mcp",
      passed:
        !legacyInspection.config.commands.includes("global-command-marker") &&
        !legacyInspection.config.mcpServers.includes("global-mcp-marker"),
    },
    {
      id: "legacy.project-config-remains-ambient",
      passed:
        legacyInspection.config.commands.includes("project-command-marker") &&
        legacyInspection.config.mcpServers.includes("project-mcp-marker"),
    },
    {
      id: "desktop.preserves-global-and-project-behavior",
      passed:
        desktopInspection.config.commands.includes("global-command-marker") &&
        desktopInspection.config.commands.includes("project-command-marker") &&
        desktopInspection.config.mcpServers.includes("global-mcp-marker") &&
        desktopInspection.config.mcpServers.includes("project-mcp-marker"),
    },
    {
      id: "desktop.renames-app-mcp-for-observed-json-config-collisions",
      passed: desktopBefore.appMcpServerName === "agent-teams-runtime-2",
    },
    {
      id: "desktop.regex-jsonc-parser-misses-valid-collision",
      passed:
        !desktopJsoncCollision.declaredMcpNames.includes("jsonc-mcp-marker") &&
        desktopJsoncCollision.appMcpServerName === "jsonc-mcp-marker",
    },
    {
      id: "opencode.native-mode-mutates-ambient-config",
      passed:
        JSON.parse(desktopGlobalConfigAfterProvider).$schema ===
        "https://opencode.ai/config.json",
    },
    {
      id: "desktop.fingerprint-changes-on-mtime-only-change",
      passed:
        desktopGlobalAfterProviderSource?.fingerprint !==
        desktopGlobalAfterTouch?.fingerprint,
    },
    {
      id: "desktop.directory-limit-is-silent",
      passed:
        desktopProjectTree?.fileCount === 200 &&
        !desktopBefore.diagnostics.some((value) =>
          value.toLowerCase().includes("truncat"),
        ),
    },
    {
      id: "target.content-revision-ignores-mtime",
      passed: targetBefore.sourceRevision === targetAfterTouch.sourceRevision,
    },
    {
      id: "target.rejects-ambiguous-skill-id",
      passed:
        !targetBefore.accepted &&
        targetBefore.duplicateSkillIds.includes("duplicate-skill"),
    },
  ];
  const evidence = {
    schemaVersion: 1,
    scenarioId: "opencode-legacy-overlay-target-comparison",
    capturedAt: new Date().toISOString(),
    sourceRevisions: {
      legacy: legacyRevision,
      desktop: desktopRevision,
    },
    legacy: {
      profileRootKey: legacyBefore.profileRootKey,
      profileRootPath: legacyBefore.profileRootPath.replace(
        legacyFixture.root,
        "<fixture>",
      ),
      projectBehaviorFingerprint: legacyBefore.projectBehaviorFingerprint,
      managedConfigFingerprint: legacyBefore.managedConfigFingerprint,
      managedConfigKeys: Object.keys(legacyBefore.managedConfig).sort(),
      behaviorSources: legacyBefore.behaviorSources,
      inspection: legacyInspection,
      afterContentChange: {
        profileRootKey: legacyAfterContentChange.profileRootKey,
        managedConfigFingerprint:
          legacyAfterContentChange.managedConfigFingerprint,
      },
    },
    desktop: {
      appMcpServerName: desktopBefore.appMcpServerName,
      declaredMcpNames: desktopBefore.declaredMcpNames,
      preservedSources: desktopBefore.preservedSources,
      diagnostics: desktopBefore.diagnostics,
      inspection: desktopInspection,
      sourceMutation: {
        globalSchemaAfterProvider:
          JSON.parse(desktopGlobalConfigAfterProvider).$schema ?? null,
      },
      jsoncCollisionProbe: {
        appMcpServerName: desktopJsoncCollision.appMcpServerName,
        declaredMcpNames: desktopJsoncCollision.declaredMcpNames,
      },
      afterMtimeOnlyChange: desktopAfterTouch.preservedSources,
    },
    targetInvariantEvaluation: {
      beforeMtimeChange: targetBefore,
      afterMtimeChange: targetAfterTouch,
    },
    assertions,
  };
  const evidencePath = join(
    run.evidenceRoot,
    "opencode-legacy-overlay-target-comparison.json",
  );
  await writeJsonEvidence(evidencePath, evidence);
  await writeJsonEvidence(join(run.root, "manifest.json"), {
    schemaVersion: 1,
    runId: run.id,
    scenario: "legacy-comparison",
    createdAt: new Date().toISOString(),
    evidence: ["evidence/opencode-legacy-overlay-target-comparison.json"],
    rawArtifacts: [],
  });
  process.stdout.write(
    `${JSON.stringify(
      {
        runId: run.id,
        evidencePath,
        assertions: assertions.map(({ id, passed }) => ({ id, passed })),
      },
      null,
      2,
    )}\n`,
  );
};
