import type { SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";

import type {
  ClaudeSdkSpawnedProcess,
} from "../../../dist/features/contained-agent-turn/adapters/outbound/claude-agent-sdk/claude-agent-sdk-query-contracts.js";

declare global {
  // Root typecheck runs with skipLibCheck:false, which fully checks
  // @modelcontextprotocol/sdk's transport.d.ts (pulled in transitively by the
  // official SDK's own sdk.d.ts). That file references the WHATWG fetch global
  // HeadersInit, which this repo's pinned @types/node does not (yet) declare.
  // This shim only supplies the missing global name for this compile-only
  // file; it has no runtime effect and does not touch production code.
  type HeadersInit = Headers | Record<string, string> | [string, string][];
}

/**
 * Compile-only contract: Claude Agent SDK 0.3.251 requires spawnClaudeCodeProcess
 * to return a SpawnedProcess (exitCode/killed/kill/on('exit')/on('error')/off/once).
 * This is an official SDK-facing spawn contract, not a second Host-owned process
 * authority; Host Custody still owns the real process. Never execute this file.
 */
export const claudeSdkSpawnedProcessSatisfiesOfficialSdkContract =
  (null as unknown as ClaudeSdkSpawnedProcess) satisfies SpawnedProcess;
