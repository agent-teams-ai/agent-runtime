import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {mkdtemp, rm} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {setTimeout as delay} from "node:timers/promises";

// Private test-runner lifetime; never used for provider execution.
// Linux callers require a host reaper for orphaned descendants.
export async function runOwnedTestProcess({command, args, cwd, timeoutMilliseconds = 120000}) {
  let child; let temporaryRoot; let timer; let escalation;
  let interrupted = false; let expired = false; let code;
  const terminate = signal => {
    if (child?.pid === undefined) {return;}
    try {process.kill(-child.pid, signal);} catch (error) {if (error.code !== "ESRCH") {throw error;}}
  };
  const groupExists = () => {
    if (child?.pid === undefined) {return false;}
    try {process.kill(-child.pid, 0); return true;} catch (error) {
      if (error.code === "ESRCH") {return false;} throw error;
    }
  };
  const interrupt = () => {
    if (interrupted) {return;}
    interrupted = true;
    terminate("SIGTERM");
    escalation = setTimeout(() => terminate("SIGKILL"), 1000);
  };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  try {
    temporaryRoot = await mkdtemp(join(tmpdir(), "ar69-joined-runner-"));
    if (!interrupted) {
      child = spawn(command, args, {cwd, stdio: "inherit", detached: true,
        env: {...process.env, AR69_JOINED_TEST_PARENT: temporaryRoot}});
      timer = setTimeout(() => {expired = true; terminate("SIGKILL");}, timeoutMilliseconds);
      code = await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (status, signal) => resolve(signal === null ? status : 1));
      });
    }
  } finally {
    // Direct-child exit does not prove descendant exit. Retain exact directory
    // ownership until the detached group has disappeared, including reaping.
    try {
      terminate("SIGTERM");
      const deadline = Date.now() + 1000;
      while (groupExists() && Date.now() < deadline) {await delay(25);}
      terminate("SIGKILL");
      const killDeadline = Date.now() + 2000;
      while (groupExists() && Date.now() < killDeadline) {await delay(25);}
      assert.ok(!groupExists(), `test process group remains; retained directory: ${temporaryRoot}`);
      if (temporaryRoot !== undefined) {await rm(temporaryRoot, {recursive: true, force: true});}
    } finally {
      clearTimeout(timer); clearTimeout(escalation);
      process.off("SIGINT", interrupt); process.off("SIGTERM", interrupt);
    }
  }
  return interrupted ? 130 : expired ? 124 : code ?? 1;
}
