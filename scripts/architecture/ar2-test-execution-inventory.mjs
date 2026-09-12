import assert from "node:assert/strict";

import {
  packagePath, testCommand, testProcesses,
} from "@agent-teams/embedded-runtime/scripts/run-package-tests.mjs";
import { readCustodiedRepositoryFile } from "./ar2-evidence-custody.mjs";

// Only the reviewed launcher and literal Node test argv are supported here.
// This is deliberately not a shell-command interpreter.
export const readAr2TestExecutionInventory = async (packageRoot, options = {}) => {
  const read = path => readCustodiedRepositoryFile(path, { ...options, allowedRoot: packageRoot });
  const manifest = JSON.parse((await read(`${packageRoot}/package.json`)).toString("utf8"));
  const script = manifest.scripts?.test;
  assert.equal(typeof script, "string", `${packageRoot} must declare a test script`);
  let processes;
  if (packageRoot === packagePath) {
    assert.equal(script, testCommand, `${packageRoot} altered test launcher`);
    const launcherPath = `${packageRoot}/scripts/run-package-tests.mjs`;
    const launcher = await read(launcherPath);
    const canonical = await readCustodiedRepositoryFile(launcherPath, { allowedRoot: packageRoot });
    assert.deepEqual(launcher, canonical, `${packageRoot} altered test launcher source`);
    processes = testProcesses;
  } else {
    assert.match(script, /^node --test(?: --test-concurrency=1)?(?: tests\/[A-Za-z0-9._/*-]+\.test\.(?:ts|mjs))+$/u,
      `${packageRoot} unsupported test command`);
    processes = [script.split(" ").slice(1)];
  }
  return processes.flatMap(argv => {
    assert.ok(argv.includes("--test"), `${packageRoot} must execute Node tests`);
    return argv.filter(arg => arg.startsWith("tests/"));
  });
};

export const ar2InventoryExecutes = (inventory, relativeTestFile) => inventory.some(pattern => {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&").replaceAll("\\*", "[^/]+");
  return new RegExp(`^${escaped}$`, "u").test(relativeTestFile);
});
