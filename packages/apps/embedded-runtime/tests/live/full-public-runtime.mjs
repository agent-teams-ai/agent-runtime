import {createHash, randomUUID} from "node:crypto";
import {readFile, writeFile} from "node:fs/promises";

const digest = value => createHash("sha256").update(value).digest("hex");
const terminal = new Set(["succeeded", "failed", "cancelled", "reconcile_required"]);

const writeJson = (path, value) => writeFile(path, `${JSON.stringify(value, null, 2)}\n`, {flag: "wx", mode: 0o600});

export async function executeOnePublicContainedTurn(input) {
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
    return {accepted, terminal: undefined, submitEntered, uncertainty: {reason: "submit_unresolved", message: String(error)}};
  }
  if (accepted.status !== "accepted") {
    await writeJson(`${input.evidenceDirectory}/submit.json`, accepted);
    return {accepted, terminal: undefined, submitEntered};
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
    return {accepted, terminal: observed, submitEntered};
  } catch (error) {
    const uncertainty = {operationId: accepted.operationId, reason: "accepted_operation_unresolved", message: String(error)};
    try {await writeJson(`${input.evidenceDirectory}/reconciliation-debt.json`, uncertainty);} catch {}
    return {accepted, terminal: observed, submitEntered, uncertainty};
  }
}

export async function verifySuccessfulPublicResult(input, result) {
  if (result.uncertainty !== undefined || result.accepted?.status !== "accepted" || result.terminal?.status !== "observed" ||
      result.terminal.turn.status !== "succeeded" || result.terminal.turn.provider !== "codex") {
    throw new Error("public contained turn did not reach succeeded terminal truth");
  }
  const assistant = result.terminal.turn.output?.find(item => item.kind === "assistant" && item.text === input.expectedMarker);
  const cursors = result.terminal.turn.output?.map(item => item.cursor) ?? [];
  if (cursors.some((cursor, index) => cursor !== index)) {throw new Error("terminal output cursors are not contiguous");}
  if (!assistant || !result.terminal.turn.resultRef || !result.terminal.turn.artifactManifestRef) {
    throw new Error("terminal result is missing exact assistant output or linked artifacts");
  }
  const bytes = await readFile(input.resultPath);
  const expected = Buffer.from(`${input.expectedMarker}\n`);
  if (!bytes.equals(expected) || digest(bytes) !== input.expectedResultSha256) {
    throw new Error("result.txt bytes do not match the accepted marker");
  }
}

export async function runDarwinPublicRuntimeHostChild() {
  const {activation: input, createDarwinLiveRuntime} = await import("./darwin-live-production-root.mjs");
  if (input.version !== 1 || input.candidate !== true || input.qualified !== false) {
    throw new Error("invalid candidate child input");
  }
  // The production root module is deliberately resolved only after the Darwin
  // acquisition guard. It must construct the retained owners and return one
  // RuntimeAccessHandle-owning Host; capabilities never cross JSON.
  const runtime = await createDarwinLiveRuntime(input);
  let result;
  try {
    result = await executeOnePublicContainedTurn({...input, ...runtime});
    await verifySuccessfulPublicResult({...input, ...runtime}, result);
  } finally {
    await runtime.dispose(result);
  }
}
