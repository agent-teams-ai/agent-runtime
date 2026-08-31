/* oxlint-disable max-lines -- Keeping this contained-turn filesystem acceptance fixture intact preserves its shared lifecycle setup. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  chmod,
  link,
  mkdir,
  readFile,
  rename,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test, type TestContext } from "node:test";

import {
  createNodeContainedTurnArtifacts,
  createNodeContainedTurnWorkspace,
  type NodeContainedTurnArtifactOptions,
  type NodeContainedTurnWorkspaceOptions,
} from "../dist/composition.js";
import { createContainedTurnFeature } from "../dist/features/contained-agent-turn/composition/feature-module-factory.js";
import { digestContainedTurnCanonicalValue } from "../dist/features/contained-agent-turn/domain/contained-turn-codecs.js";
import { containedTurnIdentity } from "../dist/features/contained-agent-turn/domain/contained-turn-identities.js";
import { createDependencies } from "./features/contained-agent-turn/support/contained-agent-turn-fixture.ts";
import {
  assertNoTemporaryResidue,
  cleanupTrackedFilesystemLayouts,
  createDeterministicFaultInjector,
  createDomainSelectiveFakeDigest,
  createSyntheticFilesystemLayout,
  listRelativeResidue,
  type SyntheticFilesystemLayout,
} from "./filesystem-contained-turn/fixture.ts";

const TEST_SCOPE = Object.freeze({ projectId: "project:test", tenantId: "tenant:test" });
const SMALL_LIMITS = Object.freeze({
  maxDepth: 4,
  maxEntries: 16,
  maxFileBytes: 1_024,
  maxTotalBytes: 16 * 1_024,
});
const LINUX_DURABLE_DIRECTORY_REASON =
  "requires qualified Linux /proc descriptor custody, process locks, and renameat2 publication";

const linuxDurableDirectoryTest = (
  name: string,
  body: (context: TestContext) => Promise<void> | void,
) => test(name, {
  skip: process.platform === "linux" ? false : LINUX_DURABLE_DIRECTORY_REASON,
}, body);

after(cleanupTrackedFilesystemLayouts);

const createAdapters = async (
  layout: SyntheticFilesystemLayout,
  options: Readonly<{
    artifact?: Partial<NodeContainedTurnArtifactOptions>;
    workspace?: Partial<NodeContainedTurnWorkspaceOptions>;
  }> = {},
) => Promise.all([
  createNodeContainedTurnWorkspace({
    ...layout.workspaceOptions,
    limits: SMALL_LIMITS,
    ...options.workspace,
  }),
  createNodeContainedTurnArtifacts({
    ...layout.artifactOptions,
    limits: SMALL_LIMITS,
    ...options.artifact,
  }),
]);

const createWorkspace = (
  workspace: Awaited<ReturnType<typeof createNodeContainedTurnWorkspace>>,
  operationId: string,
) => workspace.create({ operationId, scope: TEST_SCOPE });

const manifestDigest = (resultRef: string): string => {
  const digest = resultRef.split(":").at(-1);
  assert.match(digest, /^[a-f\d]{64}$/u);
  return digest;
};

const manifestPath = (layout: SyntheticFilesystemLayout, digest: string): string =>
  join(layout.artifactRoot, "manifests", digest.slice(0, 2), digest);

const lookup = (operationId: string, resultRef: string) => ({
  operationId,
  resultRef,
  scope: TEST_SCOPE,
});

const crashWorker = fileURLToPath(new URL("./filesystem-contained-turn/crash-worker.ts", import.meta.url));

const runKilledFilesystemWorker = async (input: object): Promise<void> => {
  const child = spawn(process.execPath, [crashWorker, JSON.stringify(input)], {
    env: process.env,
    stdio: "ignore",
  });
  const outcome = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
    },
  );
  assert.equal(outcome.code, null);
  assert.equal(outcome.signal, "SIGKILL");
};

linuxDurableDirectoryTest("seals, verifies, reconstructs, and durably cleans one canonical tree", async () => {
  const layout = await createSyntheticFilesystemLayout();
  const [workspace, artifacts] = await createAdapters(layout);
  const operationId = "operation:reconstructible-tree";
  const created = await createWorkspace(workspace, operationId);
  await mkdir(join(created.workspaceRef, "empty"), { mode: 0o750 });
  await mkdir(join(created.workspaceRef, "nested"), { mode: 0o700 });
  await writeFile(join(created.workspaceRef, "nested", "result.txt"), "deterministic result", {
    mode: 0o640,
  });
  const input = {
    operationId,
    output: [{ cursor: 0, kind: "assistant" as const, text: "provider result" }],
    scope: TEST_SCOPE,
    workspaceRef: created.workspaceRef,
  };

  const sealed = await artifacts.seal(input);
  assert.deepEqual(await artifacts.seal(input), sealed);
  const manifest = await artifacts.verify(lookup(operationId, sealed.resultRef));
  assert.deepEqual(manifest.entries.map(entry => [entry.kind, entry.path]), [
    ["directory", "empty"],
    ["directory", "nested"],
    ["file", "nested/result.txt"],
  ]);
  assert.match(manifest.treeDigest, /^[a-f\d]{64}$/u);

  const joiningArtifacts = await createNodeContainedTurnArtifacts({
    ...layout.artifactOptions, limits: SMALL_LIMITS,
  });
  const [reconstructed, joined] = await Promise.all([
    artifacts.rehydrate(lookup(operationId, sealed.resultRef)),
    joiningArtifacts.rehydrate(lookup(operationId, sealed.resultRef)),
  ]);
  assert.equal(joined, reconstructed);
  assert.equal(await readFile(join(reconstructed, "nested", "result.txt"), "utf8"), "deterministic result");
  assert.deepEqual(await artifacts.rehydrate(lookup(operationId, sealed.resultRef)), reconstructed);

  const closeInput = { operationId, scope: TEST_SCOPE, workspaceRef: created.workspaceRef };
  const closure = await workspace.close(closeInput);
  assert.deepEqual(await workspace.close(closeInput), closure);
  assert.match(closure.receiptRef, /^urn:agent-runtime:workspace-closed:[a-f\d]{64}$/u);
  assert.equal((await listRelativeResidue(join(layout.workspaceRoot, "frozen"))).length, 0);
  assert.equal((await listRelativeResidue(join(layout.workspaceRoot, "cleanup"))).length, 0);
  await assertNoTemporaryResidue(layout.disposableRoot);
  await layout.cleanup();
});

linuxDurableDirectoryTest("materializes canonical content and binds replay and lookup to scope and inode", async () => {
  const layout = await createSyntheticFilesystemLayout();
  await mkdir(join(layout.canonicalProjectRoot, "source"), { mode: 0o750 });
  const canonicalFile = join(layout.canonicalProjectRoot, "source", "input.txt");
  await writeFile(canonicalFile, "authorized source", { mode: 0o640 });
  const [workspace, artifacts] = await createAdapters(layout);
  const operationId = "operation:scope-materialization";
  const created = await createWorkspace(workspace, operationId);
  const materializedFile = join(created.workspaceRef, "source", "input.txt");
  assert.equal(await readFile(materializedFile, "utf8"), "authorized source");
  const [sourceIdentity, materializedIdentity] = await Promise.all([
    stat(canonicalFile, { bigint: true }), stat(materializedFile, { bigint: true }),
  ]);
  assert.notEqual(materializedIdentity.ino, sourceIdentity.ino, "materialization must not hardlink source files");
  assert.equal(Number(materializedIdentity.mode & 0o777n), 0o640);
  assert.deepEqual(await createWorkspace(workspace, operationId), created);
  const directoryCapability = await workspace.verify({
    operationId, scope: TEST_SCOPE, workspaceRef: created.workspaceRef,
  });
  assert.equal(directoryCapability.kind, "workspace_launch_authority");
  assert.deepEqual(Object.keys(directoryCapability).toSorted(), ["authorityRef", "kind", "version"]);

  const otherScope = Object.freeze({ projectId: "project:other", tenantId: "tenant:other" });
  await assert.rejects(
    workspace.verify({ operationId, scope: otherScope, workspaceRef: created.workspaceRef }),
    /scope or operation mismatch/u,
  );
  const sealed = await artifacts.seal({
    operationId,
    output: [],
    scope: TEST_SCOPE,
    workspaceRef: created.workspaceRef,
  });
  await assert.rejects(
    artifacts.verify({ operationId, resultRef: sealed.resultRef, scope: otherScope }),
    /scope or operation mismatch/u,
  );
  await layout.cleanup();
});

linuxDurableDirectoryTest("empty creation and sealing are deterministic and idempotent under callers racing", async () => {
  const layout = await createSyntheticFilesystemLayout();
  const [workspace, artifacts] = await createAdapters(layout);
  const operationId = "operation:empty-race";
  const [firstWorkspace, secondWorkspace] = await Promise.all([
    createWorkspace(workspace, operationId),
    createWorkspace(workspace, operationId),
  ]);
  assert.deepEqual(secondWorkspace, firstWorkspace);
  const sealInput = {
    operationId,
    output: [],
    scope: TEST_SCOPE,
    workspaceRef: firstWorkspace.workspaceRef,
  };
  const [firstSeal, secondSeal] = await Promise.all([
    artifacts.seal(sealInput),
    artifacts.seal(sealInput),
  ]);
  assert.deepEqual(secondSeal, firstSeal);
  const manifest = await artifacts.verify(lookup(operationId, firstSeal.resultRef));
  assert.deepEqual(manifest.entries, []);
  assert.deepEqual(manifest.output, []);
  await layout.cleanup();
});

linuxDurableDirectoryTest("rejects workspace pathname substitution on replay and dispatch lookup", async () => {
  const layout = await createSyntheticFilesystemLayout();
  const [workspace] = await createAdapters(layout);
  const operationId = "operation:substituted-root";
  const created = await createWorkspace(workspace, operationId);
  const displaced = `${created.workspaceRef}-displaced`;
  await rename(created.workspaceRef, displaced);
  await mkdir(created.workspaceRef, { mode: 0o700 });
  await assert.rejects(createWorkspace(workspace, operationId), /identity was replaced/u);
  await assert.rejects(
    workspace.verify({ operationId, scope: TEST_SCOPE, workspaceRef: created.workspaceRef }),
    /identity was replaced/u,
  );
  await layout.cleanup();
});

linuxDurableDirectoryTest("rejects overlapping roots, symlink aliases, and symlink ancestors", async () => {
  const layout = await createSyntheticFilesystemLayout();
  await assert.rejects(
    createNodeContainedTurnWorkspace({
      canonicalProjectRoot: layout.canonicalProjectRoot,
      disposableRoot: layout.campaignRoot,
      root: join(layout.canonicalProjectRoot, "workspaces"),
    }),
    /overlap|ancestor|disposable-root descendant/u,
  );

  const alias = join(layout.disposableRoot, "workspace-alias");
  await symlink(layout.workspaceRoot, alias, "dir");
  await assert.rejects(
    createNodeContainedTurnWorkspace({ ...layout.workspaceOptions, root: alias }),
    /not a directory|no-follow|symlink|canonical alias|workspace_initialize failed \(ENOTDIR\)/u,
  );

  const realAncestor = join(layout.disposableRoot, "real-ancestor");
  const linkedAncestor = join(layout.disposableRoot, "linked-ancestor");
  await mkdir(realAncestor, { mode: 0o700 });
  await symlink(realAncestor, linkedAncestor, "dir");
  await assert.rejects(
    createNodeContainedTurnWorkspace({
      ...layout.workspaceOptions,
      root: join(linkedAncestor, "workspaces"),
    }),
    /not a directory|no-follow|symlink|workspace_initialize failed \(ENOTDIR\)/u,
  );
  await layout.cleanup();
});

linuxDurableDirectoryTest("descriptor traversal rejects root replacement, leaf symlinks, and hard links", async () => {
  const layout = await createSyntheticFilesystemLayout();
  let movedRoot = "";
  const rootSwapFault = {
    async checkpoint(point: string): Promise<void> {
      if (point !== "artifact.scan.root-opened.directory.") {return;}
      const frozenRoot = join(layout.workspaceRoot, "frozen");
      const [name] = await (await import("node:fs/promises")).readdir(frozenRoot);
      assert.ok(name);
      const current = join(frozenRoot, name);
      movedRoot = `${current}-moved`;
      await rename(current, movedRoot);
      await mkdir(current, { mode: 0o700 });
    },
  };
  const [swappedWorkspace, swappedArtifacts] = await createAdapters(layout, {
    artifact: { testFaults: rootSwapFault },
  });
  const swapped = await createWorkspace(swappedWorkspace, "operation:root-swap");
  await writeFile(join(swapped.workspaceRef, "result.txt"), "result", { mode: 0o600 });
  await assert.rejects(
    swappedArtifacts.seal({ operationId: "operation:root-swap", output: [], scope: TEST_SCOPE, workspaceRef: swapped.workspaceRef }),
    /directory changed|root path changed|identity changed/u,
  );
  assert.notEqual(movedRoot, "");

  const secondLayout = await createSyntheticFilesystemLayout();
  const [workspace, artifacts] = await createAdapters(secondLayout);
  const outside = join(secondLayout.campaignRoot, "outside-secret");
  await writeFile(outside, "must not be captured", { mode: 0o600 });
  const symbolic = await createWorkspace(workspace, "operation:symlink");
  await symlink(outside, join(symbolic.workspaceRef, "escape"));
  await assert.rejects(
    artifacts.seal({ operationId: "operation:symlink", output: [], scope: TEST_SCOPE, workspaceRef: symbolic.workspaceRef }),
    /symbolic link|too many levels|artifact_seal failed \(ELOOP\)/u,
  );
  const hardLinked = await createWorkspace(workspace, "operation:hardlink");
  await link(outside, join(hardLinked.workspaceRef, "linked"));
  await assert.rejects(
    artifacts.seal({ operationId: "operation:hardlink", output: [], scope: TEST_SCOPE, workspaceRef: hardLinked.workspaceRef }),
    /hard-linked|single-link/u,
  );
  assert.equal(await readFile(outside, "utf8"), "must not be captured");
  await Promise.all([layout.cleanup(), secondLayout.cleanup()]);
});

linuxDurableDirectoryTest("rejects path escape and portable case or Unicode collisions", async () => {
  const layout = await createSyntheticFilesystemLayout();
  const [workspace, artifacts] = await createAdapters(layout);
  await assert.rejects(
    artifacts.seal({
      operationId: "operation:path-escape",
      output: [],
      scope: TEST_SCOPE,
      workspaceRef: layout.canonicalProjectRoot,
    }),
    /outside active custody/u,
  );

  const caseId = "operation:case-collision";
  const caseWorkspace = await createWorkspace(workspace, caseId);
  await writeFile(join(caseWorkspace.workspaceRef, "Result"), "one", { mode: 0o600 });
  await writeFile(join(caseWorkspace.workspaceRef, "result"), "two", { mode: 0o600 });
  await assert.rejects(
    artifacts.seal({ operationId: caseId, output: [], scope: TEST_SCOPE, workspaceRef: caseWorkspace.workspaceRef }),
    /case or Unicode collision/u,
  );

  const unicodeId = "operation:unicode-collision";
  const unicodeWorkspace = await createWorkspace(workspace, unicodeId);
  await writeFile(join(unicodeWorkspace.workspaceRef, "\u00e9"), "one", { mode: 0o600 });
  await writeFile(join(unicodeWorkspace.workspaceRef, "e\u0301"), "two", { mode: 0o600 });
  await assert.rejects(
    artifacts.seal({
      operationId: unicodeId,
      output: [],
      scope: TEST_SCOPE,
      workspaceRef: unicodeWorkspace.workspaceRef,
    }),
    /non-portable entry name|case or Unicode collision/u,
  );
  await layout.cleanup();
});

linuxDurableDirectoryTest("enforces bounded entries, files, total bytes, and canonical output", async () => {
  const cases = [
    {
      limits: { maxDepth: 2, maxEntries: 1, maxFileBytes: 128, maxTotalBytes: 2_048 },
      populate: async (root: string) => {
        await writeFile(join(root, "a"), "a", { mode: 0o600 });
        await writeFile(join(root, "b"), "b", { mode: 0o600 });
      },
      pattern: /entry|enumeration/u,
    },
    {
      limits: { maxDepth: 2, maxEntries: 4, maxFileBytes: 3, maxTotalBytes: 2_048 },
      populate: (root: string) => writeFile(join(root, "large"), "four", { mode: 0o600 }),
      pattern: /bounded read|file limit/u,
    },
    {
      limits: { maxDepth: 2, maxEntries: 4, maxFileBytes: 64, maxTotalBytes: 80 },
      populate: (root: string) => writeFile(join(root, "bytes"), "x".repeat(64), { mode: 0o600 }),
      pattern: /operation byte limit|byte limit/u,
    },
  ] as const;
  for (const [index, item] of cases.entries()) {
    const layout = await createSyntheticFilesystemLayout();
    const [workspace, artifacts] = await createAdapters(layout, {
      artifact: { limits: item.limits },
      workspace: { limits: item.limits },
    });
    const operationId = `operation:quota:${index}`;
    const created = await createWorkspace(workspace, operationId);
    await item.populate(created.workspaceRef);
    await assert.rejects(
      artifacts.seal({ operationId, output: [], scope: TEST_SCOPE, workspaceRef: created.workspaceRef }),
      item.pattern,
    );
    await assertNoTemporaryResidue(layout.disposableRoot);
    await layout.cleanup();
  }

  const layout = await createSyntheticFilesystemLayout();
  const [workspace, artifacts] = await createAdapters(layout);
  const operationId = "operation:output-order";
  const created = await createWorkspace(workspace, operationId);
  await assert.rejects(
    artifacts.seal({
      operationId,
      output: [{ cursor: 1, kind: "assistant", text: "gap" }],
      scope: TEST_SCOPE,
      workspaceRef: created.workspaceRef,
    }),
    /output projection is invalid/u,
  );
  await layout.cleanup();
});

linuxDurableDirectoryTest("detects digest collision and corrupt manifest without publishing false truth", async () => {
  const collisionLayout = await createSyntheticFilesystemLayout();
  const [collisionWorkspace, collisionArtifacts] = await createAdapters(collisionLayout, {
    artifact: { testDigest: createDomainSelectiveFakeDigest("blob") },
  });
  const collisionId = "operation:digest-collision";
  const collision = await createWorkspace(collisionWorkspace, collisionId);
  await writeFile(join(collision.workspaceRef, "a"), "first", { mode: 0o600 });
  await writeFile(join(collision.workspaceRef, "b"), "second", { mode: 0o600 });
  await assert.rejects(
    collisionArtifacts.seal({ operationId: collisionId, output: [], scope: TEST_SCOPE, workspaceRef: collision.workspaceRef }),
    /digest collision|immutable file mismatch/u,
  );
  await assertNoTemporaryResidue(collisionLayout.disposableRoot);

  const corruptLayout = await createSyntheticFilesystemLayout();
  const [workspace, artifacts] = await createAdapters(corruptLayout);
  const operationId = "operation:corrupt-manifest";
  const created = await createWorkspace(workspace, operationId);
  await writeFile(join(created.workspaceRef, "result"), "result", { mode: 0o600 });
  const sealed = await artifacts.seal({ operationId, output: [], scope: TEST_SCOPE, workspaceRef: created.workspaceRef });
  const digest = manifestDigest(sealed.resultRef);
  await writeFile(manifestPath(corruptLayout, digest), "{}", { mode: 0o600 });
  await assert.rejects(artifacts.verify(lookup(operationId, sealed.resultRef)), /digest does not match|manifest/u);
  await Promise.all([collisionLayout.cleanup(), corruptLayout.cleanup()]);
});

linuxDurableDirectoryTest("fails closed when retained seal or canonical result publication is missing or corrupt", async () => {
  const missingSealLayout = await createSyntheticFilesystemLayout();
  const [missingSealWorkspace, missingSealArtifacts] = await createAdapters(missingSealLayout);
  const missingSealOperation = "operation:missing-seal";
  const missingSeal = await createWorkspace(missingSealWorkspace, missingSealOperation);
  const sealed = await missingSealArtifacts.seal({
    operationId: missingSealOperation,
    output: [],
    scope: TEST_SCOPE,
    workspaceRef: missingSeal.workspaceRef,
  });
  await unlink(join(
    missingSealLayout.workspaceRoot,
    "seals",
    `${basename(missingSeal.workspaceRef)}.json`,
  ));
  await assert.rejects(
    missingSealArtifacts.seal({
      operationId: missingSealOperation,
      output: [],
      scope: TEST_SCOPE,
      workspaceRef: missingSeal.workspaceRef,
    }),
    /no retained seal/u,
  );
  await assert.rejects(
    missingSealArtifacts.verify(lookup(missingSealOperation, sealed.resultRef)),
    error => {
      assert.ok(error instanceof Error && "code" in error);
      assert.equal(error.code, "ERR_CONTAINED_TURN_FILESYSTEM_CUSTODY");
      assert.match(error.message, /publication|seal/u);
      assert.equal(error.message.includes(missingSealLayout.campaignRoot), false);
      return true;
    },
  );

  const corruptResultLayout = await createSyntheticFilesystemLayout();
  const [corruptResultWorkspace, corruptResultArtifacts] = await createAdapters(corruptResultLayout);
  const corruptResultOperation = "operation:corrupt-result-publication";
  const corruptResult = await createWorkspace(corruptResultWorkspace, corruptResultOperation);
  const published = await corruptResultArtifacts.seal({
    operationId: corruptResultOperation,
    output: [],
    scope: TEST_SCOPE,
    workspaceRef: corruptResult.workspaceRef,
  });
  await writeFile(join(
    corruptResultLayout.artifactRoot,
    "results",
    `${basename(corruptResult.workspaceRef)}.json`,
  ), "{}", { mode: 0o600 });
  await assert.rejects(
    corruptResultArtifacts.verify(lookup(corruptResultOperation, published.resultRef)),
    /publication/u,
  );
  await Promise.all([missingSealLayout.cleanup(), corruptResultLayout.cleanup()]);
});

linuxDurableDirectoryTest("recovers durable seal and closure transitions after injected failures", async () => {
  const layout = await createSyntheticFilesystemLayout();
  const sealFaults = createDeterministicFaultInjector();
  sealFaults.arm("artifact.seal-record.metadata.published", new Error("injected seal interruption"));
  const [workspace, faultingArtifacts] = await createAdapters(layout, {
    artifact: { testFaults: sealFaults },
  });
  const operationId = "operation:durable-replay";
  const created = await createWorkspace(workspace, operationId);
  await writeFile(join(created.workspaceRef, "result"), "durable", { mode: 0o600 });
  const input = { operationId, output: [], scope: TEST_SCOPE, workspaceRef: created.workspaceRef };
  await assert.rejects(faultingArtifacts.seal(input), /injected seal interruption/u);
  await assertNoTemporaryResidue(layout.disposableRoot);

  const artifacts = await createNodeContainedTurnArtifacts({
    ...layout.artifactOptions,
    limits: SMALL_LIMITS,
  });
  const sealed = await artifacts.seal(input);
  assert.equal((await artifacts.verify(lookup(operationId, sealed.resultRef))).operationId, operationId);

  const closeFaults = createDeterministicFaultInjector();
  closeFaults.arm("workspace.receipt.metadata.published", new Error("injected closure interruption"));
  const faultingWorkspace = await createNodeContainedTurnWorkspace({
    ...layout.workspaceOptions,
    limits: SMALL_LIMITS,
    testFaults: closeFaults,
  });
  const closeInput = { operationId, scope: TEST_SCOPE, workspaceRef: created.workspaceRef };
  await assert.rejects(faultingWorkspace.close(closeInput), /injected closure interruption/u);
  await assertNoTemporaryResidue(layout.disposableRoot);
  const restartedWorkspace = await createNodeContainedTurnWorkspace({
    ...layout.workspaceOptions,
    limits: SMALL_LIMITS,
  });
  assert.match(
    (await restartedWorkspace.close(closeInput)).receiptRef,
    /^urn:agent-runtime:workspace-closed:/u,
  );
  await layout.cleanup();
});

linuxDurableDirectoryTest("recovers replay-safe workspace creation across subprocess kill boundaries", async () => {
  const points = [
    "workspace.create.directory-created",
    "workspace.creation.metadata.written",
    "workspace.creation.metadata.synced",
    "workspace.creation.metadata.before-publish",
    "workspace.creation.metadata.published",
    "workspace.creation.metadata.before-unlink",
    "workspace.creation.metadata.unlinked",
    "workspace.create.creation-recorded",
    "workspace.create.published",
  ] as const;
  for (const [index, faultPoint] of points.entries()) {
    const layout = await createSyntheticFilesystemLayout();
    await writeFile(join(layout.canonicalProjectRoot, "source.txt"), `source-${index}`, { mode: 0o640 });
    const operationId = `operation:create-crash:${index}`;
    await runKilledFilesystemWorker({
      action: "create",
      artifactOptions: { ...layout.artifactOptions, limits: SMALL_LIMITS },
      faultPoint,
      operationId,
      scope: TEST_SCOPE,
      workspaceOptions: { ...layout.workspaceOptions, limits: SMALL_LIMITS },
    });
    const workspace = await createNodeContainedTurnWorkspace({
      ...layout.workspaceOptions,
      limits: SMALL_LIMITS,
    });
    const recovered = await createWorkspace(workspace, operationId);
    assert.equal(await readFile(join(recovered.workspaceRef, "source.txt"), "utf8"), `source-${index}`);
    const capability = await workspace.verify({
      operationId, scope: TEST_SCOPE, workspaceRef: recovered.workspaceRef,
    });
    assert.equal(capability.kind, "workspace_launch_authority");
    await layout.cleanup();
  }
});

linuxDurableDirectoryTest("recovers CAS, seal, result and receipt publication across SIGKILL boundaries", async () => {
  const sealPoints = [
    "artifact.blob.cas.written",
    "artifact.blob.cas.synced",
    "artifact.blob.cas.before-publish",
    "artifact.blob.cas.published",
    "artifact.blob.cas.before-unlink",
    "artifact.blob.cas.unlinked",
    "artifact.blob.cas.staging-synced",
    "artifact.manifest.cas.published",
    "artifact.seal-record.metadata.published",
    "artifact.result-record.metadata.published",
  ] as const;
  for (const [index, faultPoint] of sealPoints.entries()) {
    const layout = await createSyntheticFilesystemLayout();
    const [workspace] = await createAdapters(layout);
    const operationId = `operation:seal-crash:${index}`;
    const created = await createWorkspace(workspace, operationId);
    await runKilledFilesystemWorker({
      action: "seal",
      artifactOptions: { ...layout.artifactOptions, limits: SMALL_LIMITS },
      faultPoint,
      operationId,
      scope: TEST_SCOPE,
      workspaceOptions: { ...layout.workspaceOptions, limits: SMALL_LIMITS },
      workspaceRef: created.workspaceRef,
    });
    const artifacts = await createNodeContainedTurnArtifacts({
      ...layout.artifactOptions,
      limits: SMALL_LIMITS,
    });
    const sealed = await artifacts.seal({
      operationId,
      output: [],
      scope: TEST_SCOPE,
      workspaceRef: created.workspaceRef,
    });
    assert.equal((await artifacts.verify(lookup(operationId, sealed.resultRef))).operationId, operationId);
    await layout.cleanup();
  }

  const receiptPoints = [
    "workspace.close.frozen-moved",
    "workspace.close.retained",
    "workspace.receipt.metadata.before-publish",
    "workspace.receipt.metadata.published",
    "workspace.receipt.metadata.before-unlink",
    "workspace.receipt.metadata.unlinked",
    "workspace.receipt.metadata.staging-synced",
  ] as const;
  for (const [index, faultPoint] of receiptPoints.entries()) {
    const layout = await createSyntheticFilesystemLayout();
    const [workspace, artifacts] = await createAdapters(layout);
    const operationId = `operation:receipt-crash:${index}`;
    const created = await createWorkspace(workspace, operationId);
    await artifacts.seal({ operationId, output: [], scope: TEST_SCOPE, workspaceRef: created.workspaceRef });
    await runKilledFilesystemWorker({
      action: "close",
      artifactOptions: { ...layout.artifactOptions, limits: SMALL_LIMITS },
      faultPoint,
      operationId,
      scope: TEST_SCOPE,
      workspaceOptions: { ...layout.workspaceOptions, limits: SMALL_LIMITS },
      workspaceRef: created.workspaceRef,
    });
    const restarted = await createNodeContainedTurnWorkspace({
      ...layout.workspaceOptions,
      limits: SMALL_LIMITS,
    });
    assert.match(
      (await restarted.close({ operationId, scope: TEST_SCOPE, workspaceRef: created.workspaceRef })).receiptRef,
      /^urn:agent-runtime:workspace-closed:/u,
    );
    await layout.cleanup();
  }
});

linuxDurableDirectoryTest("cleans partial immutable writes and partial reconstruction", async () => {
  const layout = await createSyntheticFilesystemLayout();
  const writeFaults = createDeterministicFaultInjector();
  writeFaults.arm("artifact.blob.cas.written", new Error("injected blob write failure"));
  const [workspace, artifacts] = await createAdapters(layout, {
    artifact: { testFaults: writeFaults },
  });
  const operationId = "operation:partial-write";
  const created = await createWorkspace(workspace, operationId);
  await writeFile(join(created.workspaceRef, "result"), "bytes", { mode: 0o600 });
  await assert.rejects(
    artifacts.seal({ operationId, output: [], scope: TEST_SCOPE, workspaceRef: created.workspaceRef }),
    /injected blob write failure/u,
  );
  await assertNoTemporaryResidue(layout.disposableRoot);

  const cleanArtifacts = await createNodeContainedTurnArtifacts({
    ...layout.artifactOptions,
    limits: SMALL_LIMITS,
  });
  const sealed = await cleanArtifacts.seal({ operationId, output: [], scope: TEST_SCOPE, workspaceRef: created.workspaceRef });
  const rehydrateFaults = createDeterministicFaultInjector();
  rehydrateFaults.arm("artifact.rehydrate.verified", new Error("injected rehydration failure"));
  const faultingRehydration = await createNodeContainedTurnArtifacts({
    ...layout.artifactOptions,
    limits: SMALL_LIMITS,
    testFaults: rehydrateFaults,
  });
  await assert.rejects(
    faultingRehydration.rehydrate(lookup(operationId, sealed.resultRef)),
    /injected rehydration failure/u,
  );
  await assertNoTemporaryResidue(layout.rehydrationRoot);
  await layout.cleanup();
});

linuxDurableDirectoryTest("refuses rehydration replacement and preserves unknown destination content", async () => {
  const layout = await createSyntheticFilesystemLayout();
  const [workspace, artifacts] = await createAdapters(layout);
  const operationId = "operation:rehydration-replacement";
  const created = await createWorkspace(workspace, operationId);
  await writeFile(join(created.workspaceRef, "result"), "verified", { mode: 0o600 });
  const sealed = await artifacts.seal({
    operationId, output: [], scope: TEST_SCOPE, workspaceRef: created.workspaceRef,
  });
  const digest = manifestDigest(sealed.resultRef);
  const resultPath = join(layout.rehydrationRoot, "results", digest);
  const displacedPath = join(layout.rehydrationRoot, "quarantine", `${digest}-displaced`);
  let replaced = false;
  const replacing = await createNodeContainedTurnArtifacts({
    ...layout.artifactOptions,
    limits: SMALL_LIMITS,
    testFaults: {
      async checkpoint(point) {
        if (point !== "artifact.rehydrate.publish.published" || replaced) {return;}
        replaced = true;
        await rename(resultPath, displacedPath);
        await mkdir(resultPath, { mode: 0o700 });
        await writeFile(join(resultPath, "unknown"), "third-party", { mode: 0o600 });
      },
    },
  });
  await assert.rejects(
    replacing.rehydrate(lookup(operationId, sealed.resultRef)),
    /rehydration and cleanup failed|identity changed|replaced result custody/u,
  );
  assert.equal(await readFile(join(resultPath, "unknown"), "utf8"), "third-party");
  await layout.cleanup();
});

linuxDurableDirectoryTest("rejects special modes and closure or quarantine replacement residue", async () => {
  const modeLayout = await createSyntheticFilesystemLayout();
  const [modeWorkspace, modeArtifacts] = await createAdapters(modeLayout);
  const modeOperation = "operation:special-mode";
  const modeCreated = await createWorkspace(modeWorkspace, modeOperation);
  const special = join(modeCreated.workspaceRef, "setuid");
  await writeFile(special, "mode", { mode: 0o600 });
  await chmod(special, 0o4755);
  await assert.rejects(
    modeArtifacts.seal({
      operationId: modeOperation, output: [], scope: TEST_SCOPE,
      workspaceRef: modeCreated.workspaceRef,
    }),
    /special permission bits/u,
  );

  const closeLayout = await createSyntheticFilesystemLayout();
  const [closeWorkspace, closeArtifacts] = await createAdapters(closeLayout);
  const closeOperation = "operation:closure-residue";
  const closeCreated = await createWorkspace(closeWorkspace, closeOperation);
  await closeArtifacts.seal({
    operationId: closeOperation, output: [], scope: TEST_SCOPE,
    workspaceRef: closeCreated.workspaceRef,
  });
  const closeInput = {
    operationId: closeOperation, scope: TEST_SCOPE, workspaceRef: closeCreated.workspaceRef,
  };
  await closeWorkspace.close(closeInput);
  await mkdir(join(closeLayout.workspaceRoot, "cleanup", basename(closeCreated.workspaceRef)), {
    mode: 0o700,
  });
  await assert.rejects(closeWorkspace.close(closeInput), /conflicts with retained custody/u);

  const quarantineLayout = await createSyntheticFilesystemLayout();
  const [quarantineWorkspace] = await createAdapters(quarantineLayout);
  const quarantineOperation = "operation:quarantine-replacement";
  const quarantineCreated = await createWorkspace(quarantineWorkspace, quarantineOperation);
  const quarantineInput = {
    evidenceRef: "evidence:replacement", operationId: quarantineOperation,
    scope: TEST_SCOPE, workspaceRef: quarantineCreated.workspaceRef,
  };
  await quarantineWorkspace.quarantine(quarantineInput);
  const quarantineName = `${basename(quarantineCreated.workspaceRef)}-${
    createHash("sha256").update(quarantineInput.evidenceRef).digest("hex")}`;
  await rename(
    join(quarantineLayout.workspaceRoot, "quarantine", quarantineName),
    join(quarantineLayout.workspaceRoot, "quarantine", `${quarantineName}-displaced`),
  );
  await mkdir(join(quarantineLayout.workspaceRoot, "quarantine", quarantineName), { mode: 0o700 });
  await assert.rejects(
    quarantineWorkspace.quarantine(quarantineInput),
    /ambiguous|identity was replaced/u,
  );
  await Promise.all([modeLayout.cleanup(), closeLayout.cleanup(), quarantineLayout.cleanup()]);
});

linuxDurableDirectoryTest("quarantine and cleanup report exact custody outcomes", async () => {
  const layout = await createSyntheticFilesystemLayout();
  const [workspace] = await createAdapters(layout);
  const created = await createWorkspace(workspace, "operation:quarantine");
  await workspace.quarantine({ evidenceRef: "evidence:one", operationId: "operation:quarantine", scope: TEST_SCOPE, workspaceRef: created.workspaceRef });
  await workspace.quarantine({ evidenceRef: "evidence:one", operationId: "operation:quarantine", scope: TEST_SCOPE, workspaceRef: created.workspaceRef });
  await assert.rejects(
    workspace.quarantine({ evidenceRef: "evidence:two", operationId: "operation:quarantine", scope: TEST_SCOPE, workspaceRef: created.workspaceRef }),
    /ambiguous/u,
  );
  assert.deepEqual(
    await listRelativeResidue(join(layout.workspaceRoot, "quarantine")),
    [`${basename(created.workspaceRef)}-${createHash("sha256").update("evidence:one").digest("hex")}`],
  );

  await chmod(layout.workspaceRoot, 0o755);
  await assert.rejects(
    workspace.create({ operationId: "operation:permission-drift", scope: TEST_SCOPE }),
    /not private and owned/u,
  );
  await chmod(layout.workspaceRoot, 0o700);
  await layout.cleanup();
});

linuxDurableDirectoryTest("current kernel closure proofs survive adapter restart without path evidence", async () => {
  const layout = await createSyntheticFilesystemLayout();
  const operationId = containedTurnIdentity("operation", "operation:kernel-filesystem-restart");
  const workspace = await createNodeContainedTurnWorkspace({
    ...layout.workspaceOptions, limits: SMALL_LIMITS,
  });
  const artifacts = await createNodeContainedTurnArtifacts({
    ...layout.artifactOptions, limits: SMALL_LIMITS,
  });
  const created = await workspace.create({ operationId, scope: TEST_SCOPE });
  assert.match(created.workspaceId, /^workspace:operation-[a-f\d]{64}$/u);
  assert.equal(created.workspaceId.includes("/"), false);
  await writeFile(join(created.workspaceRef, "kernel-result.txt"), "restart-safe", { mode: 0o600 });

  const artifactRequest = Object.freeze({
    authorityVectorDigest: digestContainedTurnCanonicalValue({ authority: "kernel-restart" }),
    operationId,
    output: Object.freeze([{ cursor: 0, kind: "assistant" as const, text: "current kernel" }]),
    requestDigest: digestContainedTurnCanonicalValue({ closure: "artifact", operationId }),
    requestId: containedTurnIdentity("closure_request", "closure-request:kernel-artifact-restart"),
    workspaceId: created.workspaceId,
  });
  const sealed = await artifacts.ensureSealed(artifactRequest);
  assert.equal(sealed.kind, "proved");
  if (sealed.kind !== "proved") {throw new Error("artifact closure was not proved");}
  assert.equal(JSON.stringify(sealed).includes(layout.campaignRoot), false);
  const restartedArtifacts = await createNodeContainedTurnArtifacts({
    ...layout.artifactOptions, limits: SMALL_LIMITS,
  });
  assert.deepEqual(await restartedArtifacts.querySeal(artifactRequest), sealed);

  const workspaceRequest = Object.freeze({
    authorityVectorDigest: artifactRequest.authorityVectorDigest,
    operationId,
    requestDigest: digestContainedTurnCanonicalValue({ closure: "workspace", operationId }),
    requestId: containedTurnIdentity("closure_request", "closure-request:kernel-workspace-restart"),
    workspaceId: created.workspaceId,
  });
  const closed = await workspace.ensureClosed(workspaceRequest);
  assert.equal(closed.kind, "proved");
  if (closed.kind !== "proved") {throw new Error("workspace closure was not proved");}
  assert.equal(JSON.stringify(closed).includes(layout.campaignRoot), false);
  const restartedWorkspace = await createNodeContainedTurnWorkspace({
    ...layout.workspaceOptions, limits: SMALL_LIMITS,
  });
  assert.deepEqual(await restartedWorkspace.queryClosure(workspaceRequest), closed);
  await layout.cleanup();
});

linuxDurableDirectoryTest("current seven-port composition closes through durable filesystem adapters", async () => {
  const layout = await createSyntheticFilesystemLayout();
  const workspace = await createNodeContainedTurnWorkspace({
    ...layout.workspaceOptions, limits: SMALL_LIMITS,
  });
  const artifacts = await createNodeContainedTurnArtifacts({
    ...layout.artifactOptions, limits: SMALL_LIMITS,
  });
  const fixture = createDependencies();
  const feature = createContainedTurnFeature(Object.freeze({
    ...fixture.dependencies,
    artifacts,
    workspace,
  }));
  const result = await feature.submit.execute({
    commandId: "command:one",
    expectedProvider: "codex",
    intent: { mode: "analysis", prompt: "exercise durable filesystem composition" },
    scope: { projectId: "project:one", tenantId: "tenant:one" },
  });
  assert.equal(result.status, "observed");
  if (result.status !== "observed") {throw new Error("current kernel composition was not observed");}
  assert.equal(result.turn.status, "succeeded", JSON.stringify(fixture.current(), undefined, 2));
  const operation = fixture.current();
  assert.ok(operation?.workspaceId);
  assert.match(operation.workspaceId, /^workspace:operation-[a-f\d]{64}$/u);
  assert.equal(JSON.stringify(operation).includes(layout.campaignRoot), false);
  assert.match(result.turn.artifactManifestRef ?? "", /^urn:agent-runtime:artifact-manifest:[a-f\d]{64}$/u);
  assert.match(result.turn.resultRef ?? "", /^urn:agent-runtime:contained-turn-result:[a-f\d]{64}$/u);
  await layout.cleanup();
});
