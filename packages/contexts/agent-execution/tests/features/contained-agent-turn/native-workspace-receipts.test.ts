import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {test} from "node:test";

test("native receipt readback returns retained records before release and rejects crossed records", () => {
  const result = spawnSync(process.execPath, ["--experimental-test-module-mocks", "--input-type=module", "-e", `
    import assert from "node:assert/strict";
    import {createHash} from "node:crypto";
    import {mock} from "node:test";
    const root = ${JSON.stringify(new URL("../../../dist/features/contained-agent-turn/adapters/outbound/", import.meta.url).href)};
    const manifest = Buffer.alloc(112), digest = value => createHash("sha256").update(value).digest();
    digest("operation").copy(manifest, 48);
    digest(Buffer.from("tenant\\0project")).copy(manifest, 80);
    const original = await import(root + "host-custody/darwin-attempt-workspace-entrypoint.js");
    let closedReads = 0;
    mock.module(root + "host-custody/darwin-attempt-workspace-entrypoint.js", {namedExports: {...original,
      consumeDarwinNativeWorkspaceSelection: () => ({
        capturedManifest: () => manifest, binding: () => ({workspaceDev: "1", workspaceIno: "2"}),
        materializeComplete: async tree => tree,
        readClosedWorkspace: async () => {closedReads++; throw Error("not released");},
      }),
    }});
    const {selectDarwinAttemptWorkspaceBackend} = await import(root + "filesystem/darwin-attempt-workspace-backend.js");
    const scope = {tenantId: "tenant", projectId: "project"};
    const workspaceName = "operation-" + digest(JSON.stringify(["tenant", "project", "operation"])).toString("hex");
    const creation = {schemaVersion: 1, operationId: "operation", workspaceName,
      scope, rootIdentity: {dev: "1", ino: "2"}, materializationDigest: "tree"};
    const seal = {schemaVersion: 2, operationId: "operation", workspaceName,
      scope, rootIdentity: {dev: "1", ino: "2"}, treeDigest: "sealed-tree", manifestDigest: "manifest"};
    const publication = {...seal, schemaVersion: 1, resultRef: "stored-result",
      manifestReceiptRef: "stored-manifest-receipt", resultReceiptRef: "stored-result-receipt"};
    const records = {creation, seal, publication};
    let creationReads = 0, changeCreation = false;
    const backend = selectDarwinAttemptWorkspaceBackend({}, {
      creation: async () => {creationReads++; return changeCreation && creationReads > 1
        ? {...records.creation, workspaceName: "changed-between-reads"} : records.creation;},
      seal: async () => records.seal,
      artifactResult: async () => records.publication, closure: async () => {throw Error("not closed");},
    });
    await backend.materializeComplete({treeDigest: "tree"}, {});
    const read = await backend.readReceipts();
    assert.equal(read.creation, creation); assert.equal(read.seal, seal); assert.equal(read.publication, publication);
    assert.equal(Object.isFrozen(read), true); assert.equal(closedReads, 0);
    for (const [record, patches] of [
      ["creation", [{operationId: "other"}, {scope: {...scope, tenantId: "other"}},
        {rootIdentity: {dev: "1", ino: "3"}}, {materializationDigest: "other"}]],
      ["seal", [{operationId: "other"}, {workspaceName: "other"}, {scope: {...scope, projectId: "other"}},
        {rootIdentity: {dev: "2", ino: "2"}}]],
      ["publication", [{operationId: "other"}, {workspaceName: "other"},
        {scope: {...scope, tenantId: "other"}}, {manifestDigest: "other"}, {treeDigest: "other"}]],
    ]) {
      const saved = records[record];
      for (const patch of patches) {
        records[record] = {...saved, ...patch};
        await assert.rejects(backend.readReceipts());
      }
      records[record] = saved;
    }
    creationReads = 0; changeCreation = true;
    const stable = await backend.readReceipts();
    assert.equal(creationReads, 1);
    assert.equal(stable.creation, creation);
    assert.equal(stable.seal.workspaceName, stable.creation.workspaceName);
    changeCreation = false;
    for (const record of ["creation", "seal", "publication"]) {
      records[record] = {...records[record], workspaceName: "operation-" + "f".repeat(64)};
    }
    await assert.rejects(backend.readReceipts(), /reservation/);
    assert.equal(closedReads, 0);
  `], {encoding: "utf8"});
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("receipt composition authenticates issued owners and exact workspace identity without effects", () => {
  const result = spawnSync(process.execPath, ["--experimental-test-module-mocks", "--input-type=module", "-e", `
    import assert from "node:assert/strict";
    import {mock} from "node:test";
    const root = ${JSON.stringify(new URL("../../../dist/features/contained-agent-turn/adapters/outbound/filesystem/", import.meta.url).href)};
    const original = await import(root + "darwin-attempt-workspace-backend.js");
    let reads = 0, hold;
    const receipts = Object.freeze({creation: {}, seal: {}, publication: {resultReceiptRef: "retained"}});
    mock.module(root + "darwin-attempt-workspace-backend.js", {namedExports: {...original,
      selectDarwinAttemptWorkspaceBackend: () => ({
        readReceipts: async () => {reads++; if (hold) await hold; return receipts;},
      }),
      revokeDarwinNativeWorkspaceSelection: () => {},
    }});
    mock.module(root + "node-contained-turn-workspace.js", {namedExports: {
      createNodeContainedTurnWorkspaceOwnerBackend: async (options, retention, initialize) => {
        if (initialize) await initialize({});
        return {workspace: {create: async input => ({workspaceId: "workspace:" + input.operationId})}};
      },
    }});
    const {createNodeContainedTurnWorkspaceOwner: create,
      readNodeContainedTurnNativeWorkspaceReceipts: read} = await import(root + "node-contained-turn-workspace-owner.js");
    const owner = await create({selectedNativeWorkspace: {}}), foreign = await create({selectedNativeWorkspace: {}});
    const ordinary = await create({});
    const input = {operationId: "operation", workspaceId: "workspace:operation"};
    const createInput = {operationId: "operation", scope: {tenantId: "tenant", projectId: "project"}};
    await owner.workspace.create(createInput);
    await foreign.workspace.create({...createInput, operationId: "foreign"});
    for (const candidate of [{}, {...owner}, Object.create(owner), ordinary]) {
      assert.throws(() => read(candidate, input), /not issued/);
    }
    await assert.rejects(read(foreign, input), /not owned/);
    for (const patch of [{operationId: "foreign"}, {workspaceId: "workspace:foreign"}]) {
      await assert.rejects(read(owner, {...input, ...patch}), /not owned/);
    }
    assert.equal(reads, 0);
    assert.equal(await read(owner, input), receipts);
    let release;
    hold = new Promise(resolve => {release = resolve;});
    const pending = read(owner, input);
    await owner.dispose(); release();
    await assert.rejects(pending, /disposed/);
    await assert.rejects(read(owner, input), /disposed/);
    assert.equal(reads, 2);
    await foreign.dispose(); await ordinary.dispose();
  `], {encoding: "utf8"});
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
