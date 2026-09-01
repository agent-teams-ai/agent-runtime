import assert from "node:assert/strict";
import { mkdir, rename, stat } from "node:fs/promises";
import { after, test, type TestContext } from "node:test";

import { containedTurnIdentity } from
  "../../../dist/features/contained-agent-turn/domain/contained-turn-identities.js";
import { createNodeContainedTurnWorkspaceOwner } from
  "../../../dist/features/contained-agent-turn/adapters/outbound/filesystem/node-contained-turn-workspace-owner.js";
import {
  cleanupTrackedFilesystemLayouts,
  createSyntheticFilesystemLayout,
} from "../../filesystem-contained-turn/fixture.ts";

const SCOPE = Object.freeze({ projectId: "project:owner", tenantId: "tenant:owner" });
const LIMITS = Object.freeze({
  maxDepth: 4,
  maxEntries: 16,
  maxFileBytes: 1_024,
  maxTotalBytes: 16 * 1_024,
});
const LINUX_REASON = "requires qualified Linux /proc descriptor custody";

const linuxTest = (
  name: string,
  body: (context: TestContext) => Promise<void> | void,
) => test(name, { skip: process.platform === "linux" ? false : LINUX_REASON }, body);

const operationId = (suffix: string) =>
  containedTurnIdentity("operation", `operation:${suffix}`);
const attemptId = (suffix: string) =>
  containedTurnIdentity("attempt", `attempt:${suffix}`);

after(cleanupTrackedFilesystemLayouts);

linuxTest("owner exposes only the frozen kernel workspace projection and exact create result", async () => {
  const layout = await createSyntheticFilesystemLayout();
  const owner = await createNodeContainedTurnWorkspaceOwner({
    ...layout.workspaceOptions,
    limits: LIMITS,
  });
  try {
    assert.equal(Object.isFrozen(owner), true);
    assert.deepEqual(Object.keys(owner).toSorted(), ["dispose", "withLaunchAuthority", "workspace"]);
    assert.equal(Object.isFrozen(owner.workspace), true);
    assert.deepEqual(Object.keys(owner.workspace).toSorted(), [
      "close", "create", "ensureClosed", "quarantine", "queryClosure",
    ]);

    const created = await owner.workspace.create({
      operationId: operationId("exact-projection"),
      scope: SCOPE,
    });
    assert.deepEqual(Object.keys(created), ["workspaceId"]);
    assert.match(created.workspaceId, /^workspace:operation-[a-f\d]{64}$/u);
    assert.equal("workspaceRef" in created, false);
  } finally {
    await owner.dispose();
    await layout.cleanup();
  }
});

linuxTest("owner binds one-use launch authority to its operation, workspace, attempt, and instance", async () => {
  const [firstLayout, secondLayout] = await Promise.all([
    createSyntheticFilesystemLayout(),
    createSyntheticFilesystemLayout(),
  ]);
  const [first, second] = await Promise.all([
    createNodeContainedTurnWorkspaceOwner({ ...firstLayout.workspaceOptions, limits: LIMITS }),
    createNodeContainedTurnWorkspaceOwner({ ...secondLayout.workspaceOptions, limits: LIMITS }),
  ]);
  try {
    const firstOperation = operationId("owner-first");
    const secondOperation = operationId("owner-second");
    const firstWorkspace = await first.workspace.create({ operationId: firstOperation, scope: SCOPE });
    const secondWorkspace = await second.workspace.create({ operationId: secondOperation, scope: SCOPE });
    let callbacks = 0;

    await assert.rejects(second.withLaunchAuthority({
      attemptId: attemptId("cross-owner"),
      operationId: firstOperation,
      workspaceId: firstWorkspace.workspaceId,
    }, async () => {callbacks += 1;}), /not owned by this owner/u);
    await assert.rejects(first.withLaunchAuthority({
      attemptId: attemptId("wrong-identity"),
      operationId: secondOperation,
      workspaceId: firstWorkspace.workspaceId,
    }, async () => {callbacks += 1;}), /not owned by this owner/u);

    const launch = {
      attemptId: attemptId("one-use"),
      operationId: firstOperation,
      workspaceId: firstWorkspace.workspaceId,
    };
    const observed = await first.withLaunchAuthority(launch, async target => {
      callbacks += 1;
      assert.equal(Object.isFrozen(target), true);
      assert.match(target.descriptorPath, /^\/proc\/self\/fd\/\d+$/u);
      return target.identity.mountId;
    });
    assert.match(observed, /^\d+$/u);
    await assert.rejects(
      first.withLaunchAuthority(launch, async () => {callbacks += 1;}),
      /stale or already consumed/u,
    );
    assert.equal(callbacks, 1);

    await second.withLaunchAuthority({
      attemptId: attemptId("second-owner"),
      operationId: secondOperation,
      workspaceId: secondWorkspace.workspaceId,
    }, async () => {callbacks += 1;});
    assert.equal(callbacks, 2);
  } finally {
    await Promise.allSettled([first.dispose(), second.dispose()]);
    await Promise.all([firstLayout.cleanup(), secondLayout.cleanup()]);
  }
});

linuxTest("callback rejection closes authority and disposal is idempotent and refuses new use", async () => {
  const layout = await createSyntheticFilesystemLayout();
  const owner = await createNodeContainedTurnWorkspaceOwner({
    ...layout.workspaceOptions,
    limits: LIMITS,
  });
  const operation = operationId("callback-rejection");
  const created = await owner.workspace.create({ operationId: operation, scope: SCOPE });
  let descriptorPath = "";
  await assert.rejects(owner.withLaunchAuthority({
    attemptId: attemptId("callback-rejection"),
    operationId: operation,
    workspaceId: created.workspaceId,
  }, async target => {
    descriptorPath = target.descriptorPath;
    throw new Error("synthetic launch rejection");
  }), /synthetic launch rejection/u);
  await assert.rejects(stat(descriptorPath), error =>
    typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
  );

  const firstDisposal = owner.dispose();
  assert.equal(owner.dispose(), firstDisposal);
  await firstDisposal;
  await assert.rejects(
    owner.workspace.create({ operationId: operationId("after-disposal"), scope: SCOPE }),
    /owner is disposed/u,
  );
  await assert.rejects(owner.withLaunchAuthority({
    attemptId: attemptId("after-disposal"),
    operationId: operation,
    workspaceId: created.workspaceId,
  }, async () => {}), /owner is disposed/u);
  await layout.cleanup();
});

linuxTest("disposal waits for an active callback without silently revoking its descriptor", async () => {
  const layout = await createSyntheticFilesystemLayout();
  const owner = await createNodeContainedTurnWorkspaceOwner({
    ...layout.workspaceOptions,
    limits: LIMITS,
  });
  const operation = operationId("active-disposal");
  const created = await owner.workspace.create({ operationId: operation, scope: SCOPE });
  let release!: () => void;
  const held = new Promise<void>(resolve => {release = resolve;});
  let entered!: (descriptorPath: string) => void;
  const active = new Promise<string>(resolve => {entered = resolve;});
  const launch = owner.withLaunchAuthority({
    attemptId: attemptId("active-disposal"),
    operationId: operation,
    workspaceId: created.workspaceId,
  }, async target => {
    entered(target.descriptorPath);
    await held;
    await stat(target.descriptorPath);
    return target.descriptorPath;
  });
  const descriptorPath = await active;
  const disposal = owner.dispose();
  await stat(descriptorPath);
  release();
  assert.equal(await launch, descriptorPath);
  await disposal;
  await assert.rejects(stat(descriptorPath), error =>
    typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
  );
  await layout.cleanup();
});

linuxTest("disposal rejects within its bound without revoking an unsettled callback descriptor", async () => {
  const layout = await createSyntheticFilesystemLayout();
  const owner = await createNodeContainedTurnWorkspaceOwner({
    ...layout.workspaceOptions,
    limits: LIMITS,
  });
  const operation = operationId("bounded-disposal");
  const created = await owner.workspace.create({ operationId: operation, scope: SCOPE });
  let release!: () => void;
  const held = new Promise<void>(resolve => {release = resolve;});
  let entered!: (descriptorPath: string) => void;
  const active = new Promise<string>(resolve => {entered = resolve;});
  const launch = owner.withLaunchAuthority({
    attemptId: attemptId("bounded-disposal"),
    operationId: operation,
    workspaceId: created.workspaceId,
  }, async target => {
    entered(target.descriptorPath);
    await held;
    await stat(target.descriptorPath);
    return target.descriptorPath;
  });
  const descriptorPath = await active;
  const startedAt = Date.now();
  await assert.rejects(owner.dispose(), /disposal incomplete/u);
  assert.ok(Date.now() - startedAt < 2_500, "owner disposal must reject within its fixed bound");
  await stat(descriptorPath);
  release();
  assert.equal(await launch, descriptorPath);
  await assert.rejects(stat(descriptorPath), error =>
    typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
  );
  await layout.cleanup();
});

linuxTest("durable identity substitution fails closed before the launch callback", async () => {
  const layout = await createSyntheticFilesystemLayout();
  const owner = await createNodeContainedTurnWorkspaceOwner({
    ...layout.workspaceOptions,
    limits: LIMITS,
  });
  try {
    const operation = operationId("identity-substitution");
    const created = await owner.workspace.create({ operationId: operation, scope: SCOPE });
    const workspaceName = created.workspaceId.slice("workspace:".length);
    const canonicalPath = `${layout.workspaceRoot}/active/${workspaceName}`;
    await rename(canonicalPath, `${canonicalPath}-displaced`);
    await mkdir(canonicalPath, { mode: 0o700 });
    let callbackCalled = false;
    await assert.rejects(owner.withLaunchAuthority({
      attemptId: attemptId("identity-substitution"),
      operationId: operation,
      workspaceId: created.workspaceId,
    }, async () => {callbackCalled = true;}), /identity|changed/u);
    assert.equal(callbackCalled, false);
  } finally {
    await owner.dispose();
    await layout.cleanup();
  }
});
