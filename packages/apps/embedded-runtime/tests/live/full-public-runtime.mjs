import {createHash, randomUUID} from "node:crypto";
import {writeFile} from "node:fs/promises";
import {join, isAbsolute} from "node:path";

import {withOperatorProviderAccess} from "./darwin-operator-provider-access.mjs";

const digest = value => createHash("sha256").update(value).digest("hex");
const terminal = new Set(["succeeded", "failed", "cancelled", "reconcile_required"]);

const writeJson = (path, value) => writeFile(path, `${JSON.stringify(value, null, 2)}\n`, {flag: "wx", mode: 0o600});

// oxlint-disable-next-line complexity -- every ambiguous public outcome is classified without retry
export async function executeOnePublicContainedTurn(input) {
  if (!Number.isInteger(input.maximumObservations) || input.maximumObservations < 1 || input.maximumObservations > 128 ||
      !Number.isInteger(input.observeTimeoutMs) || input.observeTimeoutMs < 1 || input.observeTimeoutMs > 30_000) {
    throw new TypeError("public observation bounds are invalid");
  }
  const commandId = input.commandId ?? randomUUID();
  const handle = input.host.bindAccess({containedTurn: input.scope});
  let submitEntered = false;
  const submitRecord = {commandId, enteredAt: new Date().toISOString()};
  await writeJson(`${input.evidenceDirectory}/attempt.json`, submitRecord);
  let accepted;
  try {
    submitEntered = true;
    accepted = await handle.containedTurn.submit({
      commandId,
      expectedProvider: "codex",
      intent: {mode: "workspace-write", prompt: "Follow TASK.md in the provided workspace."},
    });
  } catch (error) {
    return {accepted, commandId, terminal: undefined, submitEntered, uncertainty: {reason: "submit_unresolved", message: String(error)}};
  }
  if (accepted.status !== "accepted") {
    await writeJson(`${input.evidenceDirectory}/submit.json`, accepted);
    if (accepted.status === "potential_acceptance") {
      const uncertainty = {operationId: accepted.candidateOperationId, reason: "potential_acceptance"};
      await writeJson(`${input.evidenceDirectory}/reconciliation-debt.json`, uncertainty);
      return {accepted, commandId, terminal: undefined, submitEntered, uncertainty};
    }
    return {accepted, commandId, terminal: undefined, submitEntered};
  }
  let observed;
  try {
    await input.onAccepted?.(accepted.operationId);
    await writeJson(`${input.evidenceDirectory}/submit.json`, accepted);
    for (let sequence = 0; sequence < input.maximumObservations; sequence += 1) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(new Error("bounded observation timeout")), input.observeTimeoutMs);
        try {
          observed = await handle.containedTurn.observe(accepted.operationId, {signal: controller.signal});
        } finally {
          clearTimeout(timeout);
        }
        await writeJson(`${input.evidenceDirectory}/observe-${String(sequence + 1).padStart(4, "0")}.json`, observed);
      if (observed.status !== "observed" || terminal.has(observed.turn.status)) {break;}
    }
    if (observed?.status !== "observed" || observed.turn.status === "reconcile_required" || !terminal.has(observed.turn.status)) {
      const uncertainty = {operationId: accepted.operationId, reason: observed?.status === "not_found"
        ? "observation_not_found" : observed?.status === "unsupported" ? "observation_unsupported"
          : observed?.turn.status === "reconcile_required" ? "reconcile_required" : "observation_exhausted"};
      await writeJson(`${input.evidenceDirectory}/reconciliation-debt.json`, uncertainty);
      return {accepted, commandId, terminal: observed, submitEntered, uncertainty};
    }
    return {accepted, commandId, terminal: observed, submitEntered};
  } catch (error) {
    const uncertainty = {operationId: accepted.operationId, reason: "accepted_operation_unresolved", message: String(error)};
    try {await writeJson(`${input.evidenceDirectory}/reconciliation-debt.json`, uncertainty);} catch {}
    return {accepted, commandId, terminal: observed, submitEntered, uncertainty};
  }
}

// oxlint-disable-next-line complexity -- the qualification predicate is intentionally conjunctive and fail-closed
export async function verifySuccessfulPublicResult(input, result) {
  if (result.uncertainty !== undefined || result.accepted?.status !== "accepted" || result.terminal?.status !== "observed" ||
      result.terminal.turn.status !== "succeeded" || result.terminal.turn.provider !== "codex") {
    throw new Error("public contained turn did not reach succeeded terminal truth");
  }
  const assistant = result.terminal.turn.output?.find(item => item.kind === "assistant" && item.text === input.expectedMarker);
  const cursors = result.terminal.turn.output?.map(item => item.cursor) ?? [];
  if (cursors.length === 0 || cursors.some((cursor, index) => cursor !== cursors[0] + index)) {throw new Error("terminal output cursors are not contiguous");}
  if (!assistant || !result.terminal.turn.resultRef || !result.terminal.turn.artifactManifestRef) {
    throw new Error("terminal result is missing exact assistant output or linked artifacts");
  }
  if (result.terminal.turn.operationId !== result.accepted.operationId ||
      result.terminal.turn.commandId !== result.commandId || result.terminal.turn.effectId !== input.effectId) {
    throw new Error("terminal public identities differ from the accepted attempt");
  }
  const manifest = await input.verifyArtifactManifest(result.terminal.turn.artifactManifestRef, result.terminal.turn.resultRef);
  const receiptKinds = new Set(manifest.receipts?.map(receipt => receipt.kind));
  const requiredReceipts = ["workspace-creation", "workspace-seal", "result-publication", "output-drain", "terminal-truth"];
  if (manifest.status !== "verified" || manifest.files?.some(file => file.path === "result.txt") !== true ||
      manifest.receipts?.every(receipt => receipt.operationId === result.accepted.operationId &&
        receipt.attemptId === input.attemptId && receipt.executionGenerationId === input.executionGenerationId) !== true ||
      requiredReceipts.some(kind => !receiptKinds.has(kind))) {
    throw new Error("artifact manifest or retained receipt identity is incomplete");
  }
  const frozenWorkspace = await input.rehydrateArtifact(result.terminal.turn.artifactManifestRef, input.frozenWorkspacePath);
  if (typeof frozenWorkspace !== "string" || !isAbsolute(frozenWorkspace)) {throw new Error("artifact owner returned no materialized workspace");}
  const bytes = await input.readResultBytes(frozenWorkspace);
  const expected = Buffer.from(`${input.expectedMarker}\n`);
  if (!bytes.equals(expected) || digest(bytes) !== input.expectedResultSha256) {
    throw new Error("result.txt bytes do not match the accepted marker");
  }
  if (typeof input.sourceRoot !== "string" || !isAbsolute(input.sourceRoot) ||
      input.sourceMessagePath !== join(input.sourceRoot, "input", "nested", "message.txt") || input.taskPath !== join(input.sourceRoot, "TASK.md")) {
    throw new Error("source fixture paths differ from the fixed inventory");
  }
  const source = await input.readSourceFixtureBytes();
  const sourceBytes = source.message;
  if (!sourceBytes.equals(expected) || digest(sourceBytes) !== input.expectedResultSha256) {
    throw new Error("source message bytes do not match the accepted marker");
  }
  if (digest(source.task) !== input.expectedTaskSha256 || await input.verifySourceInventory() !== true) {
    throw new Error("source inventory or TASK.md identity differs from activation");
  }
}

// oxlint-disable-next-line complexity -- every exact owner readback is required independently
export function verifyReleasedCleanup(cleanup) {
  if (cleanup?.status !== "released" || cleanup.persistence?.repositoryClosed !== true ||
      cleanup.persistence?.decisionsClosed !== true || cleanup.pool?.closed !== true ||
      cleanup.database?.kind !== "observed" || cleanup.database?.otherSessions !== 0 ||
      cleanup.database?.preparedTransactions !== 0 || cleanup.database?.inspectorClosed !== true ||
      cleanup.providerAccess?.disposed !== true || cleanup.native?.closureAcknowledged !== true ||
      cleanup.output?.closed !== true || cleanup.custody?.identity?.status !== "proved" ||
      cleanup.custody?.sealed !== true || cleanup.custody?.closure?.profile !== "native-darwin-attempt-owner" ||
      cleanup.custody?.closure?.status !== "closed" || cleanup.custody?.stdout?.status !== "complete" ||
      cleanup.custody?.stderr?.status !== "complete" || cleanup.http?.gaps?.length !== 0 ||
      cleanup.verification?.artifactManifestVerified !== true || cleanup.verification?.sourceInventoryVerified !== true ||
      cleanup.verification?.resultRehydrated !== true || cleanup.gaps?.length !== 0 || cleanup.failures?.length !== 0) {
    throw new Error("cleanup release readback is incomplete");
  }
}

export async function runDarwinPublicRuntimeHostChild() {
  const {loadDarwinLiveActivation, createDarwinLiveRuntime} = await import("../package/live/darwin-live-production-root.mjs");
  const sealed = await loadDarwinLiveActivation();
  // Real codexHome/sandbox/operatorApproval never enter the sealed manifest
  // (finding 6); this process (dropped to the operator's own uid, env wiped
  // to PATH/LANG/LC_ALL by ae_root_isolate_host) reads them itself from a
  // sibling of its own evidenceDirectory. See darwin-live-infrastructure.mjs.
  const activation = await withOperatorProviderAccess(sealed);
  const input = Object.freeze({...activation, ...activation.turn});
  if (input.version !== 1 || input.candidate !== true || input.qualified !== false) {
    throw new Error("invalid candidate child input");
  }
  // The production root module is deliberately resolved only after the Darwin
  // acquisition guard. It must construct the retained owners and return one
  // RuntimeAccessHandle-owning Host; capabilities never cross JSON.
  const runtime = await createDarwinLiveRuntime(input);
  let result;
  let cleanup;
  try {
    result = await executeOnePublicContainedTurn({...input, ...runtime});
    if (result.uncertainty !== undefined) {
      await runtime.sealAdmission();
      await runtime.retainForReconciliation(result);
      throw new Error("accepted operation requires reconciliation");
    }
    await verifySuccessfulPublicResult({...input, ...runtime}, result);
  } finally {
    cleanup = await runtime.dispose(result);
  }
  verifyReleasedCleanup(cleanup);
}
