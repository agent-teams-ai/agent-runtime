import {
  inspectDarwinNativeLaunchObservation, assertDarwinNativeLaunchObservationCurrent,
  inspectDarwinNativeCodexMaterial, assertDarwinNativeCodexMaterialCurrent,
  type DarwinNativeCodexMaterial, type DarwinNativeLaunchObservation,
} from "../filesystem/darwin-attempt-workspace-backend.js";
import {codexProtocolPaths} from "./codex-docker-path-projection.js";
import { createHash } from "node:crypto";
import { lstatSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { retainIssuedCodexPermissionBoundary } from "./codex-native-broker-boundary.js";
import { codexDisabledFeatures } from "./codex-app-server-config-defaults.js";

export { isExactCodexPermissionProfile, validateCodexConfigEvidence } from "./codex-app-server-config-wire.js";

import {
  codexNotificationMethod,
  codexStringField,
  isCodexRecord,
  type CodexJsonRecord,
} from "./codex-app-server-jsonl.js";
import {
  CODEX_APP_SERVER_LINUX_X64_TUPLE,
  CODEX_PERMISSION_PROFILE_ID,
  validateCodexAppServerUserAgent,
  type CodexAppServerPlatformTuple,
} from "./codex-app-server-platform-tuple.js";

export {
  CODEX_APP_SERVER_ADAPTER_REVISION,
  CODEX_APP_SERVER_BINDINGS_SHA256,
  CODEX_APP_SERVER_SCHEMA_SHA256,
  CODEX_APP_SERVER_VERSION,
  CODEX_CAPABILITY_MANIFEST_REVISION,
  CODEX_PERMISSION_PROFILE_ID,
} from "./codex-app-server-platform-tuple.js";

/** Linux aliases retained for provider-local compatibility; new code consumes the selected tuple. */
export const CODEX_APP_SERVER_BINARY_REVISION = CODEX_APP_SERVER_LINUX_X64_TUPLE.binaryRevision;
export const CODEX_APP_SERVER_BINARY_SHA256 = CODEX_APP_SERVER_LINUX_X64_TUPLE.binarySha256;

export const codexContainedThreadConfig = (): CodexJsonRecord => ({
  features: codexDisabledFeatures(),
});

export type CodexContainedTurnMode = "analysis" | "workspace-write";

export const codexTurnSandboxPolicy = (
  mode: CodexContainedTurnMode,
  _workspaceRef: string,
): Readonly<CodexJsonRecord> => mode === "analysis"
  ? Object.freeze({ networkAccess: false, type: "readOnly" })
  : Object.freeze({
    excludeSlashTmp: true,
    excludeTmpdirEnvVar: true,
    networkAccess: false,
    type: "workspaceWrite",
    writableRoots: Object.freeze([]),
  });

export const codexEffectiveTurnPolicyDigest = (
  boundary: CodexAppServerPermissionBoundary,
  mode: CodexContainedTurnMode,
): string => `sha256:${createHash("sha256").update(canonicalCodexJson({
  basePolicyDigest: boundary.effectivePolicyDigest,
  mode,
  sandboxPolicy: codexTurnSandboxPolicy(mode, boundary.workspaceRef),
})).digest("hex")}`;

export interface CodexDirectoryIdentity {
  readonly device: number;
  readonly inode: number;
  readonly path: string;
}

const normalizedAbsoluteDirectory = (
  name: string,
  value: string,
  requirePrivateOwnership: boolean,
): { readonly identity: CodexDirectoryIdentity; readonly path: string } => {
  if (!isAbsolute(value) || resolve(value) !== value) {
    throw new TypeError(`${name} must be a normalized absolute path`);
  }
  if (value === "/") {throw new TypeError(`${name} must not be the filesystem root`);}
  const link = lstatSync(value);
  if (!link.isDirectory() || link.isSymbolicLink()) {throw new TypeError(`${name} must be a non-symlink directory`);}
  if (realpathSync(value) !== value) {throw new TypeError(`${name} must be canonical`);}
  const directory = statSync(value);
  if (!directory.isDirectory()) {throw new TypeError(`${name} must be a directory`);}
  if (!Number.isSafeInteger(directory.dev) || !Number.isSafeInteger(directory.ino)) {
    throw new TypeError(`${name} filesystem identity cannot be represented without ambiguity`);
  }
  if ((directory.mode & 0o022) !== 0) {throw new TypeError(`${name} must not be shared-group or world-writable`);}
  if (requirePrivateOwnership) {
    if (typeof process.getuid !== "function" || directory.uid !== process.getuid()) {
      throw new TypeError(`${name} must be owned by the current process user`);
    }
    if ((directory.mode & 0o077) !== 0) {throw new TypeError(`${name} must have mode 0700 or more restrictive`);}
  }
  return {
    identity: Object.freeze({ device: directory.dev, inode: directory.ino, path: value }),
    path: value,
  };
};

export const validateCodexDirectoryIdentity = (
  name: string,
  expected: CodexDirectoryIdentity,
  requirePrivateOwnership = true,
): void => {
  const current = normalizedAbsoluteDirectory(name, expected.path, requirePrivateOwnership).identity;
  if (current.device !== expected.device || current.inode !== expected.inode) {
    throw new TypeError(`${name} changed filesystem identity after validation`);
  }
};

const contains = (parent: string, candidate: string): boolean => {
  const path = relative(parent, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
};

export const canonicalCodexJson = (value: unknown): string => {
  if (value === undefined) {throw new TypeError("canonical JSON rejects undefined");}
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new TypeError("canonical JSON rejects non-finite numbers");
  }
  if (typeof value === "bigint" || typeof value === "function" || typeof value === "symbol") {
    throw new TypeError(`canonical JSON rejects ${typeof value}`);
  }
  if (Array.isArray(value)) {return `[${value.map(canonicalCodexJson).join(",")}]`;}
  if (value !== null && typeof value === "object") {
    if (Object.getPrototypeOf(value) !== Object.prototype) {
      throw new TypeError("canonical JSON rejects non-plain objects");
    }
    return `{${Object.entries(value as Record<string, unknown>)
      .toSorted(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalCodexJson(nested)}`)
      .join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) {throw new TypeError("canonical JSON rejects non-serializable values");}
  return encoded;
};

export interface CodexAppServerPermissionBoundary {
  readonly codexHome: string;
  readonly codexHomeIdentity: CodexDirectoryIdentity;
  readonly effectivePolicyDigest: string;
  readonly permissionProfile: Readonly<{
    readonly extends: ":read-only" | ":workspace";
    readonly file_system: Readonly<{
      readonly entries: readonly Readonly<{ readonly access: "deny" | "read"; readonly path: string }>[];
    }>;
    readonly network: Readonly<{ readonly enabled: false }>;
  }>;
  readonly permissionProfileId: typeof CODEX_PERMISSION_PROFILE_ID;
  readonly intentMode: CodexContainedTurnMode;
  readonly workspaceRef: string;
  readonly workspaceIdentity: CodexDirectoryIdentity;
}

export const createCodexAppServerPermissionBoundary = (input: {
  readonly codexHome: string;
  readonly intentMode: CodexContainedTurnMode;
  readonly workspaceRef: string;
}): CodexAppServerPermissionBoundary => {
  const privateHome = normalizedAbsoluteDirectory("codexHome", input.codexHome, true);
  const workspace = normalizedAbsoluteDirectory("workspaceRef", input.workspaceRef, false);
  return issuePermissionBoundary(privateHome, workspace, input.intentMode);
};

const nativeObservations = new WeakMap<CodexAppServerPermissionBoundary, DarwinNativeLaunchObservation>();
const nativeOriginals = new WeakMap<CodexAppServerPermissionBoundary, ReturnType<typeof inspectDarwinNativeLaunchObservation>>();
/** Only authenticated installed material can advance a boundary generation. */
export const acceptCodexDarwinNativeMaterialObservation = (
  boundary: CodexAppServerPermissionBoundary, material: DarwinNativeCodexMaterial,
): void => {
  const original = nativeOriginals.get(boundary);
  if (original === undefined) {throw new TypeError("Native Codex boundary provenance rejected");}
  const installed = inspectDarwinNativeCodexMaterial(material);
  assertDarwinNativeCodexMaterialCurrent(material);
  const next = inspectDarwinNativeLaunchObservation(installed.observation);
  if (next.operationId !== original.operationId || next.leasedUid !== original.leasedUid ||
      (["privateRoot", "codexHome", "tmpDir", "workspace"] as const).some(key => {
        const a = original[key]; const b = next[key];
        return a.path !== b.path || a.dev !== b.dev || a.ino !== b.ino || a.uid !== b.uid || a.mode !== b.mode;
      })) {throw new TypeError("Native Codex material changed original roots");}
  assertDarwinNativeLaunchObservationCurrent(installed.observation);
  nativeObservations.set(boundary, installed.observation);
};
/** Same-object lookup precedes observation inspection; this is lifetime validation,
 * not fresh OS readback. Native START must revalidate descriptors atomically. */
export const codexDarwinNativeLaunchObservation = (
  boundary: CodexAppServerPermissionBoundary,
): DarwinNativeLaunchObservation | undefined => {
  const observation = nativeObservations.get(boundary);
  if (observation !== undefined) {assertDarwinNativeLaunchObservationCurrent(observation);}
  return observation;
};

const validateNativeDirectories = (facts: ReturnType<typeof inspectDarwinNativeLaunchObservation>): void => {
  const directories = [facts.privateRoot, facts.codexHome, facts.tmpDir, facts.workspace];
  if (!Number.isSafeInteger(facts.leasedUid) || facts.leasedUid <= 0) {
    throw new TypeError("Native Codex leased UID rejected");
  }
  for (const fact of directories) {
    if (!isAbsolute(fact.path) || resolve(fact.path) !== fact.path || fact.path === "/" || fact.path.includes("\0") ||
        fact.dev < 0n || fact.ino <= 0n || !Number.isSafeInteger(Number(fact.dev)) ||
        !Number.isSafeInteger(Number(fact.ino)) || fact.uid !== facts.leasedUid ||
        (fact.mode & 0o170000) !== 0o040000 || (fact.mode & 0o077) !== 0) {
      throw new TypeError("Native Codex directory observation rejected");
    }
  }
};

export const createDarwinNativeCodexPermissionBoundary = (
  observation: DarwinNativeLaunchObservation, intentMode: CodexContainedTurnMode,
): CodexAppServerPermissionBoundary => {
  const facts = inspectDarwinNativeLaunchObservation(observation);
  assertDarwinNativeLaunchObservationCurrent(observation);
  validateNativeDirectories(facts);
  const {privateRoot, codexHome, tmpDir, workspace} = facts;
  if (!contains(privateRoot.path, codexHome.path) || privateRoot.path === codexHome.path ||
      !contains(privateRoot.path, tmpDir.path) || privateRoot.path === tmpDir.path ||
      contains(privateRoot.path, workspace.path) || contains(workspace.path, privateRoot.path)) {
    throw new TypeError("Native Codex private roots rejected");
  }
  const peers = [codexHome, tmpDir, workspace];
  for (let i = 0; i < peers.length; i += 1) {
    for (let j = i + 1; j < peers.length; j += 1) {
      if (contains(peers[i]!.path, peers[j]!.path) || contains(peers[j]!.path, peers[i]!.path) ||
          peers[i]!.dev === peers[j]!.dev && peers[i]!.ino === peers[j]!.ino) {
        throw new TypeError("Native Codex roots must be disjoint");
      }
    }
  }
  const project = (fact: typeof codexHome) => Object.freeze({path: fact.path,
    identity: Object.freeze({device: Number(fact.dev), inode: Number(fact.ino), path: fact.path})});
  const boundary = issuePermissionBoundary(project(codexHome), project(workspace), intentMode);
  nativeObservations.set(boundary, observation);
  nativeOriginals.set(boundary, facts);
  return boundary;
};

const issuePermissionBoundary = (
  privateHome: Readonly<{path: string; identity: CodexDirectoryIdentity}>,
  workspace: Readonly<{path: string; identity: CodexDirectoryIdentity}>,
  intentMode: CodexContainedTurnMode,
): CodexAppServerPermissionBoundary => {
  const codexHome = privateHome.path;
  const workspaceRef = workspace.path;
  if (contains(codexHome, workspaceRef) || contains(workspaceRef, codexHome)) {
    throw new TypeError("Codex private home and workspace must be disjoint");
  }
  if (intentMode !== "analysis" && intentMode !== "workspace-write") {
    throw new TypeError("intentMode must be analysis or workspace-write");
  }
  const permissionProfile = Object.freeze({
    extends: (intentMode === "analysis" ? ":read-only" : ":workspace") as ":read-only" | ":workspace",
    file_system: Object.freeze({
      entries: Object.freeze([
        Object.freeze({ access: "deny" as const, path: codexHome }),
        Object.freeze({ access: "read" as const, path: ":tmpdir" }),
        Object.freeze({ access: "read" as const, path: ":slash_tmp" }),
      ]),
    }),
    network: Object.freeze({ enabled: false as const }),
  });
  const policyPreimage = Object.freeze({
    permissionProfile,
    permissionProfileId: CODEX_PERMISSION_PROFILE_ID,
    intentMode,
    schema: "agent-runtime/codex-contained-permission-policy/v1",
    workspaceRef,
  });
  const boundary = Object.freeze({
    codexHome,
    codexHomeIdentity: privateHome.identity,
    effectivePolicyDigest: `sha256:${createHash("sha256").update(canonicalCodexJson(policyPreimage)).digest("hex")}`,
    intentMode,
    permissionProfile,
    permissionProfileId: CODEX_PERMISSION_PROFILE_ID,
    workspaceRef,
    workspaceIdentity: workspace.identity,
  });
  retainIssuedCodexPermissionBoundary(boundary);
  return boundary;
};

const evidenceError = (message: string): Error => new Error(`Codex permission evidence rejected: ${message}`);

const hasExactKeys = (value: CodexJsonRecord, keys: readonly string[]): boolean =>
  Object.getPrototypeOf(value) === Object.prototype
  && Reflect.ownKeys(value).every(key => typeof key === "string")
  && Reflect.ownKeys(value).length === keys.length
  && Object.keys(value).toSorted().join("\0") === [...keys].toSorted().join("\0")
  && Object.values(Object.getOwnPropertyDescriptors(value)).every(descriptor =>
    descriptor.enumerable === true && "value" in descriptor);

export const validateCodexInitializeEvidence = (
  result: unknown,
  boundary: CodexAppServerPermissionBoundary,
  platformTuple: CodexAppServerPlatformTuple,
): void => {
  if (!isCodexRecord(result)
    || !hasExactKeys(result, ["codexHome", "platformFamily", "platformOs", "userAgent"])
    || result.codexHome !== codexProtocolPaths(boundary).codexHome
    || result.platformFamily !== platformTuple.platformFamily
    || result.platformOs !== platformTuple.platformOs) {
    throw evidenceError("initialization does not match the pinned candidate runtime tuple");
  }
  try {validateCodexAppServerUserAgent(result.userAgent, platformTuple);}
  catch {throw evidenceError("initialization does not match the pinned candidate runtime tuple");}
};

export const validateCodexPermissionProfileEvidence = (
  result: unknown,
  boundary: CodexAppServerPermissionBoundary,
): void => {
  if (!isCodexRecord(result) || !hasExactKeys(result, ["data", "nextCursor"])
    || !Array.isArray(result.data) || result.nextCursor !== null
    || result.data.some(value => !isCodexRecord(value)
      || !hasExactKeys(value, ["allowed", "description", "id"])
      || typeof value.id !== "string" || typeof value.allowed !== "boolean"
      || (value.description !== null && typeof value.description !== "string"))) {
    throw evidenceError("permission profile list is incomplete");
  }
  const selected = result.data.filter(value => isCodexRecord(value) && value.id === boundary.permissionProfileId);
  const summary = selected[0];
  if (selected.length !== 1 || summary === undefined || summary.allowed !== true
    || !("description" in summary) || (summary.description !== null && typeof summary.description !== "string")
    || !hasExactKeys(summary, ["allowed", "description", "id"])) {
    throw evidenceError("permission profile is absent, duplicate, or disallowed");
  }
};

export const observeCodexActiveProfileEvidence = (
  message: CodexJsonRecord,
  threadId: string,
  boundary: CodexAppServerPermissionBoundary,
  mode: CodexContainedTurnMode,
): boolean => {
  if (boundary.intentMode !== mode) {
    throw evidenceError("notification turn mode does not match the immutable launch boundary");
  }
  const method = codexNotificationMethod(message);
  if (method === "remoteControl/status/changed") {
    if (!isCodexRecord(message.params) || !hasExactKeys(message.params, ["environmentId", "installationId", "serverName", "status"])
      || message.params.status !== "disabled" || message.params.environmentId !== null
      || typeof message.params.installationId !== "string" || typeof message.params.serverName !== "string") {
      throw evidenceError("remote control status is not the qualified disabled state");
    }
    return false;
  }
  if (method === "thread/started") {
    if (!isCodexRecord(message.params)) {throw evidenceError("thread-start notification is malformed");}
    const id = message.params.threadId ?? (isCodexRecord(message.params.thread) ? message.params.thread.id : undefined);
    if (id !== threadId) {throw evidenceError("thread-start notification identity changed");}
    return false;
  }
  throw evidenceError("unexpected pre-turn notification");
};

export const validateCodexThreadStartEvidence = (
  result: unknown,
  boundary: CodexAppServerPermissionBoundary,
  mode: CodexContainedTurnMode,
): string => {
  if (!isCodexRecord(result) || !isCodexRecord(result.thread)) {throw evidenceError("thread/start response is incomplete");}
  const threadId = codexStringField(result.thread, "id");
  const active = result.activePermissionProfile;
  if (threadId === undefined || threadId.length === 0 || !isCodexRecord(active) || !hasExactKeys(active, ["extends", "id"])
    || active.id !== boundary.permissionProfileId || active.extends !== boundary.permissionProfile.extends
    || result.cwd !== codexProtocolPaths(boundary).workspaceRef || result.approvalPolicy !== "never"
    || canonicalCodexJson(result.sandbox) !== canonicalCodexJson(codexTurnSandboxPolicy(mode, boundary.workspaceRef))) {
    throw evidenceError("thread/start permission provenance does not match the qualified profile");
  }
  return threadId;
};
