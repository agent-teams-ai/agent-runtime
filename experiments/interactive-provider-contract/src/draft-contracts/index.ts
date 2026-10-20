/** TEST-only consumer-owned draft. Runtime owns admission, identities and durability. */
export type FailureCode = 'invalid-config' | 'unavailable' | 'dependency-unavailable' |
  'backpressure' | 'stale' | 'unsupported' | 'checkpoint-incompatible' |
  'checkpoint-missing' | 'provider-failure' | 'output-limit' | 'unknown';
export type Failure = { ok: false; code: FailureCode };
export type Reply<T> = { ok: true; value: T } | Failure;
export type Input = { inputId: string; operationRef: string; content: string };
export type Handoff = { inputId: string; operationRef: string; delivery: 'sdk-consumed'; providerAcceptance: 'unknown' };
export type InteractionReply = { kind: 'permission'; decision: 'allow' | 'deny' } |
  { kind: 'question'; answers: Record<string, string> };
export type EventPayload = (
  { kind: 'text'; messageRef: string; block: number; text: string; phase: 'snapshot' | 'complete' } |
  { kind: 'tool'; messageRef: string; toolRef: string; name: string; input: unknown } |
  { kind: 'tool-result'; toolRef: string; content: unknown; isError: boolean } |
  { kind: 'usage'; inputTokens?: number; outputTokens?: number; cumulativeCostUsd?: number } |
  { kind: 'result'; outcome: 'succeeded' | 'failed' | 'unknown'; code?: FailureCode } |
  { kind: 'interaction'; interactionRef: string; request: { kind: 'permission'; tool: string; input: unknown } | { kind: 'question'; questions: unknown } } |
  { kind: 'diagnostic'; code: FailureCode | 'unknown-event' | 'iterator-ended' }
);
export type Event = { sessionRef: string; operationRef?: string; inputId?: string } & EventPayload;
export type Limits = { queuedInputs: number; inputBytes: number; outputBytes: number; outputEvents: number; pendingInteractions: number; timeoutMs: number };
export type CloseReceipt = { logicallyClosed: true; cleanup: 'confirmed' | 'unknown' };
export interface Session {
  readonly sessionRef: string;
  submit(input: Input): Promise<Reply<Handoff>>;
  observe(): AsyncIterable<Event>;
  respondToInteraction(ref: string, reply: InteractionReply): Reply<void>;
  interrupt(operationRef: string): Promise<Reply<{ requested: true; terminal: 'unconfirmed' }>>;
  checkReadiness(): Promise<Reply<void>>;
  checkpoint(): Reply<unknown>;
  close(): Promise<CloseReceipt>;
}
