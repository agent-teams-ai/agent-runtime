import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { runCommand } from "../process-execution/run-command.ts";
import type { ScenarioSandbox } from "./scenario.ts";

const initializeTestRepository = async (
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
    timeoutMs: 10_000,
  });
  if (result.exitCode !== 0) {
    throw new Error(`Unable to initialize scenario repository: ${result.stderr}`);
  }
};

export const createScenarioSandbox = async (
  runSandboxRoot: string,
  scenarioId: string,
): Promise<ScenarioSandbox> => {
  const root = join(runSandboxRoot, scenarioId);
  const home = join(root, "home");
  const workspace = join(root, "workspace");
  const temp = join(root, "tmp");
  const xdgConfig = join(home, ".config");
  const xdgData = join(home, ".local", "share");
  const xdgState = join(home, ".local", "state");
  const xdgCache = join(home, ".cache");
  const codexHome = join(home, ".codex");
  const claudeConfig = join(home, ".claude");

  await Promise.all(
    [
      root,
      home,
      workspace,
      temp,
      xdgConfig,
      xdgData,
      xdgState,
      xdgCache,
      codexHome,
      claudeConfig,
    ].map((path) => mkdir(path, { recursive: true, mode: 0o700 })),
  );
  await initializeTestRepository(home, workspace);

  return {
    root,
    home,
    workspace,
    temp,
    xdgConfig,
    xdgData,
    xdgState,
    xdgCache,
    codexHome,
    claudeConfig,
  };
};
