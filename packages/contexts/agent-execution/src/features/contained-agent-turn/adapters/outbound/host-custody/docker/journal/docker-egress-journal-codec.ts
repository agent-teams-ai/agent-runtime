import { createHash } from "node:crypto";
import { types } from "node:util";

import { parseStrictJson } from "../serialization/strict-json.js";
import {
  DEFAULT_DOCKER_EGRESS_JOURNAL_LIMITS,
  DOCKER_EGRESS_JOURNAL_VERSION,
  DOCKER_EGRESS_RESOURCE_KINDS,
  DockerEgressJournalCorruptionError,
  type DockerEgressAuthorityBinding,
  type DockerEgressCleanupObservation,
  type DockerEgressIdentity,
  type DockerEgressJournalEvent,
  type DockerEgressJournalLimits,
  type DockerEgressJournalRecord,
  type DockerEgressJournalSubject,
  type DockerEgressQuarantineDiagnostic,
  type DockerEgressReconcileReason,
  type DockerEgressReservation,
  type DockerEgressResourceIdentities,
  type DockerEgressResourceKind,
  type DockerEgressTombstone,
  type DockerEgressTrustedRuntimeIdentity,
} from "./docker-egress-journal-types.js";

const DIGEST = /^[a-f0-9]{64}$/u;
const RECORD_KEYS = [
  "checksumSha256", "commandDigestSha256", "commandId", "event", "previousChecksumSha256", "sequence", "subject", "version",
] as const;
const SUBJECT_KEYS = ["authority", "bindingSha256", "identity", "resources"] as const;
const IDENTITY_KEYS = [
  "attemptId", "custodyId", "daemonGenerationId", "daemonId", "effectId", "exactFingerprintSha256",
  "executionGenerationId", "hostBootId", "hostInstanceId", "hostSlotId", "operationId", "slotGenerationId", "workspaceId",
] as const;
const AUTHORITY_KEYS = [
  "acceptedAuthoritySha256", "brokerPolicySha256", "materializationAuthorizationSha256", "operationSha256",
  "routeAuthorizationSha256", "scopeSha256",
] as const;
const RESOURCE_KEYS = [
  "brokerCgroupHandle", "brokerInboundSocketHandle", "brokerListenerHandle", "brokerNamespaceHandle", "brokerProcessHandle",
  "brokerUpstreamSocketHandle", "networkEndpointHandle", "privateNetworkHandle", "providerContainerHandle", "providerEndpointHandle",
  "upstreamRuleHandle",
] as const;
const OBSERVATION_KEYS = [
  "capabilityRevisionSha256", "cleanupHandle", "daemonGenerationId", "daemonId", "executionGenerationId", "hostBootId",
  "hostInstanceId", "observationSha256", "observerId", "resource", "result", "scopeSha256", "slotGenerationId",
] as const;
const TRUSTED_KEYS = [
  "daemonGenerationId", "daemonId", "executionGenerationId", "hostBootId", "hostInstanceId", "hostSlotId", "scopeSha256",
  "slotGenerationId",
] as const;
const TOMBSTONE_KEYS = ["bindingSha256", "checksumSha256", "disposition", "locatorSha256", "terminalRecord", "version"] as const;

const ID_PREFIXES: Readonly<Record<Exclude<keyof DockerEgressIdentity, "exactFingerprintSha256">, string>> = Object.freeze({
  operationId: "operation:", attemptId: "attempt:", effectId: "effect:", custodyId: "custody:", workspaceId: "workspace:",
  hostSlotId: "host-slot:", hostInstanceId: "host-instance:", hostBootId: "host-boot:",
  executionGenerationId: "execution-generation:", daemonId: "daemon:", daemonGenerationId: "daemon-generation:",
  slotGenerationId: "slot-generation:",
});
const RESOURCE_PREFIXES: Readonly<Record<keyof DockerEgressResourceIdentities, string>> = Object.freeze({
  privateNetworkHandle: "private-network-handle:", brokerNamespaceHandle: "broker-netns-handle:",
  brokerCgroupHandle: "broker-cgroup-handle:", brokerProcessHandle: "broker-process-handle:",
  brokerListenerHandle: "broker-listener-handle:", brokerInboundSocketHandle: "broker-inbound-socket-handle:",
  brokerUpstreamSocketHandle: "broker-upstream-socket-handle:", providerEndpointHandle: "provider-endpoint-handle:",
  networkEndpointHandle: "network-endpoint-handle:", upstreamRuleHandle: "upstream-rule-handle:",
  providerContainerHandle: "provider-container-handle:",
});
const RESOURCE_HANDLE: Readonly<Record<DockerEgressResourceKind, keyof DockerEgressResourceIdentities>> = Object.freeze({
  private_network: "privateNetworkHandle", broker_namespace: "brokerNamespaceHandle", broker_cgroup: "brokerCgroupHandle",
  broker_process: "brokerProcessHandle", broker_listener: "brokerListenerHandle",
  broker_inbound_socket: "brokerInboundSocketHandle", broker_upstream_socket: "brokerUpstreamSocketHandle",
  provider_endpoint: "providerEndpointHandle", network_endpoint: "networkEndpointHandle", upstream_rule: "upstreamRuleHandle",
  provider_container: "providerContainerHandle",
});
const RECONCILE_REASONS: readonly DockerEgressReconcileReason[] = Object.freeze([
  "acknowledgement_unknown", "cleanup_failed", "cleanup_observation_unknown", "journal_corrupt", "legacy_incompatible",
  "legacy_malformed", "identity_stale",
]);
const QUARANTINE_DIAGNOSTICS: readonly DockerEgressQuarantineDiagnostic[] = Object.freeze([
  "cleanup_incomplete", "journal_corrupt", "identity_stale", "locator_mismatch", "legacy_unsafe", "unsafe_entry",
]);

const sha256 = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");
const orderedClosedValue = (item: unknown): unknown => {
    if (Array.isArray(item)) { return item.map(orderedClosedValue); }
    if (item === null || typeof item !== "object") { return item; }
    return Object.fromEntries(Object.keys(item).toSorted().map(key => [key, orderedClosedValue((item as Record<string, unknown>)[key])]));
};
const canonicalClosed = (value: null | boolean | number | string | readonly unknown[] | Readonly<Record<string, unknown>>): string =>
  JSON.stringify(orderedClosedValue(value));

const assertExact: (value: unknown, keys: readonly string[], label: string) => asserts value is Record<string, unknown> =
  (value, keys, label) => {
    if (value === null || typeof value !== "object" || types.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) {
      throw new TypeError(`${label} must be a plain non-proxy object`);
    }
    const own = Reflect.ownKeys(value); const descriptors = Object.getOwnPropertyDescriptors(value);
    if (own.some(key => typeof key !== "string") || (own as string[]).toSorted().join("\0") !== [...keys].toSorted().join("\0") ||
        Object.values(descriptors).some(item => !("value" in item) || !item.enumerable)) {
      throw new TypeError(`${label} must have its exact data-only shape`);
    }
  };
const digest = (value: unknown, label: string): string => {
  if (typeof value !== "string" || !DIGEST.test(value)) { throw new TypeError(`${label} must be a lowercase SHA-256 digest`); }
  return value;
};
const fixed = (value: unknown, prefix: string, label: string): string => {
  if (typeof value !== "string" || value.length !== prefix.length + 64 || !value.startsWith(prefix) ||
      !DIGEST.test(value.slice(prefix.length))) { throw new TypeError(`${label} must be an adapter-issued fixed-format opaque handle`); }
  return value;
};
const safeInteger = (value: unknown, label: string, allowZero = true): number => {
  if (!Number.isSafeInteger(value) || (value as number) < (allowZero ? 0 : 1)) { throw new TypeError(`${label} must be a bounded integer`); }
  return value as number;
};

const identityFrom = (value: unknown): DockerEgressIdentity => {
  assertExact(value, IDENTITY_KEYS, "egress identity");
  const result: Record<string, string> = {};
  for (const [key, prefix] of Object.entries(ID_PREFIXES)) { result[key] = fixed(value[key], prefix, key); }
  result.exactFingerprintSha256 = digest(value.exactFingerprintSha256, "exactFingerprintSha256");
  return Object.freeze(result) as unknown as DockerEgressIdentity;
};
const authorityFrom = (value: unknown): DockerEgressAuthorityBinding => {
  assertExact(value, AUTHORITY_KEYS, "egress authority binding");
  return Object.freeze(Object.fromEntries(AUTHORITY_KEYS.map(key => [key, digest(value[key], key)]))) as unknown as DockerEgressAuthorityBinding;
};
const resourcesFrom = (value: unknown): DockerEgressResourceIdentities => {
  assertExact(value, RESOURCE_KEYS, "egress cleanup handles");
  const result = Object.fromEntries(RESOURCE_KEYS.map(key => [key, fixed(value[key], RESOURCE_PREFIXES[key], key)]));
  const opaqueParts = Object.values(result).map(handle => handle.slice(handle.indexOf(":") + 1));
  if (new Set(opaqueParts).size !== RESOURCE_KEYS.length) { throw new TypeError("cleanup handles must be pairwise unique"); }
  return Object.freeze(result) as unknown as DockerEgressResourceIdentities;
};
const subjectBody = (identity: DockerEgressIdentity, authority: DockerEgressAuthorityBinding,
  resources: DockerEgressResourceIdentities): Readonly<Record<string, unknown>> => ({
  contract: "agent-runtime-host-egress-custody/v3", authority, identity, resources,
});
export const dockerEgressBindingSha256 = (input: Readonly<{
  identity: DockerEgressIdentity; authority: DockerEgressAuthorityBinding; resources: DockerEgressResourceIdentities;
}>): string => {
  const identity = identityFrom(input.identity); const authority = authorityFrom(input.authority); const resources = resourcesFrom(input.resources);
  return sha256(canonicalClosed(subjectBody(identity, authority, resources)));
};
export const createDockerEgressSubject = (input: Readonly<{
  identity: DockerEgressIdentity; authority: DockerEgressAuthorityBinding; resources: DockerEgressResourceIdentities;
}>): DockerEgressJournalSubject => {
  const identity = identityFrom(input.identity); const authority = authorityFrom(input.authority); const resources = resourcesFrom(input.resources);
  return Object.freeze({ identity, authority, resources, bindingSha256: sha256(canonicalClosed(subjectBody(identity, authority, resources))) });
};
export const validateDockerEgressSubject = (value: unknown): DockerEgressJournalSubject => {
  assertExact(value, SUBJECT_KEYS, "egress journal subject");
  const subject = createDockerEgressSubject({
    identity: value.identity as DockerEgressIdentity, authority: value.authority as DockerEgressAuthorityBinding,
    resources: value.resources as DockerEgressResourceIdentities,
  });
  if (digest(value.bindingSha256, "bindingSha256") !== subject.bindingSha256) { throw new TypeError("subject binding mismatch"); }
  return subject;
};

export const validateDockerEgressTrustedIdentity = (value: unknown): DockerEgressTrustedRuntimeIdentity => {
  assertExact(value, TRUSTED_KEYS, "trusted runtime identity");
  return Object.freeze({
    scopeSha256: digest(value.scopeSha256, "scopeSha256"), hostSlotId: fixed(value.hostSlotId, "host-slot:", "hostSlotId"),
    hostInstanceId: fixed(value.hostInstanceId, "host-instance:", "hostInstanceId"),
    hostBootId: fixed(value.hostBootId, "host-boot:", "hostBootId"),
    executionGenerationId: fixed(value.executionGenerationId, "execution-generation:", "executionGenerationId"),
    daemonId: fixed(value.daemonId, "daemon:", "daemonId"),
    daemonGenerationId: fixed(value.daemonGenerationId, "daemon-generation:", "daemonGenerationId"),
    slotGenerationId: fixed(value.slotGenerationId, "slot-generation:", "slotGenerationId"),
  });
};
export const dockerEgressCleanupHandle = (subject: DockerEgressJournalSubject, resource: DockerEgressResourceKind): string =>
  validateDockerEgressSubject(subject).resources[RESOURCE_HANDLE[resource]];

const observationBody = (value: Omit<DockerEgressCleanupObservation, "observationSha256">): Readonly<Record<string, unknown>> =>
  ({ contract: "docker-egress-cleanup-observation/v1", ...value });
export const createDockerEgressCleanupObservation = (input: Omit<DockerEgressCleanupObservation, "observationSha256">): DockerEgressCleanupObservation => {
  const checked = observationFrom({ ...input, observationSha256: "0".repeat(64) }, false);
  const { observationSha256: _observationSha256, ...body } = checked;
  return Object.freeze({ ...body, observationSha256: sha256(canonicalClosed(observationBody(body))) });
};
const resourceFrom = (value: unknown): DockerEgressResourceKind => {
  if (typeof value !== "string" || !DOCKER_EGRESS_RESOURCE_KINDS.includes(value as DockerEgressResourceKind)) { throw new TypeError("unknown resource"); }
  return value as DockerEgressResourceKind;
};
const observationFrom = (value: unknown, verify = true): DockerEgressCleanupObservation => {
  assertExact(value, OBSERVATION_KEYS, "cleanup absence observation");
  if (value.result !== "absent") { throw new TypeError("cleanup observation must prove absence"); }
  const result = Object.freeze({
    resource: resourceFrom(value.resource), cleanupHandle: fixed(value.cleanupHandle, RESOURCE_PREFIXES[RESOURCE_HANDLE[resourceFrom(value.resource)]], "cleanupHandle"),
    scopeSha256: digest(value.scopeSha256, "scopeSha256"), hostInstanceId: fixed(value.hostInstanceId, "host-instance:", "hostInstanceId"),
    hostBootId: fixed(value.hostBootId, "host-boot:", "hostBootId"),
    executionGenerationId: fixed(value.executionGenerationId, "execution-generation:", "executionGenerationId"),
    daemonId: fixed(value.daemonId, "daemon:", "daemonId"), daemonGenerationId: fixed(value.daemonGenerationId, "daemon-generation:", "daemonGenerationId"),
    slotGenerationId: fixed(value.slotGenerationId, "slot-generation:", "slotGenerationId"),
    observerId: fixed(value.observerId, "observer:", "observerId"), capabilityRevisionSha256: digest(value.capabilityRevisionSha256, "capabilityRevisionSha256"),
    result: "absent" as const, observationSha256: digest(value.observationSha256, "observationSha256"),
  });
  if (verify) {
    const { observationSha256, ...body } = result;
    if (observationSha256 !== sha256(canonicalClosed(observationBody(body)))) { throw new TypeError("cleanup observation digest mismatch"); }
  }
  return result;
};

const reservationFrom = (value: unknown): DockerEgressReservation => {
  assertExact(value, ["byteCount", "recordCount"], "capacity reservation");
  return Object.freeze({ byteCount: safeInteger(value.byteCount, "byteCount", false), recordCount: safeInteger(value.recordCount, "recordCount", false) });
};
const intentFrom = (value: Record<string, unknown>, kind: "materialize_intent" | "cleanup_intent") => {
  assertExact(value, ["kind", "reservation", "resource"], "egress event");
  return Object.freeze({ kind, reservation: reservationFrom(value.reservation), resource: resourceFrom(value.resource) });
};
const eventFrom = (value: unknown): DockerEgressJournalEvent => {
  if (value === null || typeof value !== "object" || types.isProxy(value)) { throw new TypeError("event must be plain data"); }
  const record = value as Record<string, unknown>; const kind = Object.getOwnPropertyDescriptor(record, "kind")?.value;
  switch (kind) {
    case "open_intent": case "closed": assertExact(record, ["kind"], "egress event"); return Object.freeze({ kind });
    case "materialize_intent": case "cleanup_intent": return intentFrom(record, kind);
    case "materialize_receipt": assertExact(record, ["kind", "resource"], "egress event");
      return Object.freeze({ kind, resource: resourceFrom(record.resource) });
    case "cleanup_receipt": assertExact(record, ["kind", "observation", "resource"], "egress event");
      return Object.freeze({ kind, observation: observationFrom(record.observation), resource: resourceFrom(record.resource) });
    case "reconcile_required": {
      assertExact(record, ["kind", "reason", "resource"], "egress event");
      if (typeof record.reason !== "string" || !RECONCILE_REASONS.includes(record.reason as DockerEgressReconcileReason)) { throw new TypeError("unknown reason"); }
      return Object.freeze({ kind, reason: record.reason as DockerEgressReconcileReason,
        resource: record.resource === null ? null : resourceFrom(record.resource) });
    }
    case "quarantined": assertExact(record, ["diagnostic", "kind"], "egress event");
      if (typeof record.diagnostic !== "string" || !QUARANTINE_DIAGNOSTICS.includes(record.diagnostic as DockerEgressQuarantineDiagnostic)) { throw new TypeError("unknown diagnostic"); }
      return Object.freeze({ diagnostic: record.diagnostic as DockerEgressQuarantineDiagnostic, kind });
    default: throw new TypeError("unknown event");
  }
};

const recordBody = (record: Omit<DockerEgressJournalRecord, "checksumSha256">): string => canonicalClosed(record);
export const createDockerEgressRecord = (input: Readonly<{
  sequence: number; subject: DockerEgressJournalSubject; commandId: string; event: DockerEgressJournalEvent;
  previousChecksumSha256: string | null;
}>): DockerEgressJournalRecord => {
  const sequence = safeInteger(input.sequence, "sequence"); const subject = validateDockerEgressSubject(input.subject);
  const commandId = fixed(input.commandId, "command:", "commandId"); const event = eventFrom(input.event);
  const previousChecksumSha256 = input.previousChecksumSha256 === null ? null : digest(input.previousChecksumSha256, "previous checksum");
  const commandDigestSha256 = sha256(canonicalClosed({ commandId, event, previousChecksumSha256, sequence, subjectBindingSha256: subject.bindingSha256 }));
  const body = Object.freeze({ version: DOCKER_EGRESS_JOURNAL_VERSION, sequence, subject, commandId, commandDigestSha256, event, previousChecksumSha256 });
  return Object.freeze({ ...body, checksumSha256: sha256(recordBody(body)) });
};
const recordFrom = (value: unknown): DockerEgressJournalRecord => {
  assertExact(value, RECORD_KEYS, "journal record");
  if (value.version !== DOCKER_EGRESS_JOURNAL_VERSION) { throw new TypeError("unknown version"); }
  const candidate = createDockerEgressRecord({ sequence: value.sequence as number, subject: value.subject as DockerEgressJournalSubject,
    commandId: value.commandId as string, event: value.event as DockerEgressJournalEvent,
    previousChecksumSha256: value.previousChecksumSha256 as string | null });
  if (digest(value.commandDigestSha256, "command digest") !== candidate.commandDigestSha256 ||
      digest(value.checksumSha256, "record checksum") !== candidate.checksumSha256) { throw new TypeError("record digest mismatch"); }
  return candidate;
};
const parsedPlain = (value: unknown): unknown => {
  if (Array.isArray(value)) { return value.map(parsedPlain); }
  if (value === null || typeof value !== "object") { return value; }
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, parsedPlain(item)]));
};
export const encodeDockerEgressRecord = (record: DockerEgressJournalRecord,
  limits: DockerEgressJournalLimits = DEFAULT_DOCKER_EGRESS_JOURNAL_LIMITS): Uint8Array => {
  const bytes = Buffer.from(`${canonicalClosed({ ...recordFrom(record) })}\n`, "utf8");
  if (bytes.byteLength > limits.maxRecordBytes) { throw new DockerEgressJournalCorruptionError("record bound exceeded"); }
  return bytes;
};
export interface DockerEgressReplay { readonly records: readonly DockerEgressJournalRecord[]; readonly tail: "complete" | "partial"; }
export const replayDockerEgressBytes = (bytes: Uint8Array,
  limits: DockerEgressJournalLimits = DEFAULT_DOCKER_EGRESS_JOURNAL_LIMITS): DockerEgressReplay => {
  if (bytes.byteLength > limits.maxJournalBytes) { throw new DockerEgressJournalCorruptionError("journal bound exceeded"); }
  const records: DockerEgressJournalRecord[] = []; let start = 0;
  for (let index = 0; index < bytes.byteLength; index += 1) {
    if (bytes[index] !== 0x0a) { continue; }
    try {
      const line = bytes.subarray(start, index);
      if (line.byteLength === 0 || line.byteLength + 1 > limits.maxRecordBytes || records.length >= limits.maxRecordsPerJournal) { throw new Error("journal record bound exceeded"); }
      const record = recordFrom(parsedPlain(parseStrictJson(line))); const previous = records.at(-1);
      if (record.sequence !== records.length || record.previousChecksumSha256 !== (previous?.checksumSha256 ?? null) ||
          (previous !== undefined && record.subject.bindingSha256 !== previous.subject.bindingSha256)) { throw new Error("journal chain mismatch"); }
      records.push(record); start = index + 1;
    } catch {
      if (records.length === 0) { throw new DockerEgressJournalCorruptionError(); }
      return Object.freeze({ records: Object.freeze(records), tail: "partial" });
    }
  }
  return Object.freeze({ records: Object.freeze(records), tail: start === bytes.byteLength ? "complete" : "partial" });
};

export const dockerEgressJournalLocator = (subjectInput: DockerEgressJournalSubject): string => {
  const { identity } = validateDockerEgressSubject(subjectInput);
  return sha256(canonicalClosed({ contract: "docker-egress-journal-locator/v3", operationId: identity.operationId,
    effectId: identity.effectId, hostSlotId: identity.hostSlotId, exactFingerprintSha256: identity.exactFingerprintSha256 }));
};

export const createDockerEgressTombstone = (input: Omit<DockerEgressTombstone, "checksumSha256" | "version">): DockerEgressTombstone => {
  const locatorSha256 = digest(input.locatorSha256, "locatorSha256"); const bindingSha256 = input.bindingSha256 === null ? null : digest(input.bindingSha256, "bindingSha256");
  if (input.disposition !== "retired" && input.disposition !== "quarantined") { throw new TypeError("invalid tombstone disposition"); }
  const terminalRecord = input.terminalRecord === null ? null : recordFrom(input.terminalRecord);
  if (terminalRecord !== null && terminalRecord.subject.bindingSha256 !== bindingSha256) { throw new TypeError("tombstone binding mismatch"); }
  const body = Object.freeze({ version: DOCKER_EGRESS_JOURNAL_VERSION, locatorSha256, bindingSha256, disposition: input.disposition, terminalRecord });
  return Object.freeze({ ...body, checksumSha256: sha256(canonicalClosed(body)) });
};
const tombstoneFrom = (value: unknown): DockerEgressTombstone => {
  assertExact(value, TOMBSTONE_KEYS, "egress tombstone");
  if (value.version !== DOCKER_EGRESS_JOURNAL_VERSION) { throw new TypeError("invalid tombstone version"); }
  const result = createDockerEgressTombstone({ locatorSha256: value.locatorSha256 as string, bindingSha256: value.bindingSha256 as string | null,
    disposition: value.disposition as "retired" | "quarantined", terminalRecord: value.terminalRecord as DockerEgressJournalRecord | null });
  if (digest(value.checksumSha256, "tombstone checksum") !== result.checksumSha256) { throw new TypeError("tombstone checksum mismatch"); }
  return result;
};
export const encodeDockerEgressTombstone = (value: DockerEgressTombstone,
  limits: DockerEgressJournalLimits = DEFAULT_DOCKER_EGRESS_JOURNAL_LIMITS): Uint8Array => {
  const bytes = Buffer.from(`${canonicalClosed({ ...tombstoneFrom(value) })}\n`, "utf8");
  if (bytes.byteLength > limits.maxRecordBytes) { throw new DockerEgressJournalCorruptionError("tombstone bound exceeded"); }
  return bytes;
};
export const decodeDockerEgressTombstone = (bytes: Uint8Array,
  limits: DockerEgressJournalLimits = DEFAULT_DOCKER_EGRESS_JOURNAL_LIMITS): DockerEgressTombstone => {
  if (bytes.byteLength === 0 || bytes.byteLength > limits.maxRecordBytes || bytes.at(-1) !== 0x0a || bytes.subarray(0, -1).includes(0x0a)) {
    throw new DockerEgressJournalCorruptionError("invalid tombstone boundary");
  }
  try { return tombstoneFrom(parsedPlain(parseStrictJson(bytes.subarray(0, -1)))); }
  catch { throw new DockerEgressJournalCorruptionError("corrupt tombstone"); }
};
