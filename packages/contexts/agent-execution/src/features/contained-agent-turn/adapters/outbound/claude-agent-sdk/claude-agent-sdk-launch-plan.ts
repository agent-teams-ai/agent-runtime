import { isAbsolute, relative, resolve } from "node:path";

import type {
  HostCustodyLaunchPlan,
} from "../provider-delegation-ports/contained-turn-provider-delegation-port.js";
import type {
  PrivateDirectoryCustodyPort,
} from "../provider-delegation-ports/private-directory-custody-port.js";
import { captureClaudePrivateDirectoryCustody } from "./claude-private-directory-custody.js";

export const CLAUDE_AGENT_SDK_VERSION = "0.3.251";
export const CLAUDE_AGENT_SDK_BUNDLED_CLI_VERSION = "2.1.251";
export const CLAUDE_AGENT_SDK_ADAPTER_REVISION = "claude-agent-sdk-contained-turn:0.3.251";
export const CLAUDE_AGENT_SDK_MANIFEST_REVISION = "claude-contained-turn-v1@1";
export const CLAUDE_AGENT_SDK_RESOURCE_SCOPE_REVISION = "contained-turn-v1-worst-case-scope@1";
export const CLAUDE_AGENT_SDK_LINUX_DESCRIPTOR_CWD = "/proc/self/fd/4" as const;
/** Compatibility export. The selected Linux tuple is the only consumer of this descriptor path. */
export const CLAUDE_AGENT_SDK_HOST_WORKSPACE_CWD = CLAUDE_AGENT_SDK_LINUX_DESCRIPTOR_CWD;

export type ClaudeAgentSdkPlatformTuple = Readonly<{
  adapterRevision: typeof CLAUDE_AGENT_SDK_ADAPTER_REVISION;
  architecture: "arm64" | "x64";
  binaryRevision: `sha256:${string}`;
  bundledCliVersion: typeof CLAUDE_AGENT_SDK_BUNDLED_CLI_VERSION;
  containmentProfile: "cooperative-darwin-posix-process-group" | "strict-linux-cgroup-v2";
  executableSha256: string;
  manifestRevision: typeof CLAUDE_AGENT_SDK_MANIFEST_REVISION;
  platform: "darwin" | "linux";
  resourceScopeRevision: typeof CLAUDE_AGENT_SDK_RESOURCE_SCOPE_REVISION;
  sdkVersion: typeof CLAUDE_AGENT_SDK_VERSION;
  workspaceAuthority: "canonical-operation-workspace" | "retained-descriptor";
}>;

const platformTuple = (
  platform: ClaudeAgentSdkPlatformTuple["platform"],
  architecture: ClaudeAgentSdkPlatformTuple["architecture"],
  executableSha256: string,
  containmentProfile: ClaudeAgentSdkPlatformTuple["containmentProfile"],
  workspaceAuthority: ClaudeAgentSdkPlatformTuple["workspaceAuthority"],
): ClaudeAgentSdkPlatformTuple => Object.freeze({
  adapterRevision: CLAUDE_AGENT_SDK_ADAPTER_REVISION,
  architecture,
  binaryRevision: `sha256:${executableSha256}`,
  bundledCliVersion: CLAUDE_AGENT_SDK_BUNDLED_CLI_VERSION,
  containmentProfile,
  executableSha256,
  manifestRevision: CLAUDE_AGENT_SDK_MANIFEST_REVISION,
  platform,
  resourceScopeRevision: CLAUDE_AGENT_SDK_RESOURCE_SCOPE_REVISION,
  sdkVersion: CLAUDE_AGENT_SDK_VERSION,
  workspaceAuthority,
});

export const CLAUDE_AGENT_SDK_LINUX_X64_TUPLE = platformTuple(
  "linux", "x64", "fd5f10ff0eb58daec04900466b143ea98aab50abf208a422bc008eaec13f61f7",
  "strict-linux-cgroup-v2", "retained-descriptor",
);
export const CLAUDE_AGENT_SDK_DARWIN_ARM64_TUPLE = platformTuple(
  "darwin", "arm64", "625869b01e0050f260b2980fac248fd9cef9e462612bded4ec9d3d49ff8969a5",
  "cooperative-darwin-posix-process-group", "canonical-operation-workspace",
);

/** Compatibility name for the ADR-0010 Linux tuple. New composition selects a platform tuple explicitly. */
export const CLAUDE_AGENT_SDK_PRODUCTION_TUPLE = CLAUDE_AGENT_SDK_LINUX_X64_TUPLE;
export const CLAUDE_AGENT_SDK_EXECUTABLE_SHA256 = CLAUDE_AGENT_SDK_LINUX_X64_TUPLE.executableSha256;
export const CLAUDE_AGENT_SDK_BINARY_REVISION = CLAUDE_AGENT_SDK_LINUX_X64_TUPLE.binaryRevision;

export const selectClaudeAgentSdkPlatformTuple = (
  platform: string,
  architecture: string,
): ClaudeAgentSdkPlatformTuple => {
  if (platform === "linux" && architecture === "x64") {return CLAUDE_AGENT_SDK_LINUX_X64_TUPLE;}
  if (platform === "darwin" && architecture === "arm64") {return CLAUDE_AGENT_SDK_DARWIN_ARM64_TUPLE;}
  throw new TypeError("Claude Agent SDK has no qualified tuple for the selected platform and architecture");
};

export const claudeAgentSdkWorkspaceAuthorityPath = (
  tuple: ClaudeAgentSdkPlatformTuple,
  workspaceRef: string,
): string => tuple.workspaceAuthority === "retained-descriptor"
  ? CLAUDE_AGENT_SDK_LINUX_DESCRIPTOR_CWD
  : workspaceRef;
export const CLAUDE_AGENT_SDK_READ_TOOLS = Object.freeze(["Read", "Glob", "Grep"] as const);
export const CLAUDE_AGENT_SDK_WRITE_TOOLS = Object.freeze([...CLAUDE_AGENT_SDK_READ_TOOLS, "Edit", "Write"] as const);

export interface ClaudeAgentSdkPrivateProjection {
  readonly environment: Readonly<Record<string, string>>;
  readonly projectionRef: string;
}

export interface CreateClaudeAgentSdkPrivateProjectionInput {
  readonly configRoot: string;
  readonly homeRoot: string;
  readonly projectionRef: string;
  readonly tempRoot: string;
  readonly workspaceRef: string;
}

const normalizedAbsolute = (name: string, path: string): string => {
  if (!isAbsolute(path) || resolve(path) !== path) {throw new TypeError(`${name} must be a normalized absolute path`);}
  return path;
};

const isWithin = (parent: string, candidate: string): boolean => {
  const path = relative(parent, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
};

export const isClaudeAgentSdkPrivateProjectionUsable = async (
  projection: ClaudeAgentSdkPrivateProjection,
  workspaceRef: string,
  privateDirectoryCustody: PrivateDirectoryCustodyPort,
): Promise<boolean> => {
  const custody = captureClaudePrivateDirectoryCustody(privateDirectoryCustody);
  if (!Object.isFrozen(projection) || !Object.isFrozen(projection.environment)) {return false;}
  if (!isAbsolute(workspaceRef) || resolve(workspaceRef) !== workspaceRef || projection.projectionRef.length === 0) {return false;}
  const environment = projection.environment;
  if (environment.CLAUDE_AGENT_SDK_VERSION !== CLAUDE_AGENT_SDK_VERSION || environment.CLAUDE_CODE_ENTRYPOINT !== "sdk-ts") {return false;}
  const { CLAUDE_CONFIG_DIR: configRoot, HOME: homeRoot, TMPDIR: tempRoot } = environment;
  if (configRoot === undefined || homeRoot === undefined || tempRoot === undefined) {return false;}
  const roots = [configRoot, homeRoot, tempRoot];
  if (roots.some(root => !isAbsolute(root) || resolve(root) !== root)) {return false;}
  try {
    await Promise.all([workspaceRef, ...roots].map(root => custody.assertPrivateDirectory(root)));
  } catch {
    return false;
  }
  for (const root of roots) {
    if (isWithin(workspaceRef, root) || isWithin(root, workspaceRef)) {return false;}
  }
  return true;
};

export const createClaudeAgentSdkPrivateProjection = (
  input: CreateClaudeAgentSdkPrivateProjectionInput,
): ClaudeAgentSdkPrivateProjection => {
  const workspaceRef = normalizedAbsolute("workspaceRef", input.workspaceRef);
  const roots = {
    CLAUDE_CONFIG_DIR: normalizedAbsolute("configRoot", input.configRoot),
    HOME: normalizedAbsolute("homeRoot", input.homeRoot),
    TMPDIR: normalizedAbsolute("tempRoot", input.tempRoot),
  } as const;
  for (const root of Object.values(roots)) {
    if (isWithin(workspaceRef, root) || isWithin(root, workspaceRef)) {
      throw new TypeError("Claude private projection and deliverable workspace must be disjoint");
    }
  }
  if (input.projectionRef.length === 0) {throw new TypeError("projectionRef must not be empty");}
  return Object.freeze({
    environment: Object.freeze({
      CLAUDE_AGENT_SDK_VERSION,
      CLAUDE_CODE_ENTRYPOINT: "sdk-ts",
      ...roots,
      LANG: "C.UTF-8",
      PATH: "/usr/bin:/bin",
    }),
    projectionRef: input.projectionRef,
  });
};

export interface ClaudeAgentSdkPrivateProjectionResolver {
  resolve(input: {
    readonly custodyRef: string;
    readonly workspaceRef: string;
  }): ClaudeAgentSdkPrivateProjection | undefined;
}

const disallowedTools = (mode: "analysis" | "workspace-write"): readonly string[] =>
  mode === "analysis"
    ? Object.freeze(["Task", "Bash", "Edit", "Write", "NotebookEdit", "WebFetch", "WebSearch"])
    : Object.freeze(["Task", "Bash", "NotebookEdit", "WebFetch", "WebSearch"]);

export const claudeAgentSdkTools = (
  mode: "analysis" | "workspace-write",
): readonly string[] => mode === "analysis" ? CLAUDE_AGENT_SDK_READ_TOOLS : CLAUDE_AGENT_SDK_WRITE_TOOLS;

const sandboxSettings = (mode: "analysis" | "workspace-write", workspaceRef: string): string => JSON.stringify({
  sandbox: {
    enabled: true,
    failIfUnavailable: true,
    allowUnsandboxedCommands: false,
    filesystem: {
      allowRead: [workspaceRef],
      allowWrite: mode === "analysis" ? [] : [workspaceRef],
    },
  },
});

export const claudeAgentSdkArguments = (
  mode: "analysis" | "workspace-write",
  workspaceRef: string,
): readonly string[] => {
  const tools = claudeAgentSdkTools(mode);
  return Object.freeze([
    "--output-format", "stream-json",
    "--verbose",
    "--input-format", "stream-json",
    "--max-turns", "1",
    "--allowedTools", tools.join(","),
    "--disallowedTools", disallowedTools(mode).join(","),
    "--tools", tools.join(","),
    "--setting-sources=",
    "--strict-mcp-config",
    "--permission-mode", "dontAsk",
    "--include-partial-messages",
    "--no-session-persistence",
    "--settings", sandboxSettings(mode, workspaceRef),
  ]);
};

export interface CreateClaudeAgentSdkLaunchPlanInput {
  readonly binaryRevision: string;
  readonly executablePath: string;
  readonly executableSha256: string;
  readonly intentMode: "analysis" | "workspace-write";
  readonly privateProjection: ClaudeAgentSdkPrivateProjection;
  readonly privateDirectoryCustody: PrivateDirectoryCustodyPort;
  readonly privateRootPath: string;
  readonly platformTuple: ClaudeAgentSdkPlatformTuple;
  readonly workspaceRef: string;
}

const acceptedIntentMode = (value: unknown): "analysis" | "workspace-write" => {
  if (value !== "analysis" && value !== "workspace-write") {
    throw new TypeError("intentMode must be analysis or workspace-write");
  }
  return value;
};

const acceptedPrivateRoot = (
  value: unknown,
  workspaceRef: string,
  environment: Readonly<Record<string, string>>,
): string => {
  if (typeof value !== "string" || !isAbsolute(value) || resolve(value) !== value || value === "/") {
    throw new TypeError("privateRootPath must be a normalized absolute non-root path");
  }
  if (isWithin(value, workspaceRef) || isWithin(workspaceRef, value)) {
    throw new TypeError("privateRootPath and workspaceRef must be disjoint");
  }
  for (const key of ["CLAUDE_CONFIG_DIR", "HOME", "TMPDIR"] as const) {
    const path = environment[key];
    if (path === undefined || path === value || !isWithin(value, path)) {
      throw new TypeError("Claude private projection paths must be strictly within privateRootPath");
    }
  }
  return value;
};

export const createClaudeAgentSdkLaunchPlan = async (
  input: CreateClaudeAgentSdkLaunchPlanInput,
): Promise<HostCustodyLaunchPlan> => {
  const privateDirectoryCustody = captureClaudePrivateDirectoryCustody(input.privateDirectoryCustody);
  const tuple = selectClaudeAgentSdkPlatformTuple(input.platformTuple.platform, input.platformTuple.architecture);
  const environment = input.privateProjection.environment;
  const intentMode = acceptedIntentMode(input.intentMode);
  if (input.platformTuple !== tuple || input.binaryRevision !== tuple.binaryRevision ||
      input.executableSha256 !== tuple.executableSha256) {
    throw new TypeError("Claude launch plan tuple does not match its exact binary revision");
  }
  if (environment.CLAUDE_AGENT_SDK_VERSION !== CLAUDE_AGENT_SDK_VERSION) {
    throw new Error(`Claude SDK launch requires CLAUDE_AGENT_SDK_VERSION=${CLAUDE_AGENT_SDK_VERSION}`);
  }
  if (environment.CLAUDE_CODE_ENTRYPOINT !== "sdk-ts") {
    throw new Error("Claude SDK launch requires CLAUDE_CODE_ENTRYPOINT=sdk-ts");
  }
  if (!await isClaudeAgentSdkPrivateProjectionUsable(
    input.privateProjection,
    input.workspaceRef,
    privateDirectoryCustody,
  )) {
    throw new TypeError("Claude launch plan requires a frozen private projection disjoint from its workspace");
  }
  const privateRootPath = acceptedPrivateRoot(input.privateRootPath, input.workspaceRef, environment);
  const workspaceAuthorityPath = claudeAgentSdkWorkspaceAuthorityPath(tuple, input.workspaceRef);
  return Object.freeze({
    arguments: claudeAgentSdkArguments(intentMode, workspaceAuthorityPath),
    binaryRevision: input.binaryRevision,
    containmentProfile: tuple.containmentProfile,
    environment,
    executablePath: input.executablePath,
    executableSha256: input.executableSha256,
    intentMode,
    privateRootPath,
    provider: "claude",
    spawnMode: "sdk-delegated",
  });
};
