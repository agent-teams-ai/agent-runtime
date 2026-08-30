import { createHash } from "node:crypto";

import { DockerEngineError } from "./docker-engine-error.js";
import type {
  DockerContainerAuthority,
  DockerContainerObservation,
  DockerContainerResourceFacts,
  DockerEngineIdentity,
  DockerEnginePolicy,
} from "./docker-engine-port.js";
import type { DockerEndpointIdentity } from "./bounded-unix-http.js";
import { canonicalJsonSha256 } from "./docker-canonical-json.js";
import { snapshotDockerContainerAuthority } from "./docker-boundary-snapshot.js";
import { decodeDockerContainerState } from "./docker-container-state.js";
import { containerName, isSensitiveMountRoot, isWithin, labelsFor } from "./docker-create-request.js";
import {
  BIND_OPTIONS_FIELDS,
  CONFIG_FIELDS,
  CONFIGURED_MOUNT_FIELDS,
  CREATE_CONFIG_FIELDS,
  CREATE_HOST_FIELDS,
  HOST_CONFIG_FIELDS,
  INFO_FIELDS,
  INSPECT_FIELDS,
  OBSERVED_MOUNT_FIELDS,
} from "./docker-api-v1.47-fields.js";

const SHA256 = /^[a-f0-9]{64}$/u;
const FULL_IMAGE = /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[0-9]{1,5})?(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*(?::[A-Za-z0-9._-]+)?@sha256:[a-f0-9]{64}$/u;
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

const versionedObject = (
  value: unknown,
  allowedKeys: readonly string[],
  requiredKeys: readonly string[],
  failure: "authority-conflict" | "malformed-response" = "malformed-response",
): Record<string, unknown> => {
  const decoded = object(value);
  const observed = Object.keys(decoded);
  if (observed.some(key => !allowedKeys.includes(key)) || requiredKeys.some(key => !Object.hasOwn(decoded, key))) {
    throw new DockerEngineError(failure);
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

export const decodeEngineIdentity = (
  value: unknown,
  policy: DockerEnginePolicy,
  endpoint: DockerEndpointIdentity,
): DockerEngineIdentity => {
  const info = versionedObject(
    value,
    INFO_FIELDS,
    ["CgroupDriver", "CgroupVersion", "Driver", "ID", "ServerVersion"],
  );
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
  const mounts = value.map(entry => versionedObject(
    entry,
    CONFIGURED_MOUNT_FIELDS,
    ["BindOptions", "ReadOnly", "Source", "Target", "Type"],
    "authority-conflict",
  ));
  const workspace = mounts.find(mount => mount.Target === "/workspace");
  const privateRoot = mounts.find(mount => mount.Target === "/agent-private");
  for (const mount of mounts) {
    const bindOptions = versionedObject(
      mount.BindOptions,
      BIND_OPTIONS_FIELDS,
      ["Propagation"],
      "authority-conflict",
    );
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
  const mounts = value.map(entry => versionedObject(
    entry,
    OBSERVED_MOUNT_FIELDS,
    ["Destination", "Propagation", "RW", "Source", "Type"],
    "authority-conflict",
  ));
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
  versionedObject(hostConfig, HOST_CONFIG_FIELDS, CREATE_HOST_FIELDS, "authority-conflict");
  const storage = exactObject(hostConfig.StorageOpt, ["size"]);
  const tmpfs = exactObject(hostConfig.Tmpfs, ["/tmp"]);
  const restart = exactObject(hostConfig.RestartPolicy, ["MaximumRetryCount", "Name"]);
  const tmpfsValue = string(tmpfs["/tmp"]);
  const tmpfsSize = /(?:^|,)size=([0-9]+)(?:,|$)/u.exec(tmpfsValue)?.[1];
  const cgroupNamespaceMode = string(hostConfig.CgroupnsMode);
  const security = [
    "no-new-privileges=true",
    `seccomp=${policy.seccompProfileJson}`,
    `apparmor=${policy.appArmorProfile}`,
  ];
  if (tmpfsSize === undefined || [
    cgroupNamespaceMode !== "private",
    hostConfig.AutoRemove !== false,
    hostConfig.Privileged !== false,
    hostConfig.PidMode !== "private",
    hostConfig.Init !== true,
    hostConfig.IpcMode !== "private",
    hostConfig.OomKillDisable !== false,
    hostConfig.CgroupParent !== policy.cgroupParent,
    hostConfig.CpuPeriod !== 100_000,
    hostConfig.NetworkMode !== policy.allowedNetworkName,
    !exactStrings(hostConfig.CapDrop, ["ALL"]),
    !exactStrings(hostConfig.SecurityOpt, security),
    restart.Name !== "no",
    restart.MaximumRetryCount !== 0,
  ].some(Boolean)) {
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
    cgroupNamespaceMode: "private",
    cgroupParent: string(hostConfig.CgroupParent),
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
    tmpfsBytes: Number(tmpfsSize),
    user: policy.user,
    workspaceSourceSha256: mounts.workspaceSourceSha256,
    workspaceWritable: mounts.workspaceWritable,
    writableLayerBytes: Number(string(storage.size)),
  };
};

const projectedConfiguredMounts = (value: unknown): readonly Record<string, unknown>[] => {
  if (!Array.isArray(value) || value.length !== 2) {throw new DockerEngineError("authority-conflict");}
  return value.map(entry => {
    const mount = versionedObject(
      entry,
      CONFIGURED_MOUNT_FIELDS,
      ["BindOptions", "ReadOnly", "Source", "Target", "Type"],
      "authority-conflict",
    );
    const bind = versionedObject(mount.BindOptions, BIND_OPTIONS_FIELDS, ["Propagation"], "authority-conflict");
    return {
      BindOptions: { Propagation: bind.Propagation },
      ReadOnly: mount.ReadOnly,
      Source: mount.Source,
      Target: mount.Target,
      Type: mount.Type,
    };
  });
};

const observedCreateSpecificationSha256 = (
  name: unknown,
  config: Record<string, unknown>,
  hostConfig: Record<string, unknown>,
): string => {
  const projectedHost: Record<string, unknown> = {};
  for (const key of CREATE_HOST_FIELDS) {projectedHost[key] = hostConfig[key];}
  projectedHost.Mounts = projectedConfiguredMounts(hostConfig.Mounts);
  const restart = exactObject(hostConfig.RestartPolicy, ["MaximumRetryCount", "Name"]);
  projectedHost.RestartPolicy = { MaximumRetryCount: restart.MaximumRetryCount, Name: restart.Name };
  const storage = exactObject(hostConfig.StorageOpt, ["size"]);
  projectedHost.StorageOpt = { size: storage.size };
  const tmpfs = exactObject(hostConfig.Tmpfs, ["/tmp"]);
  projectedHost.Tmpfs = { "/tmp": tmpfs["/tmp"] };
  const request: Record<string, unknown> = { HostConfig: projectedHost };
  for (const key of CREATE_CONFIG_FIELDS) {request[key] = config[key];}
  return canonicalJsonSha256({ Name: string(name).replace(/^\//u, ""), Request: request });
};

export const decodeInspection = (
  value: unknown,
  authority: DockerContainerAuthority,
  engine: DockerEngineIdentity,
  policy: DockerEnginePolicy,
): DockerContainerObservation => {
  const inspect = versionedObject(
    value,
    INSPECT_FIELDS,
    ["AppArmorProfile", "Config", "HostConfig", "Id", "Mounts", "Name", "State"],
  );
  const id = string(inspect.Id);
  const config = versionedObject(inspect.Config, CONFIG_FIELDS, CREATE_CONFIG_FIELDS);
  const hostConfig = versionedObject(inspect.HostConfig, HOST_CONFIG_FIELDS, CREATE_HOST_FIELDS);
  const expectedLabels = labelsFor(
    authority.operationNonceSha256,
    authority.launchFingerprintSha256,
    authority.hostIdentitySha256,
  );
  const observedSpecification = observedCreateSpecificationSha256(inspect.Name, config, hostConfig);
  if (id !== authority.containerId || !SHA256.test(id) || config.Image !== authority.imageDigest ||
      config.User !== policy.user || inspect.AppArmorProfile !== policy.appArmorProfile ||
      !exactLabels(config.Labels, expectedLabels) || observedSpecification !== authority.createSpecificationSha256 ||
      inspect.Name !== `/${containerName(authority.operationNonceSha256)}`) {
    throw new DockerEngineError("authority-conflict");
  }
  const resources = resourceFacts(id, hostConfig, inspect.Mounts, policy);
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
    state: decodeDockerContainerState(inspect.State),
  };
};

export const validateAuthorityShape = (value: DockerContainerAuthority): DockerContainerAuthority => {
  const authority = snapshotDockerContainerAuthority(value);
  if (!SHA256.test(authority.containerId) || !SHA256.test(authority.daemonIdentitySha256) ||
      !SHA256.test(authority.daemonBootGenerationSha256) || !SHA256.test(authority.hostBootGenerationSha256) ||
      !SHA256.test(authority.createSpecificationSha256) ||
      !SHA256.test(authority.hostIdentitySha256) || !SHA256.test(authority.launchFingerprintSha256) ||
      !SHA256.test(authority.operationNonceSha256) || !FULL_IMAGE.test(authority.imageDigest)) {
    throw new DockerEngineError("invalid-authority");
  }
  return authority;
};
