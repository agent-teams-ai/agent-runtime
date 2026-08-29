// The Claude Agent SDK exposes one transitive MCP declaration that references
// the DOM spelling even in a Node-only program. Keep that compatibility alias
// beside the outer adapter instead of enabling the entire DOM library in the
// Agent Execution domain and application compiler boundary.
declare global {
  type HeadersInit = readonly (readonly [string, string])[] | Readonly<Record<string, string>>;
}

export type AgentRuntimeClaudeSdkHeadersInit = HeadersInit;
