import {digestContainedTurnCanonicalValue, type ContainedTurnCanonicalValue} from "./contained-turn-codecs.js";
import {containedTurnCommandFingerprint} from "./contained-turn-authority.js";
import {CONTAINED_TURN_LIMITS, utf8ByteLength, validateContainedTurnText} from "./contained-turn-limits.js";
import {assertContainedTurnCanonicalArray, assertContainedTurnExactRecord} from "./contained-turn-record.js";
import {ORDINARY_PROFILE, type OrdinaryBinding, type OrdinaryOperation, type OrdinaryReceipt, type OrdinaryInput} from "./ordinary-model.js";

const requireFact = (valid: boolean): void => {if (!valid) {throw new TypeError("invalid ordinary operation evidence");}};
function record(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  requireFact(value !== null && typeof value === "object" && !Array.isArray(value));
  assertContainedTurnExactRecord("ordinary record", value as object, keys);
}
const text = (value: unknown, limit: import("./contained-turn-limits.js").ContainedTurnTextLimit = CONTAINED_TURN_LIMITS.text.identifier): void => {
  requireFact(typeof value === "string");
  validateContainedTurnText("ordinary field", value as string, limit);
};
const integer = (value: unknown, minimum = 0): void => {requireFact(typeof value === "number" && Number.isSafeInteger(value) && value >= minimum);};
const digest = (value: unknown): void => {requireFact(typeof value === "string" && /^(?:sha256:)?[a-f0-9]{64}$/u.test(value));};
const bindingKeys = ["operationId", "attemptId", "executionProfile", "capabilityManifestRevision"] as const;
const receiptFields = {
  dispatch_claim: ["claimId", "reservationId", "committedRevision", "preparationDigest"],
  provider_terminal: ["terminalStatus", "threadId", "turnId"],
  output_drain: ["finalSequence", "stdoutClosed", "stderrClosed"],
  process_group_closed: ["reservationId", "pid", "processGroupId", "ownershipToken", "exitObserved", "groupEmptyObserved"],
  workspace_snapshot: ["workspaceId", "snapshotDigest", "sourceDigest", "inventoryDigest", "stable"],
  artifact_published: ["workspaceId", "snapshotDigest", "artifactDigest", "artifactManifestRef", "resultRef", "byteLength"],
  credential_retired: ["materializationId", "generation", "retiredAt"],
  provider_grant_settled: ["grantId", "ownerReceiptId", "settlementReceiptId", "disposition"],
  security_grant_settled: ["grantId", "ownerReceiptId", "settlementReceiptId", "disposition"],
} as const;
export const ORDINARY_REQUIRED_RECEIPTS = Object.freeze(Object.keys(receiptFields));
export function validateOrdinaryInput(value: unknown): asserts value is OrdinaryInput {
  record(value, ["commandId", "expectedProvider", "intent", "scope"]);
  text(value.commandId, CONTAINED_TURN_LIMITS.text.commandId); text(value.expectedProvider);
  record(value.scope, ["projectId", "tenantId"]); text(value.scope.projectId); text(value.scope.tenantId);
  record(value.intent, ["mode", "prompt"]); requireFact(value.intent.mode === "workspace-write");
  requireFact(typeof value.intent.prompt === "string");
  validateContainedTurnText("prompt", value.intent.prompt as string, CONTAINED_TURN_LIMITS.text.prompt);
}
export function validateOrdinaryReceipt(value: unknown, binding: OrdinaryBinding): asserts value is OrdinaryReceipt {
  requireFact(value !== null && typeof value === "object");
  const descriptor = Object.getOwnPropertyDescriptor(value as object, "kind");
  requireFact(descriptor !== undefined && descriptor.enumerable === true && "value" in descriptor);
  const kind: unknown = descriptor?.value;
  requireFact(typeof kind === "string" && Object.hasOwn(receiptFields, kind));
  const fields = receiptFields[kind as keyof typeof receiptFields];
  record(value, [...bindingKeys, "kind", ...fields]);
  for (const key of bindingKeys) {requireFact(value[key] === binding[key]);}
  for (const field of fields) {
    const fact = value[field];
    if (["stable", "stdoutClosed", "stderrClosed", "exitObserved", "groupEmptyObserved"].includes(field)) {requireFact(fact === true);}
    else if (["pid", "processGroupId", "committedRevision", "generation"].includes(field)) {integer(fact, 1);}
    else if (["finalSequence", "byteLength"].includes(field)) {integer(fact);}
    else if (field.endsWith("Digest")) {digest(fact);}
    else if (field === "terminalStatus") {requireFact(fact === "completed" || fact === "failed" || fact === "cancelled");}
    else if (field === "disposition") {requireFact(fact === "claim_committed" || fact === "abandoned_without_claim");}
    else {text(fact);}
  }
}
export function validateOrdinaryOperation(value: unknown): asserts value is OrdinaryOperation {
  record(value, [...bindingKeys, "schemaVersion", "effectClass", "effectId", "commandId", "fingerprint", "scope", "input", "preparation", "revision", "status", "cancellationRequested", "output", "receipts"]);
  requireFact(value.schemaVersion === 3 && value.executionProfile === ORDINARY_PROFILE.executionProfile && value.effectClass === ORDINARY_PROFILE.effectClass && value.capabilityManifestRevision === ORDINARY_PROFILE.capabilityManifestRevision);
  text(value.operationId); text(value.attemptId); text(value.effectId); integer(value.revision);
  validateOrdinaryInput(value.input); record(value.scope, ["projectId", "tenantId"]);
  requireFact(value.input.commandId === value.commandId && value.scope.projectId === value.input.scope.projectId && value.scope.tenantId === value.input.scope.tenantId);
  requireFact(value.fingerprint === containedTurnCommandFingerprint({scope: value.input.scope, intent: value.input.intent, provider: value.input.expectedProvider}));
  requireFact(typeof value.cancellationRequested === "boolean");
  requireFact(["accepted", "running", "succeeded", "failed", "cancelled", "reconcile_required"].includes(String(value.status)));
  requireFact(Array.isArray(value.output) && Array.isArray(value.receipts));
  const output = value.output as unknown[]; const receipts = value.receipts as unknown[];
  assertContainedTurnCanonicalArray(output); assertContainedTurnCanonicalArray(receipts);
  requireFact(output.length <= CONTAINED_TURN_LIMITS.collections.outputChunks && receipts.length <= ORDINARY_REQUIRED_RECEIPTS.length);
  let totalBytes = 0;
  output.forEach((item, index) => {
    record(item, ["cursor", "kind", "text"]); requireFact(item.cursor === index + 1);
    requireFact(item.kind === "assistant" || item.kind === "diagnostic" || item.kind === "progress");
    requireFact(typeof item.text === "string");
    validateContainedTurnText("output", item.text as string, CONTAINED_TURN_LIMITS.text.outputChunk);
    totalBytes += utf8ByteLength(item.text as string);
  });
  requireFact(totalBytes <= CONTAINED_TURN_LIMITS.text.outputTotal.maximumBytes);
  const binding: OrdinaryBinding = {operationId: value.operationId as string, attemptId: value.attemptId as string, ...ORDINARY_PROFILE};
  const kinds = new Set<string>(); const checked: OrdinaryReceipt[] = [];
  for (const receipt of receipts) {validateOrdinaryReceipt(receipt, binding); requireFact(!kinds.has(receipt.kind)); kinds.add(receipt.kind); checked.push(receipt);}
  if (value.preparation !== null) {validateOrdinaryPreparation(value.preparation, binding, value.input);}
  validateOperationReceiptState(value, output, checked, kinds);
}
const validatePreparationReceipts = (value: unknown, checked: readonly OrdinaryReceipt[]): void => {
  if (value !== null) {
    const preparation = value as Record<string, unknown>;
    for (const receipt of checked) {
      if (receipt.kind === "process_group_closed") {requireFact(receipt.reservationId === preparation.reservationId);}
      if (receipt.kind === "workspace_snapshot" || receipt.kind === "artifact_published") {requireFact(receipt.workspaceId === preparation.workspaceId);}
      if (receipt.kind === "credential_retired") {requireFact(receipt.materializationId === preparation.materializationId && receipt.generation === preparation.credentialGeneration);}
      if (receipt.kind === "provider_grant_settled" || receipt.kind === "security_grant_settled") {
        const authority = preparation[receipt.kind === "provider_grant_settled" ? "providerAccess" : "security"] as Record<string, unknown>;
        requireFact(receipt.grantId === authority.grantId && receipt.ownerReceiptId === authority.ownerReceiptId);
      }
    }
  }
};
const validateOperationReceiptState = (value: Record<string, unknown>, output: readonly unknown[], checked: readonly OrdinaryReceipt[], kinds: ReadonlySet<string>): void => {
  const claim = checked.find(item => item.kind === "dispatch_claim");
  if (value.status === "accepted") {requireFact(checked.length === 0 && output.length === 0);}
  if (value.status === "running") {requireFact(claim !== undefined);}
  if (claim !== undefined) {requireFact(claim.committedRevision <= Number(value.revision) && value.preparation !== null); requireFact(claim.preparationDigest === ordinaryPreparationDigest(value.preparation)); requireFact(claim.reservationId === Reflect.get(value.preparation as object, "reservationId"));}
  const drain = checked.find(item => item.kind === "output_drain");
  if (drain !== undefined) {requireFact(drain.finalSequence === output.length);}
  const snapshot = checked.find(item => item.kind === "workspace_snapshot");
  const artifact = checked.find(item => item.kind === "artifact_published");
  if (artifact !== undefined) {requireFact(snapshot !== undefined && artifact.snapshotDigest === snapshot.snapshotDigest && artifact.workspaceId === snapshot.workspaceId);}
  validatePreparationReceipts(value.preparation, checked);
  validateTerminalReceiptState(value, output, checked, kinds, claim !== undefined);
};
const validateTerminalReceiptState = (value: Record<string, unknown>, output: readonly unknown[], checked: readonly OrdinaryReceipt[], kinds: ReadonlySet<string>, claimed: boolean): void => {
  if (value.status === "succeeded" || value.status === "failed" || (value.status === "cancelled" && claimed)) {
    requireFact(ORDINARY_REQUIRED_RECEIPTS.every(kind => kinds.has(kind)));
    const terminal = checked.find(item => item.kind === "provider_terminal");
    requireFact(terminal !== undefined && terminal.terminalStatus === (value.status === "succeeded" ? "completed" : value.status));
    for (const receipt of checked) {if (receipt.kind === "provider_grant_settled" || receipt.kind === "security_grant_settled") {requireFact(receipt.disposition === "claim_committed");}}
  }
  if (value.status === "cancelled" && !claimed) {requireFact(value.cancellationRequested === true && output.length === 0);}
};

export const ordinaryTerminalStatus = (operation: OrdinaryOperation, receipts: readonly OrdinaryReceipt[]): OrdinaryOperation["status"] => {
  const terminal = receipts.find(item => item.kind === "provider_terminal");
  const claim = receipts.find(item => item.kind === "dispatch_claim");
  const status = claim === undefined && operation.cancellationRequested ? "cancelled" : terminal?.terminalStatus === "completed" ? "succeeded" : terminal?.terminalStatus ?? "reconcile_required";
  try {validateOrdinaryOperation({...operation, status, receipts}); return status;} catch {return "reconcile_required";}
};

export function validateOrdinaryPreparation(value: unknown, binding: OrdinaryBinding, input: OrdinaryInput): void {
  record(value, ["providerAccess", "security", "reservationId", "workspaceId", "materializationId", "credentialGeneration"]);
  text(value.reservationId); text(value.workspaceId); text(value.materializationId); integer(value.credentialGeneration, 1);
  for (const [key, owner] of [["providerAccess", "provider_access"], ["security", "runtime_security"]] as const) {
    const authority = value[key];
    record(authority, [...bindingKeys, "owner", "grantId", "ownerReceiptId", "consumptionDigest", "consumptionRevision", "authorityDigest", "expiresAt", "scope", "provider"]);
    for (const field of bindingKeys) {requireFact(authority[field] === binding[field]);}
    requireFact(authority.owner === owner && authority.provider === input.expectedProvider);
    text(authority.grantId); text(authority.ownerReceiptId); digest(authority.consumptionDigest); integer(authority.consumptionRevision, 1); digest(authority.authorityDigest); integer(authority.expiresAt, 1);
    record(authority.scope, ["tenantId", "projectId"]);
    requireFact(authority.scope.tenantId === input.scope.tenantId && authority.scope.projectId === input.scope.projectId);
  }
}
export const ordinaryPreparationDigest = (value: unknown): string => digestContainedTurnCanonicalValue(value as ContainedTurnCanonicalValue);
