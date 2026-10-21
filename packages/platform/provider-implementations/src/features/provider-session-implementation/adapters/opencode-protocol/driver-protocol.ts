import type { EventPayload, Limits } from '@agent-teams/agent-execution/interactive-contracts'

/** Private seam for the two actual native dialects; no runtime ownership or native DTOs. */
export type DriverPermission = { requestId: string; tool: string; input: unknown }
export type DriverSnapshot = { facts: readonly EventPayload[]; terminal?: 'succeeded' | 'failed' | 'cancelled' | undefined; permissions: readonly DriverPermission[] }
export type DriverTurn = { nativeInputId: string; read: () => Promise<DriverSnapshot>; interrupt: () => Promise<void> }
export type DriverProtocol = {
  pollIntervalMs: number
  dispose: () => Promise<void>
  queue: (operationKey: string, text: string) => Promise<DriverTurn>
  replyPermission: (requestId: string, decision: 'allow' | 'deny', signal: AbortSignal) => Promise<void>
}
export type DriverSessionConfig = {
  binding: Readonly<{ tenantId: string; projectId: string; sessionId: string; generation: number }>
  nativeSessionId: string; trustedBinding: string; engine: 'opencode-v1' | 'opencode-v2'; compatibility: string
  limits: Limits
  probe: (signal: AbortSignal) => Promise<boolean>
  confirmStopped: () => Promise<boolean>
}
