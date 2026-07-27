import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

import { runCommand } from "../process-execution/run-command.ts";

const workspace = process.argv[2];
const repetitions = Number(process.argv[3] ?? "5");
if (workspace === undefined) {
  throw new Error("Expected workspace path");
}

interface CodexEvent {
  readonly type?: string;
  readonly thread_id?: string;
  readonly item?: {
    readonly type?: string;
    readonly text?: string;
  };
}

const killProcessGroup = (
  child: ReturnType<typeof spawn>,
): void => {
  if (child.pid === undefined) {
    child.kill("SIGKILL");
    return;
  }
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
};

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

const summarize = (stdout: string) => {
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
];

const crashAfterThreadStarted = async () => {
  const child = spawn(
    "codex",
    [
      "exec",
      ...common,
      "--sandbox",
      "read-only",
      "-C",
      workspace,
      "Use the shell to run sleep 30. After it finishes, reply with exactly unreachable-before-crash.",
    ],
    {
      cwd: workspace,
      env: process.env,
      detached: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  let threadId: string | undefined;
  let crashTriggerObserved = false;
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    stdout += `${line}\n`;
    try {
      const event = JSON.parse(line) as CodexEvent;
      if (
        event.type === "thread.started" &&
        typeof event.thread_id === "string" &&
        threadId === undefined
      ) {
        threadId = event.thread_id;
      }
      if (
        event.type === "item.started" &&
        event.item?.type === "command_execution" &&
        !crashTriggerObserved
      ) {
        crashTriggerObserved = true;
        killProcessGroup(child);
      }
    } catch {
      // Non-JSON diagnostics remain in the captured stream.
    }
  });
  const timeout = setTimeout(() => killProcessGroup(child), 30_000);
  const processResult = await new Promise<{
    readonly exitCode: number | null;
    readonly signal: NodeJS.Signals | null;
  }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (exitCode, signal) => {
      resolve({ exitCode, signal });
    });
  }).finally(() => clearTimeout(timeout));
  lines.close();
  return {
    ...processResult,
    threadId,
    crashTriggerObserved,
    stdout,
    stderr,
  };
};

const results = [];
for (let iteration = 0; iteration < repetitions; iteration += 1) {
  const crashed = await crashAfterThreadStarted();
  await new Promise((resolve) => setTimeout(resolve, 250));
  const marker = `runtime-profile-crash-resume-${iteration}-ok`;
  const resumed =
    crashed.threadId === undefined
      ? undefined
      : await runCommand("codex", {
          args: [
            "exec",
            "resume",
            ...common,
            "-c",
            'sandbox_mode="read-only"',
            crashed.threadId,
            `Reply with exactly ${marker}. Do not use tools.`,
          ],
          cwd: workspace,
          env: process.env,
          timeoutMs: 60_000,
        });
  const resumedSummary = summarize(resumed?.stdout ?? "");
  results.push({
    iteration,
    marker,
    crashed: {
      exitCode: crashed.exitCode,
      signal: crashed.signal,
      threadId: crashed.threadId,
      crashTriggerObserved: crashed.crashTriggerObserved,
      eventTypes: summarize(crashed.stdout).eventTypes,
      stderrPresent: crashed.stderr.trim().length > 0,
    },
    resumed: {
      exitCode: resumed?.exitCode,
      ...resumedSummary,
    },
    sameThread:
      crashed.threadId !== undefined &&
      crashed.threadId === resumedSummary.threadId,
  });
}

const allRecovered = results.every(
  (result) =>
    result.crashed.signal === "SIGKILL" &&
    result.crashed.crashTriggerObserved &&
    result.resumed.exitCode === 0 &&
    result.resumed.finalText === result.marker &&
    result.sameThread,
);

process.stdout.write(
  `${JSON.stringify({ repetitions, allRecovered, results }, null, 2)}\n`,
);
if (!allRecovered) {
  process.exitCode = 1;
}
