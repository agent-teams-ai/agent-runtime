import { snapshotOwnDataObject } from "./docker-boundary-snapshot.js";
import { DockerEngineError } from "./docker-engine-error.js";
import { parseDockerImageReference } from "./docker-image-reference.js";
import { DOCKER_ARCHIVE_FILE_MAX_BYTES, type DockerArchiveFile } from "./docker-bounded-file-archive.js";

export const DOCKER_CUSTODY_NODE_PATH = "/ar-custody-node";
export const DOCKER_CUSTODY_BOOTSTRAP_PATH = "/ar-custody-init.mjs";
export const DOCKER_CUSTODY_INIT_ARGUMENTS = Object.freeze([
  "--no-addons", "--no-global-search-paths", DOCKER_CUSTODY_BOOTSTRAP_PATH,
]);

/** Supplied by trusted deployment selection BEFORE measuring this attempt.
 * Build entry contract (not an observation-generated allowlist):
 * - Bundle the production NodeDockerCustodyInitDriver and its complete transitive
 *   JS closure into /ar-custody-init.mjs; the only external imports are node: builtins.
 * - Invoke new NodeDockerCustodyInitDriver(options).run(), with NO second argument,
 *   synthetic internals, topology override, spawn override, or injected streams.
 * - Read bounded non-code options from AR_CUSTODY_INIT_CONFIGURATION; reject unknown
 *   options. Do not evaluate/import configuration or read executable code from mounts.
 * - No dynamic loading, package resolution, eval, vm, preload, native addons, or
 *   external JS/data-driven code. No imports via cwd, /tmp, or operation mounts.
 * - Ship the interpreter as a root-level regular executable, the bundle as a
 *   root-level regular file, both root-owned and non-writable. Their entire bytes,
 *   exact size/mode, Linux platform and actual image config ID are pinned here.
 * The lock's build contract needs independent build review; a digest is not approval.
 */
export interface DockerImageInitLock {
  readonly imageReference: string;
  readonly imageConfigId: string;
  readonly architecture: "amd64" | "arm64";
  readonly os: "linux";
  readonly variant: string;
  readonly loadingPolicy: "closed-bundle-node-builtins-only-v1";
  readonly interpreter: DockerArchiveFile;
  /** This one bundle contains the bootstrap AND complete shipped JS closure. */
  readonly bootstrap: DockerArchiveFile;
}

const fail = (): never => {throw new DockerEngineError("invalid-create-request");};
const file = (value: unknown, path: string, mode: number): DockerArchiveFile => {
  const keys = ["path", "sha256", "size", "mode"];
  const entry = snapshotOwnDataObject(value, keys, keys, "invalid-create-request");
  if (entry.path !== path || entry.mode !== mode || typeof entry.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(entry.sha256) || typeof entry.size !== "number" ||
      !Number.isSafeInteger(entry.size) || entry.size < 1 || entry.size > DOCKER_ARCHIVE_FILE_MAX_BYTES) {return fail();}
  return Object.freeze({path, mode, sha256: entry.sha256, size: entry.size});
};
export const snapshotDockerImageInitLock = (value: DockerImageInitLock): DockerImageInitLock => {
  const keys = ["imageReference", "imageConfigId", "architecture", "os", "variant", "loadingPolicy", "interpreter", "bootstrap"];
  const lock = snapshotOwnDataObject(value, keys, keys, "invalid-create-request");
  const reference = parseDockerImageReference(lock.imageReference);
  const config = parseDockerImageReference(lock.imageConfigId);
  if (reference === undefined || config?.kind !== "image-id" || lock.os !== "linux" ||
      !["amd64", "arm64"].includes(lock.architecture as string) ||
      (lock.variant !== "" && !(lock.architecture === "arm64" && lock.variant === "v8")) ||
      lock.loadingPolicy !== "closed-bundle-node-builtins-only-v1" ||
      (reference.kind === "image-id" && reference.reference !== config.reference)) {return fail();}
  return Object.freeze({imageReference: reference.reference, imageConfigId: config.reference,
    architecture: lock.architecture as "amd64" | "arm64", os: "linux", variant: lock.variant as string,
    loadingPolicy: "closed-bundle-node-builtins-only-v1",
    interpreter: file(lock.interpreter, DOCKER_CUSTODY_NODE_PATH, 0o555),
    bootstrap: file(lock.bootstrap, DOCKER_CUSTODY_BOOTSTRAP_PATH, 0o444)});
};
