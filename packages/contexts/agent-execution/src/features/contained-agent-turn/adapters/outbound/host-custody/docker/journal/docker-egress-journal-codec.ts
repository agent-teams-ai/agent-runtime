import { createHash } from "node:crypto";
import { types } from "node:util";

import { parseStrictJson } from "../engine/strict-json.js";
import {
  DEFAULT_DOCKER_EGRESS_JOURNAL_LIMITS,
  DOCKER_EGRESS_JOURNAL_VERSION,
  DOCKER_EGRESS_RESOURCE_KINDS,
  DockerEgressJournalCorruptionError,
  type DockerEgressAuthorityBinding,
  type DockerEgressIdentity,
  type DockerEgressJournalEvent,
  type DockerEgressJournalLimits,
  type DockerEgressJournalRecord,
  type DockerEgressJournalSubject,
  type DockerEgressQuarantineDiagnostic,
  type DockerEgressReconcileReason,
  type DockerEgressResourceIdentities,
  type DockerEgressResourceKind,
} from "./docker-egress-journal-types.js";

const DIGEST = /^[a-f0-9]{64}$/u;
const OPAQUE = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,159}$/u;
const RECORD_KEYS = ["checksumSha256", "event", "previousChecksumSha256", "sequence", "subject", "version"] as const;
const SUBJECT_KEYS = ["authority", "bindingSha256", "identity", "resources"] as const;
const IDENTITY_KEYS = [
  "attemptId", "custodyId", "effectId", "hostBootId", "hostInstanceId", "operationId",
  "resourceGenerationId", "workspaceId",
] as const;
const AUTHORITY_KEYS = [
  "acceptedAuthoritySha256", "brokerPolicySha256", "materializationAuthorizationSha256", "operationSha256",
  "routeAuthorizationSha256", "scopeSha256",
] as const;
const RESOURCE_KEYS = [
  "brokerCgroupId", "brokerInboundSocketId", "brokerListenerId", "brokerNamespaceId", "brokerProcessId",
  "brokerUpstreamSocketId", "networkEndpointId", "privateNetworkId", "providerContainerId", "providerEndpointId",
  "upstreamRuleGenerationId",
] as const;

const ID_PREFIXES: Readonly<Record<keyof DockerEgressIdentity, string>> = Object.freeze({
  operationId: "operation:", attemptId: "attempt:", effectId: "effect:", custodyId: "custody:",
  workspaceId: "workspace:", hostInstanceId: "host:", hostBootId: "boot:",
  resourceGenerationId: "resource-generation:",
});
const RESOURCE_PREFIXES: Readonly<Record<keyof DockerEgressResourceIdentities, string>> = Object.freeze({
  privateNetworkId: "private-network:", brokerNamespaceId: "broker-netns:", brokerCgroupId: "broker-cgroup:",
  brokerProcessId: "broker-process:", brokerListenerId: "broker-listener:",
  brokerInboundSocketId: "broker-inbound-socket:", brokerUpstreamSocketId: "broker-upstream-socket:",
  providerEndpointId: "provider-endpoint:", networkEndpointId: "network-endpoint:",
  upstreamRuleGenerationId: "upstream-rule-generation:", providerContainerId: "provider-container:",
});
const RECONCILE_REASONS: readonly DockerEgressReconcileReason[] = Object.freeze([
  "acknowledgement_unknown", "cleanup_failed", "cleanup_observation_unknown", "journal_corrupt",
  "legacy_incompatible", "legacy_malformed", "scope_conflict",
]);
const QUARANTINE_DIAGNOSTICS: readonly DockerEgressQuarantineDiagnostic[] = Object.freeze([
  "legacy_empty", "legacy_populated_without_cleanup_identity", "legacy_corrupt", "legacy_oversized", "legacy_partial_tail",
  "cleanup_incomplete", "journal_corrupt", "scope_conflict",
]);

const sha256 = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");
const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) { return value.map(canonical); }
  if (value === null || typeof value !== "object") { return value; }
  const record = value as Readonly<Record<string, unknown>>;
  return Object.fromEntries(Object.keys(record).toSorted().map(key => [key, canonical(record[key])]));
};
export const canonicalDockerEgressJson = (value: unknown): string => JSON.stringify(canonical(value));

const assertExact: (value: unknown, keys: readonly string[], label: string) => asserts value is Record<string, unknown> =
  (value, keys, label) => {
    if (value === null || typeof value !== "object" || types.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) {
      throw new TypeError(`${label} must be a plain non-proxy object`);
    }
    const own = Reflect.ownKeys(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (own.some(key => typeof key !== "string") ||
        (own as string[]).toSorted().join("\0") !== [...keys].toSorted().join("\0") ||
        Object.values(descriptors).some(item => !("value" in item) || !item.enumerable)) {
      throw new TypeError(`${label} must have its exact data-only shape`);
    }
  };

const opaque = (value: unknown, prefix: string, label: string): string => {
  if (typeof value !== "string" || !OPAQUE.test(value) || !value.startsWith(prefix) || value.length === prefix.length) {
    throw new TypeError(`${label} must be a bounded opaque ${prefix} identity`);
  }
  return value;
};
const digest = (value: unknown, label: string): string => {
  if (typeof value !== "string" || !DIGEST.test(value)) { throw new TypeError(`${label} must be a lowercase SHA-256 digest`); }
  return value;
};

const identityFrom = (value: unknown): DockerEgressIdentity => {
  assertExact(value, IDENTITY_KEYS, "egress identity");
  const result = Object.fromEntries(IDENTITY_KEYS.map(key => [key, opaque(value[key], ID_PREFIXES[key], key)]));
  return Object.freeze(result) as unknown as DockerEgressIdentity;
};
const authorityFrom = (value: unknown): DockerEgressAuthorityBinding => {
  assertExact(value, AUTHORITY_KEYS, "egress authority binding");
  const result = Object.fromEntries(AUTHORITY_KEYS.map(key => [key, digest(value[key], key)]));
  return Object.freeze(result) as unknown as DockerEgressAuthorityBinding;
};
const resourcesFrom = (value: unknown): DockerEgressResourceIdentities => {
  assertExact(value, RESOURCE_KEYS, "egress cleanup identities");
  const result = Object.fromEntries(RESOURCE_KEYS.map(key => [key, opaque(value[key], RESOURCE_PREFIXES[key], key)]));
  if (new Set(Object.values(result)).size !== RESOURCE_KEYS.length) {
    throw new TypeError("egress cleanup identities must be pairwise distinct");
  }
  return Object.freeze(result) as unknown as DockerEgressResourceIdentities;
};

const subjectBody = (identity: DockerEgressIdentity, authority: DockerEgressAuthorityBinding,
  resources: DockerEgressResourceIdentities): object => ({
  contract: "agent-runtime-host-egress-custody/v3", authority, identity, resources,
});
export const dockerEgressBindingSha256 = (input: Readonly<{
  readonly identity: DockerEgressIdentity;
  readonly authority: DockerEgressAuthorityBinding;
  readonly resources: DockerEgressResourceIdentities;
}>): string => {
  const identity = identityFrom(input.identity);
  const authority = authorityFrom(input.authority);
  const resources = resourcesFrom(input.resources);
  return sha256(canonicalDockerEgressJson(subjectBody(identity, authority, resources)));
};

export const createDockerEgressSubject = (input: Readonly<{
  readonly identity: DockerEgressIdentity;
  readonly authority: DockerEgressAuthorityBinding;
  readonly resources: DockerEgressResourceIdentities;
}>): DockerEgressJournalSubject => {
  const identity = identityFrom(input.identity);
  const authority = authorityFrom(input.authority);
  const resources = resourcesFrom(input.resources);
  return Object.freeze({ identity, authority, resources, bindingSha256: dockerEgressBindingSha256({ identity, authority, resources }) });
};

export const validateDockerEgressSubject = (value: unknown): DockerEgressJournalSubject => {
  assertExact(value, SUBJECT_KEYS, "egress journal subject");
  const subject = createDockerEgressSubject({
    identity: value.identity as DockerEgressIdentity,
    authority: value.authority as DockerEgressAuthorityBinding,
    resources: value.resources as DockerEgressResourceIdentities,
  });
  if (digest(value.bindingSha256, "bindingSha256") !== subject.bindingSha256) {
    throw new TypeError("egress subject binding digest mismatch");
  }
  return subject;
};

const resource = (value: unknown): DockerEgressResourceKind => {
  if (typeof value !== "string" || !DOCKER_EGRESS_RESOURCE_KINDS.includes(value as DockerEgressResourceKind)) {
    throw new TypeError("unknown egress resource kind");
  }
  return value as DockerEgressResourceKind;
};
const intentEventFrom = (value: Record<string, unknown>, kind: "materialize_intent" | "cleanup_intent") => {
  assertExact(value, ["kind", "resource"], "egress event");
  return Object.freeze({ kind, resource: resource(value.resource) });
};
const materializeReceiptFrom = (value: Record<string, unknown>) => {
  assertExact(value, ["acknowledgement", "kind", "resource"], "egress event");
  if (value.acknowledgement !== "acknowledged") { throw new TypeError("materialization acknowledgement must be exact"); }
  return Object.freeze({ acknowledgement: "acknowledged" as const, kind: "materialize_receipt" as const,
    resource: resource(value.resource) });
};
const cleanupReceiptFrom = (value: Record<string, unknown>) => {
  assertExact(value, ["acknowledgement", "kind", "resource"], "egress event");
  if (value.acknowledgement !== "acknowledged" && value.acknowledgement !== "already_absent") {
    throw new TypeError("cleanup acknowledgement must prove absence");
  }
  return Object.freeze({ acknowledgement: value.acknowledgement, kind: "cleanup_receipt" as const,
    resource: resource(value.resource) });
};
const reconcileEventFrom = (value: Record<string, unknown>) => {
  assertExact(value, ["kind", "reason", "resource"], "egress event");
  if (typeof value.reason !== "string" || !RECONCILE_REASONS.includes(value.reason as DockerEgressReconcileReason)) {
    throw new TypeError("unknown reconcile reason");
  }
  const target = value.resource === null ? null : resource(value.resource);
  return Object.freeze({ kind: "reconcile_required" as const, reason: value.reason as DockerEgressReconcileReason,
    resource: target });
};
const quarantineEventFrom = (value: Record<string, unknown>) => {
  assertExact(value, ["diagnostic", "kind"], "egress event");
  if (typeof value.diagnostic !== "string" || !QUARANTINE_DIAGNOSTICS.includes(value.diagnostic as DockerEgressQuarantineDiagnostic)) {
    throw new TypeError("unknown bounded quarantine diagnostic");
  }
  return Object.freeze({ diagnostic: value.diagnostic as DockerEgressQuarantineDiagnostic, kind: "quarantined" as const });
};
const eventFrom = (value: unknown): DockerEgressJournalEvent => {
  if (value === null || typeof value !== "object" || types.isProxy(value)) { throw new TypeError("event must be plain data"); }
  const record = value as Record<string, unknown>;
  const kind = Object.getOwnPropertyDescriptor(record, "kind")?.value;
  switch (kind) {
    case "open_intent":
    case "closed": assertExact(record, ["kind"], "egress event"); return Object.freeze({ kind });
    case "materialize_intent":
    case "cleanup_intent": return intentEventFrom(record, kind);
    case "materialize_receipt": return materializeReceiptFrom(record);
    case "cleanup_receipt": return cleanupReceiptFrom(record);
    case "reconcile_required": return reconcileEventFrom(record);
    case "quarantined": return quarantineEventFrom(record);
    default: throw new TypeError("unknown egress journal event");
  }
};

const recordBody = (record: Omit<DockerEgressJournalRecord, "checksumSha256">): string => canonicalDockerEgressJson(record);
export const createDockerEgressRecord = (input: Readonly<{
  readonly sequence: number;
  readonly subject: DockerEgressJournalSubject;
  readonly event: DockerEgressJournalEvent;
  readonly previousChecksumSha256: string | null;
}>): DockerEgressJournalRecord => {
  if (!Number.isSafeInteger(input.sequence) || input.sequence < 0) { throw new TypeError("sequence must be a non-negative safe integer"); }
  const subject = validateDockerEgressSubject(input.subject);
  const event = eventFrom(input.event);
  const previous = input.previousChecksumSha256 === null ? null : digest(input.previousChecksumSha256, "previous checksum");
  const body = Object.freeze({ version: DOCKER_EGRESS_JOURNAL_VERSION, sequence: input.sequence, subject, event, previousChecksumSha256: previous });
  return Object.freeze({ ...body, checksumSha256: sha256(recordBody(body)) });
};

const recordFrom = (value: unknown): DockerEgressJournalRecord => {
  assertExact(value, RECORD_KEYS, "egress journal record");
  if (value.version !== DOCKER_EGRESS_JOURNAL_VERSION) { throw new TypeError("unknown egress journal version"); }
  const candidate = createDockerEgressRecord({
    sequence: value.sequence as number,
    subject: value.subject as DockerEgressJournalSubject,
    event: value.event as DockerEgressJournalEvent,
    previousChecksumSha256: value.previousChecksumSha256 as string | null,
  });
  if (digest(value.checksumSha256, "record checksum") !== candidate.checksumSha256) { throw new TypeError("record checksum mismatch"); }
  return candidate;
};

const plainParsed = (value: unknown): unknown => {
  if (Array.isArray(value)) { return value.map(plainParsed); }
  if (value === null || typeof value !== "object") { return value; }
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, plainParsed(item)]));
};
export const encodeDockerEgressRecord = (
  record: DockerEgressJournalRecord,
  limits: DockerEgressJournalLimits = DEFAULT_DOCKER_EGRESS_JOURNAL_LIMITS,
): Uint8Array => {
  const checked = recordFrom(record);
  const bytes = Buffer.from(`${canonicalDockerEgressJson(checked)}\n`, "utf8");
  if (bytes.byteLength > limits.maxRecordBytes) { throw new DockerEgressJournalCorruptionError("egress record exceeds byte bound"); }
  return bytes;
};

export interface DockerEgressReplay { readonly records: readonly DockerEgressJournalRecord[]; readonly tail: "complete" | "partial"; }
export const replayDockerEgressBytes = (
  bytes: Uint8Array,
  limits: DockerEgressJournalLimits = DEFAULT_DOCKER_EGRESS_JOURNAL_LIMITS,
): DockerEgressReplay => {
  if (bytes.byteLength > limits.maxJournalBytes) { throw new DockerEgressJournalCorruptionError("egress journal exceeds byte bound"); }
  const newline = 0x0a;
  const records: DockerEgressJournalRecord[] = [];
  let start = 0;
  try {
    for (let index = 0; index < bytes.byteLength; index += 1) {
      if (bytes[index] !== newline) { continue; }
      const slice = bytes.subarray(start, index);
      if (slice.byteLength === 0 || slice.byteLength + 1 > limits.maxRecordBytes || records.length >= limits.maxRecordsPerJournal) {
        throw new DockerEgressJournalCorruptionError();
      }
      const record = recordFrom(plainParsed(parseStrictJson(slice)));
      const previous = records.at(-1);
      if (record.sequence !== records.length || record.previousChecksumSha256 !== (previous?.checksumSha256 ?? null) ||
          (previous !== undefined && record.subject.bindingSha256 !== previous.subject.bindingSha256)) {
        throw new DockerEgressJournalCorruptionError("egress journal chain or identity mismatch");
      }
      records.push(record); start = index + 1;
    }
  } catch (error) {
    if (error instanceof DockerEgressJournalCorruptionError) { throw error; }
    throw new DockerEgressJournalCorruptionError();
  }
  return Object.freeze({ records: Object.freeze(records), tail: start === bytes.byteLength ? "complete" : "partial" });
};

export const dockerEgressJournalLocator = (subject: DockerEgressJournalSubject): string =>
  sha256(canonicalDockerEgressJson({ bindingSha256: validateDockerEgressSubject(subject).bindingSha256, contract: "docker-egress-journal-locator/v3" }));
