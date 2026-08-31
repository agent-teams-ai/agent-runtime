import type {
  DockerContainerAuthority,
  DockerContainerCreate,
  DockerContainerObservation,
  DockerEngineIdentity,
} from "./engine/index.js";
import {
  bindDockerCustodyAttemptKey,
  dockerCustodyOwnerIdentitySha256,
} from "./journal/docker-custody-journal-codec.js";
import type {
  DockerCustodyAttemptKey,
  DockerCustodyOwnerIdentity,
} from "./journal/docker-custody-journal-types.js";

export type DockerHostCustodyContainerCreateInput = Omit<DockerContainerCreate, "ownerIdentitySha256">;

export const bindDockerHostCustodyCreate = (
  key: DockerCustodyAttemptKey,
  create: DockerHostCustodyContainerCreateInput,
): DockerContainerCreate => {
  if (key.launchFingerprintSha256 !== create.launchFingerprintSha256 ||
      key.operationNonceSha256 !== create.operationNonceSha256) {
    throw new TypeError("Docker Host Custody launch facts conflict with their canonical owner identity");
  }
  return Object.freeze({
    ...create,
    ownerIdentitySha256: dockerCustodyOwnerIdentitySha256(key),
  });
};

export const assertDockerEngineBinding = (
  key: DockerCustodyAttemptKey,
  engine: DockerEngineIdentity,
): void => {
  if (key.daemonIdentitySha256 !== engine.daemonIdentitySha256 ||
      key.daemonBootGenerationSha256 !== engine.daemonBootGenerationSha256 ||
      key.hostIdentitySha256 !== engine.hostIdentitySha256 ||
      key.hostBootGenerationSha256 !== engine.hostBootGenerationSha256) {
    throw new TypeError("Docker Host Custody engine generation conflicts with its canonical owner identity");
  }
};

export const assertDockerAuthorityBinding = (
  key: DockerCustodyAttemptKey,
  authority: DockerContainerAuthority,
): void => {
  if (key.daemonIdentitySha256 !== authority.daemonIdentitySha256 ||
      key.daemonBootGenerationSha256 !== authority.daemonBootGenerationSha256 ||
      key.hostIdentitySha256 !== authority.hostIdentitySha256 ||
      key.hostBootGenerationSha256 !== authority.hostBootGenerationSha256 ||
      key.launchFingerprintSha256 !== authority.launchFingerprintSha256 ||
      key.operationNonceSha256 !== authority.operationNonceSha256 ||
      authority.ownerIdentitySha256 !== dockerCustodyOwnerIdentitySha256(key)) {
    throw new TypeError("Docker Host Custody authority conflicts with its canonical owner identity");
  }
};

export const sameDockerAuthority = (
  left: DockerContainerAuthority,
  right: DockerContainerAuthority,
): boolean =>
  left.containerId === right.containerId &&
  left.createSpecificationSha256 === right.createSpecificationSha256 &&
  left.daemonBootGenerationSha256 === right.daemonBootGenerationSha256 &&
  left.daemonIdentitySha256 === right.daemonIdentitySha256 &&
  left.hostBootGenerationSha256 === right.hostBootGenerationSha256 &&
  left.hostIdentitySha256 === right.hostIdentitySha256 &&
  left.imageDigest === right.imageDigest &&
  left.launchFingerprintSha256 === right.launchFingerprintSha256 &&
  left.operationNonceSha256 === right.operationNonceSha256 &&
  left.ownerIdentitySha256 === right.ownerIdentitySha256;

export const isRunningDockerObservation = (observation: DockerContainerObservation): boolean =>
  observation.existence === "present" && observation.state.running && observation.state.status === "running";

export const isInactiveDockerObservation = (observation: DockerContainerObservation): boolean =>
  observation.existence === "absent" || (
    !observation.state.running && !observation.state.paused && !observation.state.restarting &&
    observation.state.hostPid === 0 && ["created", "dead", "exited"].includes(observation.state.status)
  );

export const dockerHostCustodyAttemptKey = (
  owner: DockerCustodyOwnerIdentity,
  create: DockerHostCustodyContainerCreateInput,
  engine: DockerEngineIdentity,
): DockerCustodyAttemptKey => bindDockerCustodyAttemptKey({
  daemonBootGenerationSha256: engine.daemonBootGenerationSha256,
  daemonIdentitySha256: engine.daemonIdentitySha256,
  hostBootGenerationSha256: engine.hostBootGenerationSha256,
  hostIdentitySha256: engine.hostIdentitySha256,
  launchFingerprintSha256: create.launchFingerprintSha256,
  operationNonceSha256: create.operationNonceSha256,
  owner,
});
