import { createHash } from "node:crypto";

import type { DockerContainerAuthority } from "../engine/index.js";

import {
  DOCKER_CUSTODY_DEBT_REASONS,
  DOCKER_CUSTODY_JOURNAL_VERSION,
  DOCKER_CUSTODY_STATES,
  DockerCustodyJournalCorruptionError,
  isDockerCustodyJournalTransition,
  type DockerCustodyAttemptKey,
  type DockerCustodyDebtReason,
  type DockerCustodyJournalEvidence,
  type DockerCustodyJournalLimits,
  type DockerCustodyJournalRecord,
  type DockerCustodyJournalState,
  type DockerCustodyOwnerIdentity,
  type DockerCustodyRetirementReceipt,
} from "./docker-custody-journal-types.js";

const HEX_SHA256 = /^[a-f0-9]{64}$/u;
const BOUNDED_ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/u;
const RECORD_KEYS = [
  "attemptKey", "authoritySha256", "checksumSha256", "evidence", "previousChecksumSha256", "sequence", "state", "version",
] as const;
const RETIREMENT_RECEIPT_KEYS = [
  "attemptKey", "journalChecksumSha256", "receiptChecksumSha256", "version",
] as const;
const ATTEMPT_KEYS = [
  "attemptId", "custodyId", "daemonBootGenerationSha256", "daemonIdentitySha256", "hostBootGenerationSha256",
  "hostBootId", "hostIdentitySha256", "hostInstanceId", "launchFingerprintSha256", "operationId",
  "operationNonceSha256", "projectId", "tenantId",
] as const;
const OWNER_KEYS = [
  "attemptId", "custodyId", "hostBootId", "hostInstanceId", "operationId", "projectId", "tenantId",
] as const;
const AUTHORITY_KEYS = [
  "containerId", "createSpecificationSha256", "daemonBootGenerationSha256", "daemonIdentitySha256",
  "hostBootGenerationSha256", "hostIdentitySha256", "imageDigest", "launchFingerprintSha256",
  "operationNonceSha256", "ownerIdentitySha256",
] as const;
const isProxy = process.getBuiltinModule("node:util").types.isProxy;

const sha256 = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");

const canonicalValue = (value: unknown): unknown => {
  if (Array.isArray(value)) {return value.map(canonicalValue);}
  if (value === null || typeof value !== "object") {return value;}
  const record = value as Readonly<Record<string, unknown>>;
  return Object.fromEntries(Object.keys(record).toSorted().map(key => [key, canonicalValue(record[key])]));
};

export const canonicalDockerCustodyJson = (value: unknown): string => JSON.stringify(canonicalValue(value));

const assertPlainDataObject: (
  value: unknown,
  keys: readonly string[],
  label: string,
) => asserts value is Record<string, unknown> = (value, keys, label) => {
  if (value === null || typeof value !== "object") {
    throw new TypeError(`${label} must be a plain object`);
  }
  if (isProxy(value)) {throw new TypeError(`${label} must be a non-proxy object`);}
  if (Object.getPrototypeOf(value) !== Object.prototype) {throw new TypeError(`${label} must be a plain object`);}
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.some(key => typeof key !== "string") ||
    (ownKeys as string[]).toSorted().join("\0") !== [...keys].toSorted().join("\0") ||
    Object.values(descriptors).some(candidate => !("value" in candidate) || !candidate.enumerable)
  ) {
    throw new TypeError(`${label} must have its exact data-only shape`);
  }
};

const assertBoundedId: (name: string, value: unknown) => asserts value is string = (name, value) => {
  if (typeof value !== "string" || !BOUNDED_ID.test(value)) {
    throw new TypeError(`${name} must be a bounded opaque identifier`);
  }
};

const attemptKeyFrom = (value: unknown): DockerCustodyAttemptKey => {
  assertPlainDataObject(value, ATTEMPT_KEYS, "attemptKey");
  assertBoundedId("tenantId", value.tenantId);
  assertBoundedId("projectId", value.projectId);
  assertBoundedId("operationId", value.operationId);
  assertBoundedId("attemptId", value.attemptId);
  assertBoundedId("custodyId", value.custodyId);
  assertBoundedId("hostInstanceId", value.hostInstanceId);
  assertBoundedId("hostBootId", value.hostBootId);
  for (const name of [
    "daemonIdentitySha256", "daemonBootGenerationSha256", "hostIdentitySha256", "hostBootGenerationSha256",
    "launchFingerprintSha256", "operationNonceSha256",
  ] as const) {
    if (typeof value[name] !== "string" || !HEX_SHA256.test(value[name])) {
      throw new TypeError(`${name} must be a lowercase SHA-256 digest`);
    }
  }
  const digests = value as Record<
    "daemonIdentitySha256" | "daemonBootGenerationSha256" | "hostIdentitySha256" |
    "hostBootGenerationSha256" | "launchFingerprintSha256" | "operationNonceSha256",
    string
  >;
  return Object.freeze({
    tenantId: value.tenantId, projectId: value.projectId, operationId: value.operationId,
    attemptId: value.attemptId, custodyId: value.custodyId, hostInstanceId: value.hostInstanceId,
    hostBootId: value.hostBootId, daemonIdentitySha256: digests.daemonIdentitySha256,
    daemonBootGenerationSha256: digests.daemonBootGenerationSha256, hostIdentitySha256: digests.hostIdentitySha256,
    hostBootGenerationSha256: digests.hostBootGenerationSha256,
    launchFingerprintSha256: digests.launchFingerprintSha256, operationNonceSha256: digests.operationNonceSha256,
  });
};

export const validateDockerCustodyAttemptKey = (value: unknown): DockerCustodyAttemptKey => attemptKeyFrom(value);

export const validateDockerCustodyOwnerIdentity = (value: unknown): DockerCustodyOwnerIdentity => {
  assertPlainDataObject(value, OWNER_KEYS, "ownerIdentity");
  const owner = value as Record<typeof OWNER_KEYS[number], unknown>;
  for (const name of OWNER_KEYS) {assertBoundedId(name, owner[name]);}
  const bounded = owner as Record<typeof OWNER_KEYS[number], string>;
  return Object.freeze({
    attemptId: bounded.attemptId, custodyId: bounded.custodyId, hostBootId: bounded.hostBootId,
    hostInstanceId: bounded.hostInstanceId, operationId: bounded.operationId, projectId: bounded.projectId,
    tenantId: bounded.tenantId,
  });
};

export const bindDockerCustodyAttemptKey = (input: Readonly<{
  daemonBootGenerationSha256: string;
  daemonIdentitySha256: string;
  hostBootGenerationSha256: string;
  hostIdentitySha256: string;
  launchFingerprintSha256: string;
  operationNonceSha256: string;
  owner: DockerCustodyOwnerIdentity;
}>): DockerCustodyAttemptKey => attemptKeyFrom({
  ...validateDockerCustodyOwnerIdentity(input.owner),
  daemonBootGenerationSha256: input.daemonBootGenerationSha256,
  daemonIdentitySha256: input.daemonIdentitySha256,
  hostBootGenerationSha256: input.hostBootGenerationSha256,
  hostIdentitySha256: input.hostIdentitySha256,
  launchFingerprintSha256: input.launchFingerprintSha256,
  operationNonceSha256: input.operationNonceSha256,
});

export const dockerCustodyOwnerIdentitySha256 = (key: DockerCustodyAttemptKey): string =>
  sha256(canonicalDockerCustodyJson({ contract: "docker-custody-owner/v1", ...attemptKeyFrom(key) }));

export const dockerCustodyAuthoritySha256 = (value: DockerContainerAuthority): string => {
  assertPlainDataObject(value, AUTHORITY_KEYS, "containerAuthority");
  assertBoundedId("containerId", value.containerId);
  if (typeof value.imageDigest !== "string" || value.imageDigest.length === 0 || value.imageDigest.length > 512) {
    throw new TypeError("imageDigest must be a bounded immutable image reference");
  }
  for (const name of [
    "createSpecificationSha256", "daemonBootGenerationSha256", "daemonIdentitySha256", "hostBootGenerationSha256",
    "hostIdentitySha256", "launchFingerprintSha256", "operationNonceSha256", "ownerIdentitySha256",
  ] as const) {
    if (!HEX_SHA256.test(value[name])) {throw new TypeError(`${name} must be a lowercase SHA-256 digest`);}
  }
  return sha256(canonicalDockerCustodyJson({ contract: "docker-custody-created-authority/v1", ...value }));
};

const evidenceFrom = (value: unknown): DockerCustodyJournalEvidence => {
  if (value === null || typeof value !== "object") {throw new TypeError("evidence must be a plain object");}
  if (isProxy(value)) {throw new TypeError("evidence must be a non-proxy object");}
  if (Object.getPrototypeOf(value) !== Object.prototype) {throw new TypeError("evidence must be a plain object");}
  const statusDescriptor = Object.getOwnPropertyDescriptor(value, "status");
  if (statusDescriptor === undefined || !("value" in statusDescriptor)) {throw new TypeError("evidence must be data-only");}
  if (statusDescriptor.value === "proved") {
    assertPlainDataObject(value, ["status"], "evidence");
    return Object.freeze({ status: "proved" });
  }
  if (statusDescriptor.value === "unproven") {
    assertPlainDataObject(value, ["reason", "status"], "evidence");
    const reason = value.reason;
    if (typeof reason !== "string" || !DOCKER_CUSTODY_DEBT_REASONS.includes(reason as DockerCustodyDebtReason)) {throw new TypeError("unknown debt reason");}
    return Object.freeze({ status: "unproven", reason: reason as DockerCustodyDebtReason });
  }
  throw new TypeError("evidence has an unknown status");
};

export const dockerCustodyAttemptLocator = (key: DockerCustodyAttemptKey): string => {
  const exact = attemptKeyFrom(key);
  return sha256(canonicalDockerCustodyJson({ operationNonceSha256: exact.operationNonceSha256 }));
};

const retirementReceiptBody = (
  receipt: Omit<DockerCustodyRetirementReceipt, "receiptChecksumSha256">,
): string => canonicalDockerCustodyJson(receipt);

export const createDockerCustodyRetirementReceipt = (input: Readonly<{
  attemptKey: DockerCustodyAttemptKey;
  journalChecksumSha256: string;
}>): DockerCustodyRetirementReceipt => {
  const attemptKey = attemptKeyFrom(input.attemptKey);
  if (typeof input.journalChecksumSha256 !== "string" || !HEX_SHA256.test(input.journalChecksumSha256)) {
    throw new TypeError("retired journal checksum must be a lowercase SHA-256 digest");
  }
  const body = Object.freeze({
    version: DOCKER_CUSTODY_JOURNAL_VERSION,
    attemptKey,
    journalChecksumSha256: input.journalChecksumSha256,
  });
  return Object.freeze({ ...body, receiptChecksumSha256: sha256(retirementReceiptBody(body)) });
};

const retirementReceiptFrom = (value: unknown): DockerCustodyRetirementReceipt => {
  assertPlainDataObject(value, RETIREMENT_RECEIPT_KEYS, "retirement receipt");
  if (value.version !== DOCKER_CUSTODY_JOURNAL_VERSION) {throw new TypeError("unknown retirement receipt version");}
  if (typeof value.receiptChecksumSha256 !== "string" || !HEX_SHA256.test(value.receiptChecksumSha256)) {
    throw new TypeError("invalid retirement receipt checksum");
  }
  const candidate = createDockerCustodyRetirementReceipt({
    attemptKey: attemptKeyFrom(value.attemptKey),
    journalChecksumSha256: value.journalChecksumSha256 as string,
  });
  if (candidate.receiptChecksumSha256 !== value.receiptChecksumSha256) {
    throw new TypeError("retirement receipt checksum mismatch");
  }
  return candidate;
};

export const encodeDockerCustodyRetirementReceipt = (
  receipt: DockerCustodyRetirementReceipt,
  limits: DockerCustodyJournalLimits,
): Uint8Array => {
  const checked = retirementReceiptFrom(receipt);
  const bytes = Buffer.from(`${canonicalDockerCustodyJson(checked)}\n`, "utf8");
  if (bytes.byteLength > limits.maxRecordBytes) {throw new TypeError("retirement receipt exceeds byte bound");}
  return bytes;
};

export const decodeDockerCustodyRetirementReceipt = (
  bytes: Uint8Array,
  limits: DockerCustodyJournalLimits,
): DockerCustodyRetirementReceipt => {
  if (bytes.byteLength === 0 || bytes.byteLength > limits.maxRecordBytes) {
    throw new DockerCustodyJournalCorruptionError("retirement receipt exceeds its fixed bound");
  }
  const text = Buffer.from(bytes).toString("utf8");
  if (!text.endsWith("\n") || text.slice(0, -1).includes("\n")) {
    throw new DockerCustodyJournalCorruptionError("retirement receipt has an invalid record boundary");
  }
  try {return retirementReceiptFrom(JSON.parse(text.slice(0, -1)) as unknown);} catch {
    throw new DockerCustodyJournalCorruptionError("retirement receipt is corrupt");
  }
};

const recordBody = (record: Omit<DockerCustodyJournalRecord, "checksumSha256">): string =>
  canonicalDockerCustodyJson(record);

export const createDockerCustodyRecord = (input: {
  readonly attemptKey: DockerCustodyAttemptKey;
  readonly authoritySha256?: string | null;
  readonly sequence: number;
  readonly state: DockerCustodyJournalState;
  readonly evidence: DockerCustodyJournalEvidence;
  readonly previousChecksumSha256: string | null;
}): DockerCustodyJournalRecord => {
  const attemptKey = attemptKeyFrom(input.attemptKey);
  if (typeof input.sequence !== "number" || !Number.isSafeInteger(input.sequence) || input.sequence < 0) {throw new TypeError("sequence must be non-negative");}
  if (typeof input.state !== "string" || !DOCKER_CUSTODY_STATES.includes(input.state)) {throw new TypeError("unknown journal state");}
  const evidence = evidenceFrom(input.evidence);
  const authoritySha256 = input.authoritySha256 ?? null;
  if (authoritySha256 !== null && !HEX_SHA256.test(authoritySha256)) {
    throw new TypeError("authority binding must be null or a lowercase SHA-256 digest");
  }
  if (input.previousChecksumSha256 !== null && (typeof input.previousChecksumSha256 !== "string" || !HEX_SHA256.test(input.previousChecksumSha256))) {
    throw new TypeError("previous checksum must be null or lowercase SHA-256");
  }
  const body = Object.freeze({
    version: DOCKER_CUSTODY_JOURNAL_VERSION, sequence: input.sequence, attemptKey, authoritySha256, state: input.state,
    evidence, previousChecksumSha256: input.previousChecksumSha256,
  });
  return Object.freeze({ ...body, checksumSha256: sha256(recordBody(body)) });
};

export const encodeDockerCustodyRecord = (record: DockerCustodyJournalRecord, limits: DockerCustodyJournalLimits): Uint8Array => {
  const checked = recordFrom(record);
  const bytes = Buffer.from(`${canonicalDockerCustodyJson(checked)}\n`, "utf8");
  if (bytes.byteLength > limits.maxRecordBytes) {throw new TypeError("journal record exceeds byte bound");}
  return bytes;
};

const recordFrom = (value: unknown): DockerCustodyJournalRecord => {
  assertPlainDataObject(value, RECORD_KEYS, "journal record");
  if (value.version !== DOCKER_CUSTODY_JOURNAL_VERSION) {throw new TypeError("unknown journal version");}
  if (typeof value.sequence !== "number" || !Number.isSafeInteger(value.sequence) || value.sequence < 0) {throw new TypeError("invalid sequence");}
  if (typeof value.state !== "string" || !DOCKER_CUSTODY_STATES.includes(value.state as DockerCustodyJournalState)) {throw new TypeError("unknown state");}
  if (typeof value.checksumSha256 !== "string" || !HEX_SHA256.test(value.checksumSha256)) {throw new TypeError("invalid checksum");}
  const candidate = createDockerCustodyRecord({
    attemptKey: attemptKeyFrom(value.attemptKey), sequence: value.sequence,
    authoritySha256: value.authoritySha256 as string | null,
    state: value.state as DockerCustodyJournalState, evidence: evidenceFrom(value.evidence),
    previousChecksumSha256: value.previousChecksumSha256 as string | null,
  });
  if (value.checksumSha256 !== candidate.checksumSha256) {throw new TypeError("checksum mismatch");}
  return candidate;
};

const decodeRecord = (line: string): DockerCustodyJournalRecord => {
  let parsed: unknown;
  try {parsed = JSON.parse(line) as unknown;} catch {throw new DockerCustodyJournalCorruptionError();}
  try {
    return recordFrom(parsed);
  } catch (error) {
    if (error instanceof DockerCustodyJournalCorruptionError) {throw error;}
    throw new DockerCustodyJournalCorruptionError();
  }
};

export interface DockerCustodyReplay {
  readonly records: readonly DockerCustodyJournalRecord[];
  readonly tail: "complete" | "partial";
}

export const replayDockerCustodyBytes = (bytes: Uint8Array, limits: DockerCustodyJournalLimits): DockerCustodyReplay => {
  if (bytes.byteLength > limits.maxJournalBytes) {throw new DockerCustodyJournalCorruptionError();}
  const text = Buffer.from(bytes).toString("utf8");
  if (text.length === 0) {return { records: [], tail: "complete" };}
  const completeTail = text.endsWith("\n");
  const lines = text.split("\n");
  if (completeTail) {lines.pop();} else {lines.pop();}
  if (lines.length > limits.maxRecordsPerJournal) {throw new DockerCustodyJournalCorruptionError();}
  const records: DockerCustodyJournalRecord[] = [];
  for (const line of lines) {
    if (Buffer.byteLength(`${line}\n`, "utf8") > limits.maxRecordBytes) {throw new DockerCustodyJournalCorruptionError();}
    const record = decodeRecord(line);
    const previous = records.at(-1);
    if (
      record.sequence !== records.length || (previous === undefined
        ? record.state !== "prepared"
        : !isDockerCustodyJournalTransition(previous, record.state)) ||
      record.previousChecksumSha256 !== (previous?.checksumSha256 ?? null) ||
      (previous !== undefined && canonicalDockerCustodyJson(previous.attemptKey) !== canonicalDockerCustodyJson(record.attemptKey)) ||
      (record.state === "created" ? record.authoritySha256 === null : previous !== undefined &&
        record.authoritySha256 !== previous.authoritySha256)
    ) {throw new DockerCustodyJournalCorruptionError();}
    records.push(record);
  }
  return { records: Object.freeze(records), tail: completeTail ? "complete" : "partial" };
};
