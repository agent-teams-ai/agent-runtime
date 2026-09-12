import {codexDockerProjectionSource, type CodexDockerPathProjection} from "./codex-docker-path-projection.js";
import { createHash } from "node:crypto";

import type { ContainedTurnAdapterCapabilityManifest } from "../legacy/legacy-contained-turn-ports.js";
import type { CustodiedProviderProcessRegistry } from "../host-custody/custodied-provider-process.js";
import type { CodexEffectCustodyAuthority } from "./codex-app-server-effect-custody.js";
import {
  CODEX_PERMISSION_PROFILE_ID,
  canonicalCodexJson,
  type CodexAppServerPermissionBoundary,
  type CodexDirectoryIdentity,
} from "./codex-app-server-permission-boundary.js";
import { detachCodexManifest } from "./codex-app-server-receipt-identity.js";

import { codexNativeBrokerBoundary } from "./codex-native-broker-recipe.js";
import { codexNativeBrokerLaunchInput, type CodexAppServerLaunchPlan } from "./codex-app-server-launch-plan.js";

interface CodexProviderOptionsInput {
  readonly boundary: CodexAppServerPermissionBoundary;
  readonly cancellationPollMs?: number;
  readonly dockerProjection?: CodexDockerPathProjection;
  readonly effectCustody?: CodexEffectCustodyAuthority;
  readonly manifest: ContainedTurnAdapterCapabilityManifest;
  readonly nativeBrokerLaunchPlan?: CodexAppServerLaunchPlan;
  readonly maxActiveNotificationBytes?: number;
  readonly maxActiveNotifications?: number;
  readonly maxLineBytes?: number;
  readonly processes: CustodiedProviderProcessRegistry;
  readonly privateRootPath: string;
  readonly requestTimeoutMs?: number;
  readonly sensitiveOutputTokens?: readonly string[];
  readonly tmpDir: string;
  readonly turnTimeoutMs?: number;
}

type DataSnapshot = Readonly<Record<string, unknown>>;

interface RuntimeTypes {
  readonly isProxy: (value: unknown) => boolean;
}

const utilTypes = (process.getBuiltinModule("node:util") as { readonly types: RuntimeTypes }).types;

const snapshotRecord = (
  value: unknown,
  name: string,
  required: readonly string[],
  optional: readonly string[] = [],
): DataSnapshot => {
  if (typeof value !== "object" || value === null || utilTypes.isProxy(value)) {
    throw new TypeError(`${name} must be a non-Proxy plain record`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${name} must be a plain record`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value) as unknown as Record<PropertyKey, PropertyDescriptor>;
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some(key => typeof key !== "string")) {throw new TypeError(`${name} must not have symbol keys`);}
  const allowed = new Set([...required, ...optional]);
  if (keys.some(key => !allowed.has(String(key))) || required.some(key => !Object.hasOwn(descriptors, key))) {
    throw new TypeError(`${name} has missing or unknown keys`);
  }
  const snapshot: Record<string, unknown> = Object.create(null);
  for (const key of keys as string[]) {
    const descriptor = descriptors[key];
    if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true) {
      throw new TypeError(`${name}.${key} must be an enumerable own data property`);
    }
    snapshot[key] = descriptor.value;
  }
  return Object.freeze(snapshot);
};

const boundedString = (value: unknown, name: string): string => {
  if (typeof value !== "string" || value.length === 0 || value.length > 4_096) {
    throw new TypeError(`${name} must be a bounded non-empty string`);
  }
  return value;
};

const directoryIdentity = (value: unknown, name: string): CodexDirectoryIdentity => {
  const identity = snapshotRecord(value, name, ["device", "inode", "path"]);
  if (!Number.isSafeInteger(identity.device) || Number(identity.device) < 0
    || !Number.isSafeInteger(identity.inode) || Number(identity.inode) < 0) {
    throw new TypeError(`${name} must contain bounded integer device and inode identities`);
  }
  return Object.freeze({
    device: Number(identity.device),
    inode: Number(identity.inode),
    path: boundedString(identity.path, `${name}.path`),
  });
};

const snapshotBoundary = (value: unknown): CodexAppServerPermissionBoundary => {
  const boundary = snapshotRecord(value, "Codex permission boundary", [
    "codexHome", "codexHomeIdentity", "effectivePolicyDigest", "permissionProfile",
    "permissionProfileId", "intentMode", "workspaceRef", "workspaceIdentity",
  ]);
  const profile = snapshotRecord(boundary.permissionProfile, "Codex permission profile", ["extends", "file_system", "network"]);
  const fileSystem = snapshotRecord(profile.file_system, "Codex permission file-system profile", ["entries"]);
  const entries = snapshotArray(fileSystem.entries, "Codex permission file-system entries", 16);
  const detachedEntries = entries.map((entry, index) => {
    const record = snapshotRecord(entry, `Codex permission file-system entry ${index}`, ["access", "path"]);
    if (record.access !== "deny" && record.access !== "read") {throw new TypeError("Codex permission boundary contains an invalid filesystem access");}
    return Object.freeze({ access: record.access as "deny" | "read", path: boundedString(record.path, "Codex permission path") });
  });
  const network = snapshotRecord(profile.network, "Codex permission network profile", ["enabled"]);
  const intentMode = boundary.intentMode;
  if ((intentMode !== "analysis" && intentMode !== "workspace-write")
    || profile.extends !== (intentMode === "analysis" ? ":read-only" : ":workspace") || network.enabled !== false) {
    throw new TypeError("Codex permission boundary has an invalid authority profile");
  }
  const permissionProfileId = boundedString(boundary.permissionProfileId, "Codex permission profile identity");
  if (permissionProfileId !== CODEX_PERMISSION_PROFILE_ID) {
    throw new TypeError("Codex permission boundary has an unknown permission profile identity");
  }
  const codexHome = boundedString(boundary.codexHome, "Codex home");
  const workspaceRef = boundedString(boundary.workspaceRef, "Codex workspace");
  const codexHomeIdentity = directoryIdentity(boundary.codexHomeIdentity, "Codex home identity");
  const workspaceIdentity = directoryIdentity(boundary.workspaceIdentity, "Codex workspace identity");
  if (codexHomeIdentity.path !== codexHome || workspaceIdentity.path !== workspaceRef
    || detachedEntries.length !== 3 || detachedEntries[0]?.path !== codexHome
    || detachedEntries[0]?.access !== "deny"
    || !detachedEntries.some(entry => entry.path === ":tmpdir" && entry.access === "read")
    || !detachedEntries.some(entry => entry.path === ":slash_tmp" && entry.access === "read")) {
    throw new TypeError("Codex permission boundary identities do not match its exact roots");
  }
  const permissionProfile = Object.freeze({
    extends: (intentMode === "analysis" ? ":read-only" : ":workspace") as ":read-only" | ":workspace",
    file_system: Object.freeze({ entries: Object.freeze(detachedEntries) }),
    network: Object.freeze({ enabled: false as const }),
  });
  const effectivePolicyDigest = boundedString(boundary.effectivePolicyDigest, "Codex effective policy digest");
  const expectedPolicyDigest = `sha256:${createHash("sha256").update(canonicalCodexJson({
    permissionProfile,
    permissionProfileId,
    intentMode,
    schema: "agent-runtime/codex-contained-permission-policy/v1",
    workspaceRef,
  })).digest("hex")}`;
  if (effectivePolicyDigest !== expectedPolicyDigest) {
    throw new TypeError("Codex permission boundary has a substituted effective policy digest");
  }
  const detached = Object.freeze({
    codexHome,
    codexHomeIdentity,
    effectivePolicyDigest,
    intentMode,
    permissionProfile,
    permissionProfileId,
    workspaceRef,
    workspaceIdentity,
  });
  return detached as CodexAppServerPermissionBoundary;
};

const snapshotArray = (value: unknown, name: string, maximumLength: number): readonly unknown[] => {
  if (!Array.isArray(value) || utilTypes.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new TypeError(`${name} must be a non-Proxy plain array`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value) as unknown as Record<PropertyKey, PropertyDescriptor>;
  const lengthDescriptor = descriptors.length;
  if (lengthDescriptor === undefined || !("value" in lengthDescriptor)
    || !Number.isSafeInteger(lengthDescriptor.value) || Number(lengthDescriptor.value) > maximumLength) {
    throw new TypeError(`${name} exceeds its bounded length`);
  }
  const length = Number(lengthDescriptor.value);
  const expected = new Set(["length", ...Array.from({ length }, (_unused, index) => String(index))]);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some(key => typeof key !== "string" ? true : !expected.has(key)) || keys.length !== expected.size) {
    throw new TypeError(`${name} must be dense and have no aggregate properties`);
  }
  const result: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true) {
      throw new TypeError(`${name}[${index}] must be an enumerable own data property`);
    }
    result.push(descriptor.value);
  }
  return Object.freeze(result);
};

const callableAuthority = <T extends object>(
  value: unknown,
  name: string,
  method: string,
  wrap: (owner: object, callable: (...arguments_: unknown[]) => unknown) => T,
): T => {
  const record = snapshotRecord(value, name, [method]);
  const callable = record[method];
  if (typeof callable !== "function" || utilTypes.isProxy(callable)) {
    throw new TypeError(`${name}.${method} must be a non-Proxy own data function`);
  }
  return Object.freeze(wrap(record, callable as (...arguments_: unknown[]) => unknown));
};

const snapshotSensitiveOutputTokens = (input: unknown, localCapability: string | undefined): readonly string[] => {
  const tokens = input === undefined
    ? [] : snapshotArray(input, "Codex sensitive output tokens", 256);
  const allTokens = localCapability === undefined || tokens.includes(localCapability) ? tokens : [...tokens, localCapability];
  if (allTokens.length > 256) {throw new TypeError("Codex sensitive output tokens exceed their bounded length");}
  let tokenBytes = 0;
  const sensitiveOutputTokens = allTokens.map((token, index) => {
    const detached = boundedString(token, `Codex sensitive output token ${index}`);
    tokenBytes += Buffer.byteLength(detached, "utf8");
    return detached;
  });
  if (tokenBytes > 65_536) {throw new TypeError("Codex sensitive output tokens exceed their aggregate byte bound");}
  return Object.freeze(sensitiveOutputTokens);
};

const detachProtocolBinding = (options: DataSnapshot) => {
  const nativePlan = options.nativeBrokerLaunchPlan as CodexAppServerLaunchPlan | undefined;
  const native = nativePlan === undefined ? undefined : codexNativeBrokerLaunchInput(nativePlan);
  const projection = options.dockerProjection as CodexDockerPathProjection | undefined;
  if (projection !== undefined && codexDockerProjectionSource(projection).boundary !== options.boundary) {
    throw new TypeError("Codex Docker provider boundary does not match projection");
  }
  const boundary = native === undefined && projection === undefined ? snapshotBoundary(options.boundary)
    : options.boundary as CodexAppServerPermissionBoundary;
  if (native !== undefined && codexNativeBrokerBoundary(native.recipe) !== boundary) {
    throw new TypeError("Codex native broker boundary does not match the launch");
  }
  return {nativePlan, native, projection, boundary};
};

export const detachCodexProviderOptions = (input: CodexProviderOptionsInput): CodexProviderOptionsInput => {
  const options = snapshotRecord(input, "Codex provider constructor options", ["boundary", "manifest", "privateRootPath", "processes", "tmpDir"], [
    "cancellationPollMs", "effectCustody", "maxActiveNotificationBytes", "maxActiveNotifications",
    "maxLineBytes", "requestTimeoutMs", "sensitiveOutputTokens", "turnTimeoutMs", "nativeBrokerLaunchPlan", "dockerProjection",
  ]);
  const {nativePlan, native, projection, boundary} = detachProtocolBinding(options);
  const manifest = detachCodexManifest(options.manifest as ContainedTurnAdapterCapabilityManifest);
  if (nativePlan !== undefined && (options.boundary !== boundary
    || nativePlan.privateRootPath !== options.privateRootPath || nativePlan.tmpDir !== options.tmpDir
    || nativePlan.binaryRevision !== manifest.providerBinding.binaryRevision)) {
    throw new TypeError("Codex native broker provider options do not match the launch");
  }
  const sensitiveOutputTokens = snapshotSensitiveOutputTokens(options.sensitiveOutputTokens, native?.localCapability);
  const processes = callableAuthority(options.processes, "Codex process registry", "get", (owner, get) => ({
    get: custodyRef => get.call(owner, custodyRef),
  })) as CustodiedProviderProcessRegistry;
  const effectCustody = options.effectCustody === undefined ? undefined
    : callableAuthority(options.effectCustody, "Codex effect custody authority", "admit", (owner, admit) => ({
      admit: request => admit.call(owner, request),
    })) as CodexEffectCustodyAuthority;
  return Object.freeze({
    boundary,
    ...(projection === undefined ? {} : {dockerProjection: projection}),
    ...(nativePlan === undefined ? {} : { nativeBrokerLaunchPlan: nativePlan }),
    ...(options.cancellationPollMs === undefined ? {} : { cancellationPollMs: options.cancellationPollMs as number }),
    ...(effectCustody === undefined ? {} : { effectCustody }),
    manifest,
    ...(options.maxActiveNotificationBytes === undefined ? {} : { maxActiveNotificationBytes: options.maxActiveNotificationBytes as number }),
    ...(options.maxActiveNotifications === undefined ? {} : { maxActiveNotifications: options.maxActiveNotifications as number }),
    ...(options.maxLineBytes === undefined ? {} : { maxLineBytes: options.maxLineBytes as number }),
    privateRootPath: boundedString(options.privateRootPath, "Codex private root"),
    processes,
    ...(options.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: options.requestTimeoutMs as number }),
    sensitiveOutputTokens: Object.freeze(sensitiveOutputTokens),
    tmpDir: boundedString(options.tmpDir, "Codex private TMPDIR"),
    ...(options.turnTimeoutMs === undefined ? {} : { turnTimeoutMs: options.turnTimeoutMs as number }),
  });
};
