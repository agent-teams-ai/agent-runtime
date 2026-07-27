import { spawn, type ChildProcess } from "node:child_process";

export interface ChildResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

export const waitForChild = async (
  child: ChildProcess,
  timeoutMs = 20_000,
): Promise<ChildResult> => {
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });

  const result = await new Promise<{
    exitCode: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve, reject) => {
    const timeout = setTimeout(() => {
      terminateChildTree(child);
      reject(new Error("Managed-policy child timed out"));
    }, timeoutMs);
    child.once("error", reject);
    child.once("close", (exitCode, signal) => {
      clearTimeout(timeout);
      resolve({ exitCode, signal });
    });
  });
  return { ...result, stdout, stderr };
};

export const terminateChildTree = (child: ChildProcess): void => {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  if (process.platform !== "win32" && child.pid !== undefined) {
    try {
      process.kill(-child.pid, "SIGTERM");
      return;
    } catch {
      // Fall through when the process exited between checks.
    }
  }
  child.kill("SIGTERM");
};

export const spawnProvider = (
  executable: string,
  args: readonly string[],
  options: {
    readonly cwd: string;
    readonly env: NodeJS.ProcessEnv;
    readonly stdin?: "ignore" | "pipe";
  },
): ChildProcess =>
  spawn(executable, [...args], {
    cwd: options.cwd,
    env: options.env,
    detached: process.platform !== "win32",
    shell: false,
    stdio: [options.stdin ?? "ignore", "pipe", "pipe"],
  });
