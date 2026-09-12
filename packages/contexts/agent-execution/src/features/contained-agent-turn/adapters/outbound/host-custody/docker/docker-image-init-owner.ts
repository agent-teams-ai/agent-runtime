import {
  canonicalJsonSha256, NodeUnixSocketDockerEngine, snapshotDockerEngineCall, validateAuthorityShape,
  snapshotOwnDataObject, DockerEngineError, parseDockerImageReference, snapshotDockerImageInitLock,
  type DockerImageReference, type DockerImageInitLock,
} from "./engine/docker-engine-composition.js";
import type { DockerContainerAuthority, DockerEngineCall } from "./engine/docker-engine-port.js";

/** Independent Host-bootstrap input. The image owner does not allocate or prove this generation. */
export interface DockerImageInitHostBinding {
  readonly hostIdentitySha256: string;
  readonly hostBootGenerationSha256: string;
  readonly hostLifecycleGenerationSha256: string;
}
declare const issuedImageInit: unique symbol;
export interface DockerImageInitWitness {
  readonly [issuedImageInit]: never;
  readonly scope: "created-image-init-readback";
  readonly authority: DockerContainerAuthority;
  readonly host: DockerImageInitHostBinding;
  readonly image: DockerImageReference;
  /** Actual container top-level Image AND selected image Id, not Config.Image. */
  readonly imageConfigId: string;
  readonly init: DockerImageInitLock;
  /** Stable evidence locator only; recognition requires the same runtime-issued object. */
  readonly bindingSha256: string;
}
export interface DockerImageInitOwner {
  /** Invoke after journaled create, BEFORE init_start_requested/Engine start. */
  verifyCreated(authority: DockerContainerAuthority, call: DockerEngineCall): Promise<DockerImageInitWitness>;
  /** Same owner, witness, original authority object and exact independent Host binding. */
  assertWitness(witness: DockerImageInitWitness, authority: DockerContainerAuthority, host: DockerImageInitHostBinding): void;
}
const hostBinding = (value: DockerImageInitHostBinding): DockerImageInitHostBinding => {
  const keys = ["hostIdentitySha256", "hostBootGenerationSha256", "hostLifecycleGenerationSha256"];
  const bound = snapshotOwnDataObject(value, keys, keys, "invalid-authority");
  if (Object.values(bound).some(part => typeof part !== "string" || !/^[a-f0-9]{64}$/u.test(part))) {
    throw new DockerEngineError("invalid-authority");
  }
  return bound as unknown as DockerImageInitHostBinding;
};
const verify = NodeUnixSocketDockerEngine.prototype.verifyCreatedImageInit;
const owners = new WeakSet<DockerImageInitOwner>();
/** Recognize only the frozen capability issued here, without reading caller methods. */
export const retainDockerImageInitOwner = (owner: DockerImageInitOwner): DockerImageInitOwner => {
  if (!owners.has(owner)) {throw new DockerEngineError("authority-conflict");}
  return owner;
};

/** Private Pure DI constructor. Selection is copied synchronously before any Engine observation.
 * This capability proves an image/init sample, not provider execution, Host-generation
 * ownership, absence of later exec, residue, cleanup, or deployment qualification.
 */
export const createDockerImageInitOwner = (input: {
  readonly engine: NodeUnixSocketDockerEngine;
  readonly lock: DockerImageInitLock;
  readonly host: DockerImageInitHostBinding;
}): DockerImageInitOwner => {
  const keys = ["engine", "lock", "host"];
  const construction = snapshotOwnDataObject(input, keys, keys, "invalid-authority");
  const engine = construction.engine as NodeUnixSocketDockerEngine;
  const lock = snapshotDockerImageInitLock(construction.lock as DockerImageInitLock);
  const host = hostBinding(construction.host as DockerImageInitHostBinding);
  const issued = new WeakMap<DockerImageInitWitness, {authority: DockerContainerAuthority; digest: string}>();
  const owner: DockerImageInitOwner = Object.freeze({
    async verifyCreated(authority: DockerContainerAuthority, call: DockerEngineCall): Promise<DockerImageInitWitness> {
      const bound = validateAuthorityShape(authority);
      const deadline = snapshotDockerEngineCall(call);
      if (bound.hostIdentitySha256 !== host.hostIdentitySha256 ||
          bound.hostBootGenerationSha256 !== host.hostBootGenerationSha256 || bound.imageDigest !== lock.imageReference) {
        throw new DockerEngineError("authority-conflict");
      }
      await verify.call(engine, bound, lock, deadline);
      const digest = canonicalJsonSha256(bound);
      if (canonicalJsonSha256(validateAuthorityShape(authority)) !== digest) {throw new DockerEngineError("authority-conflict");}
      const facts = {scope: "created-image-init-readback" as const, authority: bound, host,
        image: parseDockerImageReference(lock.imageReference)!, imageConfigId: lock.imageConfigId, init: lock};
      const witness = Object.freeze({...facts, bindingSha256: canonicalJsonSha256(facts)}) as DockerImageInitWitness;
      issued.set(witness, {authority, digest});
      return witness;
    },
    assertWitness(witness: DockerImageInitWitness, authority: DockerContainerAuthority, currentHost: DockerImageInitHostBinding): void {
      const entry = issued.get(witness);
      if (entry === undefined || entry.authority !== authority ||
          canonicalJsonSha256(validateAuthorityShape(authority)) !== entry.digest ||
          canonicalJsonSha256(hostBinding(currentHost)) !== canonicalJsonSha256(host)) {
        throw new DockerEngineError("authority-conflict");
      }
    },
  });
  owners.add(owner);
  return owner;
};
