import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {mkdtemp, open, readFile, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createDarwinLiveVerification} from "./darwin-live-verification.mjs";

function fixture() {
  const turn = {operationId: "op", attemptId: "attempt", executionGenerationId: "generation", effectId: "effect",
    scope: {tenantId: "tenant", projectId: "project"}};
  const binding = {operationId: "op", authorityVectorDigest: "authority"};
  const operation = {...turn, revision: 7, acceptedAuthorityVectorDigest: "authority",
    dispatch: {kind: "claimed", attemptId: "attempt", executionGenerationId: "generation"},
    artifactManifestRef: "manifest", resultRef: "result", requiredReceiptSetDigest: "required",
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
  const actual = await createDarwinLiveVerification(input).verification.verifyArtifactManifest("manifest", "result");
  assert.equal(actual.status, "incomplete");
  assert.deepEqual(actual.gaps.map(item => item.kind), ["workspace-creation", "workspace-seal"]);
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
    await assert.rejects(createDarwinLiveVerification(value.input).verification.verifyArtifactManifest("manifest", "result"),
      /DARWIN_LIVE_VERIFICATION_REFUSED/u);
  }
});

test("rejects artifact output that differs from the retained operation", async () => {
  const {input, manifest} = fixture(); manifest.output[0].digest = "wrong";
  await assert.rejects(createDarwinLiveVerification(input).verification.verifyArtifactManifest("manifest", "result"),
    /artifact output differs/u);
});

test("rehydrates using the verified result lookup and refuses false target attribution", async () => {
  const {input} = fixture(); const {verification} = createDarwinLiveVerification(input);
  await assert.rejects(verification.rehydrateArtifact("manifest", "/test/frozen-workspace"), /verified lookup/u);
  await verification.verifyArtifactManifest("manifest", "result");
  await assert.rejects(verification.rehydrateArtifact("manifest", "/test/frozen-workspace"), /path differs/u);
  assert.equal(await verification.rehydrateArtifact("manifest", "/test/rehydrated/digest"), "/test/rehydrated/digest");
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
  assert.deepEqual(actual.gaps.map(item => item.kind), ["http-evidence", "native-closure"]);
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
  await assert.rejects(createDarwinLiveVerification(input).verification.verifySourceInventory(), /owner read unavailable/u);
  input.verifySourceInventory = async () => false;
  assert.equal(await createDarwinLiveVerification(input).verification.verifySourceInventory(), false);
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
