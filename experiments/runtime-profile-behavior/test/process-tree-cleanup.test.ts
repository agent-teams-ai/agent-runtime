import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { runCommand } from "../src/features/process-execution/run-command.ts";

// MockTimers also patches timers/promises; retain real I/O polling beforehand.
const realDelay = delay;

const isAlive = (pid: number): boolean => {
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

const waitUntil = async (predicate: () => boolean, timeoutMs: number): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      return false;
    }
    await realDelay(25);
  }
  return true;
};

const readPid = async (path: string): Promise<number> => {
  const pid = Number(await readFile(path, "utf8"));
  assert.ok(Number.isSafeInteger(pid) && pid > 0, `invalid fixture PID at ${path}`);
  return pid;
};

const waitForFixture = async (root: string): Promise<[number, number]> => {
  const deadline = Date.now() + 5_000;
  while (true) {
    try {
      const pids = await Promise.all([
        readPid(join(root, "root.pid")),
        readPid(join(root, "child.pid")),
      ]);
      assert.ok(pids.every(isAlive), "both fixture processes must be live before timeout");
      return pids;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || Date.now() >= deadline) {
        throw error;
      }
    }
    await realDelay(25);
  }
};

for (const readinessDelayMs of [0, 500]) {
  test(`timeout terminates the complete extension process group (readiness delay ${readinessDelayMs}ms)`, async (context) => {
    const root = await mkdtemp(join(tmpdir(), "TEST-runtime-profile-process-tree-"));
    const childScript = [
      'const { writeFileSync, renameSync } = require("node:fs");',
      `setTimeout(() => { writeFileSync(process.argv[1] + ".tmp", String(process.pid)); renameSync(process.argv[1] + ".tmp", process.argv[1]); }, ${readinessDelayMs});`,
      "setInterval(() => {}, 1000);",
    ].join("\n");
    const script = [
      'const { spawn } = require("node:child_process");',
      'const { writeFileSync, renameSync } = require("node:fs");',
      'writeFileSync(process.argv[1] + ".tmp", String(process.pid));',
      'renameSync(process.argv[1] + ".tmp", process.argv[1]);',
      `spawn(process.execPath, ["-e", ${JSON.stringify(childScript)}, process.argv[2]], { stdio: "ignore" });`,
      "setInterval(() => {}, 1000);",
    ].join("\n");

    context.mock.timers.enable({ apis: ["setTimeout"] });
    let settled = false;
    // Attach rejection handling before any readiness I/O.
    const command = runCommand(process.execPath, {
      args: ["-e", script, join(root, "root.pid"), join(root, "child.pid")],
      timeoutMs: 300,
    }).then(
      (result) => {
        settled = true;
        return { result };
      },
      (error: unknown) => {
        settled = true;
        return { error };
      },
    );
    let pids: [number, number] | undefined;
    let testError: unknown;
    const cleanupErrors: unknown[] = [];
    const cleanup = async (): Promise<void> => {
      // Always terminate the owned command, including when readiness failed.
      context.mock.timers.tick(300);
      if (!await waitUntil(() => settled, 100)) {
        context.mock.timers.tick(1_000);
      }
      assert.ok(await waitUntil(() => settled, 3_000), "owned command must settle after escalation");
      const outcome = await command;
      if ("error" in outcome) {
        throw outcome.error;
      }
      assert.equal(outcome.result.timedOut, true);
      pids ??= await Promise.all([
        readPid(join(root, "root.pid")),
        readPid(join(root, "child.pid")),
      ]);
      const targets = process.platform === "win32" ? pids : [...pids, -pids[0]];
      assert.ok(
        await waitUntil(() => targets.every((pid) => !isAlive(pid)), 1_500),
        "the root, descendant, and complete process group must be gone",
      );
      await rm(root, { force: true, recursive: true });
    };
    try {
      pids = await waitForFixture(root);
      assert.equal(settled, false, "the command deadline must wait for explicit clock advancement");
    } catch (error) {
      testError = error;
    } finally {
      await cleanup().catch((error: unknown) => cleanupErrors.push(error));
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        testError === undefined ? cleanupErrors : [testError, ...cleanupErrors],
        `process-tree cleanup unproven; fixture evidence retained at ${root}`,
      );
    }
    if (testError !== undefined) {
      throw testError;
    }
  });
}
