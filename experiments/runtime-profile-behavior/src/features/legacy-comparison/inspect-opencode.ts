
import { runCommand } from "../process-execution/run-command.ts";
import type {
  ComparisonFixture,
  OpenCodeInspection,
  ResolvedConfigSummary,
  SkillSummary,
} from "./types.ts";

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const sortedKeys = (value: unknown): readonly string[] =>
  Object.keys(record(value)).toSorted();

const summarizeConfig = (stdout: string): ResolvedConfigSummary => {
  const value = record(JSON.parse(stdout));
  return {
    model: typeof value.model === "string" ? value.model : null,
    smallModel: typeof value.small_model === "string" ? value.small_model : null,
    username: typeof value.username === "string" ? value.username : null,
    commands: sortedKeys(value.command),
    mcpServers: sortedKeys(value.mcp),
    providers: sortedKeys(value.provider),
  };
};

const marker = (content: unknown): string | null =>
  typeof content === "string"
    ? /Marker:\s*([^\n]+)/.exec(content)?.[1]?.trim() ??
      /(?:global|project)-skill-marker/.exec(content)?.[0] ??
      null
    : null;

const summarizeSkills = (stdout: string): readonly SkillSummary[] => {
  const value = JSON.parse(stdout) as unknown;
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => record(item))
    .filter((item) => item.location !== "<built-in>")
    .map((item) => ({
      id:
        typeof item.name === "string"
          ? item.name
          : typeof item.id === "string"
            ? item.id
            : "unknown",
      marker: marker(item.content),
      location: typeof item.location === "string" ? item.location : null,
    }))
    .toSorted((left, right) => left.id.localeCompare(right.id));
};

const safeHostEnvironment = (): NodeJS.ProcessEnv => {
  const result: NodeJS.ProcessEnv = {};
  for (const key of ["LANG", "LC_ALL", "PATH", "SHELL", "TERM", "TZ"]) {
    if (process.env[key] !== undefined) {
      result[key] = process.env[key];
    }
  }
  return result;
};

export const inspectOpenCode = async (
  executable: string,
  fixture: ComparisonFixture,
  overrides: NodeJS.ProcessEnv,
): Promise<OpenCodeInspection> => {
  const env: NodeJS.ProcessEnv = {
    ...safeHostEnvironment(),
    HOME: fixture.home,
    USER: "runtime-spike",
    LOGNAME: "runtime-spike",
    TMPDIR: fixture.temp,
    XDG_CONFIG_HOME: fixture.xdgConfig,
    XDG_DATA_HOME: fixture.xdgData,
    XDG_STATE_HOME: fixture.xdgState,
    XDG_CACHE_HOME: fixture.xdgCache,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    ...overrides,
  };
  const config = await runCommand(executable, {
    args: ["debug", "config"],
    cwd: fixture.workspace,
    env,
    timeoutMs: 30_000,
  });
  const skills = await runCommand(executable, {
    args: ["debug", "skill"],
    cwd: fixture.workspace,
    env,
    timeoutMs: 30_000,
  });
  if (config.exitCode !== 0 || skills.exitCode !== 0) {
    throw new Error(
      `OpenCode inspection failed: config=${config.stderr}; skills=${skills.stderr}`,
    );
  }
  return {
    config: summarizeConfig(config.stdout),
    skills: summarizeSkills(skills.stdout).map((skill) => ({
      ...skill,
      location: skill.location?.replace(fixture.root, "<fixture>") ?? null,
    })),
    configExitCode: config.exitCode,
    skillExitCode: skills.exitCode,
  };
};

export const legacyInspectionEnvironment = (
  profile: import("./types.ts").LegacyPreparedProfileSummary,
): NodeJS.ProcessEnv => ({
  HOME: profile.paths.home,
  USERPROFILE: profile.paths.home,
  TMPDIR: profile.paths.temp,
  TMP: profile.paths.temp,
  TEMP: profile.paths.temp,
  XDG_CONFIG_HOME: profile.paths.xdgConfig,
  XDG_DATA_HOME: profile.paths.xdgData,
  XDG_CACHE_HOME: profile.paths.xdgCache,
  OPENCODE_DISABLE_CLAUDE_CODE: "1",
  OPENCODE_DISABLE_AUTOUPDATE: "1",
  OPENCODE_CONFIG_CONTENT: JSON.stringify(profile.managedConfig),
});
