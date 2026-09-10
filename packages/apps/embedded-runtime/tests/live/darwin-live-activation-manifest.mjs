import {createHash} from "node:crypto";
import {lstat, readFile} from "node:fs/promises";
import {isAbsolute} from "node:path";

export const plainJson = value => {
  const seen = new Set();
  const visit = entry => {
    if (entry === null || typeof entry === "string" || typeof entry === "boolean") {return entry;}
    if (typeof entry === "number" && Number.isFinite(entry)) {return entry;}
    if (typeof entry !== "object" || seen.has(entry) ||
        (!Array.isArray(entry) && Object.getPrototypeOf(entry) !== Object.prototype)) {
      throw new TypeError("activation infrastructure must contain only plain JSON values");
    }
    seen.add(entry);
    const result = Array.isArray(entry) ? [] : {};
    for (const key of Reflect.ownKeys(entry)) {
      if (Array.isArray(entry) && key === "length") {continue;}
      const descriptor = Object.getOwnPropertyDescriptor(entry, key);
      if (typeof key !== "string" || !descriptor.enumerable || !("value" in descriptor) ||
          /^(token|password|cookie|authJson|credentials|sensitiveOutputTokens)$/iu.test(key)) {
        throw new TypeError("activation infrastructure contains forbidden material");
      }
      Object.defineProperty(result, key, {value: visit(descriptor.value), enumerable: true});
    }
    seen.delete(entry);
    return Object.freeze(result);
  };
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("activation infrastructure must be a plain JSON record");
  }
  return visit(value);
};

const digestFile = async ({path, role}) => {
  if (typeof role !== "string" || role.length === 0) {throw new TypeError("activation closure roles are required");}
  if (!isAbsolute(path)) {throw new TypeError("activation closure paths must be absolute");}
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink()) {throw new TypeError("activation closure entries must be regular files");}
  return {role, path, sha256: createHash("sha256").update(await readFile(path)).digest("hex")};
};

export async function createDarwinLiveActivationManifest(input) {
  const turn = input.turn;
  const textFields = ["operationId", "commandId", "effectId", "attemptId", "executionGenerationId", "expectedMarker",
    "frozenWorkspacePath", "resultPath", "sourceMessagePath", "taskPath"];
  if (!/^[a-f0-9]{40}$/.test(input.sourceRevision) || !Array.isArray(input.closure) || input.closure.length === 0 ||
      !turn || textFields.some(key => typeof turn[key] !== "string" || turn[key].length === 0) ||
      typeof turn.scope?.tenantId !== "string" || typeof turn.scope?.projectId !== "string" ||
      !/^[a-f0-9]{64}$/.test(turn.expectedResultSha256) || !/^[a-f0-9]{64}$/.test(turn.expectedTaskSha256) ||
      !Number.isInteger(turn.maximumObservations) || turn.maximumObservations < 1 || turn.maximumObservations > 128 ||
      !Number.isInteger(turn.observeTimeoutMs) || turn.observeTimeoutMs < 1 || turn.observeTimeoutMs > 30000) {
    throw new TypeError("invalid activation source, closure or turn identity");
  }
  const infrastructure = plainJson(input.infrastructure);
  for (const key of ["identities", "database", "providerAccess", "runtimeSecurity", "filesystem", "host", "deployment", "verification", "native"]) {
    if (infrastructure[key] === null || typeof infrastructure[key] !== "object") {throw new TypeError(`activation infrastructure ${key} is required`);}
  }
  for (const key of ["operationId", "attemptId", "effectId", "executionGenerationId"]) {
    if (infrastructure.identities[key] !== turn[key]) {throw new TypeError(`activation identity ${key} differs from infrastructure`);}
  }
  const files = [];
  for (const entry of input.closure) {files.push(await digestFile(entry));}
  return Object.freeze({
    version: 1,
    platform: "darwin-arm64",
    sourceRevision: input.sourceRevision,
    candidate: true,
    qualified: false,
    consumerStandard: Object.freeze({revision: input.consumerStandardRevision, adoption: "pending"}),
    codex: Object.freeze({version: "0.153.4", path: input.codexPath, sha256: input.codexSha256}),
    native: Object.freeze({...input.native}),
    database: Object.freeze({...input.database}),
    source: Object.freeze({...input.source}),
    evidenceDirectory: input.evidenceDirectory,
    runtimeRootModulePath: input.runtimeRootModulePath,
    paRuntimeModulePath: input.paRuntimeModulePath,
    infrastructureModulePath: input.infrastructureModulePath,
    turn: Object.freeze(structuredClone(input.turn)),
    infrastructure: Object.freeze(infrastructure),
    files: Object.freeze(files.map(Object.freeze)),
  });
}
