import {
  MATERIALIZATION_COMMAND_KEYS, materializationReceiptPayload, materializationRequestPayload, nextMaterializationState, snapshotMaterializationCommand,
  snapshotMaterializationRecord, type MaterializationCommand, type MaterializationRecord, type MaterializationState,
} from "../domain/materialization-authorization.js";
import {
  consumptionDigestPayload, settlementDigestPayload, snapshotDispatchBindingHead, snapshotDispatchConsumedReceipt,
  snapshotDispatchSettlementOutcome,
} from "../domain/dispatch-consumption.js";
import type { MaterializationAuthorizationDigest } from "./ports/outbound/materialization-authorization-digest.js";
import type {
  MaterializationAuthorizationRepository, MaterializationAuthorizationTransaction,
} from "./ports/outbound/materialization-authorization-repository.js";

export interface MaterializationAuthorizationDependencies {
  readonly digest: MaterializationAuthorizationDigest;
  readonly repository: MaterializationAuthorizationRepository;
}
type Rejection =
  | "access_changed" | "account_changed" | "already_used_by_another_request" | "availability_changed" | "binding_changed"
  | "binding_revision_changed" | "consumption_not_claim_committed" | "credential_changed" | "credential_rotated"
  | "expired" | "operation_mismatch" | "provider_mismatch" | "revoked" | "route_changed" | "scope_mismatch"
  | "settled_consumption_not_found";
type AuthorizationOutcome =
  | { readonly kind: "claimed" | "observed"; readonly receipt: MaterializationRecord }
  | { readonly kind: "conflict"; readonly reason: "materialization_request_digest_conflict" }
  | { readonly kind: "indeterminate" } | { readonly kind: "invalid"; readonly reason: "invalid_request" }
  | { readonly kind: "rejected"; readonly reason: Rejection; readonly receipt: MaterializationRecord };
type ObservationOutcome =
  | { readonly kind: "indeterminate" | "not_found" } | { readonly kind: "observed"; readonly receipt: MaterializationRecord };
type TransitionOutcome =
  | { readonly kind: "conflict"; readonly reason: "invalid_state_transition" | "materialization_request_digest_conflict" }
  | { readonly kind: "indeterminate" } | { readonly kind: "invalid"; readonly reason: "invalid_request" }
  | { readonly kind: "observed" | "transitioned"; readonly receipt: MaterializationRecord };
export interface MaterializationAuthorizationUseCase {
  acknowledgeCleanup(input: unknown): Promise<TransitionOutcome>;
  authorize(input: unknown): Promise<AuthorizationOutcome>;
  observe(input: unknown): Promise<ObservationOutcome>;
  transition(input: unknown): Promise<TransitionOutcome>;
}

const canonicalDigest = async (digest: MaterializationAuthorizationDigest, payload: string): Promise<string> => {
  const value = await digest.digest(payload);
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(value)) {throw new TypeError("digest result is invalid");}
  return value;
};
const withoutRequestDigest = (command: MaterializationCommand): Omit<MaterializationCommand, "requestDigest"> => {
  const exact = snapshotMaterializationCommand(Object.fromEntries(MATERIALIZATION_COMMAND_KEYS.map(key => [key, command[key]])));
  const { requestDigest: _requestDigest, ...unsigned } = exact; return unsigned;
};
const withoutReceiptDigest = (record: MaterializationRecord): Omit<MaterializationRecord, "receiptDigest"> => {
  const { receiptDigest: _receiptDigest, ...unsigned } = record; return unsigned;
};
const verifiedRecord = async (
  value: unknown, digest: MaterializationAuthorizationDigest, expectedId?: string,
): Promise<MaterializationRecord> => {
  const record = snapshotMaterializationRecord(value);
  if (expectedId !== undefined && record.materializationRequestId !== expectedId) {throw new TypeError("materialization record identity mismatch");}
  if (await canonicalDigest(digest, materializationRequestPayload(withoutRequestDigest(record))) !== record.requestDigest ||
      await canonicalDigest(digest, materializationReceiptPayload(withoutReceiptDigest(record))) !== record.receiptDigest) {
    throw new TypeError("materialization record digest mismatch");
  }
  return record;
};
const recordFor = async (
  command: MaterializationCommand, state: MaterializationState, stateRevision: number, observedAtControlTime: number,
  digest: MaterializationAuthorizationDigest,
): Promise<MaterializationRecord> => {
  const base = snapshotMaterializationCommand(Object.fromEntries(MATERIALIZATION_COMMAND_KEYS.map(key => [key, command[key]])));
  const unsigned = { ...base, observedAtControlTime, state, stateRevision };
  return snapshotMaterializationRecord({ ...unsigned, receiptDigest: await canonicalDigest(digest, materializationReceiptPayload(unsigned)) });
};
const receipt = (record: MaterializationRecord): MaterializationRecord => record;
const sameOwnerScope = (record: MaterializationRecord, selector: {
  readonly projectId: string; readonly provider: string; readonly scopeDigest: string; readonly tenantId: string;
}): boolean => record.tenantId === selector.tenantId && record.projectId === selector.projectId &&
  record.provider === selector.provider && record.scopeDigest === selector.scopeDigest;
const settledRecordEligibility = (
  command: MaterializationCommand, consumption: ReturnType<typeof snapshotDispatchConsumedReceipt>,
  settlement: Extract<ReturnType<typeof snapshotDispatchSettlementOutcome>, { readonly kind: "settled" }>,
): Rejection | undefined => {
  if (settlement.receipt.disposition !== "claim_committed") {return "consumption_not_claim_committed";}
  if (consumption.operationId !== command.operationId || settlement.receipt.operationId !== command.operationId) {return "operation_mismatch";}
  if (consumption.provider !== command.provider || settlement.receipt.provider !== command.provider) {return "provider_mismatch";}
  if (consumption.scope.tenantId !== command.tenantId || consumption.scope.projectId !== command.projectId ||
      consumption.scope.scopeDigest !== command.scopeDigest) {return "scope_mismatch";}
  return undefined;
};
const headStatusEligibility = (
  command: MaterializationCommand, head: ReturnType<typeof snapshotDispatchBindingHead>, now: number,
): Rejection | undefined => {
  if (now >= head.expiresAtControlTime) {return "expired";}
  if (head.revocation !== "active") {return "revoked";}
  if (head.availability !== "available") {return "availability_changed";}
  if (head.tenantId !== command.tenantId || head.projectId !== command.projectId || head.scopeDigest !== command.scopeDigest) {return "scope_mismatch";}
  if (head.provider !== command.provider) {return "provider_mismatch";}
  return undefined;
};
const bindingDriftEligibility = (
  command: MaterializationCommand, consumption: ReturnType<typeof snapshotDispatchConsumedReceipt>,
  settlement: Extract<ReturnType<typeof snapshotDispatchSettlementOutcome>, { readonly kind: "settled" }>,
  head: ReturnType<typeof snapshotDispatchBindingHead>,
): Rejection | undefined => {
  if (head.accessRef !== command.accessRef || consumption.accessRef !== command.accessRef) {return "access_changed";}
  if (head.providerAccountRef !== command.providerAccountRef || consumption.providerAccountRef !== command.providerAccountRef) {return "account_changed";}
  if (head.providerRouteRef !== command.providerRouteRef || consumption.providerRouteRef !== command.providerRouteRef) {return "route_changed";}
  if (head.bindingRevision !== command.bindingRevision || consumption.bindingRevision !== command.bindingRevision) {return "binding_revision_changed";}
  if (head.authorityHeadDigest !== consumption.authorityHeadDigestAtConsumption || head.bindingDigest !== consumption.bindingDigest ||
      head.acceptedAuthorityDigest !== consumption.acceptedAuthorityDigest ||
      settlement.receipt.expectedBinding.authorityHeadDigest !== consumption.authorityHeadDigestAtConsumption ||
      settlement.receipt.expectedBinding.bindingDigest !== consumption.bindingDigest ||
      settlement.receipt.expectedBinding.acceptedAuthorityDigest !== consumption.acceptedAuthorityDigest) {return "binding_changed";}
  if (head.credentialGeneration !== command.credentialGeneration || consumption.credentialGeneration !== command.credentialGeneration) {return "credential_rotated";}
  if (head.credentialBindingDigest !== command.credentialBindingDigest || consumption.credentialBindingDigest !== command.credentialBindingDigest) {
    return "credential_changed";
  }
  return undefined;
};
const settledEligibility = async (
  command: MaterializationCommand, transaction: MaterializationAuthorizationTransaction, now: number,
  transactionDigest: MaterializationAuthorizationDigest,
): Promise<Rejection | undefined> => {
  const rawConsumption = await transaction.findConsumption();
  const rawSettlement = await transaction.findSettlementByConsumption();
  if (rawConsumption === undefined || rawSettlement === undefined) {return "settled_consumption_not_found";}
  const consumption = snapshotDispatchConsumedReceipt(rawConsumption);
  const settlement = snapshotDispatchSettlementOutcome(rawSettlement);
  if (await canonicalDigest(transactionDigest, consumptionDigestPayload(consumption)) !== consumption.consumptionDigest) {
    throw new TypeError("consumption digest is corrupt");
  }
  if (settlement.kind !== "settled" || settlement.receipt.consumptionDigest !== command.settledConsumptionDigest) {
    return "settled_consumption_not_found";
  }
  if (await canonicalDigest(transactionDigest, settlementDigestPayload(settlement.receipt)) !== settlement.receipt.settlementDigest) {
    throw new TypeError("settlement digest is corrupt");
  }
  const settledReason = settledRecordEligibility(command, consumption, settlement);
  if (settledReason !== undefined) {return settledReason;}
  const rawHead = await transaction.findBindingHead();
  if (rawHead === undefined) {return "settled_consumption_not_found";}
  const head = snapshotDispatchBindingHead(rawHead);
  return headStatusEligibility(command, head, now) ?? bindingDriftEligibility(command, consumption, settlement, head);
};

const authorizationInTransaction = async (
  command: MaterializationCommand, transaction: MaterializationAuthorizationTransaction, dependencies: MaterializationAuthorizationDependencies,
): Promise<AuthorizationOutcome> => {
  const existingRaw = await transaction.findMaterializationRequest();
  if (existingRaw !== undefined) {
    const existing = await verifiedRecord(existingRaw, dependencies.digest, command.materializationRequestId);
    if (existing.requestDigest !== command.requestDigest ||
        materializationRequestPayload(withoutRequestDigest(existing)) !== materializationRequestPayload(withoutRequestDigest(command))) {
      return Object.freeze({ kind: "conflict", reason: "materialization_request_digest_conflict" });
    }
    return Object.freeze({ kind: "observed", receipt: receipt(existing) });
  }
  if (await canonicalDigest(dependencies.digest, materializationRequestPayload(withoutRequestDigest(command))) !== command.requestDigest) {
    return Object.freeze({ kind: "invalid", reason: "invalid_request" });
  }
  const usedRaw = await transaction.findMaterializationByConsumption();
  if (usedRaw !== undefined) {
    await verifiedRecord(usedRaw, dependencies.digest);
    const now = await transaction.controlTime();
    const rejected = await recordFor(command, "rejected", 1, now, dependencies.digest);
    await transaction.saveMaterialization(rejected);
    return Object.freeze({ kind: "rejected", reason: "already_used_by_another_request", receipt: receipt(rejected) });
  }
  const now = await transaction.controlTime();
  const reason = await settledEligibility(command, transaction, now, dependencies.digest);
  const state: MaterializationState = reason === "expired" ? "expired" : reason === undefined ? "claimed" : "rejected";
  const persisted = await recordFor(command, state, 1, now, dependencies.digest);
  await transaction.saveMaterialization(persisted);
  if (reason !== undefined) {return Object.freeze({ kind: "rejected", reason, receipt: receipt(persisted) });}
  return Object.freeze({ kind: "claimed", receipt: receipt(persisted) });
};

const desiredAction = (transition: string): "cleanup" | "installing" | "materialized" | "reconcile" => {
  if (transition === "installation_may_have_begun") {return "installing";}
  if (transition === "cleanup_pending") {return "cleanup";}
  if (transition === "reconcile_required") {return "reconcile";}
  return "materialized";
};
const actionAlreadyReached = (state: MaterializationState, action: "cleanup" | "destroyed" | "installing" | "materialized" | "quarantined" | "reconcile"): boolean => {
  if (action === "installing") {return ["installing", "materialized", "cleanup_pending", "destroyed", "quarantined", "reconcile_required"].includes(state);}
  if (action === "materialized") {return ["materialized", "cleanup_pending", "destroyed", "quarantined"].includes(state);}
  if (action === "cleanup") {return ["cleanup_pending", "destroyed", "quarantined"].includes(state);}
  return state === action || (action === "reconcile" && state === "reconcile_required");
};
const transitionInTransaction = async (
  selector: BoundaryInput, action: "cleanup" | "destroyed" | "installing" | "materialized" | "quarantined" | "reconcile",
  transaction: MaterializationAuthorizationTransaction, dependencies: MaterializationAuthorizationDependencies,
): Promise<TransitionOutcome> => {
  const raw = await transaction.findMaterializationRequest();
  if (raw === undefined) {return Object.freeze({ kind: "conflict", reason: "invalid_state_transition" });}
  const current = await verifiedRecord(raw, dependencies.digest, selector.materializationRequestId);
  if (current.requestDigest !== selector.requestDigest) {return Object.freeze({ kind: "conflict", reason: "materialization_request_digest_conflict" });}
  if (!sameOwnerScope(current, selector)) {return Object.freeze({ kind: "indeterminate" });}
  const next = nextMaterializationState(current.state, action);
  if (next === undefined) {
    if (actionAlreadyReached(current.state, action)) {
      return Object.freeze({ kind: "observed", receipt: receipt(current) });
    }
    return Object.freeze({ kind: "conflict", reason: "invalid_state_transition" });
  }
  const now = await transaction.controlTime();
  const updated = await recordFor(current, next, current.stateRevision + 1, now, dependencies.digest);
  await transaction.saveMaterialization(updated);
  return Object.freeze({ kind: "transitioned", receipt: receipt(updated) });
};

export const createCredentialMaterializationAuthorizationV1 = (
  dependencies: MaterializationAuthorizationDependencies,
): MaterializationAuthorizationUseCase => Object.freeze({
  async acknowledgeCleanup(input: unknown): Promise<TransitionOutcome> {
    try {
      const command = snapshotTransitionInput(input, ["materializationRequestId", "outcome", "projectId", "provider", "requestDigest", "scopeDigest", "tenantId"]);
      if (command.outcome !== "destroyed" && command.outcome !== "quarantined") {throw new TypeError("cleanup outcome is invalid");}
      return await dependencies.repository.transact(emptySelector(command), transaction =>
        transitionInTransaction(command, command.outcome as "destroyed" | "quarantined", transaction, dependencies));
    } catch {return Object.freeze({ kind: "indeterminate" });}
  },
  async authorize(input: unknown): Promise<AuthorizationOutcome> {
    let command: MaterializationCommand;
    try {command = snapshotMaterializationCommand(input);}
    catch {return Object.freeze({ kind: "invalid", reason: "invalid_request" });}
    try {
      return await dependencies.repository.transact(selector(command), transaction => authorizationInTransaction(command, transaction, dependencies));
    } catch {return Object.freeze({ kind: "indeterminate" });}
  },
  async observe(input: unknown): Promise<ObservationOutcome> {
    try {
      const command = snapshotTransitionInput(input, ["materializationRequestId", "projectId", "provider", "requestDigest", "scopeDigest", "tenantId"]);
      if (command.provider !== "claude" && command.provider !== "codex") {throw new TypeError("provider is invalid");}
      const raw = await dependencies.repository.observeMaterializationRequest(command.materializationRequestId);
      if (raw === undefined) {return Object.freeze({ kind: "not_found" });}
      const found = await verifiedRecord(raw, dependencies.digest, command.materializationRequestId);
      if (!sameOwnerScope(found, command)) {return Object.freeze({ kind: "not_found" });}
      if (found.requestDigest !== command.requestDigest) {return Object.freeze({ kind: "indeterminate" });}
      return Object.freeze({ kind: "observed", receipt: receipt(found) });
    } catch {return Object.freeze({ kind: "indeterminate" });}
  },
  async transition(input: unknown): Promise<TransitionOutcome> {
    try {
      const command = snapshotTransitionInput(input, ["materializationRequestId", "projectId", "provider", "requestDigest", "scopeDigest", "tenantId", "transition"]);
      const allowed = ["installation_may_have_begun", "materialized", "cleanup_pending", "reconcile_required"];
      if (!allowed.includes(command.transition as string)) {throw new TypeError("transition is invalid");}
      return await dependencies.repository.transact(emptySelector(command), transaction =>
        transitionInTransaction(command, desiredAction(command.transition as string), transaction, dependencies));
    } catch {return Object.freeze({ kind: "indeterminate" });}
  },
});

type BoundaryInput = Readonly<Record<string, string> & {
  materializationRequestId: string; projectId: string; provider: string; requestDigest: string; scopeDigest: string; tenantId: string;
}>;
const snapshotTransitionInput = (input: unknown, keys: readonly string[]): BoundaryInput => {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {throw new TypeError("input must be a record");}
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (Object.keys(descriptors).toSorted().join("\0") !== [...keys].toSorted().join("\0") || Reflect.ownKeys(descriptors).some(key => typeof key !== "string")) {
    throw new TypeError("input has an invalid shape");
  }
  const result: Record<string, string> = {};
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (descriptor === undefined || !("value" in descriptor) || typeof descriptor.value !== "string" || descriptor.value.length === 0 || descriptor.value.length > 512) {
      throw new TypeError("input has invalid values");
    }
    result[key] = descriptor.value;
  }
  return Object.freeze(result) as BoundaryInput;
};
const selector = (command: MaterializationCommand) => Object.freeze({
  materializationRequestId: command.materializationRequestId, projectId: command.projectId, provider: command.provider,
  scopeDigest: command.scopeDigest, settledConsumptionDigest: command.settledConsumptionDigest, tenantId: command.tenantId,
});
const emptySelector = (command: BoundaryInput) => Object.freeze({
  materializationRequestId: command.materializationRequestId, projectId: command.projectId,
  provider: command.provider === "claude" ? "claude" as const : "codex" as const, scopeDigest: command.scopeDigest ?? "invalid",
  settledConsumptionDigest: "unknown", tenantId: command.tenantId,
});
