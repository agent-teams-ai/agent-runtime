import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createCodexCurrentKernelOwner } from "../../../dist/composition.js";
import { createCodexAppServerLaunchPlan } from "../../../dist/features/contained-agent-turn/adapters/outbound/codex-app-server/codex-app-server-launch-plan.js";
import { createCodexAppServerPermissionBoundary } from "../../../dist/features/contained-agent-turn/adapters/outbound/codex-app-server/codex-app-server-permission-boundary.js";
import {
  codexCredentialOutputInventory, FakeHost, ids, openInput,
  syntheticCodexEffectCustody, workspaceOwner,
} from "./support/current-provider-owner-fixture.ts";

for (const platformTarget of [
  {architecture: "x64", platform: "linux"},
  {architecture: "arm64", platform: "darwin"},
] as const) {
  test(`Codex ${platformTarget.platform} native preparation rejects structural Host custody before callback or start`, async t => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "codex-custody-authority-")));
    t.after(() => rm(root, {recursive: true, force: true}));
    const workspaceRef = join(root, "workspace");
    const privateRootPath = join(root, "private");
    const codexHome = join(privateRootPath, "home");
    const tmpDir = join(privateRootPath, "tmp");
    for (const path of [workspaceRef, codexHome, tmpDir]) {
      await mkdir(path, {recursive: true, mode: 0o700});
    }
    const identity = ids("codex", `structural-${platformTarget.platform}`);
    const boundary = createCodexAppServerPermissionBoundary({codexHome, intentMode: "analysis", workspaceRef});
    const recipe = {boundary, executablePath: "/synthetic/unexecuted-codex",
      intentMode: "analysis" as const, platformTarget, privateRootPath, tmpDir};
    // A valid recipe reaches tuple selection. A missing target fails earlier
    // during the hardened input snapshot, so it cannot assert a tuple error.
    assert.doesNotThrow(() => createCodexAppServerLaunchPlan(recipe));
    assert.throws(() => createCodexAppServerLaunchPlan({...recipe,
      platformTarget: {architecture: "x64", platform: "darwin"} as never}), /No exact/u);

    const host = new FakeHost();
    let callbacks = 0;
    const owner = createCodexCurrentKernelOwner({
      effectCustody: syntheticCodexEffectCustody(),
      hostBootId: "host-boot:structural", hostInstanceId: "host-instance:structural",
      hostCustody: host as never, platformTarget,
      launchRecords: {resolve: async input => ({...recipe,
        credentialOutputInventory: codexCredentialOutputInventory(input)})},
      workspaceOwner: workspaceOwner(identity, workspaceRef),
      postClaimPreparation: {async prepareClaimed() {callbacks += 1; return {kind: "prepared"};}},
    });
    t.after(() => owner.dispose());
    await assert.rejects(owner.custody.open(openInput(identity, "codex", owner.provider.adapterSnapshot)),
      {name: "TypeError", message: "Codex native finalization requires actual Host custody"});
    assert.equal(host.reserves, 1, "a structural reservation cannot supply native provenance");
    assert.equal(host.starts, 0);
    assert.equal(callbacks, 0);
  });
}
