import { copyFile, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";

import { runCommand } from "../process-execution/run-command.ts";

const workspace = process.argv[2];
const mode = process.argv[3];
if (workspace === undefined || !["shared", "isolated"].includes(mode ?? "")) {
  throw new Error("Expected workspace and shared|isolated mode");
}

interface CodexEvent {
  readonly type?: string;
  readonly thread_id?: string;
  readonly item?: {
    readonly type?: string;
    readonly text?: string;
  };
}

const summarize = (
  stdout: string,
): {
  readonly threadId?: string;
  readonly finalText?: string;
  readonly eventTypes: readonly (string | undefined)[];
} => {
  const events = stdout
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as CodexEvent];
      } catch {
        return [];
      }
    });
  const thread = events.find((event) => event.type === "thread.started");
  const message = events.find(
    (event) =>
      event.type === "item.completed" &&
      event.item?.type === "agent_message",
  );
  return {
    ...(thread?.thread_id === undefined ? {} : { threadId: thread.thread_id }),
    ...(message?.item?.text === undefined
      ? {}
      : { finalText: message.item.text }),
    eventTypes: [...new Set(events.map((event) => event.type))].filter(
      (type) => type !== undefined,
    ),
  };
};

const baseCodexHome = process.env.CODEX_HOME;
if (baseCodexHome === undefined) {
  throw new Error("CODEX_HOME is required");
}

const countPersistedSessionEntries = async (
  codexHome: string,
): Promise<number> => {
  try {
    return (
      await readdir(join(codexHome, "sessions"), {
        recursive: true,
      })
    ).length;
  } catch {
    return 0;
  }
};

const isolatedEnvironment = async (
  name: string,
): Promise<NodeJS.ProcessEnv> => {
  if (mode === "shared") {
    return process.env;
  }
  const home = join(baseCodexHome, "..", "concurrent", name, "home");
  const codexHome = join(home, ".codex");
  await mkdir(codexHome, { recursive: true, mode: 0o700 });
  await copyFile(join(baseCodexHome, "auth.json"), join(codexHome, "auth.json"));
  return {
    ...process.env,
    HOME: home,
    CODEX_HOME: codexHome,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    XDG_CACHE_HOME: join(home, ".cache"),
  };
};

const run = async (name: "a" | "b") => {
  const expected = `runtime-profile-concurrent-${name}-ok`;
  const environment = await isolatedEnvironment(name);
  const result = await runCommand("codex", {
    args: [
      "exec",
      "--ignore-user-config",
      "--ignore-rules",
      "--json",
      "--sandbox",
      "read-only",
      "-m",
      "gpt-5.4-mini",
      "-C",
      workspace,
      "--disable",
      "apps",
      "--disable",
      "plugins",
      "--disable",
      "plugin_sharing",
      "--disable",
      "skill_mcp_dependency_install",
      "-c",
      'approval_policy="never"',
      "-c",
      'web_search="disabled"',
      `Reply with exactly ${expected}. Do not use tools.`,
    ],
    cwd: workspace,
    env: environment,
    timeoutMs: 60_000,
  });
  const codexHome = environment.CODEX_HOME;
  if (codexHome === undefined) {
    throw new Error("Concurrent probe CODEX_HOME is required");
  }
  return {
    name,
    expected,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    ...summarize(result.stdout),
    stderrPresent: result.stderr.trim().length > 0,
    persistedSessionEntries: await countPersistedSessionEntries(codexHome),
  };
};

const [first, second] = await Promise.all([run("a"), run("b")]);
const distinctThreads =
  typeof first.threadId === "string" &&
  typeof second.threadId === "string" &&
  first.threadId !== second.threadId;

process.stdout.write(
  `${JSON.stringify(
    {
      mode,
      first,
      second,
      distinctThreads,
    },
    null,
    2,
  )}\n`,
);

if (first.exitCode !== 0 || second.exitCode !== 0) {
  process.exitCode = 1;
}
