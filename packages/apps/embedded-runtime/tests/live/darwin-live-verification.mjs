import {createHash} from "node:crypto";
import {constants} from "node:fs";
import {lstat, open, readFile, realpath} from "node:fs/promises";
import {join} from "node:path";

import {captureVerificationDirectoryIdentity, readStableVerificationFile, verifyPinnedSource} from "../package/live/darwin-live-filesystem-verification.mjs";

const refused = reason => new Error(`DARWIN_LIVE_VERIFICATION_REFUSED: ${reason}`);
const gap = (kind, capability) => Object.freeze({kind, capability});
const hash = bytes => createHash("sha256").update(bytes).digest("hex");

async function readOperation(input) {
  const turn = input.activation.turn;
  const operation = await input.operationStore.read({operationId: turn.operationId, scope: turn.scope});
  if (!operation || operation.operationId !== turn.operationId ||
      operation.scope?.tenantId !== turn.scope.tenantId || operation.scope?.projectId !== turn.scope.projectId) {
    throw refused("operation owner read is absent or scope differs");
  }
  return operation;
}

function requireAttempt(operation, turn) {
  if (operation.dispatch?.kind !== "claimed" || operation.dispatch.attemptId !== turn.attemptId ||
      operation.dispatch.executionGenerationId !== turn.executionGenerationId || operation.effectId !== turn.effectId) {
    throw refused("retained dispatch identity differs from activation");
  }
}

function projectProof(operation, kind, matches) {
  const candidates = operation.proofs.filter(proof => proof.kind === kind && matches(proof));
  if (candidates.length !== 1) {throw refused(`missing or ambiguous ${kind} proof`);}
  const proof = candidates[0];
  if (!proof.proofId || proof.binding.operationId !== operation.operationId ||
      proof.binding.authorityVectorDigest !== operation.acceptedAuthorityVectorDigest) {
    throw refused(`${kind} proof owner binding differs`);
  }
  // Generation is joined from the same retained operation's claimed dispatch.
  // Keep this provenance explicit: it is not a field invented on the owner proof.
  return Object.freeze({kind: kind.replaceAll("_", "-"), proofId: proof.proofId,
    operationId: operation.operationId, attemptId: operation.dispatch.attemptId,
    executionGenerationId: operation.dispatch.executionGenerationId,
    provenance: {owner: "operationStore.read", revision: operation.revision,
      generationSource: "dispatch.executionGenerationId", proof}});
}

function retainedReceipts(operation) {
  return [
    projectProof(operation, "result_publication", proof => proof.binding.resultRef === operation.resultRef),
    projectProof(operation, "output_drain", proof => proof.binding.attemptId === operation.dispatch.attemptId &&
      proof.binding.effectId === operation.effectId && operation.output.fence.kind === "fenced" &&
      proof.binding.finalCursor === operation.output.fence.finalCursor),
    projectProof(operation, "terminal_truth", proof => operation.terminal.kind === "final" &&
      proof.proofId === operation.terminal.terminalProofId && proof.binding.terminalOutcome === "succeeded" &&
      proof.binding.satisfactionDigest === operation.terminal.satisfactionDigest &&
      proof.binding.requiredReceiptSetDigest === operation.requiredReceiptSetDigest),
  ];
}

function matchManifest(manifest, operation, turn) {
  if (manifest.schemaVersion !== 3 || manifest.operationId !== operation.operationId ||
      manifest.tenantId !== turn.scope.tenantId || manifest.projectId !== turn.scope.projectId ||
      !Array.isArray(manifest.entries) || !Array.isArray(manifest.output)) {throw refused("verified manifest scope differs");}
  const chunks = operation.output.chunks;
  if (manifest.output.length !== chunks.length || manifest.output.some((record, index) => {
    const chunk = chunks[index];
    return record.cursor !== chunk.cursor || record.kind !== chunk.kind ||
      record.size !== Buffer.byteLength(chunk.text) || record.digest !== hash(Buffer.from(chunk.text));
  })) {throw refused("artifact output differs from operation owner output");}
}

async function workspaceReceipts(input, operation, manifest) {
  const reader = input.agentExecution?.readNodeContainedTurnNativeWorkspaceReceipts;
  if (!reader) {return {receipts: [], gaps: [gap("workspace-receipts", "native workspace receipt reader unavailable")]};}
  const records = await reader(input.getWorkspaceOwner(), {operationId: operation.operationId, workspaceId: operation.workspaceId});
  const {creation, seal, publication} = records;
  const expectedName = operation.workspaceId?.replace(/^workspace:/u, "");
  for (const record of [creation, seal, publication]) {
    if (record.operationId !== operation.operationId || record.workspaceName !== expectedName ||
        record.scope.tenantId !== operation.scope.tenantId || record.scope.projectId !== operation.scope.projectId) {
      throw refused("native workspace receipt scope differs");
    }
  }
  if (creation.rootIdentity.dev !== seal.rootIdentity.dev || creation.rootIdentity.ino !== seal.rootIdentity.ino ||
      seal.treeDigest !== manifest.treeDigest || publication.treeDigest !== manifest.treeDigest ||
      seal.manifestDigest !== publication.manifestDigest || publication.resultRef !== operation.resultRef ||
      operation.artifactManifestRef !== `urn:agent-runtime:artifact-manifest:${seal.manifestDigest}`) {
    throw refused("native workspace receipt linkage differs");
  }
  const receipts = [["workspace-creation", creation], ["workspace-seal", seal]].map(([kind, record]) => ({kind,
    operationId: operation.operationId, attemptId: operation.dispatch.attemptId,
    executionGenerationId: operation.dispatch.executionGenerationId,
    provenance: {owner: "readNodeContainedTurnNativeWorkspaceReceipts", record, operationRevision: operation.revision,
      generationSource: "operationStore.read.dispatch.executionGenerationId"}}));
  return {receipts, records, gaps: []};
}

function verification(input, state, filesystem) {
  const turn = input.activation.turn;
  let verified;
  return Object.freeze({
    sourceRoot: input.activation.infrastructure?.filesystem?.sourceRoot,
    async readResultBytes(root) {
      if (root !== state.rehydrated) {throw refused("result read root differs from owner rehydration");}
      return readStableVerificationFile(join(root, "result.txt"), 16 * 1024 * 1024, filesystem, state.rehydratedIdentity);
    },
    async readSourceFixtureBytes() {
      const root = input.activation.infrastructure.filesystem.sourceRoot;
      if (turn.taskPath !== join(root, "TASK.md") || turn.sourceMessagePath !== join(root, "input", "nested", "message.txt")) {
        throw refused("source fixture paths differ from canonical source root");
      }
      return {task: await readStableVerificationFile(turn.taskPath, 16 * 1024 * 1024, filesystem),
        message: await readStableVerificationFile(turn.sourceMessagePath, 16 * 1024 * 1024, filesystem)};
    },
    async verifyArtifactManifest(artifactManifestRef, resultRef) {
      verified = undefined;
      const operation = await readOperation(input);
      requireAttempt(operation, turn);
      if (operation.terminal?.kind !== "final" || operation.terminal.outcome !== "succeeded" ||
          operation.reconciliation?.kind !== "clear" || operation.artifactManifestRef !== artifactManifestRef ||
          operation.resultRef !== resultRef || !artifactManifestRef || !resultRef) {throw refused("terminal artifact references differ");}
      const lookup = {operationId: operation.operationId, scope: turn.scope, resultRef};
      const manifest = await input.getArtifacts().verify(lookup);
      matchManifest(manifest, operation, turn);
      const workspace = await workspaceReceipts(input, operation, manifest);
      const receipts = [...workspace.receipts, ...retainedReceipts(operation)];
      if (workspace.records) {receipts.find(receipt => receipt.kind === "result-publication").provenance.publication = workspace.records.publication;}
      verified = {artifactManifestRef, lookup};
      state.operation = operation; state.workspace = workspace.records; state.manifest = manifest;
      state.artifactManifestVerified = workspace.gaps.length === 0;
      return Object.freeze({status: workspace.gaps.length ? "incomplete" : "verified",
        files: manifest.entries.filter(entry => entry.kind === "file"), receipts, manifest, gaps: workspace.gaps});
    },
    async rehydrateArtifact(artifactManifestRef) {
      if (verified?.artifactManifestRef !== artifactManifestRef) {throw refused("rehydration requires verified lookup");}
      const actual = await input.getArtifacts().rehydrate(verified.lookup);
      const digest = artifactManifestRef.match(/^urn:agent-runtime:artifact-manifest:([a-f0-9]{64})$/u)?.[1];
      const root = input.activation.infrastructure?.filesystem?.rehydrationRoot;
      if (!digest || !root || actual !== join(root, "results", digest) || await realpath(actual) !== actual ||
          !(await lstat(actual)).isDirectory()) {throw refused("owner rehydration path differs from verified manifest");}
      state.rehydratedIdentity = await captureVerificationDirectoryIdentity(actual, filesystem);
      state.rehydrated = actual;
      state.resultRehydrated = true;
      return actual;
    },
    async verifySourceInventory() {
      const result = await verifyPinnedSource(input.activation, filesystem);
      state.sourceInventoryVerified = result === true;
      return result;
    },
  });
}

async function syncExistingSnapshot(openFile, path, bytes) {
  const file = await openFile(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat();
    if (!before.isFile() || await file.readFile("utf8") !== bytes) {
      throw refused("existing reconciliation snapshot differs (EEXIST)");
    }
    const after = await file.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      throw refused("existing reconciliation snapshot changed during read");
    }
    await file.sync();
    const linked = await lstat(path);
    if (!linked.isFile() || linked.dev !== after.dev || linked.ino !== after.ino ||
        linked.size !== after.size || linked.mtimeMs !== after.mtimeMs || linked.ctimeMs !== after.ctimeMs) {
      throw refused("existing reconciliation snapshot identity changed");
    }
  } finally {await file.close();}
}

async function retainSnapshot(input, result, openFile) {
  const operation = await readOperation(input);
  if (result.accepted?.operationId !== undefined && result.accepted.operationId !== operation.operationId) {
    throw refused("reconciliation result operation differs");
  }
  const record = {version: 1, kind: "owner-reconciliation-snapshot", operationId: operation.operationId,
    revision: operation.revision, dispatch: operation.dispatch.kind === "claimed" ? {
      kind: "claimed", attemptId: operation.dispatch.attemptId,
      executionGenerationId: operation.dispatch.executionGenerationId} : {kind: operation.dispatch.kind},
    terminal: operation.terminal, reconciliation: operation.reconciliation,
    proofIds: operation.proofs.map(proof => proof.proofId)};
  const bytes = `${JSON.stringify(record, null, 2)}\n`;
  const directory = input.activation.turn.evidenceDirectory ?? input.activation.evidenceDirectory;
  const path = join(directory, "reconciliation-owner-snapshot.json");
  let file;
  try {
    file = await openFile(path, "wx", 0o600);
    await file.writeFile(bytes); await file.sync();
  } catch (error) {
    if (error.code !== "EEXIST") {throw error;}
    await syncExistingSnapshot(openFile, path, bytes);
  } finally {await file?.close();}
  const parent = await openFile(directory, "r");
  try {await parent.sync();} finally {await parent.close();}
  if (await readFile(path, "utf8") !== bytes) {throw refused("retained reconciliation readback differs");}
  return Object.freeze({status: "retained", path, sha256: hash(bytes), operationRevision: operation.revision});
}

async function readHttpClosure(input, operation) {
  // Kernel closureRecovery.requestId is NOT an HTTP request identity. An exact
  // owner inventory must bridge this namespace before using the public reader.
  if (!input.readHttpRequestIdentities) {return {gaps: [gap("http-request-identities",
    "operation/proof records expose no HTTP request identity; closed owner inventory required")]};}
  const identity = {...operation.scope, operationId: operation.operationId,
    attemptId: operation.dispatch.attemptId, custodyId: operation.custodyId};
  const inventory = await input.readHttpRequestIdentities(identity);
  if (inventory?.kind !== "closed" || !Array.isArray(inventory.requestIds) ||
      new Set(inventory.requestIds).size !== inventory.requestIds.length) {
    return {gaps: [gap("http-request-identities", "HTTP owner inventory is not closed for this attempt")]};
  }
  const reader = new input.agentExecution.PostgresHttpEgressEvidence(input.pool,
    {...operation.scope, deploymentId: input.activation.infrastructure.deployment.id});
  const receipts = [];
  for (const requestId of inventory.requestIds) {
    const outcome = await reader.read({operationId: identity.operationId, attemptId: identity.attemptId, requestId});
    if (outcome.kind !== "found" || outcome.receipt.operationId !== identity.operationId ||
        outcome.receipt.attemptId !== identity.attemptId || outcome.receipt.requestId !== requestId ||
        !["closed", "not_opened"].includes(outcome.receipt.inboundClosure) ||
        !["closed", "not_opened"].includes(outcome.receipt.upstreamClosure)) {
      return {receipts, gaps: [gap("http-closure", "exact HTTP receipt missing, uncertain or unclosed")]};
    }
    receipts.push(outcome.receipt);
  }
  return {receipts, gaps: []};
}

async function nativeClosure(input, state, gaps) {
  const operation = state.operation;
  if (!operation || !input.agentExecution?.readNodeContainedTurnNativeWorkspaceClosure) {
    gaps.push(gap("native-closure", "native closure reader or operation unavailable")); return;
  }
  try {
    const record = await input.agentExecution.readNodeContainedTurnNativeWorkspaceClosure(input.getWorkspaceOwner(),
      {operationId: operation.operationId, workspaceId: operation.workspaceId});
    if (record.operationId !== operation.operationId || record.workspaceName !== state.workspace?.seal.workspaceName ||
        record.manifestDigest !== state.workspace?.seal.manifestDigest || record.treeDigest !== state.manifest.treeDigest ||
        record.scope.tenantId !== operation.scope.tenantId || record.scope.projectId !== operation.scope.projectId) {
      throw refused("native closure identity differs");
    }
    return {closureAcknowledged: true, record};
  } catch (error) {gaps.push(gap("native-closure", String(error)));}
}

function closedCustody(custody) {
  return custody?.identity?.status === "proved" && custody.sealed === true &&
    custody.closure?.profile === "native-darwin-attempt-owner" && custody.closure.status === "closed" &&
    custody.stdout?.status === "complete" && custody.stderr?.status === "complete";
}

// oxlint-disable-next-line complexity -- each independently owned release fact must be proved
function releasedFacts(value) {
  return value.persistence?.repositoryClosed === true && value.persistence?.decisionsClosed === true &&
    value.pool?.closed === true && value.database?.kind === "observed" && value.database?.otherSessions === 0 &&
    value.database?.preparedTransactions === 0 && value.database?.inspectorClosed === true &&
    value.providerAccess?.disposed === true && value.native?.closureAcknowledged === true &&
    value.output?.closed === true && closedCustody(value.custody) && value.http?.gaps?.length === 0 &&
    value.verification?.artifactManifestVerified === true && value.verification?.sourceInventoryVerified === true &&
    value.verification?.resultRehydrated === true;
}

async function readCustody(input, operation) {
  if (!operation || !input.readHostCustodyEvidence) {return;}
  const identity = {operationId: operation.operationId, attemptId: operation.dispatch.attemptId};
  const found = await input.readHostCustodyEvidence(identity);
  if (found?.kind !== "found" || found.operationId !== identity.operationId || found.attemptId !== identity.attemptId) {return;}
  return found.evidence;
}

async function cleanupReadback(input, state, failures) {
  const observed = await input.readCleanup?.(), gaps = [];
  const operation = state.operation;
  if (!observed) {gaps.push(gap("cleanup-owner-state", "final DB inspector, pool/storage and route lifecycle readback unavailable"));}
  if (!operation) {gaps.push(gap("operation-snapshot", "pre-disposal operation owner snapshot unavailable"));}
  const native = await nativeClosure(input, state, gaps);
  const custody = state.custody;
  if (!custody) {gaps.push(gap("host-custody", "attempt-bound host custody evidence hook missing or exact binding differs"));}
  const output = await input.outputOwner?.readback();
  if (output?.closed !== true) {gaps.push(gap("output-owner", "native output owner has not durably closed"));}
  // HTTP must be read while the borrowed DB pool is live, before owner disposal.
  const http = state.http ?? {gaps: [gap("http-closure", "pre-disposal HTTP owner read unavailable")]};
  gaps.push(...http.gaps);
  if (custody && !closedCustody(custody)) {
    gaps.push(gap("host-custody", "native host identity, closure or stream drain unproved"));
  }
  const verificationFacts = Object.freeze({artifactManifestVerified: state.artifactManifestVerified === true,
    sourceInventoryVerified: state.sourceInventoryVerified === true, resultRehydrated: state.resultRehydrated === true});
  const result = {...observed, providerAccess: state.providerAccess, native, output, custody, http,
    verification: verificationFacts, gaps, failures: [...failures]};
  const required = ["persistence", "database", "pool"];
  for (const key of required) {if (!observed?.[key]) {gaps.push(gap(key, `final ${key} owner readback missing`));}}
  if (!state.providerAccess) {gaps.push(gap("provider-access", "provider access disposal readback missing"));}
  if (observed && !releasedFacts(result)) {gaps.push(gap("cleanup-release", "one or more final release predicates remain unproved"));}
  return Object.freeze({...result, status: gaps.length || failures.length ? "incomplete" : "released"});
}

/** Feature-local projection. Only public owner reads establish qualification. */
export function createDarwinLiveVerification(input, {openFile = open, filesystem} = {}) {
  const failures = [], state = {};
  const checks = verification(input, state, filesystem);
  let captured;
  const captureBeforePoolClose = () => captured ??= (async () => {
    const operation = state.operation;
    if (!operation) {
      state.http = {gaps: [gap("http-closure", "operation owner snapshot unavailable before pool close")]};
      return;
    }
    try {state.http = await readHttpClosure(input, operation);}
    catch (error) {state.http = {gaps: [gap("http-closure", String(error))]};}
    try {state.custody = await readCustody(input, operation);}
    catch (error) {failures.push(String(error));}
  })();
  return Object.freeze({verification: Object.freeze({...checks,
    async verifyArtifactManifest(...args) {
      state.operation = undefined; state.workspace = undefined; state.manifest = undefined; state.http = undefined;
      state.custody = undefined; state.rehydrated = undefined; state.rehydratedIdentity = undefined;
      state.artifactManifestVerified = false;
      state.resultRehydrated = false;
      // A repeat verification cycle must re-run captureBeforePoolClose against
      // the fresh operation snapshot above, not resolve to the prior cycle's
      // memoized (and now stale/undefined) state.http/state.custody.
      captured = undefined;
      return checks.verifyArtifactManifest(...args);
    }}),
    reconciliation: Object.freeze({retain: result => retainSnapshot(input, result, openFile)}),
    cleanup: Object.freeze({recordFailure(error) {failures.push(String(error));},
      captureBeforePoolClose,
      readback(ownerFacts = {}) {state.providerAccess = ownerFacts.providerAccess; return cleanupReadback(input, state, failures);}}),
  });
}
