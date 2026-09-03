import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, test, type TestContext } from "node:test";

import {
  createNodeContainedTurnArtifacts,
  createNodeContainedTurnWorkspace,
} from "../../../dist/composition.js";
import { createContainedTurnFeature } from "../../../dist/features/contained-agent-turn/composition/feature-module-factory.js";
import { digestContainedTurnCanonicalValue } from "../../../dist/features/contained-agent-turn/domain/contained-turn-codecs.js";
import { containedTurnIdentity } from "../../../dist/features/contained-agent-turn/domain/contained-turn-identities.js";
import { createDependencies } from "../../features/contained-agent-turn/support/contained-agent-turn-fixture.ts";
import {
  cleanupTrackedFilesystemLayouts,
  createSyntheticFilesystemLayout,
} from "../../filesystem-contained-turn/fixture.ts";

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
