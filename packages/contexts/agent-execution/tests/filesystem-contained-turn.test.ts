import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile, link } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, test } from "node:test";

import {
  createNodeContainedTurnArtifacts,
  createNodeContainedTurnWorkspace,
} from "../dist/composition.js";

const disposableRoots: string[] = [];

const disposableRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "agent-runtime-contained-turn-"));
  disposableRoots.push(root);
  return root;
};

afterEach(async () => {
  await Promise.all(disposableRoots.splice(0).map(root => rm(root, { force: true, recursive: true })));
});

test("workspace and artifact adapters produce repeatable content-addressed closure", async () => {
  const root = await disposableRoot();
  const workspace = await createNodeContainedTurnWorkspace({ root: join(root, "workspaces") });
  const artifacts = await createNodeContainedTurnArtifacts({ root: join(root, "artifacts") });
  const created = await workspace.create({
    operationId: "operation:filesystem",
    scope: { projectId: "project:test", tenantId: "tenant:test" },
  });
  await mkdir(join(created.workspaceRef, "nested"));
  await writeFile(join(created.workspaceRef, "nested", "result.txt"), "deterministic result", { mode: 0o600 });
  const input = {
    operationId: "operation:filesystem",
    output: [{ cursor: 0, kind: "assistant" as const, text: "provider result" }],
    workspaceRef: created.workspaceRef,
  };
  const firstSeal = await artifacts.seal(input);
  const secondSeal = await artifacts.seal(input);
  assert.deepEqual(secondSeal, firstSeal);
  const manifestDigest = firstSeal.manifestRef.split(":").at(-1);
  assert.ok(manifestDigest);
  const manifest = JSON.parse(await readFile(
    join(root, "artifacts", "manifests", manifestDigest.slice(0, 2), manifestDigest),
    "utf8",
  )) as { files: readonly { path: string }[]; treeDigest: string };
  assert.deepEqual(manifest.files.map(file => file.path), ["nested/result.txt"]);
  assert.match(manifest.treeDigest, /^[a-f\d]{64}$/u);
  const firstClosure = await workspace.close(created.workspaceRef);
  const repeatedClosure = await workspace.close(created.workspaceRef);
  assert.deepEqual(repeatedClosure, firstClosure);
  await assert.rejects(
    workspace.create({ operationId: "operation:filesystem", scope: { projectId: "project:test", tenantId: "tenant:test" } }),
    /already closed/u,
  );
});

test("workspace scanning rejects symlinks and hard links without reading their targets", async () => {
  const root = await disposableRoot();
  const workspace = await createNodeContainedTurnWorkspace({ root: join(root, "workspaces") });
  const artifacts = await createNodeContainedTurnArtifacts({ root: join(root, "artifacts") });
  const outside = join(root, "outside-secret");
  await writeFile(outside, "must not be captured", { mode: 0o600 });
  const symbolic = await workspace.create({
    operationId: "operation:symlink",
    scope: { projectId: "project:test", tenantId: "tenant:test" },
  });
  await symlink(outside, join(symbolic.workspaceRef, "escape"));
  await assert.rejects(
    artifacts.seal({ operationId: "operation:symlink", output: [], workspaceRef: symbolic.workspaceRef }),
    /symbolic link/u,
  );

  const hardLinked = await workspace.create({
    operationId: "operation:hardlink",
    scope: { projectId: "project:test", tenantId: "tenant:test" },
  });
  await link(outside, join(hardLinked.workspaceRef, "linked"));
  await assert.rejects(
    artifacts.seal({ operationId: "operation:hardlink", output: [], workspaceRef: hardLinked.workspaceRef }),
    /hard-linked/u,
  );
});

test("quarantine is idempotent for one evidence identity and rejects a conflicting outcome", async () => {
  const root = await disposableRoot();
  const workspaceRoot = join(root, "workspaces");
  const workspace = await createNodeContainedTurnWorkspace({ root: workspaceRoot });
  const created = await workspace.create({
    operationId: "operation:quarantine",
    scope: { projectId: "project:test", tenantId: "tenant:test" },
  });
  await workspace.quarantine({ evidenceRef: "evidence:one", workspaceRef: created.workspaceRef });
  await workspace.quarantine({ evidenceRef: "evidence:one", workspaceRef: created.workspaceRef });
  await assert.rejects(
    workspace.quarantine({ evidenceRef: "evidence:two", workspaceRef: created.workspaceRef }),
    /ambiguous/u,
  );
  const quarantineRoot = join(dirname(dirname(created.workspaceRef)), "quarantine");
  assert.equal(basename(quarantineRoot), "quarantine");
});

test("artifact storage detects an existing blob whose bytes no longer match its digest", async () => {
  const root = await disposableRoot();
  const workspace = await createNodeContainedTurnWorkspace({ root: join(root, "workspaces") });
  const artifactRoot = join(root, "artifacts");
  const artifacts = await createNodeContainedTurnArtifacts({ root: artifactRoot });
  const created = await workspace.create({
    operationId: "operation:tamper",
    scope: { projectId: "project:test", tenantId: "tenant:test" },
  });
  const bytes = "artifact bytes";
  await writeFile(join(created.workspaceRef, "artifact.txt"), bytes, { mode: 0o600 });
  await artifacts.seal({ operationId: "operation:tamper", output: [], workspaceRef: created.workspaceRef });
  const digest = (await import("node:crypto")).createHash("sha256").update(bytes).digest("hex");
  await writeFile(join(artifactRoot, "blobs", digest.slice(0, 2), digest), "tampered", { mode: 0o600 });
  await assert.rejects(
    artifacts.seal({ operationId: "operation:tamper", output: [], workspaceRef: created.workspaceRef }),
    /artifact mismatch/u,
  );
});
