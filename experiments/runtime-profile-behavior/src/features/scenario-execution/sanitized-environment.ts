import type { ScenarioSandbox } from "./scenario.ts";

const SAFE_HOST_KEYS = [
  "LANG",
  "LC_ALL",
  "PATH",
  "SHELL",
  "TERM",
  "TZ",
] as const;

const SENSITIVE_KEY_PATTERN =
  /(API[_-]?KEY|AUTH|CREDENTIAL|PASSWORD|SECRET|TOKEN|COOKIE)/i;

export const createSanitizedEnvironment = (
  sandbox: ScenarioSandbox,
  overrides: Readonly<Record<string, string>> = {},
): NodeJS.ProcessEnv => {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of SAFE_HOST_KEYS) {
    const value = process.env[key];
    if (value !== undefined) {
      environment[key] = value;
    }
  }

  Object.assign(environment, {
    HOME: sandbox.home,
    USER: "runtime-spike",
    LOGNAME: "runtime-spike",
    TMPDIR: sandbox.temp,
    XDG_CONFIG_HOME: sandbox.xdgConfig,
    XDG_DATA_HOME: sandbox.xdgData,
    XDG_STATE_HOME: sandbox.xdgState,
    XDG_CACHE_HOME: sandbox.xdgCache,
    CODEX_HOME: sandbox.codexHome,
    CLAUDE_CONFIG_DIR: sandbox.claudeConfig,
    GIT_CEILING_DIRECTORIES: sandbox.root,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
  });

  for (const [key, value] of Object.entries(overrides)) {
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      throw new Error(
        `Scenario environment override '${key}' requires an explicit credential fixture`,
      );
    }
    environment[key] = value;
  }

  return environment;
};

export const inheritedSensitiveKeys = (
  environment: NodeJS.ProcessEnv,
): readonly string[] =>
  Object.keys(environment)
    .filter((key) => SENSITIVE_KEY_PATTERN.test(key))
    .sort();
