import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import { bytewiseStringOrder } from "./docker-canonical-json.js";
import { DockerEngineError } from "./docker-engine-error.js";
import type { DockerContainerCreate, DockerEnginePolicy } from "./docker-engine-port.js";

const SHA256 = /^[a-f0-9]{64}$/u;
const FULL_IMAGE = /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[0-9]{1,5})?(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*(?::[A-Za-z0-9._-]+)?@sha256:[a-f0-9]{64}$/u;
const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u;
const ENV_KEY = /^[A-Z_][A-Z0-9_]{0,63}$/u;
const RESERVED_ENV = new Set(["DOCKER_CONFIG", "DOCKER_CONTEXT", "DOCKER_HOST", "HOME", "PATH", "TMPDIR"]);
const RESERVED_NETWORKS = new Set(["bridge", "default", "host", "none"]);
const SECCOMP_DENY_ACTIONS = new Set([
  "SCMP_ACT_ERRNO", "SCMP_ACT_KILL", "SCMP_ACT_KILL_PROCESS", "SCMP_ACT_KILL_THREAD", "SCMP_ACT_TRAP",
]);

const hash = (value: string): string => createHash("sha256").update(value).digest("hex");

const validSeccompProfile = (policy: DockerEnginePolicy): boolean => {
  if ([
    !SHA256.test(policy.seccompProfileSha256),
    Buffer.byteLength(policy.seccompProfileJson) > 65_536,
    hash(policy.seccompProfileJson) !== policy.seccompProfileSha256,
  ].some(Boolean)) {return false;}
  try {
    const profile = JSON.parse(policy.seccompProfileJson) as unknown;
    const defaultAction = typeof profile === "object" && profile !== null && !Array.isArray(profile)
      ? Reflect.get(profile, "defaultAction")
      : undefined;
    return typeof defaultAction === "string" && SECCOMP_DENY_ACTIONS.has(defaultAction);
  } catch {return false;}
};

export const isSensitiveMountRoot = (value: string): boolean => {
  const path = resolve(value);
  return [
    path === "/proc", path.startsWith("/proc/"), path === "/sys", path.startsWith("/sys/"), path === "/dev",
    path.startsWith("/dev/"), path.includes("docker.sock"), path === "/run/docker", path.startsWith("/run/docker/"),
    path === "/var/run/docker", path.startsWith("/var/run/docker/"),
  ].some(Boolean);
};

const overlaps = (left: string, right: string): boolean => {
  const leftFromRight = relative(resolve(left), resolve(right));
  const rightFromLeft = relative(resolve(right), resolve(left));
  return [
    leftFromRight === "",
    !leftFromRight.startsWith("..") && !isAbsolute(leftFromRight),
    !rightFromLeft.startsWith("..") && !isAbsolute(rightFromLeft),
  ].some(Boolean);
};

export const isWithin = (root: string, candidate: string): boolean => {
  const pathFromRoot = relative(resolve(root), resolve(candidate));
  return pathFromRoot !== "" && !pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot);
};

const invalidIdentityPolicy = (policy: DockerEnginePolicy): boolean => {
  const [uid, gid] = policy.user.split(":").map(Number);
  const environmentKeys = [...policy.allowedEnvironmentKeys];
  return [
    !SAFE_REF.test(policy.allowedNetworkName),
    RESERVED_NETWORKS.has(policy.allowedNetworkName),
    !/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/u.test(policy.cgroupParent),
    policy.cgroupParent.split("/").some(part => part === "." || part === ".."),
    !SAFE_REF.test(policy.appArmorProfile),
    policy.appArmorProfile === "unconfined",
    !SHA256.test(policy.hostIdentitySha256),
    !validSeccompProfile(policy),
    (uid ?? 0) <= 0,
    (gid ?? 0) <= 0,
    (uid ?? 0) > 2_147_483_647,
    (gid ?? 0) > 2_147_483_647,
    !Number.isSafeInteger(uid),
    !Number.isSafeInteger(gid),
    environmentKeys.length > 64,
    new Set(environmentKeys).size !== environmentKeys.length,
    environmentKeys.some(key => !ENV_KEY.test(key) || RESERVED_ENV.has(key)),
  ].some(Boolean);
};

const invalidPathPolicy = (policy: DockerEnginePolicy): boolean => [
  [policy.privateRootSourceRoot, policy.workspaceSourceRoot].some(path =>
    !isAbsolute(path) || path === "/" || isSensitiveMountRoot(path)),
  !isAbsolute(policy.daemonPidFilePath),
  policy.daemonPidFilePath !== resolve(policy.daemonPidFilePath),
  policy.daemonPidFilePath.includes("\0"),
  policy.daemonPidFilePath === policy.socketPath,
  !isAbsolute(policy.socketPath),
  policy.socketPath !== resolve(policy.socketPath),
  policy.socketPath.includes("\0"),
  overlaps(policy.privateRootSourceRoot, policy.workspaceSourceRoot),
].some(Boolean);

const invalidResourcePolicy = (policy: DockerEnginePolicy): boolean => {
  const limits = [policy.cpuNanoCpus, policy.memoryBytes, policy.pidsLimit, policy.tmpfsBytes, policy.writableLayerBytes];
  return [
    limits.some(limit => !Number.isSafeInteger(limit) || limit <= 0),
    !Number.isSafeInteger(policy.daemonPidFileOwnerUid),
    !Number.isSafeInteger(policy.daemonPidFileOwnerGid),
    policy.daemonPidFileOwnerUid < 0,
    policy.daemonPidFileOwnerGid < 0,
    !Number.isSafeInteger(policy.daemonPidFileMode),
    policy.daemonPidFileMode < 0,
    policy.daemonPidFileMode > 0o777,
    !Number.isSafeInteger(policy.socketOwnerUid),
    !Number.isSafeInteger(policy.socketOwnerGid),
    policy.socketOwnerUid < 0,
    policy.socketOwnerGid < 0,
    !Number.isSafeInteger(policy.socketMode),
    policy.socketMode < 0,
    policy.socketMode > 0o777,
    policy.cpuNanoCpus > 2_000_000_000,
    policy.memoryBytes > 2_147_483_648,
    policy.pidsLimit > 256,
    policy.tmpfsBytes > 1_073_741_824,
    policy.writableLayerBytes > 4_294_967_296,
  ].some(Boolean);
};

const validatePolicy = (policy: DockerEnginePolicy): void => {
  if ([invalidIdentityPolicy(policy), invalidPathPolicy(policy), invalidResourcePolicy(policy)].some(Boolean)) {
    throw new DockerEngineError("invalid-create-request");
  }
};

const validateEnvironment = (
  environment: Readonly<Record<string, string>>,
  policy: DockerEnginePolicy,
): void => {
  const entries = Object.entries(environment);
  const bytes = entries.reduce((total, [key, value]) => total + key.length + value.length, 0);
  if (entries.length > 64 || bytes > 65_536 || entries.some(([key, value]) =>
    !policy.allowedEnvironmentKeys.includes(key) || value.length > 4_096 || value.includes("\0"))) {
    throw new DockerEngineError("invalid-create-request");
  }
};

export const containerName = (nonce: string): string => `ar-turn-${nonce}`;

export const labelsFor = (
  nonce: string,
  fingerprint: string,
  hostIdentity: string,
  ownerIdentity: string,
): Readonly<Record<string, string>> => Object.freeze({
  "com.agent-runtime.contained-turn": "v1",
  "com.agent-runtime.host-identity-sha256": hostIdentity,
  "com.agent-runtime.launch-fingerprint-sha256": fingerprint,
  "com.agent-runtime.operation-nonce-sha256": nonce,
  "com.agent-runtime.owner-identity-sha256": ownerIdentity,
});

const invalidCreateInput = (input: DockerContainerCreate, policy: DockerEnginePolicy): boolean => [
  !FULL_IMAGE.test(input.imageDigest),
  !SHA256.test(input.launchFingerprintSha256),
  !SHA256.test(input.operationNonceSha256),
  !SHA256.test(input.ownerIdentitySha256),
  !isAbsolute(input.entrypoint),
  input.entrypoint.includes("\0"),
  input.arguments.length > 128,
  input.arguments.reduce((bytes, argument) => bytes + argument.length, 0) > 65_536,
  input.arguments.some(argument => argument.length > 4_096 || argument.includes("\0")),
  !isWithin(policy.workspaceSourceRoot, input.workspaceSource),
  !isWithin(policy.privateRootSourceRoot, input.privateRootSource),
  isSensitiveMountRoot(input.workspaceSource),
  isSensitiveMountRoot(input.privateRootSource),
  resolve(input.workspaceSource) === resolve(input.privateRootSource),
].some(Boolean);

export const encodeCreateRequest = (input: DockerContainerCreate, policy: DockerEnginePolicy): Record<string, unknown> => {
  validatePolicy(policy);
  validateEnvironment(input.environment, policy);
  if (invalidCreateInput(input, policy)) {throw new DockerEngineError("invalid-create-request");}
  const environment = Object.entries(input.environment)
    .toSorted(([left], [right]) => bytewiseStringOrder(left, right))
    .map(([key, value]) => `${key}=${value}`);
  const request = {
    AttachStderr: false,
    // Stdin is reserved for the one explicit pre-start hijack; Docker must not
    // create an implicit attach while keeping that stdin endpoint available.
    AttachStdin: false,
    AttachStdout: false,
    Cmd: [...input.arguments],
    Entrypoint: [input.entrypoint],
    Env: ["HOME=/agent-private/home", "PATH=/usr/local/bin:/usr/bin:/bin", "TMPDIR=/tmp", ...environment],
    HostConfig: {
      AutoRemove: false,
      CapDrop: ["ALL"],
      CgroupParent: policy.cgroupParent,
      CgroupnsMode: "private",
      CpuPeriod: 100_000,
      Init: true,
      IpcMode: "private",
      Memory: policy.memoryBytes,
      MemorySwap: policy.memoryBytes,
      Mounts: [
        { BindOptions: { Propagation: "rprivate" }, ReadOnly: !input.workspaceWritable, Source: input.workspaceSource, Target: "/workspace", Type: "bind" },
        { BindOptions: { Propagation: "rprivate" }, ReadOnly: false, Source: input.privateRootSource, Target: "/agent-private", Type: "bind" },
      ],
      NanoCpus: policy.cpuNanoCpus,
      NetworkMode: policy.allowedNetworkName,
      OomKillDisable: false,
      PidMode: "private",
      PidsLimit: policy.pidsLimit,
      Privileged: false,
      ReadonlyRootfs: true,
      RestartPolicy: { MaximumRetryCount: 0, Name: "no" },
      SecurityOpt: [
        "no-new-privileges=true",
        `seccomp=${policy.seccompProfileJson}`,
        `apparmor=${policy.appArmorProfile}`,
      ],
      StorageOpt: { size: `${policy.writableLayerBytes}` },
      Tmpfs: { "/tmp": `rw,nosuid,nodev,noexec,size=${policy.tmpfsBytes},mode=1777` },
    },
    Image: input.imageDigest,
    Labels: labelsFor(
      input.operationNonceSha256,
      input.launchFingerprintSha256,
      policy.hostIdentitySha256,
      input.ownerIdentitySha256,
    ),
    NetworkDisabled: false,
    OpenStdin: true,
    // The sole custody attach is one-shot: losing it closes this generation's
    // stdin instead of permitting a replacement attach.
    StdinOnce: true,
    StopSignal: "SIGTERM",
    Tty: false,
    User: policy.user,
    WorkingDir: "/workspace",
  };
  if (Buffer.byteLength(JSON.stringify(request)) > 131_072) {
    throw new DockerEngineError("invalid-create-request");
  }
  return request;
};

export const canonicalizeCreateMounts = async (
  input: DockerContainerCreate,
  policy: DockerEnginePolicy,
): Promise<DockerContainerCreate> => {
  try {
    const [workspaceRoot, privateRoot, workspaceSource, privateRootSource] = await Promise.all([
      realpath(policy.workspaceSourceRoot), realpath(policy.privateRootSourceRoot), realpath(input.workspaceSource),
      realpath(input.privateRootSource),
    ]);
    const [workspaceFacts, privateRootFacts] = await Promise.all([stat(workspaceSource), stat(privateRootSource)]);
    if ([
      workspaceRoot !== resolve(policy.workspaceSourceRoot), privateRoot !== resolve(policy.privateRootSourceRoot),
      !workspaceFacts.isDirectory(), !privateRootFacts.isDirectory(), !isWithin(workspaceRoot, workspaceSource),
      !isWithin(privateRoot, privateRootSource), isSensitiveMountRoot(workspaceSource),
      isSensitiveMountRoot(privateRootSource), workspaceSource === privateRootSource,
    ].some(Boolean)) {throw new DockerEngineError("invalid-create-request");}
    return { ...input, privateRootSource, workspaceSource };
  } catch (error) {
    if (error instanceof DockerEngineError) {throw error;}
    throw new DockerEngineError("invalid-create-request");
  }
};
