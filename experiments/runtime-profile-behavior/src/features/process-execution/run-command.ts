import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";

import type { CommandResult } from "../../model.ts";

export interface RunCommandOptions {
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
}

const signalProcessTree = (
  child: ReturnType<typeof spawn>,
  signal: NodeJS.Signals,
): void => {
  if (process.platform !== "win32" && child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // The process may have exited between the state check and the signal.
    }
  }
  child.kill(signal);
};

const terminateProcess = (child: ReturnType<typeof spawn>): void => {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  signalProcessTree(child, "SIGTERM");
  setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      signalProcessTree(child, "SIGKILL");
    }
  }, 1_000).unref();
};

export const runCommand = async (
  command: string,
  options: RunCommandOptions = {},
): Promise<CommandResult> => {
  const args = [...(options.args ?? [])];
  const startedAt = performance.now();
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    shell: false,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  let timedOut = false;

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  const timeout = setTimeout(() => {
    timedOut = true;
    terminateProcess(child);
  }, options.timeoutMs ?? 15_000);

  const result = await new Promise<{
    exitCode: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (exitCode, signal) => {
      resolve({ exitCode, signal });
    });
  }).finally(() => {
    clearTimeout(timeout);
  });

  return {
    command,
    args,
    exitCode: result.exitCode,
    signal: result.signal,
    stdout,
    stderr,
    timedOut,
    durationMs: Math.round(performance.now() - startedAt),
  };
};
