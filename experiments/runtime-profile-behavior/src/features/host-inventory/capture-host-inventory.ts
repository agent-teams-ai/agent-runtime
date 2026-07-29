import { constants } from "node:fs";
import { access, lstat, readdir } from "node:fs/promises";
import { homedir, hostname, platform, arch } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";

import type {
  ExecutableInventory,
  HostInventory,
  ProviderExecutable,
  StateRootInventory,
} from "../../model.ts";
import { runCommand } from "../process-execution/run-command.ts";
import { sensitiveEnvironmentPresence } from "../redaction/redact.ts";

const SENSITIVE_ENVIRONMENT_KEYS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "AWS_ACCESS_KEY_ID",
  "AWS_PROFILE",
  "AZURE_API_KEY",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENCODE_CONFIG",
  "OPENCODE_CONFIG_CONTENT",
] as const;

const STATE_ROOTS = [
  ["claude", ".claude"],
  ["codex", ".codex"],
  ["opencode", ".config/opencode"],
  ["opencode", ".local/share/opencode"],
  ["opencode", ".local/state/opencode"],
  ["opencode", ".cache/opencode"],
] as const;

const canExecute = async (path: string): Promise<boolean> => {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

const resolveExecutable = async (
  candidates: readonly string[],
): Promise<string | undefined> => {
  const searchRoots = (process.env.PATH ?? "").split(delimiter);
  for (const candidate of candidates) {
    if (isAbsolute(candidate) && (await canExecute(candidate))) {
      return candidate;
    }
    if (isAbsolute(candidate)) {
      continue;
    }
    for (const root of searchRoots) {
      const path = join(root, candidate);
      if (await canExecute(path)) {
        return path;
      }
    }
  }
  return undefined;
};

const executableInventory = async (
  provider: ProviderExecutable,
): Promise<ExecutableInventory> => {
  const executable = await resolveExecutable(provider.candidates);
  if (executable === undefined) {
    return { provider: provider.id, available: false };
  }

  const result = await runCommand(executable, {
    args: provider.versionArgs,
    timeoutMs: 10_000,
  });
  const version = `${result.stdout}\n${result.stderr}`.trim();
  return {
    provider: provider.id,
    available: true,
    executable,
    version,
    versionProbe: {
      command: result.command,
      args: result.args,
      exitCode: result.exitCode,
      signal: result.signal,
      timedOut: result.timedOut,
      durationMs: result.durationMs,
    },
  };
};

const countTree = async (
  root: string,
): Promise<{ files: number; directories: number }> => {
  let files = 0;
  let directories = 0;
  const pending = [root];

  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) {
      continue;
    }
    const children = await readdir(current, { withFileTypes: true });
    for (const child of children) {
      if (child.isSymbolicLink()) {
        files += 1;
      } else if (child.isDirectory()) {
        directories += 1;
        pending.push(join(current, child.name));
      } else {
        files += 1;
      }
    }
  }

  return { files, directories };
};

const stateRootInventory = async (
  owner: StateRootInventory["owner"],
  relativePath: string,
): Promise<StateRootInventory> => {
  const path = join(homedir(), relativePath);
  try {
    const stat = await lstat(path);
    const kind = stat.isDirectory()
      ? "directory"
      : stat.isFile()
        ? "file"
        : stat.isSymbolicLink()
          ? "symlink"
          : "other";
    const counts = kind === "directory" ? await countTree(path) : undefined;
    return {
      owner,
      path: `$HOME/${relativePath}`,
      exists: true,
      kind,
      fileCount: counts?.files,
      directoryCount: counts?.directories,
    };
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return { owner, path: `$HOME/${relativePath}`, exists: false };
    }
    throw error;
  }
};

export const captureHostInventory = async (
  providers: readonly ProviderExecutable[],
): Promise<HostInventory> => ({
  schemaVersion: 1,
  capturedAt: new Date().toISOString(),
  platform: platform(),
  architecture: arch(),
  nodeVersion: process.version,
  hostname: hostname(),
  providerExecutables: await Promise.all(
    providers.map(executableInventory),
  ),
  stateRoots: await Promise.all(
    STATE_ROOTS.map(([owner, path]) => stateRootInventory(owner, path)),
  ),
  environmentPresence: sensitiveEnvironmentPresence(
    process.env,
    SENSITIVE_ENVIRONMENT_KEYS,
  ),
  tracing: {
    strace: (await resolveExecutable(["strace"])) !== undefined,
  },
});
