import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { NodeProviderProcessCustody } from "../dist/features/contained-agent-turn/adapters/outbound/host-custody/node-provider-process-custody.js";
import { createStaticHostCustodyLaunchPlanResolver } from "../dist/features/contained-agent-turn/adapters/outbound/host-custody/static-host-custody-launch-plan-resolver.js";
import { HostCustodyUnsupportedError } from "../dist/features/contained-agent-turn/adapters/outbound/host-custody/custodied-provider-process.js";

const disposableRoots: string[] = [];
const binding = Object.freeze({
  adapterRevision: "synthetic-adapter:one",
  binaryRevision: "node:synthetic",
  capabilityManifestRevision: "manifest:synthetic",
  credentialBindingDigest: "credential:synthetic",
  provider: "codex" as const,
  providerRouteRef: "route:synthetic",
});
const claudeBinding = Object.freeze({
  ...binding,
  adapterRevision: "claude-sdk-adapter:test",
  binaryRevision: "node:claude-sdk-synthetic",
  provider: "claude" as const,
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

const createDeferredCustody = async (workspaceRef: string) => {
  const environment = Object.freeze({ HOME: workspaceRef, PATH: process.env.PATH ?? "", TMPDIR: workspaceRef });
  const executablePath = await realpath(process.execPath);
  const launchArguments = Object.freeze(["-e", fixtureScript]);
  const launchPlans = createStaticHostCustodyLaunchPlanResolver([{
    plan: {
      arguments: launchArguments,
      binaryRevision: claudeBinding.binaryRevision,
      containmentProfile: "cooperative-posix",
      environment,
      executablePath,
      executableSha256: await executableDigest(),
      provider: "claude",
      spawnMode: "sdk-delegated",
    },
    providerBinding: claudeBinding,
  }]);
  return {
    arguments: launchArguments,
    custody: new NodeProviderProcessCustody({ forceKillAfterMs: 1_000, launchPlans, terminateAfterMs: 1_000 }),
    environment,
    executablePath,
  };
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

test("reserves an exact SDK-delegated process and lets Host Custody own its process group", async () => {
  const workspaceRef = await disposableRoot();
  const deferred = await createDeferredCustody(workspaceRef);
  const opened = await deferred.custody.open({
    attemptId: "attempt:delegated",
    operationId: "operation:delegated",
    providerBinding: claudeBinding,
    workspaceRef,
  });
  assert.equal(deferred.custody.get(opened.custodyRef), undefined);

  const controller = new AbortController();
  const sdkProcess = deferred.custody.start(opened.custodyRef, {
    arguments: deferred.arguments,
    command: deferred.executablePath,
    cwd: workspaceRef,
    environment: deferred.environment,
    signal: controller.signal,
  });
  assert.ok(deferred.custody.get(opened.custodyRef));
  assert.equal(sdkProcess.exitCode, null);
  const providerProcess = deferred.custody.get(opened.custodyRef);
  assert.ok(providerProcess);
  const first = await providerProcess.stdout[Symbol.asyncIterator]().next();
  assert.equal(first.done, false);
  assert.match(Buffer.from(first.value).toString("utf8"), /descendant:\d+/u);
  assert.throws(() => deferred.custody.start(opened.custodyRef, {
    arguments: deferred.arguments,
    command: deferred.executablePath,
    cwd: workspaceRef,
    environment: deferred.environment,
    signal: controller.signal,
  }), /already started/u);

  controller.abort();
  const contained = await deferred.custody.requestContainment({
    attemptId: "attempt:delegated",
    custodyRef: opened.custodyRef,
    operationId: "operation:delegated",
  });
  assert.equal(contained.kind, "contained");
});

test("delegated SDK launch fails closed on command, arguments, cwd, or environment drift", async () => {
  const workspaceRef = await disposableRoot();
  const deferred = await createDeferredCustody(workspaceRef);
  const opened = await deferred.custody.open({
    attemptId: "attempt:drift",
    operationId: "operation:drift",
    providerBinding: claudeBinding,
    workspaceRef,
  });
  const exact = {
    arguments: deferred.arguments,
    command: deferred.executablePath,
    cwd: workspaceRef,
    environment: deferred.environment,
    signal: new AbortController().signal,
  } as const;
  assert.throws(() => deferred.custody.start(opened.custodyRef, { ...exact, command: "/bin/false" }), /command or workspace/u);
  assert.throws(() => deferred.custody.start(opened.custodyRef, { ...exact, arguments: ["--version"] }), /arguments mismatch/u);
  assert.throws(() => deferred.custody.start(opened.custodyRef, { ...exact, cwd: undefined }), /command or workspace/u);
  assert.throws(() => deferred.custody.start(opened.custodyRef, { ...exact, environment: { ...deferred.environment, EXTRA: "1" } }), /environment mismatch/u);
  assert.equal(deferred.custody.get(opened.custodyRef), undefined);

  const contained = await deferred.custody.requestContainment({
    attemptId: "attempt:drift",
    custodyRef: opened.custodyRef,
    operationId: "operation:drift",
  });
  assert.equal(contained.kind, "contained");
  assert.throws(() => deferred.custody.start(opened.custodyRef, exact), /reservation is sealed/u);
});
