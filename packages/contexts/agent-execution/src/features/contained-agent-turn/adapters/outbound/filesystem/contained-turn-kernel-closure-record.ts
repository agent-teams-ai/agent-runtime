import {
  digestContainedTurnCanonicalValue,
  parseContainedTurnCanonicalDigest,
  type ContainedTurnCanonicalDigest,
} from "../../../domain/contained-turn-codecs.js";
import {
  containedTurnIdentity,
  validateContainedTurnIdentity,
  type ContainedTurnClosureRequestIdentity,
  type ContainedTurnEvidenceId,
  type ContainedTurnOperationId,
  type ContainedTurnProofId,
  type ContainedTurnWorkspaceId,
} from "../../../domain/contained-turn-identities.js";

const WORKSPACE_RECEIPT = /^urn:agent-runtime:workspace-closed:[a-f\d]{64}$/u;
const MANIFEST_REF = /^urn:agent-runtime:artifact-manifest:[a-f\d]{64}$/u;
const MANIFEST_RECEIPT = /^urn:agent-runtime:artifact-manifest-sealed:[a-f\d]{64}$/u;
const RESULT_REF = /^urn:agent-runtime:contained-turn-result:[a-f\d]{64}$/u;
const RESULT_RECEIPT = /^urn:agent-runtime:result-published:[a-f\d]{64}$/u;

interface KernelClosureBinding {
  readonly authorityVectorDigest: ContainedTurnCanonicalDigest;
  readonly operationId: ContainedTurnOperationId;
  readonly requestDigest: ContainedTurnCanonicalDigest;
  readonly requestId: ContainedTurnClosureRequestIdentity;
  readonly workspaceId: ContainedTurnWorkspaceId;
}

export interface KernelWorkspaceClosureRecord extends KernelClosureBinding {
  readonly kind: "workspace_closure";
  readonly receiptRef: string;
  readonly schemaVersion: 1;
}

export interface KernelArtifactClosureRecord extends KernelClosureBinding {
  readonly kind: "artifact_seal";
  readonly manifestReceiptRef: string;
  readonly manifestRef: string;
  readonly resultReceiptRef: string;
  readonly resultRef: string;
  readonly schemaVersion: 1;
}

export type KernelClosureRecord = KernelWorkspaceClosureRecord | KernelArtifactClosureRecord;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const exactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
  const actual = Object.keys(value).toSorted();
  const expected = [...keys].toSorted();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
};

const parseBinding = (value: Record<string, unknown>): KernelClosureBinding => {
  if (
    typeof value.authorityVectorDigest !== "string" || typeof value.operationId !== "string" ||
    typeof value.requestDigest !== "string" || typeof value.requestId !== "string" ||
    typeof value.workspaceId !== "string"
  ) {
    throw new Error("contained turn kernel closure binding is invalid");
  }
  return Object.freeze({
    authorityVectorDigest: parseContainedTurnCanonicalDigest(value.authorityVectorDigest),
    operationId: validateContainedTurnIdentity("operation", value.operationId),
    requestDigest: parseContainedTurnCanonicalDigest(value.requestDigest),
    requestId: validateContainedTurnIdentity("closure_request", value.requestId),
    workspaceId: validateContainedTurnIdentity("workspace", value.workspaceId),
  });
};

export const parseKernelClosureRecord = (bytes: Buffer): KernelClosureRecord => {
  let value: unknown;
  try {value = JSON.parse(bytes.toString("utf8")) as unknown;} catch {
    throw new Error("contained turn kernel closure record is not valid JSON");
  }
  if (!isRecord(value) || value.schemaVersion !== 1) {
    throw new Error("contained turn kernel closure record is invalid");
  }
  const binding = parseBinding(value);
  if (value.kind === "workspace_closure") {
    if (!exactKeys(value, [
      "authorityVectorDigest", "kind", "operationId", "receiptRef", "requestDigest",
      "requestId", "schemaVersion", "workspaceId",
    ]) || typeof value.receiptRef !== "string" || !WORKSPACE_RECEIPT.test(value.receiptRef)) {
      throw new Error("contained turn kernel workspace closure record is invalid");
    }
    return Object.freeze({ ...binding, kind: value.kind, receiptRef: value.receiptRef, schemaVersion: 1 });
  }
  if (value.kind === "artifact_seal") {
    if (!exactKeys(value, [
      "authorityVectorDigest", "kind", "manifestReceiptRef", "manifestRef", "operationId",
      "requestDigest", "requestId", "resultReceiptRef", "resultRef", "schemaVersion", "workspaceId",
    ]) || typeof value.manifestReceiptRef !== "string" || !MANIFEST_RECEIPT.test(value.manifestReceiptRef) ||
      typeof value.manifestRef !== "string" || !MANIFEST_REF.test(value.manifestRef) ||
      typeof value.resultReceiptRef !== "string" || !RESULT_RECEIPT.test(value.resultReceiptRef) ||
      typeof value.resultRef !== "string" || !RESULT_REF.test(value.resultRef)) {
      throw new Error("contained turn kernel artifact closure record is invalid");
    }
    if (
      value.manifestRef.split(":").at(-1) !== value.resultRef.split(":").at(-1) ||
      value.manifestReceiptRef.split(":").at(-1) !== value.resultRef.split(":").at(-1) ||
      value.resultReceiptRef.split(":").at(-1) !== value.resultRef.split(":").at(-1)
    ) {
      throw new Error("contained turn kernel artifact closure references disagree");
    }
    return Object.freeze({
      ...binding,
      kind: value.kind,
      manifestReceiptRef: value.manifestReceiptRef,
      manifestRef: value.manifestRef,
      resultReceiptRef: value.resultReceiptRef,
      resultRef: value.resultRef,
      schemaVersion: 1,
    });
  }
  throw new Error("contained turn kernel closure record kind is invalid");
};

export const encodeKernelClosureRecord = (record: KernelClosureRecord): Buffer =>
  Buffer.from(JSON.stringify(record), "utf8");

export const kernelClosureRecordName = (
  kind: KernelClosureRecord["kind"],
  requestDigest: ContainedTurnCanonicalDigest,
): string => `kernel-${kind}-${requestDigest.slice("sha256:".length)}.json`;

export const sameKernelClosureRequest = (
  record: KernelClosureRecord,
  input: KernelClosureBinding,
): boolean => record.authorityVectorDigest === input.authorityVectorDigest &&
  record.operationId === input.operationId && record.requestDigest === input.requestDigest &&
  record.requestId === input.requestId && record.workspaceId === input.workspaceId;

export const kernelClosureProofId = (
  record: KernelClosureRecord,
  proofKind: "artifact_manifest_seal" | "result_publication" | "workspace_closure",
): ContainedTurnProofId => containedTurnIdentity(
  "proof",
  `proof:filesystem-closure:${digestContainedTurnCanonicalValue({
    proofKind,
    record: record as unknown as { readonly [key: string]: string | number },
  })}`,
);

export const kernelClosureEvidenceId = (
  input: Readonly<{ operationId: ContainedTurnOperationId; requestDigest?: ContainedTurnCanonicalDigest; source: string }>,
): ContainedTurnEvidenceId => containedTurnIdentity(
  "evidence",
  `evidence:filesystem-closure:${digestContainedTurnCanonicalValue({
    operationId: input.operationId,
    requestDigest: input.requestDigest ?? null,
    source: input.source,
  })}`,
);
