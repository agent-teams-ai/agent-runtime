import { isAbsolute, relative, resolve } from "node:path";

import type {
  HostCustodyLaunchPlan,
  PrivateDirectoryCustodyPort,
} from "../host-custody/custodied-provider-process.js";

export const CLAUDE_AGENT_SDK_VERSION = "0.3.251";
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
  if (!Object.isFrozen(projection) || !Object.isFrozen(projection.environment)) {return false;}
  if (!isAbsolute(workspaceRef) || resolve(workspaceRef) !== workspaceRef || projection.projectionRef.length === 0) {return false;}
  const environment = projection.environment;
  if (environment.CLAUDE_AGENT_SDK_VERSION !== CLAUDE_AGENT_SDK_VERSION || environment.CLAUDE_CODE_ENTRYPOINT !== "sdk-ts") {return false;}
  const { CLAUDE_CONFIG_DIR: configRoot, HOME: homeRoot, TMPDIR: tempRoot } = environment;
  if (configRoot === undefined || homeRoot === undefined || tempRoot === undefined) {return false;}
  const roots = [configRoot, homeRoot, tempRoot];
  if (roots.some(root => !isAbsolute(root) || resolve(root) !== root)) {return false;}
  try {
    await Promise.all([workspaceRef, ...roots].map(root => privateDirectoryCustody.assertPrivateDirectory(root)));
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
  const environment = input.privateProjection.environment;
  const intentMode = acceptedIntentMode(input.intentMode);
  if (environment.CLAUDE_AGENT_SDK_VERSION !== CLAUDE_AGENT_SDK_VERSION) {
    throw new Error(`Claude SDK launch requires CLAUDE_AGENT_SDK_VERSION=${CLAUDE_AGENT_SDK_VERSION}`);
  }
  if (environment.CLAUDE_CODE_ENTRYPOINT !== "sdk-ts") {
    throw new Error("Claude SDK launch requires CLAUDE_CODE_ENTRYPOINT=sdk-ts");
  }
  if (!await isClaudeAgentSdkPrivateProjectionUsable(
    input.privateProjection,
    input.workspaceRef,
    input.privateDirectoryCustody,
  )) {
    throw new TypeError("Claude launch plan requires a frozen private projection disjoint from its workspace");
  }
  const privateRootPath = acceptedPrivateRoot(input.privateRootPath, input.workspaceRef, environment);
  return Object.freeze({
    arguments: claudeAgentSdkArguments(intentMode, input.workspaceRef),
    binaryRevision: input.binaryRevision,
    containmentProfile: "strict-linux-cgroup-v2",
    environment,
    executablePath: input.executablePath,
    executableSha256: input.executableSha256,
    intentMode,
    privateRootPath,
    provider: "claude",
    spawnMode: "sdk-delegated",
  });
};
