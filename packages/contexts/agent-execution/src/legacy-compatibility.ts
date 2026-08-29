/**
 * Temporary anti-corruption boundary for provider and custody adapters that
 * still speak the pre-kernel protocol. Nothing exported here owns operation
 * state, dispatch authority, command identity, or a canonical digest.
 */
export {
  CodexAppServerContainedTurnProvider,
  type CodexAppServerContainedTurnProviderOptions,
} from "./features/contained-agent-turn/adapters/outbound/codex-app-server/codex-app-server-contained-turn-provider.js";
export {
  createCodexAppServerLaunchPlan,
  type CodexAppServerLaunchPlanOptions,
} from "./features/contained-agent-turn/adapters/outbound/codex-app-server/codex-app-server-launch-plan.js";
export {
  ClaudeAgentSdkContainedTurnProvider,
  type ClaudeAgentSdkContainedTurnProviderOptions,
} from "./features/contained-agent-turn/adapters/outbound/claude-agent-sdk/claude-agent-sdk-contained-turn-provider.js";
export {
  claudeAgentSdkArguments,
  claudeAgentSdkTools,
  CLAUDE_AGENT_SDK_READ_TOOLS,
  CLAUDE_AGENT_SDK_VERSION,
  CLAUDE_AGENT_SDK_WRITE_TOOLS,
  createClaudeAgentSdkEnvironment,
  createClaudeAgentSdkLaunchPlan,
  type CreateClaudeAgentSdkLaunchPlanInput,
} from "./features/contained-agent-turn/adapters/outbound/claude-agent-sdk/claude-agent-sdk-launch-plan.js";
export {
  createNodeContainedTurnArtifacts,
  type NodeContainedTurnArtifactOptions,
} from "./features/contained-agent-turn/adapters/outbound/filesystem/node-contained-turn-artifacts.js";
export {
  createNodeContainedTurnWorkspace,
  type NodeContainedTurnWorkspaceOptions,
} from "./features/contained-agent-turn/adapters/outbound/filesystem/node-contained-turn-workspace.js";
export {
  NodeProviderProcessCustody,
  type NodeProviderProcessCustodyOptions,
} from "./features/contained-agent-turn/adapters/outbound/host-custody/node-provider-process-custody.js";
export {
  createStaticHostCustodyLaunchPlanResolver,
  type StaticHostCustodyLaunchPlan,
} from "./features/contained-agent-turn/adapters/outbound/host-custody/static-host-custody-launch-plan-resolver.js";
export {
  HostCustodyUnsupportedError,
  type CustodiedProviderProcess,
  type CustodiedProviderProcessExit,
  type CustodiedProviderProcessRegistry,
  type CustodiedSdkProcess,
  type CustodiedSdkProcessLauncher,
  type HostCustodyLaunchPlan,
  type HostCustodyLaunchPlanResolver,
} from "./features/contained-agent-turn/adapters/outbound/host-custody/custodied-provider-process.js";
