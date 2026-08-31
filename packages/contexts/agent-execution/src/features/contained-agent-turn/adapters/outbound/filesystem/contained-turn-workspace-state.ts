const DIGEST = /^[a-f\d]{64}$/u;
const WORKSPACE_NAME = /^operation-[a-f\d]{64}$/u;

export interface ContainedTurnFilesystemScopeBinding {
  readonly projectId: string;
  readonly tenantId: string;
}

export interface ContainedTurnFrozenRootIdentity {
  readonly dev: string;
  readonly ino: string;
}

export interface ContainedTurnWorkspaceSealRecord {
  readonly manifestDigest: string;
  readonly operationId: string;
  readonly rootIdentity: ContainedTurnFrozenRootIdentity;
  readonly schemaVersion: 2;
  readonly scope: ContainedTurnFilesystemScopeBinding;
  readonly treeDigest: string;
  readonly workspaceName: string;
}

export interface ContainedTurnWorkspaceClosureRecord {
  readonly manifestDigest: string;
  readonly operationId: string;
  readonly receiptRef: string;
  readonly schemaVersion: 3;
  readonly scope: ContainedTurnFilesystemScopeBinding;
  readonly treeDigest: string;
  readonly workspaceName: string;
}

export const createWorkspaceClosureRecord = (
  name: string,
  seal: ContainedTurnWorkspaceSealRecord,
): ContainedTurnWorkspaceClosureRecord => {
  const digest = createHash("sha256")
    .update(JSON.stringify([
      seal.operationId, name, seal.treeDigest, seal.manifestDigest,
    ]))
    .digest("hex");
  return Object.freeze({
    manifestDigest: seal.manifestDigest,
    operationId: seal.operationId,
    receiptRef: `urn:agent-runtime:workspace-closed:${digest}`,
    schemaVersion: 3,
    scope: seal.scope,
    treeDigest: seal.treeDigest,
    workspaceName: name,
  });
};

export const sameWorkspaceClosureRecord = (
  left: ContainedTurnWorkspaceClosureRecord,
  right: ContainedTurnWorkspaceClosureRecord,
): boolean => encodeWorkspaceClosureRecord(left).equals(encodeWorkspaceClosureRecord(right));

export interface ContainedTurnWorkspaceCreationRecord {
  readonly materializationDigest: string;
  readonly operationId: string;
  readonly rootIdentity: ContainedTurnFrozenRootIdentity;
  readonly schemaVersion: 1;
  readonly scope: ContainedTurnFilesystemScopeBinding;
  readonly workspaceName: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasExactKeys = (
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean => {
  const actual = Object.keys(value).toSorted();
  return actual.length === expected.length &&
    actual.every((key, index) => key === expected[index]);
};

const parseJsonRecord = (bytes: Buffer, description: string): Record<string, unknown> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`contained turn ${description} is not valid JSON`);
  }
  if (!isRecord(parsed)) {throw new Error(`contained turn ${description} is not an object`);}
  return parsed;
};

const parseScope = (value: unknown, description: string): ContainedTurnFilesystemScopeBinding => {
  if (
    !isRecord(value) || !hasExactKeys(value, ["projectId", "tenantId"]) ||
    typeof value.projectId !== "string" || value.projectId.length === 0 ||
    typeof value.tenantId !== "string" || value.tenantId.length === 0 ||
    value.projectId.includes("\u0000") || value.tenantId.includes("\u0000") ||
    value.projectId !== value.projectId.normalize("NFC") ||
    value.tenantId !== value.tenantId.normalize("NFC") ||
    Buffer.byteLength(value.projectId, "utf8") > 1_024 ||
    Buffer.byteLength(value.tenantId, "utf8") > 1_024
  ) {
    throw new Error(`contained turn ${description} scope is invalid`);
  }
  return Object.freeze({ projectId: value.projectId, tenantId: value.tenantId });
};

export const encodeWorkspaceSealRecord = (
  record: ContainedTurnWorkspaceSealRecord,
): Buffer => Buffer.from(JSON.stringify(record), "utf8");

export const parseWorkspaceSealRecord = (
  bytes: Buffer,
): ContainedTurnWorkspaceSealRecord => {
  const record = parseJsonRecord(bytes, "workspace seal record");
  if (!hasExactKeys(record, [
    "manifestDigest",
    "operationId",
    "rootIdentity",
    "schemaVersion",
    "scope",
    "treeDigest",
    "workspaceName",
  ])) {
    throw new Error("contained turn workspace seal record has an invalid shape");
  }
  const identity = record.rootIdentity;
  if (
    record.schemaVersion !== 2 || typeof record.operationId !== "string" ||
    typeof record.manifestDigest !== "string" || !DIGEST.test(record.manifestDigest) ||
    typeof record.treeDigest !== "string" || !DIGEST.test(record.treeDigest) ||
    typeof record.workspaceName !== "string" || !WORKSPACE_NAME.test(record.workspaceName) ||
    !isRecord(identity) || !hasExactKeys(identity, ["dev", "ino"]) ||
    typeof identity.dev !== "string" || !/^\d+$/u.test(identity.dev) ||
    typeof identity.ino !== "string" || !/^\d+$/u.test(identity.ino)
  ) {
    throw new Error("contained turn workspace seal record is invalid");
  }
  return Object.freeze({
    manifestDigest: record.manifestDigest,
    operationId: record.operationId,
    rootIdentity: Object.freeze({ dev: identity.dev, ino: identity.ino }),
    schemaVersion: 2,
    scope: parseScope(record.scope, "workspace seal record"),
    treeDigest: record.treeDigest,
    workspaceName: record.workspaceName,
  });
};

export const encodeWorkspaceClosureRecord = (
  record: ContainedTurnWorkspaceClosureRecord,
): Buffer => Buffer.from(JSON.stringify(record), "utf8");

export const parseWorkspaceClosureRecord = (
  bytes: Buffer,
): ContainedTurnWorkspaceClosureRecord => {
  const record = parseJsonRecord(bytes, "workspace closure record");
  if (!hasExactKeys(record, [
    "manifestDigest",
    "operationId",
    "receiptRef",
    "schemaVersion",
    "scope",
    "treeDigest",
    "workspaceName",
  ])) {
    throw new Error("contained turn workspace closure record has an invalid shape");
  }
  if (
    record.schemaVersion !== 3 || typeof record.operationId !== "string" ||
    record.operationId.length === 0 || record.operationId.includes("\u0000") ||
    typeof record.manifestDigest !== "string" || !DIGEST.test(record.manifestDigest) ||
    typeof record.treeDigest !== "string" || !DIGEST.test(record.treeDigest) ||
    typeof record.workspaceName !== "string" || !WORKSPACE_NAME.test(record.workspaceName) ||
    typeof record.receiptRef !== "string" ||
    !/^urn:agent-runtime:workspace-closed:[a-f\d]{64}$/u.test(record.receiptRef)
  ) {
    throw new Error("contained turn workspace closure record is invalid");
  }
  return Object.freeze({
    manifestDigest: record.manifestDigest,
    operationId: record.operationId,
    receiptRef: record.receiptRef,
    schemaVersion: 3,
    scope: parseScope(record.scope, "workspace closure record"),
    treeDigest: record.treeDigest,
    workspaceName: record.workspaceName,
  });
};

export const encodeWorkspaceCreationRecord = (
  record: ContainedTurnWorkspaceCreationRecord,
): Buffer => Buffer.from(JSON.stringify(record), "utf8");

export const parseWorkspaceCreationRecord = (
  bytes: Buffer,
): ContainedTurnWorkspaceCreationRecord => {
  const record = parseJsonRecord(bytes, "workspace creation record");
  if (!hasExactKeys(record, [
    "materializationDigest", "operationId", "rootIdentity", "schemaVersion", "scope", "workspaceName",
  ])) {
    throw new Error("contained turn workspace creation record has an invalid shape");
  }
  const identity = record.rootIdentity;
  if (
    record.schemaVersion !== 1 || typeof record.operationId !== "string" ||
    record.operationId.length === 0 || record.operationId.includes("\u0000") ||
    typeof record.materializationDigest !== "string" || !DIGEST.test(record.materializationDigest) ||
    typeof record.workspaceName !== "string" || !WORKSPACE_NAME.test(record.workspaceName) ||
    !isRecord(identity) || !hasExactKeys(identity, ["dev", "ino"]) ||
    typeof identity.dev !== "string" || !/^\d+$/u.test(identity.dev) ||
    typeof identity.ino !== "string" || !/^\d+$/u.test(identity.ino)
  ) {
    throw new Error("contained turn workspace creation record is invalid");
  }
  return Object.freeze({
    materializationDigest: record.materializationDigest,
    operationId: record.operationId,
    rootIdentity: Object.freeze({ dev: identity.dev, ino: identity.ino }),
    schemaVersion: 1,
    scope: parseScope(record.scope, "workspace creation record"),
    workspaceName: record.workspaceName,
  });
};
import { createHash } from "node:crypto";
