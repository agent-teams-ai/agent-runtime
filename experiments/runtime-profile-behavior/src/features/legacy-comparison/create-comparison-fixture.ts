import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { ComparisonFixture } from "./types.ts";

const writeJson = async (path: string, value: unknown): Promise<void> => {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
};

const writeSkill = async (
  root: string,
  id: string,
  marker: string,
): Promise<void> => {
  const directory = join(root, id);
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "SKILL.md"),
    `---\nname: ${id}\ndescription: ${marker}\n---\n\n${marker}\n`,
    { mode: 0o600 },
  );
};

export const createComparisonFixture = async (
  root: string,
): Promise<ComparisonFixture> => {
  const home = join(root, "home");
  const workspace = join(root, "workspace");
  const temp = join(root, "tmp");
  const xdgConfig = join(home, ".config");
  const xdgData = join(home, ".local", "share");
  const xdgState = join(home, ".local", "state");
  const xdgCache = join(home, ".cache");

  await Promise.all(
    [home, workspace, temp, xdgConfig, xdgData, xdgState, xdgCache].map(
      (path) => mkdir(path, { recursive: true, mode: 0o700 }),
    ),
  );

  await writeJson(join(xdgConfig, "opencode", "opencode.json"), {
    username: "global-user-marker",
    model: "opencode/big-pickle",
    small_model: "opencode/big-pickle",
    command: {
      "global-command-marker": {
        template: "global command",
        description: "global command marker",
      },
    },
    mcp: {
      "agent-teams": {
        type: "local",
        command: ["sh", "-c", "exit 0"],
        enabled: false,
      },
      "global-mcp-marker": {
        type: "local",
        command: ["sh", "-c", "exit 0"],
        enabled: false,
      },
    },
  });
  await mkdir(join(xdgConfig, "opencode"), { recursive: true });
  await writeFile(
    join(xdgConfig, "opencode", "opencode.jsonc"),
    `{
  "username": "jsonc-user-marker // slash-is-data",
  "mcp": {
    "jsonc-mcp-marker": {
      "type": "local",
      "command": ["sh", "-c", "exit 0"],
      "enabled": false
    }
  }
}\n`,
    { mode: 0o600 },
  );
  await writeJson(join(workspace, "opencode.json"), {
    username: "project-user-marker",
    command: {
      "project-command-marker": {
        template: "project command",
        description: "project command marker",
      },
    },
    mcp: {
      "agent-teams-runtime-1": {
        type: "local",
        command: ["sh", "-c", "exit 0"],
        enabled: false,
      },
      "project-mcp-marker": {
        type: "local",
        command: ["sh", "-c", "exit 0"],
        enabled: false,
      },
    },
  });
  await writeSkill(
    join(xdgConfig, "opencode", "skills"),
    "duplicate-skill",
    "global-skill-marker",
  );
  await writeSkill(
    join(workspace, ".opencode", "skills"),
    "duplicate-skill",
    "project-skill-marker",
  );
  const largeDirectory = join(workspace, ".opencode", "large-source");
  await mkdir(largeDirectory, { recursive: true });
  await Promise.all(
    Array.from({ length: 205 }, (_, index) =>
      writeFile(
        join(largeDirectory, `entry-${String(index).padStart(3, "0")}.txt`),
        `entry-${index}\n`,
        { mode: 0o600 },
      ),
    ),
  );
  await writeFile(join(workspace, ".gitignore"), ".opencode-runtime/\n", {
    mode: 0o600,
  });

  return { root, home, workspace, temp, xdgConfig, xdgData, xdgState, xdgCache };
};
