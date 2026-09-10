import {createHash} from "node:crypto";
import {lstat, readFile} from "node:fs/promises";
import {isAbsolute} from "node:path";

const digestFile = async ({path, role}) => {
  if (typeof role !== "string" || role.length === 0) {throw new TypeError("activation closure roles are required");}
  if (!isAbsolute(path)) {throw new TypeError("activation closure paths must be absolute");}
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink()) {throw new TypeError("activation closure entries must be regular files");}
  return {role, path, sha256: createHash("sha256").update(await readFile(path)).digest("hex")};
};

export async function createDarwinLiveActivationManifest(input) {
  if (!/^[a-f0-9]{40}$/.test(input.sourceRevision) || !Array.isArray(input.closure) || input.closure.length === 0) {
    throw new TypeError("invalid activation source or closure");
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
    files: Object.freeze(files.map(Object.freeze)),
  });
}
