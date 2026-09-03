import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  DockerContainerCreate,
  DockerEngineCall,
  DockerEnginePolicy,
} from "../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/engine/index.js";

export const HOST = "a".repeat(64);
export const NONCE = "b".repeat(64);
export const FINGERPRINT = "c".repeat(64);
export const OWNER_IDENTITY = "f".repeat(64);
export const CONTAINER = "d".repeat(64);
export const IMAGE = `registry.invalid:5443/runtime@sha256:${"e".repeat(64)}`;
export const SECCOMP_JSON = JSON.stringify({ defaultAction: "SCMP_ACT_ERRNO", syscalls: [] });
const SECCOMP_SHA256 = createHash("sha256").update(SECCOMP_JSON).digest("hex");
export const HOST_BOOT = "1".repeat(64);
export const DAEMON_BOOT = "2".repeat(64);

export const call = (milliseconds = 10_000): DockerEngineCall => ({
  deadlineEpochMs: Date.now() + milliseconds,
  signal: new AbortController().signal,
});

export const policy = (root: string): DockerEnginePolicy => ({
  allowedEnvironmentKeys: ["AR_OPERATION"],
  allowedNetworkName: "ar-operation-gateway",
  appArmorProfile: "agent-runtime-contained-turn-v1",
  cgroupParent: "system.slice/agent-runtime.slice",
  cpuNanoCpus: 500_000_000,
  daemonPidFileMode: 0o600,
  daemonPidFileOwnerGid: process.getgid?.() ?? 0,
  daemonPidFileOwnerUid: process.getuid?.() ?? 0,
  daemonPidFilePath: join(root, "docker.pid"),
  hostIdentitySha256: HOST,
  memoryBytes: 100_663_296,
  pidsLimit: 32,
  privateRootSourceRoot: join(root, "private"),
  seccompProfileJson: SECCOMP_JSON,
  seccompProfileSha256: SECCOMP_SHA256,
  socketMode: 0o600,
  socketOwnerGid: process.getgid?.() ?? 0,
  socketOwnerUid: process.getuid?.() ?? 0,
  socketPath: join(root, "docker.sock"),
  tmpfsBytes: 16_777_216,
  user: "65532:65532",
  workspaceSourceRoot: join(root, "workspaces"),
  writableLayerBytes: 33_554_432,
});

export const createInput = (root: string, nonce = NONCE): DockerContainerCreate => ({
  arguments: ["serve", "--stdio"],
  entrypoint: "/usr/local/bin/provider",
  environment: { AR_OPERATION: "opaque-operation" },
  imageDigest: IMAGE,
  launchFingerprintSha256: FINGERPRINT,
  operationNonceSha256: nonce,
  ownerIdentitySha256: OWNER_IDENTITY,
  privateRootSource: join(root, "private", "operation"),
  workspaceSource: join(root, "workspaces", "operation"),
  workspaceWritable: true,
});

export const disposable = async (): Promise<string> => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ar-docker-engine-")));
  await mkdir(join(root, "private", "operation"), { recursive: true });
  await mkdir(join(root, "workspaces", "operation"), { recursive: true });
  return root;
};
