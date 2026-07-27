import { access, readdir } from "node:fs/promises";
import { join } from "node:path";

import { runCommand } from "../process-execution/run-command.ts";

const workspace = process.argv[2];
if (workspace === undefined) {
  throw new Error("Expected workspace path");
}
const strictRuntime = process.argv[3] === "strict";

interface CodexEvent {
  readonly type?: string;
  readonly thread_id?: string;
  readonly item?: {
    readonly type?: string;
    readonly text?: string;
  };
}

const parseEvents = (stdout: string): readonly CodexEvent[] =>
  stdout
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as CodexEvent];
      } catch {
        return [];
      }
    });

const summarize = (stdout: string): Record<string, unknown> => {
  const events = parseEvents(stdout);
  const thread = events.find((event) => event.type === "thread.started");
  const message = events.find(
    (event) =>
      event.type === "item.completed" &&
      event.item?.type === "agent_message",
  );
  return {
    threadId: thread?.thread_id,
    finalText: message?.item?.text,
    eventTypes: [...new Set(events.map((event) => event.type))].filter(
      (type) => type !== undefined,
    ),
  };
};

const common = [
  "--ignore-user-config",
  "--ignore-rules",
  "--json",
  "-m",
  "gpt-5.4-mini",
  "-c",
  'approval_policy="never"',
  "-c",
  'web_search="disabled"',
];
if (strictRuntime) {
  common.push(
    "--disable",
    "apps",
    "--disable",
    "plugins",
    "--disable",
    "plugin_sharing",
    "--disable",
    "skill_mcp_dependency_install",
  );
}

const first = await runCommand("codex", {
  args: [
    "exec",
    ...common,
    "--sandbox",
    "read-only",
    "-C",
    workspace,
    "Reply with exactly runtime-profile-start-ok. Do not use tools.",
  ],
  cwd: workspace,
  env: process.env,
  timeoutMs: 60_000,
});
const firstSummary = summarize(first.stdout);
const threadId = firstSummary.threadId;

let resumed:
  | Awaited<ReturnType<typeof runCommand>>
  | undefined;
if (typeof threadId === "string") {
  resumed = await runCommand("codex", {
    args: [
      "exec",
      "resume",
      ...common,
      "-c",
      'sandbox_mode="read-only"',
      threadId,
      "Reply with exactly runtime-profile-resume-ok. Do not use tools.",
    ],
    cwd: workspace,
    env: process.env,
    timeoutMs: 60_000,
  });
}
const resumedSummary = summarize(resumed?.stdout ?? "");
const sessionsRoot = join(process.env.CODEX_HOME ?? "", "sessions");
let persistedSessionEntries = 0;
try {
  persistedSessionEntries = (await readdir(sessionsRoot, { recursive: true }))
    .length;
} catch {
  persistedSessionEntries = 0;
}
let pluginCatalogMaterialized = false;
try {
  await access(join(process.env.CODEX_HOME ?? "", "plugins"));
  pluginCatalogMaterialized = true;
} catch {
  pluginCatalogMaterialized = false;
}

process.stdout.write(
  `${JSON.stringify(
    {
      first: { exitCode: first.exitCode, ...firstSummary },
      resumed: { exitCode: resumed?.exitCode, ...resumedSummary },
      sameThread:
        typeof threadId === "string" &&
        threadId === resumedSummary.threadId,
      persistedSessionEntries,
      strictRuntime,
      pluginCatalogMaterialized,
    },
    null,
    2,
  )}\n`,
);

if (first.exitCode !== 0 || resumed?.exitCode !== 0) {
  process.exitCode = 1;
}
