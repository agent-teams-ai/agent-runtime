import assert from "node:assert/strict";
import { chmod, copyFile, link, mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test as nodeTest } from "node:test";

import { NodeProviderProcessCustody as BaseNodeProviderProcessCustody } from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/node-provider-process-custody.js";
import { createStaticHostCustodyLaunchPlanResolver } from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/static-host-custody-launch-plan-resolver.js";
import {
  binding,
  disposableRoot,
  launchPlan,
  qualifiedIdentityObserver,
  syntheticResidueAuthorityFactory,
} from "../../host-custody-test-fixture.ts";

const test = process.platform === "linux" ? nodeTest : nodeTest.skip;

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

test("executable mode and canonical non-symlink ancestors fail before dispatch", async () => {
  const workspaceRef = await disposableRoot();
  const relativeCustody = new NodeProviderProcessCustody({
    launchPlans: {async resolve() {return;}},
  });
  await assert.rejects(relativeCustody.open({
    attemptId: "attempt:relative-workspace",
    operationId: "operation:relative-workspace",
    providerBinding: binding,
    workspaceRef: "relative-workspace",
  }), { name: "HostCustodyLaunchRejectedError" });
  const writableExecutable = join(workspaceRef, "world-writable-node");
  await copyFile(process.execPath, writableExecutable);
  await chmod(writableExecutable, 0o755);
  const writableEntry = await launchPlan({ executablePath: writableExecutable, workspaceRef });
  await chmod(writableExecutable, 0o775);
  const writableCustody = new NodeProviderProcessCustody({
    launchPlans: createStaticHostCustodyLaunchPlanResolver([writableEntry]),
    processIdentityObserver: qualifiedIdentityObserver,
  });
  const writableRequest = {
    attemptId: "attempt:writable-executable",
    operationId: "operation:writable-executable",
    providerBinding: binding,
    workspaceRef,
  } as const;
  await assert.rejects(writableCustody.open(writableRequest), { name: "HostCustodyLaunchRejectedError" });
  assert.equal((await writableCustody.requestContainment(writableRequest)).kind, "contained");

  await chmod(writableExecutable, 0o755);
  await link(writableExecutable, join(workspaceRef, "second-node-link"));
  const linkedFileCustody = new NodeProviderProcessCustody({
    launchPlans: createStaticHostCustodyLaunchPlanResolver([writableEntry]),
  });
  const linkedFileRequest = {
    attemptId: "attempt:hardlinked-executable",
    operationId: "operation:hardlinked-executable",
    providerBinding: binding,
    workspaceRef,
  } as const;
  await assert.rejects(linkedFileCustody.open(linkedFileRequest), { name: "HostCustodyLaunchRejectedError" });
  assert.equal((await linkedFileCustody.requestContainment(linkedFileRequest)).kind, "contained");

  const realDirectory = join(workspaceRef, "real-bin");
  const linkedDirectory = join(workspaceRef, "linked-bin");
  await mkdir(realDirectory);
  const copiedExecutable = join(realDirectory, "node");
  await copyFile(process.execPath, copiedExecutable);
  await chmod(copiedExecutable, 0o500);
  await symlink(realDirectory, linkedDirectory, "dir");
  const linkedPath = join(linkedDirectory, "node");
  const resolver = {async resolve() {
    return {
      ...(await launchPlan({ executablePath: copiedExecutable, workspaceRef })).plan,
      executablePath: linkedPath,
    };
  }};
  const linkedCustody = new NodeProviderProcessCustody({ launchPlans: resolver });
  const linkedRequest = {
    attemptId: "attempt:symlink-ancestor",
    operationId: "operation:symlink-ancestor",
    providerBinding: binding,
    workspaceRef,
  } as const;
  await assert.rejects(linkedCustody.open(linkedRequest), { name: "HostCustodyLaunchRejectedError" });
  assert.equal((await linkedCustody.requestContainment(linkedRequest)).kind, "contained");
});

test("workspace and environment custody reject public or escaping private paths without disclosure", async () => {
  const workspaceRef = await disposableRoot();
  const entry = await launchPlan({ workspaceRef });
  await chmod(workspaceRef, 0o755);
  const publicCustody = new NodeProviderProcessCustody({
    launchPlans: createStaticHostCustodyLaunchPlanResolver([entry]),
  });
  const request = {
    attemptId: "attempt:public-workspace",
    operationId: "operation:public-workspace",
    providerBinding: binding,
    workspaceRef,
  } as const;
  let publicFailure: unknown;
  try {await publicCustody.open(request);} catch (error) {publicFailure = error;}
  assert.equal(Reflect.get(publicFailure as object, "name"), "HostCustodyLaunchRejectedError");
  assert.doesNotMatch(String(publicFailure), new RegExp(workspaceRef, "u"));

  await chmod(workspaceRef, 0o700);
  const escapedPlan = Object.freeze({
    ...entry.plan,
    environment: Object.freeze({ ...entry.plan.environment, CODEX_HOME: tmpdir() }),
  });
  const escapedCustody = new NodeProviderProcessCustody({
    launchPlans: createStaticHostCustodyLaunchPlanResolver([{ plan: escapedPlan, providerBinding: binding }]),
  });
  let escapedFailure: unknown;
  try {await escapedCustody.open({ ...request, attemptId: "attempt:escaped-home" });} catch (error) {escapedFailure = error;}
  assert.equal(Reflect.get(escapedFailure as object, "name"), "HostCustodyLaunchRejectedError");
  assert.doesNotMatch(String(escapedFailure), new RegExp(workspaceRef, "u"));
});
