import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {mkdtemp, mkdir, open, readFile, realpath, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {verifySuccessfulPublicResult} from "./full-public-runtime.mjs";
import {createDarwinLiveVerification} from "./darwin-live-verification.mjs";

const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const manifestRef = `urn:agent-runtime:artifact-manifest:${"a".repeat(64)}`;

function fixture() {
  const turn = {operationId: "op", attemptId: "attempt", executionGenerationId: "generation", effectId: "effect",
    scope: {tenantId: "tenant", projectId: "project"}};
  const binding = {operationId: "op", authorityVectorDigest: "authority"};
  const operation = {...turn, revision: 7, acceptedAuthorityVectorDigest: "authority",
    dispatch: {kind: "claimed", attemptId: "attempt", executionGenerationId: "generation"},
    artifactManifestRef: manifestRef, resultRef: "result", requiredReceiptSetDigest: "required",
    terminal: {kind: "final", outcome: "succeeded", terminalProofId: "terminal", satisfactionDigest: "satisfaction"},
    reconciliation: {kind: "clear"},
    output: {chunks: [{cursor: 0, kind: "assistant", text: "ok"}], fence: {kind: "fenced", finalCursor: 0}},
    proofs: [
      {kind: "result_publication", proofId: "publication", binding: {...binding, resultRef: "result"}},
      {kind: "output_drain", proofId: "drain", binding: {...binding, attemptId: "attempt", effectId: "effect", finalCursor: 0}},
      {kind: "terminal_truth", proofId: "terminal", binding: {...binding, terminalOutcome: "succeeded",
        satisfactionDigest: "satisfaction", requiredReceiptSetDigest: "required"}},
    ]};
  const manifest = {schemaVersion: 3, operationId: "op", tenantId: "tenant", projectId: "project",
    entries: [{kind: "file", path: "result.txt"}], output: [{cursor: 0, kind: "assistant", size: 2,
      digest: createHash("sha256").update("ok").digest("hex")}]};
  const calls = [];
  const input = {activation: {turn}, operationStore: {async read(lookup) {calls.push(lookup); return operation;}},
    getArtifacts: () => ({async verify(lookup) {calls.push(lookup); return manifest;},
      async rehydrate(lookup) {calls.push(lookup); return "/test/rehydrated/digest";}})};
  return {input, operation, manifest, calls};
}

test("projects authentic proofs but never invents the missing workspace receipts", async () => {
  const {input, calls} = fixture();
  const actual = await createDarwinLiveVerification(input).verification.verifyArtifactManifest(manifestRef, "result");
  assert.equal(actual.status, "incomplete");
  assert.deepEqual(actual.gaps.map(item => item.kind), ["workspace-receipts"]);
  assert.deepEqual(actual.receipts.map(item => item.kind), ["result-publication", "output-drain", "terminal-truth"]);
  assert.ok(actual.receipts.every(item => item.operationId === "op" && item.attemptId === "attempt" &&
    item.executionGenerationId === "generation" && item.provenance.revision === 7));
  assert.deepEqual(calls, [{operationId: "op", scope: input.activation.turn.scope},
    {operationId: "op", scope: input.activation.turn.scope, resultRef: "result"}]);
});

test("rejects wrong generation, scope, references and proof authority", async () => {
  const changes = [value => {value.operation.dispatch.executionGenerationId = "other";},
    value => {value.operation.scope = {tenantId: "other", projectId: "project"};},
    value => {value.operation.resultRef = "other";},
    value => {value.operation.proofs[0].binding.authorityVectorDigest = "other";},
    value => {value.operation.proofs.push(value.operation.proofs[0]);}];
  for (const change of changes) {
    const value = fixture(); change(value);
    await assert.rejects(createDarwinLiveVerification(value.input).verification.verifyArtifactManifest(manifestRef, "result"),
      /DARWIN_LIVE_VERIFICATION_REFUSED/u);
  }
});

test("rejects artifact output that differs from the retained operation", async () => {
  const {input, manifest} = fixture(); manifest.output[0].digest = "wrong";
  await assert.rejects(createDarwinLiveVerification(input).verification.verifyArtifactManifest(manifestRef, "result"),
    /artifact output differs/u);
});

test("rehydration returns the genuine digest-addressed owner path, refusing a different path", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ar69-test-rehydrate-")));
  try {
    const value = fixture(), actual = join(root, "results", "a".repeat(64));
    await mkdir(actual, {recursive: true});
    value.input.activation.infrastructure = {filesystem: {rehydrationRoot: root}};
    const artifacts = value.input.getArtifacts();
    value.input.getArtifacts = () => ({...artifacts, rehydrate: async () => actual});
    const {verification} = createDarwinLiveVerification(value.input);
    await assert.rejects(verification.rehydrateArtifact(manifestRef), /verified lookup/u);
    await verification.verifyArtifactManifest(manifestRef, "result");
    assert.equal(await verification.rehydrateArtifact(manifestRef, "/unused/frozen-workspace"), actual);
    value.input.getArtifacts = () => artifacts;
    await assert.rejects(verification.rehydrateArtifact(manifestRef), /path differs/u);
  } finally {await rm(root, {recursive: true, force: true});}
});

test("missing cleanup reads stay incomplete even after apparent disposal success", async () => {
  const {input} = fixture();
  input.readCleanup = async () => ({pool: {closed: true}, status: "released"});
  input.outputOwner = {readback: async () => ({bytes: 12, digest: "actual-digest"})};
  const {cleanup} = createDarwinLiveVerification(input);
  cleanup.recordFailure(new Error("close failed"));
  const actual = await cleanup.readback();
  assert.equal(actual.status, "incomplete"); assert.equal(actual.pool.closed, true);
  assert.equal(actual.native, undefined); assert.equal(actual.processes, undefined);
  assert.deepEqual(actual.output, {bytes: 12, digest: "actual-digest"});
  assert.equal(actual.failures.length, 1);
  assert.ok(actual.gaps.some(item => item.kind === "native-closure"));
  assert.ok(actual.gaps.some(item => item.kind === "http-closure"));
});

test("retains sanitized owner reconciliation state with exact replay and conflicting revision refusal", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ar69-test-verification-"));
  try {
    const {input, operation} = fixture(); input.activation.evidenceDirectory = directory;
    operation.intent = {prompt: "do not retain private prompt"};
    const {reconciliation} = createDarwinLiveVerification(input);
    const result = {accepted: {operationId: "op"}};
    const first = await reconciliation.retain(result);
    assert.deepEqual(await reconciliation.retain(result), first);
    const retained = JSON.parse(await readFile(first.path, "utf8"));
    assert.equal(retained.revision, 7); assert.equal(retained.intent, undefined);
    assert.equal(retained.dispatch.executionGenerationId, "generation");
    operation.revision += 1;
    await assert.rejects(reconciliation.retain(result), /EEXIST/u);
  } finally {await rm(directory, {recursive: true, force: true});}
});

test("source inventory requires a concrete reader", async () => {
  const {input} = fixture();
  await assert.rejects(createDarwinLiveVerification(input).verification.verifySourceInventory(), /source manifest path/u);

});


test("replay fsyncs an existing snapshot after the original file fsync failed, before syncing its parent", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ar69-test-verification-fsync-"));
  try {
    const {input} = fixture(); input.activation.evidenceDirectory = directory;
    const events = []; let fail = true;
    const openFile = async (path, flags, mode) => {
      const file = await open(path, flags, mode);
      return {writeFile: (...args) => file.writeFile(...args), readFile: (...args) => file.readFile(...args),
        stat: () => file.stat(), close: () => file.close(), async sync() {
          const kind = path === directory ? "directory" : "file";
          events.push(kind);
          if (kind === "file" && fail) {fail = false; throw new Error("injected file fsync failure");}
          return file.sync();
        }};
    };
    const {reconciliation} = createDarwinLiveVerification(input, {openFile});
    const result = {accepted: {operationId: "op"}};
    await assert.rejects(reconciliation.retain(result), /injected file fsync failure/u);
    assert.equal(JSON.parse(await readFile(join(directory, "reconciliation-owner-snapshot.json"), "utf8")).revision, 7);
    assert.deepEqual(events, ["file"]);
    assert.equal((await reconciliation.retain(result)).status, "retained");
    assert.deepEqual(events, ["file", "file", "directory"]);
  } finally {await rm(directory, {recursive: true, force: true});}
});

test("concurrent exact replays each synchronize their opened snapshot before acknowledging retention", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ar69-test-verification-replay-"));
  try {
    const {input} = fixture(); input.activation.evidenceDirectory = directory;
    const result = {accepted: {operationId: "op"}};
    const original = await createDarwinLiveVerification(input).reconciliation.retain(result);
    let syncedFiles = 0;
    const openFile = async (path, flags, mode) => {
      const file = await open(path, flags, mode);
      return {readFile: (...args) => file.readFile(...args), stat: () => file.stat(), close: () => file.close(),
        async sync() {await file.sync(); if (path !== directory) {syncedFiles += 1;}}};
    };
    const replays = await Promise.all(Array.from({length: 4}, () =>
      createDarwinLiveVerification(input, {openFile}).reconciliation.retain(result)));
    assert.equal(syncedFiles, 4);
    for (const replay of replays) {assert.deepEqual(replay, original);}
  } finally {await rm(directory, {recursive: true, force: true});}
});


function nativeFixture() {
  const value = fixture(), {input, operation, manifest} = value;
  operation.workspaceId = "workspace:operation-workspace"; operation.custodyId = "custody";
  manifest.treeDigest = "tree";
  const common = {operationId: "op", workspaceName: "operation-workspace", scope: operation.scope};
  const creation = {...common, materializationDigest: "materialization", rootIdentity: {dev: "1", ino: "2"}};
  const seal = {...common, rootIdentity: creation.rootIdentity, manifestDigest: "a".repeat(64), treeDigest: "tree"};
  const publication = {...common, manifestDigest: seal.manifestDigest, treeDigest: "tree", resultRef: "result"};
  input.getWorkspaceOwner = () => "issued-test-owner";
  input.agentExecution = {async readNodeContainedTurnNativeWorkspaceReceipts(owner, lookup) {
    assert.equal(owner, "issued-test-owner"); assert.deepEqual(lookup, {operationId: "op", workspaceId: operation.workspaceId});
    return {creation, seal, publication};
  }, async readNodeContainedTurnNativeWorkspaceClosure() {return {...seal, receiptRef: "native-closed"};}};
  return {...value, creation, seal, publication};
}

test("joins genuine workspace records and operation proofs into all five receipt kinds", async () => {
  const value = nativeFixture();
  const actual = await createDarwinLiveVerification(value.input).verification.verifyArtifactManifest(manifestRef, "result");
  assert.equal(actual.status, "verified"); assert.deepEqual(actual.gaps, []);
  assert.deepEqual(actual.receipts.map(item => item.kind),
    ["workspace-creation", "workspace-seal", "result-publication", "output-drain", "terminal-truth"]);
  assert.equal(actual.receipts[0].provenance.record, value.creation);
  assert.equal(actual.receipts[2].provenance.publication, value.publication);
  value.seal.rootIdentity = {dev: "1", ino: "other"};
  await assert.rejects(createDarwinLiveVerification(value.input).verification.verifyArtifactManifest(manifestRef, "result"), /linkage differs/u);
});

test("cleanup reads native closure after disposal and HTTP receipts before the pool closes", async () => {
  const {input} = nativeFixture(); let poolClosed = false;
  input.activation.infrastructure = {deployment: {id: "deployment"}};
  input.readHttpRequestIdentities = async () => ({kind: "closed", operationId: "op", attemptId: "attempt", requestIds: ["owned-request"]});
  input.agentExecution.PostgresHttpEgressEvidence = class {
    async read(identity) {assert.equal(poolClosed, false); assert.equal(identity.requestId, "owned-request");
      return {kind: "found", receipt: {...identity, inboundClosure: "closed", upstreamClosure: "closed"}};}
  };
  input.hostCustody = {evidence: id => {assert.equal(id, "custody"); return {identity: {status: "proved"}, sealed: true,
    closure: {profile: "native-darwin-attempt-owner", status: "closed"}, stdout: {status: "complete"}, stderr: {status: "complete"}};}};
  input.outputOwner = {readback: () => ({closed: true})};
  input.readCleanup = async () => ({status: "released", processes: {survivingDescendants: 0, openWriterFds: 0},
    routes: {remaining: 0}, listeners: {remaining: 0}, database: {sessions: 0, preparedTransactions: 0},
    filesystem: {executionRootPresent: false}, checksums: {verified: true}, providerAccess: {disposeCount: 1},
    pool: {closed: true}, storage: {closed: true}, host: {identityCurrent: true, streamsDrained: true},
    evidence: {retainedTreeVerified: true}});
  const projection = createDarwinLiveVerification(input);
  await projection.verification.verifyArtifactManifest(manifestRef, "result"); poolClosed = true;
  const actual = await projection.cleanup.readback();
  assert.equal(actual.status, "released"); assert.equal(actual.native.record.receiptRef, "native-closed");
  assert.equal(actual.http.receipts[0].requestId, "owned-request"); assert.deepEqual(actual.gaps, []);
});

test("source verification checks the pinned manifest, complete inventory and every file digest", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ar69-test-source-")));
  try {
    const {input} = fixture(), sourceRoot = join(root, "source"), path = join(root, "inventory.json");
    await mkdir(sourceRoot); await writeFile(join(sourceRoot, "TASK.md"), "task");
    const bytes = JSON.stringify({version: 1, entries: [{path: "TASK.md", kind: "file", size: 4,
      sha256: createHash("sha256").update("task").digest("hex")}]});
    await writeFile(path, bytes); input.activation.source = {manifestPath: path, inventorySha256: createHash("sha256").update(bytes).digest("hex")};
    input.activation.infrastructure = {filesystem: {sourceRoot}};
    const {verification} = createDarwinLiveVerification(input);
    assert.equal(await verification.verifySourceInventory(), true);
    await writeFile(join(sourceRoot, "extra.txt"), "extra");
    assert.equal(await verification.verifySourceInventory(), false);
  } finally {await rm(root, {recursive: true, force: true});}
});


test("public result verification consumes the owner rehydration path without inventing a frozen-workspace copy", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ar69-test-public-result-")));
  try {
    const {input, operation} = nativeFixture(), sourceRoot = join(root, "source");
    const rehydrationRoot = join(root, "rehydration"), actual = join(rehydrationRoot, "results", "a".repeat(64));
    await mkdir(join(sourceRoot, "input", "nested"), {recursive: true}); await mkdir(actual, {recursive: true});
    const taskPath = join(sourceRoot, "TASK.md"), sourceMessagePath = join(sourceRoot, "input", "nested", "message.txt");
    await writeFile(taskPath, "task"); await writeFile(sourceMessagePath, "ok\n"); await writeFile(join(actual, "result.txt"), "ok\n");
    const inventory = JSON.stringify({version: 1, entries: [
      {path: "TASK.md", kind: "file", size: 4, sha256: sha256("task")},
      {path: "input", kind: "directory"}, {path: "input/nested", kind: "directory"},
      {path: "input/nested/message.txt", kind: "file", size: 3, sha256: sha256("ok\n")}]});
    const manifestPath = join(root, "inventory.json"); await writeFile(manifestPath, inventory);
    input.activation.source = {manifestPath, inventorySha256: sha256(inventory)};
    input.activation.infrastructure = {filesystem: {sourceRoot, rehydrationRoot}};
    const artifacts = input.getArtifacts(); input.getArtifacts = () => ({...artifacts, rehydrate: async () => actual});
    const {verification} = createDarwinLiveVerification(input);
    await verifySuccessfulPublicResult({...input.activation.turn, ...verification, expectedMarker: "ok",
      taskPath, sourceMessagePath, expectedTaskSha256: sha256("task"), expectedResultSha256: sha256("ok\n"),
      frozenWorkspacePath: join(root, "frozen-workspace"), resultPath: join(root, "frozen-workspace", "result.txt")},
    {commandId: "command", accepted: {status: "accepted", operationId: "op"}, terminal: {status: "observed", turn: {
      status: "succeeded", provider: "codex", commandId: "command", effectId: "effect", operationId: "op",
      resultRef: operation.resultRef, artifactManifestRef: manifestRef, output: operation.output.chunks}}});
    await assert.rejects(readFile(join(root, "frozen-workspace", "result.txt")), /ENOENT/u);
  } finally {await rm(root, {recursive: true, force: true});}
});


test("an unrelated closure request ID never becomes an HTTP request identity", async () => {
  const {input, operation} = nativeFixture();
  operation.closureRecovery = {kind: "required", requestId: "closure-request-not-http"};
  let reads = 0;
  input.agentExecution.PostgresHttpEgressEvidence = class {read() {reads += 1; throw new Error("must not infer HTTP identity");}};
  const projection = createDarwinLiveVerification(input);
  await projection.verification.verifyArtifactManifest(manifestRef, "result");
  const cleanup = await projection.cleanup.readback();
  assert.equal(reads, 0); assert.equal(cleanup.status, "incomplete");
  assert.ok(cleanup.gaps.some(item => item.kind === "http-request-identities"));
});
