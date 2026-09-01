import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, copyFile, lstat, mkdir, readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { NodeProviderProcessCustody as BaseNodeProviderProcessCustody } from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/node-provider-process-custody.js";
import { createStaticHostCustodyLaunchPlanResolver } from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/static-host-custody-launch-plan-resolver.js";
import { acquireVerifiedLaunchDescriptors } from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/host-custody-descriptor-launch.js";
import {
  verifyExecutable,
  verifyPrivateLaunchPaths,
} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/host-custody-launch.js";
import {
  claudeBinding,
  disposableRoot,
  launchPlan,
  qualifiedIdentityObserver,
  syntheticResidueAuthorityFactory,
} from "../../host-custody-test-fixture.ts";

class NodeProviderProcessCustody extends BaseNodeProviderProcessCustody {
  public constructor(options: ConstructorParameters<typeof BaseNodeProviderProcessCustody>[0]) {
    super({
      identityObservationAfterMs: 60_000,
      residueAuthorityFactory: syntheticResidueAuthorityFactory,
      spawnAcknowledgementAfterMs: 60_000,
      ...options,
    });
  }

  public override open(input: Parameters<BaseNodeProviderProcessCustody["open"]>[0]) {
    return super.open({ intentMode: "analysis", ...input });
  }
}

test("executable replacement after reservation is rejected immediately before delegated spawn", async () => {
  const workspaceRef = await disposableRoot();
  const executablePath = join(workspaceRef, "reserved-node");
  await copyFile(process.execPath, executablePath);
  await chmod(executablePath, 0o500);
  const entry = await launchPlan({
    binding: claudeBinding,
    executablePath,
    spawnMode: "sdk-delegated",
    workspaceRef,
  });
  const custody = new NodeProviderProcessCustody({
    launchPlans: createStaticHostCustodyLaunchPlanResolver([entry]),
    processIdentityObserver: qualifiedIdentityObserver,
  });
  const request = {
    attemptId: "attempt:binary-replacement",
    operationId: "operation:binary-replacement",
    providerBinding: claudeBinding,
    workspaceRef,
  } as const;
  const opened = await custody.open(request);
  const displaced = join(workspaceRef, "reserved-node-before");
  await rename(executablePath, displaced);
  await copyFile(process.execPath, executablePath);
  await chmod(executablePath, 0o500);
  assert.throws(() => custody.start(opened.custodyRef, {
    arguments: entry.plan.arguments,
    command: executablePath,
    cwd: "/proc/self/fd/4",
    environment: entry.plan.environment,
    signal: new AbortController().signal,
  }), { name: "HostCustodyLaunchRejectedError" });
  const closure = await custody.requestContainment({ ...request, custodyRef: opened.custodyRef });
  assert.equal(closure.kind, "contained");
  assert.equal(custody.evidence(opened.custodyRef)?.spawn, "never-started");
});

test("workspace replacement after reservation is rejected immediately before delegated spawn", async () => {
  const root = await disposableRoot();
  const workspaceRef = join(root, "workspace");
  await mkdir(workspaceRef, { mode: 0o700 });
  const entry = await launchPlan({
    binding: claudeBinding,
    spawnMode: "sdk-delegated",
    workspaceRef,
  });
  const custody = new NodeProviderProcessCustody({
    launchPlans: createStaticHostCustodyLaunchPlanResolver([entry]),
    processIdentityObserver: qualifiedIdentityObserver,
  });
  const request = {
    attemptId: "attempt:workspace-replacement",
    operationId: "operation:workspace-replacement",
    providerBinding: claudeBinding,
    workspaceRef,
  } as const;
  const opened = await custody.open(request);
  await rename(workspaceRef, join(root, "workspace-before"));
  await mkdir(workspaceRef, { mode: 0o700 });
  assert.throws(() => custody.start(opened.custodyRef, {
    arguments: entry.plan.arguments,
    command: entry.plan.executablePath,
    cwd: "/proc/self/fd/4",
    environment: entry.plan.environment,
    signal: new AbortController().signal,
  }), { name: "HostCustodyLaunchRejectedError" });
  const closure = await custody.requestContainment({ ...request, custodyRef: opened.custodyRef });
  assert.equal(closure.kind, "contained");
  assert.equal(custody.evidence(opened.custodyRef)?.spawn, "never-started");
});

test("workspace privacy mutation after reservation fails closed without path disclosure", async () => {
  const workspaceRef = await disposableRoot();
  const entry = await launchPlan({
    binding: claudeBinding,
    spawnMode: "sdk-delegated",
    workspaceRef,
  });
  const custody = new NodeProviderProcessCustody({
    launchPlans: createStaticHostCustodyLaunchPlanResolver([entry]),
  });
  const request = {
    attemptId: "attempt:workspace-privacy-mutation",
    operationId: "operation:workspace-privacy-mutation",
    providerBinding: claudeBinding,
    workspaceRef,
  } as const;
  const opened = await custody.open(request);
  await chmod(workspaceRef, 0o755);
  let failure: unknown;
  try {
    custody.start(opened.custodyRef, {
      arguments: entry.plan.arguments,
      command: entry.plan.executablePath,
      cwd: "/proc/self/fd/4",
      environment: entry.plan.environment,
      signal: new AbortController().signal,
    });
  } catch (error) {failure = error;}
  assert.equal(Reflect.get(failure as object, "name"), "HostCustodyLaunchRejectedError");
  assert.doesNotMatch(String(failure), new RegExp(workspaceRef, "u"));
  assert.equal((await custody.requestContainment({ ...request, custodyRef: opened.custodyRef })).kind, "contained");
});

test("descriptor-bound executable and cwd remain the verified objects across pathname replacement", async () => {
  const root = await disposableRoot();
  const workspaceRef = join(root, "workspace-descriptor");
  await mkdir(workspaceRef, { mode: 0o700 });
  const executablePath = join(workspaceRef, "node");
  await copyFile(process.execPath, executablePath);
  await chmod(executablePath, 0o500);
  const entry = await launchPlan({ executablePath, workspaceRef });
  const executable = await verifyExecutable(entry.plan);
  const workspaceStats = await lstat(workspaceRef, { bigint: true });
  const privatePaths = await verifyPrivateLaunchPaths(entry.plan, workspaceRef, workspaceStats);
  const authority = acquireVerifiedLaunchDescriptors(entry.plan, executable, workspaceRef, {
    ctimeNs: workspaceStats.ctimeNs,
    dev: workspaceStats.dev,
    ino: workspaceStats.ino,
    mode: workspaceStats.mode,
    uid: workspaceStats.uid,
  }, privatePaths);
  const displaced = join(root, "workspace-descriptor-before");
  await rename(workspaceRef, displaced);
  await mkdir(workspaceRef, { mode: 0o700 });
  const child = spawn(`/proc/self/fd/${authority.executableDescriptor.childDescriptor}`, ["-e", "require('node:fs').writeFileSync('marker', 'verified')"], {
    cwd: `/proc/self/fd/${authority.workspaceDescriptor.childDescriptor}`,
    env: entry.plan.environment,
    stdio: [
      "ignore",
      "ignore",
      "ignore",
      "ignore",
      authority.workspaceDescriptor.parentDescriptor,
      authority.executableDescriptor.parentDescriptor,
    ],
  });
  authority.close();
  const exitCode = await new Promise<number | null>(resolve => {child.once("exit", code => resolve(code));});
  assert.equal(exitCode, 0);
  assert.equal(await readFile(join(displaced, "marker"), "utf8"), "verified");
  await assert.rejects(readFile(join(workspaceRef, "marker")), { code: "ENOENT" });
});
