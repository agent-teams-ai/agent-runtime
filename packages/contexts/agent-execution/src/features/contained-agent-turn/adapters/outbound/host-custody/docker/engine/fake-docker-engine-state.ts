import type {
  DockerContainerAuthority,
  DockerContainerStateFacts,
  DockerEngineIdentity,
} from "./docker-engine-port.js";

export const initialFakeContainerState = (): DockerContainerStateFacts => ({
  dead: false,
  errorPresent: false,
  exitCode: 0,
  finishedAt: "0001-01-01T00:00:00Z",
  hostPid: 0,
  oomKilled: false,
  paused: false,
  restarting: false,
  running: false,
  startedAt: "0001-01-01T00:00:00Z",
  status: "created",
});

export const startedFakeContainerState = (
  state: DockerContainerStateFacts,
  hostPid: number,
): DockerContainerStateFacts => ({
  ...state,
  hostPid,
  paused: false,
  restarting: false,
  running: true,
  startedAt: "2026-01-01T00:00:00Z",
  status: "running",
});

export const exitedFakeContainerState = (
  state: DockerContainerStateFacts,
  exitCode: number,
): DockerContainerStateFacts => ({
  ...state,
  exitCode,
  finishedAt: "2026-01-01T00:00:01Z",
  hostPid: 0,
  paused: false,
  restarting: false,
  running: false,
  status: "exited",
});

export const sameFakeEngine = (left: DockerEngineIdentity, right: DockerEngineIdentity): boolean =>
  left.daemonIdentitySha256 === right.daemonIdentitySha256 &&
  left.hostIdentitySha256 === right.hostIdentitySha256 &&
  left.daemonBootGenerationSha256 === right.daemonBootGenerationSha256 &&
  left.hostBootGenerationSha256 === right.hostBootGenerationSha256;

export const authorityBelongsToFakeEngine = (
  authority: DockerContainerAuthority,
  engine: DockerEngineIdentity,
): boolean =>
  authority.daemonIdentitySha256 === engine.daemonIdentitySha256 &&
  authority.hostIdentitySha256 === engine.hostIdentitySha256 &&
  authority.daemonBootGenerationSha256 === engine.daemonBootGenerationSha256 &&
  authority.hostBootGenerationSha256 === engine.hostBootGenerationSha256;

export const sameFakeAuthority = (
  left: DockerContainerAuthority,
  right: DockerContainerAuthority,
): boolean =>
  left.containerId === right.containerId &&
  left.daemonIdentitySha256 === right.daemonIdentitySha256 &&
  left.createSpecificationSha256 === right.createSpecificationSha256 &&
  left.daemonBootGenerationSha256 === right.daemonBootGenerationSha256 &&
  left.hostBootGenerationSha256 === right.hostBootGenerationSha256 &&
  left.hostIdentitySha256 === right.hostIdentitySha256 &&
  left.imageDigest === right.imageDigest &&
  left.launchFingerprintSha256 === right.launchFingerprintSha256 &&
  left.operationNonceSha256 === right.operationNonceSha256 &&
  left.ownerIdentitySha256 === right.ownerIdentitySha256;
