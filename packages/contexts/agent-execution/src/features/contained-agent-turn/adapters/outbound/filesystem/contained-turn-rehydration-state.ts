const DIGEST = /^[a-f\d]{64}$/u;

export interface ContainedTurnRehydrationRecord {
  readonly manifestDigest: string;
  readonly operationId: string;
  readonly projectId: string;
  readonly rootIdentity: Readonly<{ dev: string; ino: string }>;
  readonly schemaVersion: 2;
  readonly stagingName: string;
  readonly tenantId: string;
  readonly treeDigest: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const encodeRehydrationRecord = (
  record: ContainedTurnRehydrationRecord,
): Buffer => Buffer.from(JSON.stringify(record), "utf8");

export const parseRehydrationRecord = (bytes: Buffer): ContainedTurnRehydrationRecord => {
  let value: unknown;
  try {value = JSON.parse(bytes.toString("utf8")) as unknown;} catch {
    throw new Error("contained turn rehydration record is not valid JSON");
  }
  if (!isRecord(value) || Object.keys(value).toSorted().join(",") !== [
    "manifestDigest", "operationId", "projectId", "rootIdentity", "schemaVersion",
    "stagingName", "tenantId", "treeDigest",
  ].join(",")) {
    throw new Error("contained turn rehydration record has an invalid shape");
  }
  const identity = value.rootIdentity;
  if (
    value.schemaVersion !== 2 || typeof value.manifestDigest !== "string" ||
    !DIGEST.test(value.manifestDigest) || typeof value.treeDigest !== "string" ||
    !DIGEST.test(value.treeDigest) || typeof value.operationId !== "string" ||
    typeof value.projectId !== "string" || typeof value.tenantId !== "string" ||
    typeof value.stagingName !== "string" ||
    !/^\.rehydrate-[a-f\d]{64}-[a-f\d-]{36}\.tmp$/u.test(value.stagingName) ||
    !isRecord(identity) || Object.keys(identity).toSorted().join(",") !== "dev,ino" ||
    typeof identity.dev !== "string" || !/^\d+$/u.test(identity.dev) ||
    typeof identity.ino !== "string" || !/^\d+$/u.test(identity.ino)
  ) {
    throw new Error("contained turn rehydration record is invalid");
  }
  return Object.freeze({
    manifestDigest: value.manifestDigest,
    operationId: value.operationId,
    projectId: value.projectId,
    rootIdentity: Object.freeze({ dev: identity.dev, ino: identity.ino }),
    schemaVersion: 2,
    stagingName: value.stagingName,
    tenantId: value.tenantId,
    treeDigest: value.treeDigest,
  });
};
