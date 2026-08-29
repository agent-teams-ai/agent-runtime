import type { HostCustodyLaunchPlan } from "../host-custody/custodied-provider-process.js";

export const CLAUDE_AGENT_SDK_VERSION = "0.3.251";
export const CLAUDE_AGENT_SDK_READ_TOOLS = Object.freeze(["Read", "Glob", "Grep"] as const);
export const CLAUDE_AGENT_SDK_WRITE_TOOLS = Object.freeze([...CLAUDE_AGENT_SDK_READ_TOOLS, "Edit", "Write"] as const);

export const createClaudeAgentSdkEnvironment = (workspaceRef: string): Readonly<Record<string, string>> => Object.freeze({
  CLAUDE_AGENT_SDK_VERSION,
  CLAUDE_CODE_ENTRYPOINT: "sdk-ts",
  CLAUDE_CONFIG_DIR: `${workspaceRef}/.claude-agent-runtime`,
  HOME: workspaceRef,
  LANG: "C.UTF-8",
  PATH: "/usr/bin:/bin",
  TMPDIR: workspaceRef,
});

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
  readonly environment: Readonly<Record<string, string>>;
  readonly executablePath: string;
  readonly executableSha256: string;
  readonly workspaceRef: string;
}

export const createClaudeAgentSdkLaunchPlan = (
  input: CreateClaudeAgentSdkLaunchPlanInput,
): HostCustodyLaunchPlan => {
  if (input.environment.CLAUDE_AGENT_SDK_VERSION !== CLAUDE_AGENT_SDK_VERSION) {
    throw new Error(`Claude SDK launch requires CLAUDE_AGENT_SDK_VERSION=${CLAUDE_AGENT_SDK_VERSION}`);
  }
  if (input.environment.CLAUDE_CODE_ENTRYPOINT !== "sdk-ts") {
    throw new Error("Claude SDK launch requires CLAUDE_CODE_ENTRYPOINT=sdk-ts");
  }
  const variants = Object.freeze([
    claudeAgentSdkArguments("analysis", input.workspaceRef),
    claudeAgentSdkArguments("workspace-write", input.workspaceRef),
  ]);
  return Object.freeze({
    arguments: variants[0] ?? Object.freeze([]),
    binaryRevision: input.binaryRevision,
    containmentProfile: "cooperative-posix",
    delegatedArgumentVariants: variants,
    environment: Object.freeze({ ...input.environment }),
    executablePath: input.executablePath,
    executableSha256: input.executableSha256,
    provider: "claude",
    spawnMode: "sdk-delegated",
  });
};
