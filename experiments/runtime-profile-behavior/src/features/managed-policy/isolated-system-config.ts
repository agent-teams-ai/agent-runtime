import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const prepareIsolatedProviderRoot = async (
  root: string,
): Promise<void> => {
  await Promise.all(
    [
      "home/.claude",
      "home/.codex",
      "home/.config/opencode",
      "home/.local/share",
      "home/.local/state",
      "home/.cache",
      "tmp",
      "workspace",
      "overlay/upper",
      "overlay/work",
      "overlay/merged",
    ].map((path) => mkdir(join(root, path), { recursive: true, mode: 0o700 })),
  );
  execFileSync("git", ["-c", "init.defaultBranch=main", "init", "--quiet", join(root, "workspace")], {
    env: {
      HOME: join(root, "home"),
      PATH: process.env.PATH,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    },
  });
};

export const writeSystemConfig = async (
  root: string,
  relativePath: string,
  content: string,
): Promise<void> => {
  const path = join(root, "overlay", "upper", relativePath);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, content, { mode: 0o600 });
};

export const mountSyntheticEtc = (root: string): void => {
  const overlay = join(root, "overlay");
  execFileSync("mount", [
    "-t",
    "overlay",
    "overlay",
    "-o",
    `lowerdir=/etc,upperdir=${join(overlay, "upper")},workdir=${join(overlay, "work")}`,
    join(overlay, "merged"),
  ]);
  execFileSync("mount", ["--bind", join(overlay, "merged"), "/etc"]);
};

export const providerEnvironment = (
  root: string,
  overrides: Readonly<Record<string, string>> = {},
): NodeJS.ProcessEnv => ({
  HOME: join(root, "home"),
  USER: "runtime-spike",
  LOGNAME: "runtime-spike",
  PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
  TMPDIR: join(root, "tmp"),
  XDG_CONFIG_HOME: join(root, "home", ".config"),
  XDG_DATA_HOME: join(root, "home", ".local", "share"),
  XDG_STATE_HOME: join(root, "home", ".local", "state"),
  XDG_CACHE_HOME: join(root, "home", ".cache"),
  CODEX_HOME: join(root, "home", ".codex"),
  CLAUDE_CONFIG_DIR: join(root, "home", ".claude"),
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  ...overrides,
});
