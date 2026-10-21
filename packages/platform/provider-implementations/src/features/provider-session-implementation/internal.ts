export { openClaudeSession } from './adapters/claude-sdk/open-session.ts';
export type { ClaudeConfig, ClaudeSdkBoundary } from './adapters/claude-sdk/open-session.ts';
export { createClaudeDriverFactory } from './adapters/claude-sdk/factory.ts';
export type { ClaudeDriverHost } from './adapters/claude-sdk/factory.ts';
export type { ClaudeToolBinding, ClaudeToolBindingRequest } from './adapters/claude-sdk/tool-binding.ts';

export { mapCodexNativeExecLine, mapCodexNativeExecOutput } from './adapters/codex-protocol/exec-jsonl.ts'
export type { CodexExecMappingOptions } from './adapters/codex-protocol/exec-jsonl.ts'
export type { CodexNativeNormalizedEvent, CodexNativeToolSource } from './contracts/codex-events.ts'
export { normalizeCodexAppServerApprovalRequest, isCodexAppServerApprovalMethod } from './adapters/codex-protocol/approval-request.ts'
export type { CodexAppServerRequest, CodexAppServerRequestId, CodexAppServerApprovalMethod, CodexAppServerToolApprovalRequest } from './contracts/codex-approval.ts'
export { encodeCodexApprovalResponse } from './adapters/codex-protocol/approval-response.ts'
export type { CodexApprovalReply, CodexApprovalResponse } from './adapters/codex-protocol/approval-response.ts'
export { CodexAppServerClient } from './adapters/codex-protocol/app-server.ts'
export type { CodexAppServerOptions, CodexInitializeParams } from './adapters/codex-protocol/app-server.ts'
export { CodexProtocolError } from './adapters/codex-protocol/rpc-types.ts'
export type { CodexAppServerTransport, CodexRpcLimits } from './adapters/codex-protocol/rpc-types.ts'
export type { CodexAppServerEvent, CodexApprovalHandler, CodexTurnRef, CodexTurnOutcome, CodexTurnParams, CodexTurnSubmission } from './adapters/codex-protocol/session-types.ts'
export type { CodexThreadSession } from './adapters/codex-protocol/thread-session.ts'
export { createCodexDriverFactory } from './adapters/codex-protocol/driver-factory.ts'
export type { CodexDriverHost } from './adapters/codex-protocol/driver-factory.ts'
export type { CodexDriverConfig } from './adapters/codex-protocol/driver-config.ts'

export { OpenCodeClientFactory } from './adapters/opencode-protocol/OpenCodeClientFactory.ts'
export type { OpenCodeClient, OpenCodeClientRequestContext } from './adapters/opencode-protocol/OpenCodeClientFactory.ts'
export { bindOpenCodeSession } from './adapters/opencode-protocol/bound-session.ts'
export {
  normalizeOpenCodeSseEvent, readOpenCodeSseEndpoint,
  getOpenCodeSseSessionId, getOpenCodeSseMessageId,
  getOpenCodeSseMessageRole, getOpenCodeSseMessageParentId,
  getOpenCodeSsePartType, getOpenCodeSseSessionStatusType,
} from './adapters/opencode-protocol/OpenCodeSseEventStream.ts'
export type { OpenCodeSseEndpointReadResult } from './adapters/opencode-protocol/OpenCodeSseEventStream.ts'
export {
  buildOpenCodeRuntimePromptMessageId,
  isCanonicalOpenCodeAscendingMessageId,
  getGreatestCanonicalOpenCodeMessageId,
  getOpenCodeAscendingMessageIdTimestampSlot,
} from './adapters/opencode-protocol/OpenCodeMessageIds.ts'
export type { OpenCodeMessage, OpenCodeSseEvent, OpenCodeMcpServerConfig } from './adapters/opencode-protocol/types.ts'
export { createOpenCodeSessionBindings } from './adapters/opencode-protocol/session-bindings.ts'
export type { OpenCodeBindingStorage, OpenCodeStoredBinding, OpenCodeBindingObservation, OpenCodeCursorUpdate } from './adapters/opencode-protocol/session-binding-types.ts'
export { qualifyOpenCodeV1BoundTerminalProof } from './adapters/opencode-protocol/terminal-proof.ts'
export type { OpenCodeV1TerminalEvidence, OpenCodeV1TerminalProof } from './adapters/opencode-protocol/terminal-proof.ts'
export type { OpenCodeCanonicalMessage } from './adapters/opencode-protocol/canonical-message-types.ts'
export { createOpenCodeV2ExecutionTransport } from './adapters/opencode-protocol/v2-execution-transport.ts'
export type { OpenCodeV2TransportConfig } from './adapters/opencode-protocol/v2-execution-transport.ts'
export { executionSessionIsMissing as isOpenCodeV2SessionMissing, executionWasNotSubmitted as wasOpenCodeV2InputNotSubmitted } from './adapters/opencode-protocol/v2-failures.ts'
export { projectOpenCodeV2NativeTurn } from './adapters/opencode-protocol/v2-turn-projection.ts'
export type { OpenCodeV2NativeTurnCut, OpenCodeV2NativeTurn, OpenCodeV2NativeToolFact } from './adapters/opencode-protocol/v2-projection-types.ts'
export { readOpenCodeV2NativeCut } from './adapters/opencode-protocol/v2-native-cut.ts'
export type { OpenCodeV2ReadBinding, OpenCodeV2ReadTransport } from './adapters/opencode-protocol/v2-native-cut.ts'
export { createOpenCodeV2SessionControl } from './adapters/opencode-protocol/v2-session-control.ts'
export type { OpenCodeV2SessionControlConfig } from './adapters/opencode-protocol/v2-control-transport.ts'
export type { OpenCodeV2Permission } from './adapters/opencode-protocol/v2-session-control.ts'

export { createOpenCodeV2DriverFactory } from './adapters/opencode-protocol/v2-driver-factory.ts'
export type { OpenCodeV2DriverHost } from './adapters/opencode-protocol/v2-driver-factory.ts'
export type { OpenCodeV2DriverConfig } from './adapters/opencode-protocol/v2-driver-config.ts'

export { createOpenCodeV1DriverFactory } from './adapters/opencode-protocol/v1-driver-factory.ts'
export type { OpenCodeV1DriverHost } from './adapters/opencode-protocol/v1-driver-factory.ts'
export type { OpenCodeV1DriverConfig } from './adapters/opencode-protocol/v1-driver-config.ts'

export { EventFeed, bounded, deferred } from './adapters/provider-session-io/io.ts';
