export type MaterializationState =
  | "eligible" | "claimed" | "installing" | "materialized" | "cleanup_pending" | "destroyed"
  | "rejected" | "expired" | "reconcile_required" | "quarantined";

export interface MaterializationCommand {
  readonly accessRef: string; readonly attemptId: string; readonly availability: "available";
  readonly bindingRevision: number; readonly credentialBindingDigest: string; readonly credentialGeneration: number;
  readonly custodyId: string; readonly executionGenerationId: string; readonly hostBootId: string; readonly hostInstanceId: string;
  readonly materializationRequestId: string; readonly operationId: string; readonly projectId: string;
  readonly provider: "claude" | "codex"; readonly providerAccountRef: string; readonly providerRouteRef: string;
  readonly purpose: "contained-turn.credential-materialization/v1"; readonly requestDigest: string;
  readonly revocation: "active"; readonly schemaVersion: 1; readonly scopeDigest: string;
  readonly settledConsumptionDigest: string; readonly tenantId: string;
}

export interface MaterializationRecord extends MaterializationCommand {
  readonly observedAtControlTime: number; readonly receiptDigest: string;
  readonly state: MaterializationState; readonly stateRevision: number;
}

const TOKEN = /^[\p{L}\p{N}._:@+-]+$/u;
const DIGEST = /^[\p{L}\p{N}._:+-]+$/u;
const token = (name: string, value: unknown, digest = false): string => {
  if (typeof value !== "string" || value.length === 0 || value.length > 512 || !(digest ? DIGEST : TOKEN).test(value)) {
    throw new TypeError(`${name} must be a bounded primitive token`);
  }
  return value;
};
const positive = (name: string, value: unknown): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {throw new TypeError(`${name} must be a positive safe integer`);}
  return value;
};
const exact = (name: string, value: unknown, keys: readonly string[]): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {throw new TypeError(`${name} must be a data record`);}
  let prototype: unknown; let descriptors: Record<PropertyKey, PropertyDescriptor>;
  try {prototype = Object.getPrototypeOf(value) as unknown; descriptors = Object.getOwnPropertyDescriptors(value);}
  catch {throw new TypeError(`${name} must be stable data`);}
  if (prototype !== Object.prototype && prototype !== null) {throw new TypeError(`${name} must be a plain data record`);}
  if (Reflect.ownKeys(descriptors).some(key => typeof key !== "string") ||
      Object.keys(descriptors).toSorted().join("\0") !== [...keys].toSorted().join("\0")) {
    throw new TypeError(`${name} has an invalid shape`);
  }
  for (const descriptor of Object.values(descriptors)) {
    if (!("value" in descriptor)) {throw new TypeError(`${name} cannot contain accessors`);}
  }
  return Object.fromEntries(keys.map(key => [key, descriptors[key]?.value]));
};

export const MATERIALIZATION_COMMAND_KEYS = [
  "accessRef", "attemptId", "availability", "bindingRevision", "credentialBindingDigest", "credentialGeneration", "custodyId",
  "executionGenerationId", "hostBootId", "hostInstanceId", "materializationRequestId", "operationId", "projectId", "provider",
  "providerAccountRef", "providerRouteRef", "purpose", "requestDigest", "revocation", "schemaVersion", "scopeDigest",
  "settledConsumptionDigest", "tenantId",
] as const;

export const snapshotMaterializationCommand = (value: unknown): MaterializationCommand => {
  const data = exact("materialization command", value, MATERIALIZATION_COMMAND_KEYS);
  if (data.provider !== "claude" && data.provider !== "codex") {throw new TypeError("provider is invalid");}
  if (data.availability !== "available" || data.revocation !== "active" || data.schemaVersion !== 1 ||
      data.purpose !== "contained-turn.credential-materialization/v1") {throw new TypeError("materialization constants are invalid");}
  return Object.freeze({
    accessRef: token("accessRef", data.accessRef), attemptId: token("attemptId", data.attemptId), availability: data.availability,
    bindingRevision: positive("bindingRevision", data.bindingRevision), credentialBindingDigest: token("credentialBindingDigest", data.credentialBindingDigest, true),
    credentialGeneration: positive("credentialGeneration", data.credentialGeneration), custodyId: token("custodyId", data.custodyId),
    executionGenerationId: token("executionGenerationId", data.executionGenerationId), hostBootId: token("hostBootId", data.hostBootId),
    hostInstanceId: token("hostInstanceId", data.hostInstanceId), materializationRequestId: token("materializationRequestId", data.materializationRequestId),
    operationId: token("operationId", data.operationId), projectId: token("projectId", data.projectId), provider: data.provider,
    providerAccountRef: token("providerAccountRef", data.providerAccountRef), providerRouteRef: token("providerRouteRef", data.providerRouteRef),
    purpose: data.purpose, requestDigest: token("requestDigest", data.requestDigest, true), revocation: data.revocation, schemaVersion: data.schemaVersion,
    scopeDigest: token("scopeDigest", data.scopeDigest, true), settledConsumptionDigest: token("settledConsumptionDigest", data.settledConsumptionDigest, true),
    tenantId: token("tenantId", data.tenantId),
  });
};

const STATES: readonly MaterializationState[] = [
  "eligible", "claimed", "installing", "materialized", "cleanup_pending", "destroyed", "rejected", "expired", "reconcile_required", "quarantined",
];
export const snapshotMaterializationRecord = (value: unknown): MaterializationRecord => {
  const data = exact("materialization record", value, [...MATERIALIZATION_COMMAND_KEYS, "observedAtControlTime", "receiptDigest", "state", "stateRevision"]);
  if (!STATES.includes(data.state as MaterializationState)) {throw new TypeError("materialization state is invalid");}
  return Object.freeze({
    ...snapshotMaterializationCommand(Object.fromEntries(MATERIALIZATION_COMMAND_KEYS.map(key => [key, data[key]]))),
    observedAtControlTime: positive("observedAtControlTime", data.observedAtControlTime),
    receiptDigest: token("receiptDigest", data.receiptDigest, true), state: data.state as MaterializationState,
    stateRevision: positive("stateRevision", data.stateRevision),
  });
};

export const canonicalMaterializationJson = (value: unknown): string => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {return JSON.stringify(value);}
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).toSorted().map(key => `${JSON.stringify(key)}:${canonicalMaterializationJson(object[key])}`).join(",")}}`;
};
export const materializationRequestPayload = (command: Omit<MaterializationCommand, "requestDigest">): string =>
  canonicalMaterializationJson(command);
export const materializationReceiptPayload = (record: Omit<MaterializationRecord, "receiptDigest">): string =>
  canonicalMaterializationJson(record);

export const nextMaterializationState = (
  current: MaterializationState, action: "cleanup" | "destroyed" | "installing" | "materialized" | "quarantined" | "reconcile",
): MaterializationState | undefined => {
  if (action === "installing" && current === "claimed") {return "installing";}
  if (action === "materialized" && current === "installing") {return "materialized";}
  if (action === "cleanup" && current === "materialized") {return "cleanup_pending";}
  if (action === "reconcile" && current === "installing") {return "reconcile_required";}
  if ((action === "destroyed" || action === "quarantined") && current === "cleanup_pending") {return action;}
  return undefined;
};
