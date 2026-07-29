import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import type { CommandResult } from "../../model.ts";
import { runCommand } from "../process-execution/run-command.ts";
import type { ProbeInvocation } from "./scenario.ts";

export const runTracedCommand = async (
  invocation: ProbeInvocation,
  environment: NodeJS.ProcessEnv,
  tracePrefix: string,
): Promise<CommandResult> => {
  await mkdir(dirname(tracePrefix), { recursive: true, mode: 0o700 });

  return runCommand("/usr/bin/strace", {
    args: [
      "-ff",
      "-qq",
      "-e",
      "trace=%file,process",
      "-o",
      tracePrefix,
      invocation.executable,
      ...invocation.args,
    ],
    cwd: invocation.cwd,
    env: environment,
    timeoutMs: invocation.timeoutMs ?? 30_000,
  }).then((result) => ({
    ...result,
    command: invocation.executable,
    args: invocation.args,
  }));
};
