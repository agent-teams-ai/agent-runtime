import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runCommand } from "../src/features/process-execution/run-command.ts";

const waitForExit = async (pid: number): Promise<boolean> => {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") {
        return true;
      }
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
};

test("timeout terminates the complete extension process group", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "runtime-profile-process-tree-"));
  context.after(() => rm(root, { force: true, recursive: true }));
  const pidPath = join(root, "child.pid");
  const script = [
    'const { spawn } = require("node:child_process");',
    'const { writeFileSync } = require("node:fs");',
    'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });',
    "writeFileSync(process.argv[1], String(child.pid));",
    "setInterval(() => {}, 1000);",
  ].join("\n");

  const result = await runCommand(process.execPath, {
    args: ["-e", script, pidPath],
    timeoutMs: 300,
  });
  const childPid = Number(await readFile(pidPath, "utf8"));

  assert.equal(result.timedOut, true);
  assert.equal(await waitForExit(childPid), true);
});
