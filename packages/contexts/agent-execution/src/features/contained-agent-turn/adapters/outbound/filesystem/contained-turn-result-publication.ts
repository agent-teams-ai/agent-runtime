import type { ContainedTurnFilesystemScopeBinding } from "./contained-turn-workspace-state.js";

const DIGEST = /^[a-f\d]{64}$/u;

export interface ContainedTurnResultPublicationRecord {
  readonly manifestDigest: string;
  readonly manifestReceiptRef: string;
  readonly operationId: string;
  readonly resultReceiptRef: string;
  readonly resultRef: string;
  readonly schemaVersion: 1;
  readonly scope: ContainedTurnFilesystemScopeBinding;
  readonly treeDigest: string;
  readonly workspaceName: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasPublicationKeys = (value: Record<string, unknown>): boolean =>
  Object.keys(value).toSorted().join(",") === [
    "manifestDigest", "manifestReceiptRef", "operationId", "resultReceiptRef",
    "resultRef", "schemaVersion", "scope", "treeDigest", "workspaceName",
  ].join(",");

type ValidPublicationIdentity = Readonly<{
  manifestDigest: string;
  operationId: string;
  schemaVersion: 1;
  treeDigest: string;
  workspaceName: string;
}>;

const hasValidPublicationIdentity = (
  value: Record<string, unknown>,
): value is Record<string, unknown> & ValidPublicationIdentity =>
  value.schemaVersion === 1 && typeof value.manifestDigest === "string" &&
  DIGEST.test(value.manifestDigest) && typeof value.treeDigest === "string" &&
  DIGEST.test(value.treeDigest) && typeof value.operationId === "string" &&
  typeof value.workspaceName === "string" &&
  /^operation-[a-f\d]{64}$/u.test(value.workspaceName);

type ValidPublicationReferences = Readonly<{
  manifestReceiptRef: string;
  resultReceiptRef: string;
  resultRef: string;
}>;

const hasValidPublicationReferences = (
  value: Record<string, unknown>,
): value is Record<string, unknown> & ValidPublicationReferences =>
  typeof value.manifestDigest === "string" &&
  value.manifestReceiptRef ===
    `urn:agent-runtime:artifact-manifest-sealed:${value.manifestDigest}` &&
  value.resultReceiptRef === `urn:agent-runtime:result-published:${value.manifestDigest}` &&
  value.resultRef === `urn:agent-runtime:contained-turn-result:${value.manifestDigest}`;

const isPublicationScope = (
  value: unknown,
): value is Readonly<{ projectId: string; tenantId: string }> =>
  isRecord(value) && Object.keys(value).toSorted().join(",") === "projectId,tenantId" &&
  typeof value.projectId === "string" && typeof value.tenantId === "string";

export const encodeResultPublicationRecord = (
  record: ContainedTurnResultPublicationRecord,
): Buffer => Buffer.from(JSON.stringify(record), "utf8");

export const parseResultPublicationRecord = (
  bytes: Buffer,
): ContainedTurnResultPublicationRecord => {
  let value: unknown;
  try {value = JSON.parse(bytes.toString("utf8")) as unknown;} catch {
    throw new Error("contained turn result publication is not valid JSON");
  }
  if (!isRecord(value) || !hasPublicationKeys(value)) {
    throw new Error("contained turn result publication has an invalid shape");
  }
  const scope = value.scope;
  if (!hasValidPublicationIdentity(value) || !hasValidPublicationReferences(value) ||
    !isPublicationScope(scope)) {
    throw new Error("contained turn result publication is invalid");
  }
  return Object.freeze({
    manifestDigest: value.manifestDigest,
    manifestReceiptRef: value.manifestReceiptRef,
    operationId: value.operationId,
    resultReceiptRef: value.resultReceiptRef,
    resultRef: value.resultRef,
    schemaVersion: 1,
    scope: Object.freeze({ projectId: scope.projectId, tenantId: scope.tenantId }),
    treeDigest: value.treeDigest,
    workspaceName: value.workspaceName,
  });
};
