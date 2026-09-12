import { DockerEngineError } from "./docker-engine-error.js";
import { decodeInspection, validateAuthorityShape } from "./docker-engine-codec.js";
import { snapshotDockerEngineCall } from "./docker-boundary-snapshot.js";
import { parseStrictJson } from "./strict-json.js";
import { readDockerFileArchive, type DockerArchiveFile } from "./docker-bounded-file-archive.js";
import { parseDockerImageReference } from "./docker-image-reference.js";
import {
  DOCKER_CUSTODY_INIT_ARGUMENTS, DOCKER_CUSTODY_NODE_PATH,
  snapshotDockerImageInitLock, type DockerImageInitLock,
} from "./docker-image-init-lock.js";
import type { DockerEngineClient } from "./docker-engine-client.js";
import type { DockerContainerAuthority, DockerEngineCall, DockerEngineIdentity, DockerEnginePolicy } from "./docker-engine-port.js";

export interface DockerImageReadbackDependencies {
  readonly client: Pick<DockerEngineClient, "buffered" | "stream">;
  readonly identity: (call: DockerEngineCall) => Promise<DockerEngineIdentity>;
  readonly policy: DockerEnginePolicy;
}
const fail = (): never => {throw new DockerEngineError("authority-conflict");};
const media = (value: string): string => value.split(";", 1)[0]?.trim().toLowerCase() ?? "";
const object = (value: unknown): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {return fail();}
  return value as Record<string, unknown>;
};
const stringsEqual = (value: unknown, expected: readonly string[]): boolean =>
  Array.isArray(value) && value.length === expected.length && value.every((part, i) => part === expected[i]);
const checkCall = (call: DockerEngineCall): void => {
  if (call.signal.aborted) {throw new DockerEngineError("aborted");}
  if (Date.now() >= call.deadlineEpochMs) {throw new DockerEngineError("deadline-exceeded");}
};
const sameEngine = (authority: DockerContainerAuthority, engine: DockerEngineIdentity): void => {
  if (authority.daemonIdentitySha256 !== engine.daemonIdentitySha256 ||
      authority.daemonBootGenerationSha256 !== engine.daemonBootGenerationSha256 ||
      authority.hostIdentitySha256 !== engine.hostIdentitySha256 ||
      authority.hostBootGenerationSha256 !== engine.hostBootGenerationSha256) {
    throw new DockerEngineError("daemon-identity-changed");
  }
};
const json = async (deps: DockerImageReadbackDependencies, path: string, call: DockerEngineCall): Promise<Record<string, unknown>> => {
  checkCall(call);
  const response = await deps.client.buffered({method: "GET", path, call});
  checkCall(call);
  if (response.body.byteLength > 262_144) {throw new DockerEngineError("response-too-large");}
  if (response.statusCode !== 200 || media(response.contentType) !== "application/json") {return fail();}
  return object(parseStrictJson(response.body));
};
const inspectImage = async (deps: DockerImageReadbackDependencies, lock: DockerImageInitLock, call: DockerEngineCall): Promise<void> => {
  const image = await json(deps, `/v1.47/images/${encodeURIComponent(lock.imageReference)}/json`, call);
  const reference = parseDockerImageReference(lock.imageReference)!;
  if (image.Id !== lock.imageConfigId || image.Os !== lock.os || image.Architecture !== lock.architecture ||
      (image.Variant ?? "") !== lock.variant || image.Variant === null) {return fail();}
  if (reference.kind === "repository-digest" && (!Array.isArray(image.RepoDigests) ||
      image.RepoDigests.length > 128 || !image.RepoDigests.includes(reference.repositoryDigest) ||
      image.RepoDigests.some(entry => parseDockerImageReference(entry)?.kind !== "repository-digest"))) {return fail();}
};
const inspectCreated = async (input: {
  readonly deps: DockerImageReadbackDependencies; readonly authority: DockerContainerAuthority;
  readonly lock: DockerImageInitLock; readonly call: DockerEngineCall;
}): Promise<void> => {
  const {deps, authority, lock, call} = input;
  const engine = await deps.identity(call); sameEngine(authority, engine);
  const raw = await json(deps, `/v1.47/containers/${authority.containerId}/json`, call);
  const observed = decodeInspection(raw, authority, engine, deps.policy);
  if (observed.existence !== "present" || observed.state.status !== "created" || observed.state.running ||
      observed.state.hostPid !== 0 || raw.Image !== lock.imageConfigId || raw.Path !== DOCKER_CUSTODY_NODE_PATH ||
      !stringsEqual(raw.Args, DOCKER_CUSTODY_INIT_ARGUMENTS)) {return fail();}
  const config = object(raw.Config);
  const environment = config.Env;
  if (!stringsEqual(config.Entrypoint, [DOCKER_CUSTODY_NODE_PATH]) || !stringsEqual(config.Cmd, DOCKER_CUSTODY_INIT_ARGUMENTS) ||
      !Array.isArray(environment) || environment.length !== 4 ||
      !stringsEqual(environment.slice(0, 3), ["HOME=/agent-private/home", "PATH=/usr/local/bin:/usr/bin:/bin", "TMPDIR=/tmp"]) ||
      typeof environment[3] !== "string" || !environment[3].startsWith("AR_CUSTODY_INIT_CONFIGURATION=") || environment[3].length > 32_768) {return fail();}
  sameEngine(authority, await deps.identity(call));
};
const readFile = async (deps: DockerImageReadbackDependencies, authority: DockerContainerAuthority,
  file: DockerArchiveFile, call: DockerEngineCall): Promise<void> => {
  checkCall(call);
  const response = await deps.client.stream({method: "GET", call,
    path: `/v1.47/containers/${authority.containerId}/archive?path=${encodeURIComponent(file.path)}`});
  // Always enter/close the body iterator, even for rejected metadata, to release transport custody.
  async function* checkedBody(): AsyncIterable<Uint8Array> {
    for await (const bytes of response.body) {
      if (response.statusCode !== 200 || media(response.contentType) !== "application/x-tar") {return fail();}
      yield bytes;
    }
  }
  const observed = await readDockerFileArchive(checkedBody(), file.path, file.size, call);
  if (observed.size !== file.size || observed.mode !== file.mode || observed.sha256 !== file.sha256) {return fail();}
  sameEngine(authority, await deps.identity(call));
};

/** Concrete Engine-only readback, never a caller-supplied proof. No start/mutation. */
export const readCreatedDockerImageInit = async (deps: DockerImageReadbackDependencies,
  authority: DockerContainerAuthority, selection: DockerImageInitLock, call: DockerEngineCall): Promise<void> => {
  const bound = validateAuthorityShape(authority);
  const lock = snapshotDockerImageInitLock(selection);
  const deadline = snapshotDockerEngineCall(call);
  if (bound.imageDigest !== lock.imageReference) {return fail();}
  await inspectCreated({deps, authority: bound, lock, call: deadline});
  await inspectImage(deps, lock, deadline);
  sameEngine(bound, await deps.identity(deadline));
  await readFile(deps, bound, lock.interpreter, deadline);
  await readFile(deps, bound, lock.bootstrap, deadline);
  await inspectImage(deps, lock, deadline);
  await inspectCreated({deps, authority: bound, lock, call: deadline});
  checkCall(deadline);
};
