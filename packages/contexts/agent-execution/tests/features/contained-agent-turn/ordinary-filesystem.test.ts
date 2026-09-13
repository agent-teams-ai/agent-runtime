import fsPromises from "node:fs/promises";
import {syncBuiltinESMExports} from "node:module";
import {createHash} from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import {mkdtemp, mkdir, writeFile, readFile, readdir, realpath, symlink, link, chmod, rm, stat} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createNodeOrdinaryWorkspace, OrdinaryWorkspacePreparationRetained} from "../../../dist/features/contained-agent-turn/adapters/outbound/ordinary-filesystem/node-ordinary-workspace.js";
import {createNodeOrdinaryArtifacts, readNodeOrdinaryArtifact} from "../../../dist/features/contained-agent-turn/adapters/outbound/ordinary-filesystem/node-ordinary-artifacts.js";
import {ORDINARY_PROFILE, type OrdinaryOperation} from "../../../dist/features/contained-agent-turn/domain/ordinary-model.js";

const operation: OrdinaryOperation = {...ORDINARY_PROFILE, schemaVersion: 3, operationId: "test-op", attemptId: "test-attempt", effectId: "test-effect", commandId: "test-command", fingerprint: "a".repeat(64), scope: {tenantId: "test", projectId: "TEST"}, input: {commandId: "test-command", expectedProvider: "codex", scope: {tenantId: "test", projectId: "TEST"}, intent: {mode: "workspace-write", prompt: "Write any generic answer in result.txt"}}, preparation: null, revision: 0, status: "running", cancellationRequested: false, output: [], receipts: []};
async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(await realpath(tmpdir()), "ordinary-filesystem-TEST-"));
  t.after(async () => {await chmod(join(root, "artifacts"), 0o700); await rm(root, {recursive: true, force: true});});
  const sourceDirectory = join(root, "source"), workspaceRoot = join(root, "workspaces"), artifactRoot = join(root, "artifacts");
  for (const dir of [sourceDirectory, workspaceRoot, artifactRoot]) {await mkdir(dir, {mode: 0o700});}
  await writeFile(join(sourceDirectory, "input.txt"), "source retained");
  const options = {sourceDirectory, workspaceRoot, artifactRoot, sourceRevision: "synthetic-TEST-source-v1"};
  return {options, workspace: createNodeOrdinaryWorkspace(options), artifacts: createNodeOrdinaryArtifacts(options)};
}
test("ordinary generic result survives workspace cleanup and fresh artifact reader", async t => {
  const {options, workspace, artifacts} = await fixture(t);
  const handle = await workspace.prepare(operation, new AbortController().signal);
  assert.equal(await readFile(join(handle.cwd, "TASK.md"), "utf8"), operation.input.intent.prompt);
  assert.equal(await readFile(join(handle.cwd, "input.txt"), "utf8"), "source retained");
  await writeFile(join(handle.cwd, "result.txt"), "arbitrary result\n");
  const snapshot = await workspace.snapshot(operation, handle);
  const receipt = await artifacts.publish(operation, snapshot);
  await workspace.close(handle);
  assert.equal(Buffer.from(await readNodeOrdinaryArtifact(options, receipt)).toString(), "arbitrary result\n");
  assert.equal((await stat(join(options.artifactRoot, receipt.artifactDigest))).mode & 0o777, 0o500);
  assert.equal((await stat(receipt.resultRef)).mode & 0o777, 0o400);
  assert.equal((await stat(receipt.artifactManifestRef)).mode & 0o777, 0o400);
  assert.equal((await artifacts.publish(operation, snapshot)).artifactDigest, receipt.artifactDigest);
  assert.deepEqual(await readdir(options.artifactRoot), [receipt.artifactDigest]);
  await chmod(receipt.resultRef, 0o600); await writeFile(receipt.resultRef, "corrupt");
  await assert.rejects(readNodeOrdinaryArtifact(options, receipt), /corrupt/);
  await assert.rejects(artifacts.publish(operation, snapshot), /corrupt/);
  assert.deepEqual(await readdir(options.artifactRoot), [receipt.artifactDigest]);
  assert.equal(await readFile(receipt.resultRef, "utf8"), "corrupt");
  await chmod(join(options.artifactRoot, receipt.artifactDigest), 0o700);
});
for (const kind of ["symlink", "hardlink", "source-mutation"] as const) {test(`ordinary rejects ${kind} and retains recovery workspace`, async t => {
  const {options, workspace} = await fixture(t);
  const handle = await workspace.prepare(operation, new AbortController().signal);
  if (kind === "symlink") {await symlink(join(options.sourceDirectory, "input.txt"), join(handle.cwd, "result.txt"));}
  else if (kind === "hardlink") {await link(join(options.sourceDirectory, "input.txt"), join(handle.cwd, "result.txt"));}
  else {await writeFile(join(handle.cwd, "result.txt"), "result"); await writeFile(join(options.sourceDirectory, "input.txt"), "mutated");}
  await assert.rejects(workspace.snapshot(operation, handle));
  await assert.rejects(workspace.close(handle), /retained/);
  assert.equal(await readFile(join(handle.cwd, "TASK.md"), "utf8"), operation.input.intent.prompt);
});}
test("ordinary rejects source link and noncanonical path before preparation", async t => {
  const {options, workspace} = await fixture(t);
  await symlink(join(options.sourceDirectory, "input.txt"), join(options.sourceDirectory, "linked"));
  await assert.rejects(workspace.prepare(operation, new AbortController().signal), /link/);
  await assert.rejects(createNodeOrdinaryWorkspace({...options, sourceDirectory: `${options.sourceDirectory}/../source`}).prepare(operation, new AbortController().signal), /canonical/);
});
test("ordinary refuses altered snapshot, wrong binding and unavailable storage", async t => {
  const {options, workspace, artifacts} = await fixture(t);
  const handle = await workspace.prepare(operation, new AbortController().signal);
  await writeFile(join(handle.cwd, "result.txt"), "result");
  const snapshot = await workspace.snapshot(operation, handle);
  await assert.rejects(artifacts.publish({...operation, attemptId: "wrong"}, snapshot), /binding/);
  await assert.rejects(artifacts.publish(operation, {...snapshot, resultBytes: new Uint8Array([1])}), /corrupt/);
  await assert.rejects(createNodeOrdinaryArtifacts({...options, artifactRoot: join(options.artifactRoot, "absent")}).publish(operation, snapshot));
  await workspace.close(handle);
});

for (const mutation of ["wrong-effect", "missing-effect", "extra-field"] as const) {test(`ordinary fresh reader rejects content-addressed manifest ${mutation}`, async t => {
  const {options, workspace, artifacts} = await fixture(t);
  const handle = await workspace.prepare(operation, new AbortController().signal);
  await writeFile(join(handle.cwd, "result.txt"), "generic-result");
  const receipt = await artifacts.publish(operation, await workspace.snapshot(operation, handle));
  const manifest = JSON.parse(await readFile(receipt.artifactManifestRef, "utf8"));
  assert.equal(manifest.effectClass, "ordinary_user_session_effect");
  if (mutation === "wrong-effect") {manifest.effectClass = "contained_unmediated_effect";}
  else if (mutation === "missing-effect") {delete manifest.effectClass;}
  else {manifest.unexpected = true;}
  const manifestBytes = JSON.stringify(manifest);
  const artifactDigest = createHash("sha256").update(manifestBytes).digest("hex");
  const target = join(options.artifactRoot, artifactDigest);
  await mkdir(target, {mode: 0o700});
  const artifactManifestRef = join(target, "manifest.json"), resultRef = join(target, "result.txt");
  await writeFile(artifactManifestRef, manifestBytes); await writeFile(resultRef, await readFile(receipt.resultRef));
  await workspace.close(handle);
  await assert.rejects(readNodeOrdinaryArtifact(options, {...receipt, artifactDigest, artifactManifestRef, resultRef}), /corrupt_or_binding/);
  await chmod(join(options.artifactRoot, receipt.artifactDigest), 0o700);
});}

test("ordinary preserves source TASK.md bytes and rejects directory collision before allocation", async t => {
  const {options, workspace} = await fixture(t);
  const sourceTask = join(options.sourceDirectory, "TASK.md");
  const bytes = Buffer.from("Read these source instructions; produce a unique arbitrary answer.\n");
  await writeFile(sourceTask, bytes);
  const handle = await workspace.prepare(operation, new AbortController().signal);
  assert.deepEqual(await readFile(join(handle.cwd, "TASK.md")), bytes);
  assert.deepEqual(await readFile(sourceTask), bytes);
  await workspace.close(handle);
  await rm(sourceTask); await mkdir(sourceTask, {mode: 0o700});
  await assert.rejects(workspace.prepare(operation, new AbortController().signal), /task_path_is_directory/);
  assert.deepEqual(await readdir(options.workspaceRoot), []);
});

test("ordinary allocated workspace is retained and identified when preparation evidence fails", async t => {
  const {options} = await fixture(t);
  const observations: string[] = [];
  const workspace = createNodeOrdinaryWorkspace({...options, record(observation) {observations.push(observation.kind); if (observation.kind === "workspace_allocated") {throw new Error("TEST evidence storage failure");}}});
  await assert.rejects(workspace.prepare(operation, new AbortController().signal), error => {
    assert.ok(error instanceof OrdinaryWorkspacePreparationRetained);
    assert.ok(error.retainedRoot.startsWith(`${options.workspaceRoot}/ordinary-`));
    assert.match(error.workspaceId, /^[a-f0-9]{64}$/);
    return true;
  });
  assert.equal((await readdir(options.workspaceRoot)).length, 1);
  assert.deepEqual(observations, ["workspace_allocated", "workspace_retained"]);
});

test("ordinary workspace journal is bound, synchronous and closes only after absence", async t => {
  const {options} = await fixture(t);
  const observations: string[] = [];
  const workspace = createNodeOrdinaryWorkspace({...options, record(observation) {
    assert.equal(observation.operationId, operation.operationId); assert.equal(observation.attemptId, operation.attemptId);
    assert.match(observation.workspaceId, /^[a-f0-9]{64}$/); assert.match(observation.rootIdentity ?? "", /^\d+:\d+$/);
    observations.push(observation.kind);
  }});
  const handle = await workspace.prepare(operation, new AbortController().signal);
  await workspace.close(handle);
  assert.deepEqual(await readdir(options.workspaceRoot), []);
  assert.deepEqual(observations, ["workspace_allocated", "workspace_prepared", "workspace_closed"]);
  const asyncSink = createNodeOrdinaryWorkspace({...options, record: async () => {}});
  await assert.rejects(asyncSink.prepare(operation, new AbortController().signal), OrdinaryWorkspacePreparationRetained);
  assert.equal((await readdir(options.workspaceRoot)).length, 1);
});

test("failed manifest write removes only the unpublished staging directory", async t => {
  const {options, workspace, artifacts} = await fixture(t);
  const handle = await workspace.prepare(operation, new AbortController().signal);
  await writeFile(join(handle.cwd, "result.txt"), "result");
  const snapshot = await workspace.snapshot(operation, handle);
  const original = fsPromises.open;
  const mocked = t.mock.method(fsPromises, "open", (...args: Parameters<typeof original>) => {
    if (String(args[0]).includes(".staging-") && String(args[0]).endsWith("manifest.json")) {return Promise.reject(new Error("synthetic disk write failure"));}
    return original(...args);
  });
  syncBuiltinESMExports();
  try {await assert.rejects(artifacts.publish(operation, snapshot), /synthetic disk write failure/);}
  finally {mocked.mock.restore(); syncBuiltinESMExports();}
  assert.deepEqual(await readdir(options.artifactRoot), []);
  await workspace.close(handle);
});

test("publication and staging removal failure retain an operation-bound observation", async t => {
  const {options, workspace} = await fixture(t);
  const handle = await workspace.prepare(operation, new AbortController().signal);
  await writeFile(join(handle.cwd, "result.txt"), "result");
  const snapshot = await workspace.snapshot(operation, handle);
  const observations: import("../../../dist/features/contained-agent-turn/adapters/outbound/ordinary-filesystem/node-ordinary-artifacts.js").OrdinaryArtifactObservation[] = [];
  const artifacts = createNodeOrdinaryArtifacts({...options, record: event => {observations.push(event);}});
  const originalOpen = fsPromises.open, originalRm = fsPromises.rm;
  const mockedOpen = t.mock.method(fsPromises, "open", (...args: Parameters<typeof originalOpen>) => {
    if (String(args[0]).includes(".staging-") && String(args[0]).endsWith("manifest.json")) {return Promise.reject(new Error("synthetic write failure"));}
    return originalOpen(...args);
  });
  const mockedRm = t.mock.method(fsPromises, "rm", (...args: Parameters<typeof originalRm>) => {
    if (String(args[0]).includes(".staging-")) {return Promise.reject(new Error("synthetic removal failure"));}
    return originalRm(...args);
  });
  syncBuiltinESMExports();
  try {await assert.rejects(artifacts.publish(operation, snapshot), /ordinary_artifact_staging_retained/);}
  finally {mockedOpen.mock.restore(); mockedRm.mock.restore(); syncBuiltinESMExports();}
  assert.deepEqual(observations.map(event => event.kind), ["artifact_staging_allocated", "artifact_staging_retained"]);
  assert.ok(observations.every(event => event.operationId === operation.operationId && event.attemptId === operation.attemptId && event.stagingRoot === observations[0]!.stagingRoot));
  assert.equal((await readdir(options.artifactRoot)).length, 1);
  await workspace.close(handle);
});
