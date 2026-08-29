import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import {
  createStaticHostCustodyLaunchPlanResolver,
  HostCustodyUnsupportedError,
  NodeProviderProcessCustody,
} from "../dist/composition.js";

const disposableRoots: string[] = [];
const binding = Object.freeze({
  adapterRevision: "synthetic-adapter:one",
  binaryRevision: "node:synthetic",
  capabilityManifestRevision: "manifest:synthetic",
  credentialBindingDigest: "credential:synthetic",
  provider: "codex" as const,
  providerRouteRef: "route:synthetic",
});

const disposableRoot = async (): Promise<string> => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agent-runtime-host-custody-")));
  disposableRoots.push(root);
  return root;
};

afterEach(async () => {
  await Promise.all(disposableRoots.splice(0).map(root => rm(root, { force: true, recursive: true })));
});

const executableDigest = async (): Promise<string> =>
  createHash("sha256").update(await readFile(process.execPath)).digest("hex");

const fixtureScript = `
const { spawn } = require("node:child_process");
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
process.stdout.write("descendant:" + child.pid + "\\n");
process.stdin.on("data", chunk => process.stdout.write("echo:" + chunk));
setInterval(() => {}, 1000);
`;

const createCustody = async (workspaceRef: string, digest?: string) => {
  const expectedDigest = digest ?? await executableDigest();
  const launchPlans = createStaticHostCustodyLaunchPlanResolver([{
    plan: {
      arguments: ["-e", fixtureScript],
      binaryRevision: binding.binaryRevision,
      containmentProfile: "cooperative-posix",
      environment: {
        HOME: workspaceRef,
        PATH: process.env.PATH ?? "",
        TMPDIR: workspaceRef,
      },
      executablePath: await realpath(process.execPath),
      executableSha256: expectedDigest,
      provider: "codex",
    },
    providerBinding: binding,
  }]);
  return new NodeProviderProcessCustody({ forceKillAfterMs: 1_000, launchPlans, terminateAfterMs: 1_000 });
};

test("spawns one exact process group and returns containment only after exit and drain", async () => {
  const workspaceRef = await disposableRoot();
  const custody = await createCustody(workspaceRef);
  const opened = await custody.open({
    attemptId: "attempt:one",
    operationId: "operation:one",
    providerBinding: binding,
    workspaceRef,
  });
  const replayed = await custody.open({
    attemptId: "attempt:one",
    operationId: "operation:one",
    providerBinding: binding,
    workspaceRef,
  });
  assert.deepEqual(replayed, opened);
  const providerProcess = custody.get(opened.custodyRef);
  assert.ok(providerProcess);
  const iterator = providerProcess.stdout[Symbol.asyncIterator]();
  const first = await iterator.next();
  assert.equal(first.done, false);
  const descendantMatch = Buffer.from(first.value).toString("utf8").match(/descendant:(\d+)/u);
  assert.ok(descendantMatch);
  await providerProcess.write(Buffer.from("probe\n"));
  const second = await iterator.next();
  assert.equal(second.done, false);
  assert.match(Buffer.from(second.value).toString("utf8"), /echo:probe/u);
  const contained = await custody.requestContainment({
    attemptId: "attempt:one",
    custodyRef: opened.custodyRef,
    operationId: "operation:one",
  });
  assert.equal(contained.kind, "contained");
  const exit = await providerProcess.waitForExit();
  assert.ok(exit.signal === "SIGTERM" || exit.signal === "SIGKILL");
  const descendantPid = Number(descendantMatch[1]);
  assert.throws(() => process.kill(descendantPid, 0), error =>
    error instanceof Error && "code" in error && error.code === "ESRCH");
});

test("fails before spawn for an unknown binding or executable digest mismatch", async () => {
  const workspaceRef = await disposableRoot();
  const custody = await createCustody(workspaceRef, "0".repeat(64));
  await assert.rejects(
    custody.open({ attemptId: "attempt:digest", operationId: "operation:digest", providerBinding: binding, workspaceRef }),
    /digest mismatch/u,
  );
  const empty = new NodeProviderProcessCustody({
    launchPlans: createStaticHostCustodyLaunchPlanResolver([]),
  });
  await assert.rejects(
    empty.open({ attemptId: "attempt:missing", operationId: "operation:missing", providerBinding: binding, workspaceRef }),
    HostCustodyUnsupportedError,
  );
});

test("missing custody is explicit unproven evidence and never synthetic success", async () => {
  const workspaceRef = await disposableRoot();
  const custody = await createCustody(workspaceRef);
  assert.deepEqual(
    await custody.requestContainment({ attemptId: "attempt:missing", operationId: "operation:missing" }),
    { evidenceRef: "host-custody-missing:attempt:missing", kind: "unproven" },
  );
});
