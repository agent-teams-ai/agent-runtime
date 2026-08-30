import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import { DockerEngineError } from "./docker-engine-error.js";
import type {
  DockerContainerAuthority,
  DockerContainerCreate,
  DockerContainerObservation,
  DockerContainerResourceFacts,
  DockerContainerStateFacts,
  DockerEngineIdentity,
  DockerEnginePolicy,
} from "./docker-engine-port.js";
import type { DockerEndpointIdentity } from "./bounded-unix-http.js";

const SHA256 = /^[a-f0-9]{64}$/u;
const FULL_IMAGE = /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[0-9]{1,5})?(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*(?::[A-Za-z0-9._-]+)?@sha256:[a-f0-9]{64}$/u;
const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u;
const ENV_KEY = /^[A-Z_][A-Z0-9_]{0,63}$/u;
const RESERVED_ENV = new Set(["DOCKER_CONFIG", "DOCKER_CONTEXT", "DOCKER_HOST", "HOME", "PATH", "TMPDIR"]);
const RESERVED_NETWORKS = new Set(["bridge", "default", "host", "none"]);
const SECCOMP_DENY_ACTIONS = new Set([
  "SCMP_ACT_ERRNO",
  "SCMP_ACT_KILL",
  "SCMP_ACT_KILL_PROCESS",
  "SCMP_ACT_KILL_THREAD",
  "SCMP_ACT_TRAP",
]);
const STATUSES = new Set(["created", "dead", "exited", "paused", "removing", "restarting", "running"]);
const LABEL_KEYS = Object.freeze([
  "com.agent-runtime.contained-turn",
  "com.agent-runtime.host-identity-sha256",
  "com.agent-runtime.launch-fingerprint-sha256",
  "com.agent-runtime.operation-nonce-sha256",
]);

const object = (value: unknown): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DockerEngineError("malformed-response");
  }
  return value as Record<string, unknown>;
};

const exactObject = (value: unknown, keys: readonly string[]): Record<string, unknown> => {
  const decoded = object(value);
  const observed = Object.keys(decoded).toSorted();
  const expected = [...keys].toSorted();
  if (observed.length !== expected.length || observed.some((key, index) => key !== expected[index])) {
    throw new DockerEngineError("malformed-response");
  }
  return decoded;
};

const string = (value: unknown): string => {
  if (typeof value !== "string") {throw new DockerEngineError("malformed-response");}
  return value;
};

const number = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new DockerEngineError("malformed-response");
  }
  return value;
};

const boolean = (value: unknown): boolean => {
  if (typeof value !== "boolean") {throw new DockerEngineError("malformed-response");}
  return value;
};

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

const validSeccompProfile = (policy: DockerEnginePolicy): boolean => {
  if (!SHA256.test(policy.seccompProfileSha256) || Buffer.byteLength(policy.seccompProfileJson) > 65_536 ||
      sha256(policy.seccompProfileJson) !== policy.seccompProfileSha256) {
    return false;
  }
  try {
    const profile = JSON.parse(policy.seccompProfileJson) as unknown;
    const defaultAction = typeof profile === "object" && profile !== null && !Array.isArray(profile)
      ? Reflect.get(profile, "defaultAction")
      : undefined;
    return typeof defaultAction === "string" && SECCOMP_DENY_ACTIONS.has(defaultAction);
  } catch {return false;}
};

const isSensitiveMountRoot = (value: string): boolean => {
  const path = resolve(value);
  return path === "/proc" || path.startsWith("/proc/") || path === "/sys" || path.startsWith("/sys/") ||
    path === "/dev" || path.startsWith("/dev/") || path.includes("docker.sock") ||
    path === "/run/docker" || path.startsWith("/run/docker/") ||
    path === "/var/run/docker" || path.startsWith("/var/run/docker/");
};

const overlaps = (left: string, right: string): boolean => {
  const leftFromRight = relative(resolve(left), resolve(right));
  const rightFromLeft = relative(resolve(right), resolve(left));
  return leftFromRight === "" || (!leftFromRight.startsWith("..") && !isAbsolute(leftFromRight)) ||
    (!rightFromLeft.startsWith("..") && !isAbsolute(rightFromLeft));
};

const isWithin = (root: string, candidate: string): boolean => {
  const canonicalRoot = resolve(root);
  const canonicalCandidate = resolve(candidate);
  const pathFromRoot = relative(canonicalRoot, canonicalCandidate);
  return pathFromRoot !== "" && !pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot);
};

const invalidIdentityPolicy = (policy: DockerEnginePolicy): boolean => {
  const [uid, gid] = policy.user.split(":").map(value => Number(value));
  const environmentKeys = [...policy.allowedEnvironmentKeys];
  return !SAFE_REF.test(policy.allowedNetworkName) || RESERVED_NETWORKS.has(policy.allowedNetworkName) ||
    !SAFE_REF.test(policy.appArmorProfile) || policy.appArmorProfile === "unconfined" ||
    !SHA256.test(policy.hostIdentitySha256) || !validSeccompProfile(policy) ||
    (uid ?? 0) <= 0 || (gid ?? 0) <= 0 ||
    (uid ?? 0) > 2_147_483_647 || (gid ?? 0) > 2_147_483_647 ||
    !Number.isSafeInteger(uid) || !Number.isSafeInteger(gid) || environmentKeys.length > 64 ||
    new Set(environmentKeys).size !== environmentKeys.length ||
    environmentKeys.some(key => !ENV_KEY.test(key) || RESERVED_ENV.has(key));
};

const invalidPathPolicy = (policy: DockerEnginePolicy): boolean => {
  const sources = [policy.privateRootSourceRoot, policy.workspaceSourceRoot];
  return sources.some(path => !isAbsolute(path) || path === "/" || isSensitiveMountRoot(path)) ||
    !isAbsolute(policy.daemonPidFilePath) || policy.daemonPidFilePath !== resolve(policy.daemonPidFilePath) ||
    policy.daemonPidFilePath.includes("\0") || policy.daemonPidFilePath === policy.socketPath ||
    !isAbsolute(policy.socketPath) || policy.socketPath !== resolve(policy.socketPath) ||
    policy.socketPath.includes("\0") ||
    overlaps(policy.privateRootSourceRoot, policy.workspaceSourceRoot);
};

const invalidResourcePolicy = (policy: DockerEnginePolicy): boolean => {
  const limits = [policy.cpuNanoCpus, policy.memoryBytes, policy.pidsLimit, policy.tmpfsBytes, policy.writableLayerBytes];
  return limits.some(limit => !Number.isSafeInteger(limit) || limit <= 0) ||
    !Number.isSafeInteger(policy.daemonPidFileOwnerUid) || !Number.isSafeInteger(policy.daemonPidFileOwnerGid) ||
    policy.daemonPidFileOwnerUid < 0 || policy.daemonPidFileOwnerGid < 0 ||
    !Number.isSafeInteger(policy.daemonPidFileMode) || policy.daemonPidFileMode < 0 ||
    policy.daemonPidFileMode > 0o777 ||
    !Number.isSafeInteger(policy.socketOwnerUid) || !Number.isSafeInteger(policy.socketOwnerGid) ||
    policy.socketOwnerUid < 0 || policy.socketOwnerGid < 0 || !Number.isSafeInteger(policy.socketMode) ||
    policy.socketMode < 0 || policy.socketMode > 0o777 ||
    policy.cpuNanoCpus > 2_000_000_000 || policy.memoryBytes > 2_147_483_648 ||
    policy.pidsLimit > 256 || policy.tmpfsBytes > 1_073_741_824 || policy.writableLayerBytes > 4_294_967_296;
};

const validatePolicy = (policy: DockerEnginePolicy): void => {
  if (invalidIdentityPolicy(policy) || invalidPathPolicy(policy) || invalidResourcePolicy(policy)) {
    throw new DockerEngineError("invalid-create-request");
  }
};

const validateEnvironment = (
  environment: Readonly<Record<string, string>>,
  policy: DockerEnginePolicy,
): void => {
  const entries = Object.entries(environment);
  if (entries.length > 64 || entries.reduce((bytes, [key, value]) => bytes + key.length + value.length, 0) > 65_536) {
    throw new DockerEngineError("invalid-create-request");
  }
  for (const [key, value] of entries) {
    if (!policy.allowedEnvironmentKeys.includes(key) || value.length > 4096 || value.includes("\0")) {
      throw new DockerEngineError("invalid-create-request");
    }
  }
};

export const containerName = (nonce: string): string => `ar-turn-${nonce}`;

export const labelsFor = (
  nonce: string,
  fingerprint: string,
  hostIdentity: string,
): Readonly<Record<string, string>> => Object.freeze({
  "com.agent-runtime.contained-turn": "v1",
  "com.agent-runtime.host-identity-sha256": hostIdentity,
  "com.agent-runtime.launch-fingerprint-sha256": fingerprint,
  "com.agent-runtime.operation-nonce-sha256": nonce,
});

export const encodeCreateRequest = (input: DockerContainerCreate, policy: DockerEnginePolicy): Record<string, unknown> => {
  validatePolicy(policy);
  validateEnvironment(input.environment, policy);
  if (!FULL_IMAGE.test(input.imageDigest) || !SHA256.test(input.launchFingerprintSha256) ||
      !SHA256.test(input.operationNonceSha256) || !isAbsolute(input.entrypoint) ||
      input.entrypoint.includes("\0") || input.arguments.length > 128 ||
      input.arguments.reduce((bytes, argument) => bytes + argument.length, 0) > 65_536 ||
      input.arguments.some(argument => argument.length > 4096 || argument.includes("\0")) ||
      !isWithin(policy.workspaceSourceRoot, input.workspaceSource) ||
      !isWithin(policy.privateRootSourceRoot, input.privateRootSource) ||
      isSensitiveMountRoot(input.workspaceSource) || isSensitiveMountRoot(input.privateRootSource) ||
      resolve(input.workspaceSource) === resolve(input.privateRootSource)) {
    throw new DockerEngineError("invalid-create-request");
  }
  const environment = Object.entries(input.environment)
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`);
  const request = {
    AttachStderr: false,
    AttachStdin: false,
    AttachStdout: false,
    Cmd: [...input.arguments],
    Entrypoint: [input.entrypoint],
    Env: ["HOME=/agent-private/home", "PATH=/usr/local/bin:/usr/bin:/bin", "TMPDIR=/tmp", ...environment],
    HostConfig: {
      AutoRemove: false,
      CapDrop: ["ALL"],
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
    Labels: labelsFor(input.operationNonceSha256, input.launchFingerprintSha256, policy.hostIdentitySha256),
    NetworkDisabled: false,
    OpenStdin: false,
    StdinOnce: false,
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
      realpath(policy.workspaceSourceRoot),
      realpath(policy.privateRootSourceRoot),
      realpath(input.workspaceSource),
      realpath(input.privateRootSource),
    ]);
    const [workspaceFacts, privateRootFacts] = await Promise.all([stat(workspaceSource), stat(privateRootSource)]);
    if (workspaceRoot !== resolve(policy.workspaceSourceRoot) || privateRoot !== resolve(policy.privateRootSourceRoot) ||
        !workspaceFacts.isDirectory() || !privateRootFacts.isDirectory() ||
        !isWithin(workspaceRoot, workspaceSource) || !isWithin(privateRoot, privateRootSource) ||
        isSensitiveMountRoot(workspaceSource) || isSensitiveMountRoot(privateRootSource) ||
        workspaceSource === privateRootSource) {
      throw new DockerEngineError("invalid-create-request");
    }
    return { ...input, privateRootSource, workspaceSource };
  } catch (error) {
    if (error instanceof DockerEngineError) {throw error;}
    throw new DockerEngineError("invalid-create-request");
  }
};

export const decodeEngineIdentity = (
  value: unknown,
  policy: DockerEnginePolicy,
  endpoint: DockerEndpointIdentity,
): DockerEngineIdentity => {
  const info = exactObject(value, ["CgroupDriver", "CgroupVersion", "Driver", "ID", "ServerVersion"]);
  const cgroupVersion = string(info.CgroupVersion);
  if (cgroupVersion !== "1" && cgroupVersion !== "2") {throw new DockerEngineError("malformed-response");}
  const engineVersion = string(info.ServerVersion);
  const daemonId = string(info.ID);
  const storageDriver = string(info.Driver);
  const cgroupDriver = string(info.CgroupDriver);
  if (daemonId.length === 0 || daemonId.length > 256 || engineVersion.length > 64 ||
      storageDriver.length > 64 || cgroupDriver.length > 64) {
    throw new DockerEngineError("malformed-response");
  }
  return {
    cgroupDriver,
    cgroupVersion,
    daemonBootGenerationSha256: endpoint.daemonBootGenerationSha256,
    daemonIdentitySha256: sha256(JSON.stringify([daemonId, engineVersion, storageDriver, cgroupDriver, cgroupVersion])),
    engineVersion,
    hostIdentitySha256: policy.hostIdentitySha256,
    hostBootGenerationSha256: endpoint.hostBootGenerationSha256,
    storageDriver,
  };
};

const exactLabels = (value: unknown, expected: Readonly<Record<string, string>>): boolean => {
  const labels = object(value);
  const keys = Object.keys(labels).toSorted();
  return keys.length === LABEL_KEYS.length && LABEL_KEYS.every((key, index) =>
    keys[index] === key && labels[key] === expected[key]);
};

const exactStrings = (value: unknown, expected: readonly string[]): boolean => (
  Array.isArray(value) && value.length === expected.length && value.every((entry, index) => entry === expected[index])
);

interface MountFacts {
  readonly privateRootSourceSha256: string;
  readonly workspaceSourceSha256: string;
  readonly workspaceWritable: boolean;
}

const checkedMountSources = (
  workspaceSource: string,
  privateRootSource: string,
  workspaceWritable: boolean,
  policy: DockerEnginePolicy,
): MountFacts => {
  if (!isWithin(policy.workspaceSourceRoot, workspaceSource) ||
      !isWithin(policy.privateRootSourceRoot, privateRootSource) ||
      isSensitiveMountRoot(workspaceSource) || isSensitiveMountRoot(privateRootSource)) {
    throw new DockerEngineError("authority-conflict");
  }
  return {
    privateRootSourceSha256: sha256(privateRootSource),
    workspaceSourceSha256: sha256(workspaceSource),
    workspaceWritable,
  };
};

const configuredMountFacts = (value: unknown, policy: DockerEnginePolicy): MountFacts => {
  if (!Array.isArray(value) || value.length !== 2) {throw new DockerEngineError("authority-conflict");}
  const mounts = value.map(entry => exactObject(entry, ["BindOptions", "ReadOnly", "Source", "Target", "Type"]));
  const workspace = mounts.find(mount => mount.Target === "/workspace");
  const privateRoot = mounts.find(mount => mount.Target === "/agent-private");
  for (const mount of mounts) {
    const bindOptions = exactObject(mount.BindOptions, ["Propagation"]);
    if (mount.Type !== "bind" || bindOptions.Propagation !== "rprivate") {
      throw new DockerEngineError("authority-conflict");
    }
  }
  if (workspace === undefined || privateRoot === undefined || privateRoot.ReadOnly !== false) {
    throw new DockerEngineError("authority-conflict");
  }
  const workspaceSource = string(workspace.Source);
  const privateRootSource = string(privateRoot.Source);
  return checkedMountSources(workspaceSource, privateRootSource, !boolean(workspace.ReadOnly), policy);
};

const observedMountFacts = (value: unknown, policy: DockerEnginePolicy): MountFacts => {
  if (!Array.isArray(value) || value.length !== 2) {throw new DockerEngineError("authority-conflict");}
  const mounts = value.map(entry => exactObject(entry, ["Destination", "Propagation", "RW", "Source", "Type"]));
  const workspace = mounts.find(mount => mount.Destination === "/workspace");
  const privateRoot = mounts.find(mount => mount.Destination === "/agent-private");
  if (workspace === undefined || privateRoot === undefined || privateRoot.RW !== true ||
      mounts.some(mount => mount.Type !== "bind" || mount.Propagation !== "rprivate")) {
    throw new DockerEngineError("authority-conflict");
  }
  return checkedMountSources(
    string(workspace.Source),
    string(privateRoot.Source),
    boolean(workspace.RW),
    policy,
  );
};

const resourceFacts = (
  id: string,
  hostConfig: Record<string, unknown>,
  observedMounts: unknown,
  policy: DockerEnginePolicy,
): DockerContainerResourceFacts => {
  exactObject(hostConfig, [
    "AutoRemove", "CapDrop", "CgroupParent", "CgroupnsMode", "CpuPeriod", "Init", "IpcMode", "Memory",
    "MemorySwap", "Mounts", "NanoCpus", "NetworkMode", "OomKillDisable", "PidMode", "PidsLimit",
    "Privileged", "ReadonlyRootfs", "RestartPolicy", "SecurityOpt", "StorageOpt", "Tmpfs",
  ]);
  const storage = exactObject(hostConfig.StorageOpt, ["size"]);
  const tmpfs = exactObject(hostConfig.Tmpfs, ["/tmp"]);
  const restart = exactObject(hostConfig.RestartPolicy, ["MaximumRetryCount", "Name"]);
  const tmpfsValue = string(tmpfs["/tmp"]);
  const tmpfsMatch = /(?:^|,)size=([0-9]+)(?:,|$)/u.exec(tmpfsValue);
  const cgroupNamespaceMode = string(hostConfig.CgroupnsMode);
  const security = [
    "no-new-privileges=true",
    `seccomp=${policy.seccompProfileJson}`,
    `apparmor=${policy.appArmorProfile}`,
  ];
  if (cgroupNamespaceMode !== "private" || tmpfsMatch?.[1] === undefined ||
      hostConfig.AutoRemove !== false || hostConfig.Privileged !== false || hostConfig.PidMode !== "private" ||
      hostConfig.Init !== true || hostConfig.IpcMode !== "private" || hostConfig.OomKillDisable !== false ||
      hostConfig.NetworkMode !== policy.allowedNetworkName || !exactStrings(hostConfig.CapDrop, ["ALL"]) ||
      !exactStrings(hostConfig.SecurityOpt, security) || restart.Name !== "no" || restart.MaximumRetryCount !== 0) {
    throw new DockerEngineError("authority-conflict");
  }
  if (tmpfsValue !== `rw,nosuid,nodev,noexec,size=${policy.tmpfsBytes},mode=1777`) {
    throw new DockerEngineError("authority-conflict");
  }
  const configuredMounts = configuredMountFacts(hostConfig.Mounts, policy);
  const mounts = observedMountFacts(observedMounts, policy);
  if (configuredMounts.privateRootSourceSha256 !== mounts.privateRootSourceSha256 ||
      configuredMounts.workspaceSourceSha256 !== mounts.workspaceSourceSha256 ||
      configuredMounts.workspaceWritable !== mounts.workspaceWritable) {
    throw new DockerEngineError("authority-conflict");
  }
  return {
    appArmorProfile: policy.appArmorProfile,
    autoRemove: false,
    capabilitiesDropped: "all",
    cgroupNamespaceMode,
    cgroupParent: string(hostConfig.CgroupParent ?? ""),
    containerId: id,
    cpuNanoCpus: number(hostConfig.NanoCpus),
    init: true,
    ipcNamespaceMode: "private",
    memoryBytes: number(hostConfig.Memory),
    memorySwapBytes: number(hostConfig.MemorySwap),
    mountPropagation: "rprivate",
    networkName: policy.allowedNetworkName,
    noNewPrivileges: true,
    pidNamespaceMode: "private",
    pidsLimit: number(hostConfig.PidsLimit),
    privateRootSourceSha256: mounts.privateRootSourceSha256,
    readOnlyRoot: boolean(hostConfig.ReadonlyRootfs) as true,
    restart: "disabled",
    seccompProfileSha256: policy.seccompProfileSha256,
    tmpfsBytes: Number(tmpfsMatch[1]),
    user: policy.user,
    workspaceSourceSha256: mounts.workspaceSourceSha256,
    workspaceWritable: mounts.workspaceWritable,
    writableLayerBytes: Number(string(storage.size)),
  };
};

const stateFacts = (value: unknown): DockerContainerStateFacts => {
  const state = exactObject(value, [
    "Dead", "Error", "ExitCode", "FinishedAt", "OOMKilled", "Pid", "Running", "StartedAt", "Status",
  ]);
  const status = string(state.Status);
  if (!STATUSES.has(status)) {throw new DockerEngineError("malformed-response");}
  return {
    dead: boolean(state.Dead),
    errorPresent: string(state.Error).length > 0,
    exitCode: number(state.ExitCode),
    finishedAt: string(state.FinishedAt),
    hostPid: number(state.Pid),
    oomKilled: boolean(state.OOMKilled),
    running: boolean(state.Running),
    startedAt: string(state.StartedAt),
    status: status as DockerContainerStateFacts["status"],
  };
};

export const decodeInspection = (
  value: unknown,
  authority: DockerContainerAuthority,
  engine: DockerEngineIdentity,
  policy: DockerEnginePolicy,
): DockerContainerObservation => {
  const inspect = exactObject(value, ["AppArmorProfile", "Config", "HostConfig", "Id", "Mounts", "Name", "State"]);
  const id = string(inspect.Id);
  const config = exactObject(inspect.Config, ["Cmd", "Entrypoint", "Env", "Image", "Labels", "User", "WorkingDir"]);
  const expectedLabels = labelsFor(
    authority.operationNonceSha256,
    authority.launchFingerprintSha256,
    authority.hostIdentitySha256,
  );
  const observedSpecification = sha256(JSON.stringify([
    string(inspect.Name).replace(/^\//u, ""),
    config.Cmd,
    config.Entrypoint,
    config.Env,
    config.WorkingDir,
    config.Image,
    config.Labels,
    object(inspect.HostConfig).Mounts,
  ]));
  if (id !== authority.containerId || !SHA256.test(id) || config.Image !== authority.imageDigest ||
      config.User !== policy.user || inspect.AppArmorProfile !== policy.appArmorProfile ||
      !exactLabels(config.Labels, expectedLabels) || observedSpecification !== authority.createSpecificationSha256 ||
      inspect.Name !== `/${containerName(authority.operationNonceSha256)}`) {
    throw new DockerEngineError("authority-conflict");
  }
  const resources = resourceFacts(id, object(inspect.HostConfig), inspect.Mounts, policy);
  if (!resources.readOnlyRoot || resources.cpuNanoCpus !== policy.cpuNanoCpus ||
      resources.memoryBytes !== policy.memoryBytes || resources.memorySwapBytes !== policy.memoryBytes ||
      resources.pidsLimit !== policy.pidsLimit || resources.tmpfsBytes !== policy.tmpfsBytes ||
      resources.writableLayerBytes !== policy.writableLayerBytes) {
    throw new DockerEngineError("authority-conflict");
  }
  return {
    authority,
    cgroupTree: "unobserved",
    engine,
    existence: "present",
    resources,
    state: stateFacts(inspect.State),
  };
};

export const validateAuthorityShape = (authority: DockerContainerAuthority): void => {
  if (!SHA256.test(authority.containerId) || !SHA256.test(authority.daemonIdentitySha256) ||
      !SHA256.test(authority.daemonBootGenerationSha256) || !SHA256.test(authority.hostBootGenerationSha256) ||
      !SHA256.test(authority.createSpecificationSha256) ||
      !SHA256.test(authority.hostIdentitySha256) || !SHA256.test(authority.launchFingerprintSha256) ||
      !SHA256.test(authority.operationNonceSha256) || !FULL_IMAGE.test(authority.imageDigest)) {
    throw new DockerEngineError("invalid-authority");
  }
};
