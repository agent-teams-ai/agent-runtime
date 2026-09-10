import {createHash} from "node:crypto";
import {lstat, open, readFile} from "node:fs/promises";
import {join} from "node:path";

const refused = reason => new Error(`DARWIN_LIVE_VERIFICATION_REFUSED: ${reason}`);
const gap = (kind, capability) => Object.freeze({kind, capability});
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const missingReceipts = Object.freeze([
  gap("workspace-creation", "NodeContainedTurnWorkspaceOwner has no public creation receipt read"),
  gap("workspace-seal", "NodeContainedTurnWorkspaceOwner has no public workspace seal receipt read"),
]);

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

function verification(input) {
  const turn = input.activation.turn;
  let verified;
  return Object.freeze({
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
      const receipts = retainedReceipts(operation);
      verified = {artifactManifestRef, lookup};
      // Artifact seal verification authenticates content, not workspace creation
      // or workspace-seal receipts. The five-receipt gate must stay incomplete.
      return Object.freeze({status: "incomplete", files: manifest.entries.filter(entry => entry.kind === "file"),
        receipts, manifest, gaps: missingReceipts});
    },
    async rehydrateArtifact(artifactManifestRef, target) {
      if (verified?.artifactManifestRef !== artifactManifestRef) {throw refused("rehydration requires verified lookup");}
      const actual = await input.getArtifacts().rehydrate(verified.lookup);
      if (actual !== target) {throw refused("owner rehydration path differs from requested frozen workspace");}
      return actual;
    },
    async verifySourceInventory() {
      if (typeof input.verifySourceInventory !== "function") {throw refused("source inventory owner read unavailable");}
      return input.verifySourceInventory();
    },
  });
}

async function retainSnapshot(input, result) {
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
    file = await open(path, "wx", 0o600);
    await file.writeFile(bytes); await file.sync();
  } catch (error) {
    if (error.code !== "EEXIST") {throw error;}
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || await readFile(path, "utf8") !== bytes) {throw error;}
  } finally {await file?.close();}
  const parent = await open(directory, "r");
  try {await parent.sync();} finally {await parent.close();}
  if (await readFile(path, "utf8") !== bytes) {throw refused("retained reconciliation readback differs");}
  return Object.freeze({status: "retained", path, sha256: hash(bytes), operationRevision: operation.revision});
}

/** Feature-local projection. No launch, SQL codecs, owner mutation or inferred
 * cleanup success. Missing public evidence is a bounded qualification gap. */
export function createDarwinLiveVerification(input) {
  const failures = [];
  return Object.freeze({verification: verification(input),
    reconciliation: Object.freeze({retain: result => retainSnapshot(input, result)}),
    cleanup: Object.freeze({
      recordFailure(error) {failures.push(String(error));},
      async readback() {
        const observed = await input.readCleanup?.();
        const gaps = [gap("http-evidence", "PostgresHttpEgressEvidence exposes record/digest but no public retained read"),
          gap("native-closure", "NodeContainedTurnWorkspaceOwner exposes dispose but no public closure readback")];
        if (!observed) {gaps.push(gap("cleanup-owner-state", "retained lifecycle readback unavailable"));}
        return Object.freeze({...observed, status: "incomplete", gaps, failures: [...failures],
          ...(input.outputOwner?.readback ? {output: await input.outputOwner.readback()} : {})});
      },
    }),
  });
}
