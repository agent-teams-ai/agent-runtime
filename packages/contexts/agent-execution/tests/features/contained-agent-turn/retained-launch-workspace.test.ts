import assert from "node:assert/strict";
import {test} from "node:test";
import {mkdtemp, mkdir, open, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createWorkspaceCapabilityRetention} from "../../../dist/features/contained-agent-turn/adapters/outbound/filesystem/contained-turn-workspace-capability.js";
import {retainLaunchWorkspace} from "../../../dist/features/contained-agent-turn/adapters/outbound/filesystem/retained-launch-workspace.js";

test("original callback authority duplicates once and survives callback descriptor closure", {skip: process.platform !== "linux"}, async t => {
  const path = await mkdtemp(join(tmpdir(), "ar69-retained-workspace-"));
  t.after(() => rm(path, {recursive: true, force: true}));
  const workspace = join(path, "workspace"); await mkdir(workspace);
  const parent = await open(path, "r"); t.after(() => parent.close());
  const owner = createWorkspaceCapabilityRetention(); t.after(() => owner.dispose());
  const scope = {projectId: "project", tenantId: "tenant"};
  const authority = await owner.retain({canonicalPath: workspace, workspaceRef: workspace,
    name: "workspace", parent, scope, operationId: "operation"});
  let original: Parameters<typeof retainLaunchWorkspace>[0] | undefined;
  const retained = await owner.consume({authority, scope, operationId: "operation", workspaceRef: workspace}, async target => {
    original = target;
    await assert.rejects(retainLaunchWorkspace({...target}, "operation", workspace));
    await assert.rejects(retainLaunchWorkspace(target, "foreign-operation", workspace));
    const held = await retainLaunchWorkspace(target, "operation", workspace);
    await assert.rejects(retainLaunchWorkspace(target, "operation", workspace));
    return held;
  });
  try {
    assert.ok((await retained.revalidate()).ino > 0n);
    await assert.rejects(retainLaunchWorkspace(original!, "operation", workspace));
  } finally {await retained.close();}
  await assert.rejects(retained.revalidate());
  await retained.close();
});
