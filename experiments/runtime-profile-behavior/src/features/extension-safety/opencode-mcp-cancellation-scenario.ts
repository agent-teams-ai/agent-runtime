import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { ScenarioEvidence } from "../../model.ts";
import { writeJsonFixture } from "../config-precedence/fixture-files.ts";
import type { ProbeScenario } from "../scenario-execution/scenario.ts";

const exists = async (path: string): Promise<boolean> => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

const processExists = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") {
      return false;
    }
    throw error;
  }
};

const waitForProcessExit = async (pid: number): Promise<boolean> => {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (!processExists(pid)) {
      return true;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
  }
  return false;
};

const verification = (evidence: ScenarioEvidence): Record<string, unknown> =>
  (evidence.verification ?? {}) as Record<string, unknown>;

export const opencodeMcpCancellationScenario = (
  opencodeExecutable: string,
): ProbeScenario => {
  let pidPath = "";
  return {
    id: "opencode-mcp-outer-cancel-cleans-process-tree",
    provider: "opencode",
    prepare: async (sandbox) => {
      pidPath = join(sandbox.root, "outside-workspace", "stubborn-mcp.pid");
      await mkdir(join(sandbox.root, "outside-workspace"), { recursive: true });
      const serverPath = join(sandbox.root, "stubborn-mcp.mjs");
      await writeFile(
        serverPath,
        [
          'import { writeFile } from "node:fs/promises";',
          "await writeFile(process.argv[2], String(process.pid));",
          'process.on("SIGTERM", () => {});',
          "setInterval(() => {}, 1000);",
          "",
        ].join("\n"),
      );
      await writeJsonFixture(
        join(sandbox.xdgConfig, "opencode", "opencode.json"),
        {
          mcp: {
            stubborn: {
              type: "local",
              command: [process.execPath, serverPath, pidPath],
              enabled: true,
              timeout: 60_000,
            },
          },
        },
      );
    },
    invocation: () => ({
      executable: opencodeExecutable,
      args: ["mcp", "list"],
      timeoutMs: 10_000,
      expectedTimeout: true,
    }),
    verify: async () => {
      if (!(await exists(pidPath))) {
        return { processStarted: false, processExited: false };
      }
      const pid = Number(await readFile(pidPath, "utf8"));
      return {
        processStarted: Number.isSafeInteger(pid),
        processExited: Number.isSafeInteger(pid)
          ? await waitForProcessExit(pid)
          : false,
      };
    },
    assertions: (evidence) => [
      {
        id: "opencode.mcp-outer-cancel-triggered",
        passed: evidence.result.timedOut,
        expected: true,
        actual: evidence.result.timedOut,
      },
      {
        id: "opencode.mcp-process-started-before-cancel",
        passed: verification(evidence).processStarted === true,
        expected: true,
        actual: verification(evidence).processStarted,
      },
      {
        id: "opencode.mcp-process-tree-cleaned",
        passed: verification(evidence).processExited === true,
        expected: true,
        actual: verification(evidence).processExited,
      },
    ],
  };
};
