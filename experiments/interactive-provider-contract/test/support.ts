import assert from 'node:assert/strict';
import type { Options, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ClaudeConfig, ClaudeSdkBoundary } from '../src/claude/index.ts';
type QueryHandle = ReturnType<ClaudeSdkBoundary['query']>;
import type { Event, Session } from '../src/draft-contracts/index.ts';
export function latch<T>() {
  let settle!: (value: T) => void;
  const promise = new Promise<T>((resolve) => { settle = resolve; });
  return { promise, resolve: settle };
}
export const tick = async () => { await new Promise<void>((resolve) => { setImmediate(resolve); }); };
export class FakeQuery implements QueryHandle {
  options!: Options;
  inputs: SDKUserMessage[] = [];
  statuses = [{ name: 'fixture', status: 'connected' as const, tools: [{ name: 'readiness' }, { name: 'fixture_task' }, { name: 'message_send' }] }];
  interrupts = 0;
  interruptResult: () => Promise<void> = async () => {};
  closed = 0;
  private events: unknown[] = [];
  private wakeup = latch<void>();
  private ended = false;
  private error = false;
  readonly factory: ClaudeSdkBoundary['query'] = (args) => {
    this.options = args.options;
    void (async () => { for await (const input of args.prompt) { this.inputs.push(input); } })();
    return this;
  };
  readonly boundary: ClaudeSdkBoundary = { query: this.factory, sessionExists: () => Promise.resolve(true) };
  emit(event: unknown): void { this.events.push(event); this.wake(); }
  result(index = 0, subtype = 'success'): void {
    const input = this.inputs[index]; assert(input);
    this.emit({ type: 'result', subtype, session_id: this.options.sessionId ?? this.options.resume, user_message_uuid: input.uuid });
  }
  exception(): void { this.error = true; this.wake(); }
  async mcpServerStatus(): ReturnType<QueryHandle['mcpServerStatus']> { return this.statuses; }
  async interrupt(): Promise<undefined> { this.interrupts += 1; await this.interruptResult(); }
  close(): void { this.closed += 1; this.ended = true; this.wake(); }
  private wake(): void { this.wakeup.resolve(); this.wakeup = latch<void>(); }
  async *[Symbol.asyncIterator](): AsyncGenerator<unknown> {
    while (!this.ended) {
      if (this.events.length) {yield this.events.shift();}
      else if (this.error) {throw new Error('sensitive provider error must not escape');}
      else {await this.wakeup.promise;}
    }
  }
}
type FixtureConfig = Omit<ClaudeConfig, 'limits'> & { limits: { -readonly [K in keyof ClaudeConfig['limits']]: ClaudeConfig['limits'][K] } };
export function config(ref = 'runtime-session-A'): FixtureConfig {
  return {
    sessionRef: ref, trustedBinding: `opaque:${ref}`, accountBinding: 'TEST-account', configRevision: 'TEST-v1',
    cwd: '/TEST-disposable/workspace', model: 'test-model', environment: { HOME: '/TEST-disposable/home', CLAUDE_CONFIG_DIR: '/TEST-disposable/config', PATH: '/usr/bin:/bin' },
    nativeTools: ['Read', 'AskUserQuestion'], autoAllowedTools: ['mcp__fixture__readiness'],
    mcpServers: { fixture: { type: 'http', url: 'http://127.0.0.1:10000/mcp' } }, requiredTools: { fixture: ['readiness', 'fixture_task', 'message_send'] },
    probe: () => Promise.resolve(true), sessionExists: () => Promise.resolve(true),
    limits: { queuedInputs: 1, inputBytes: 2048, outputBytes: 20000, outputEvents: 100, pendingInteractions: 2, timeoutMs: 200 },
    custody: { launch: () => { throw new Error('Synthetic test must never launch'); }, confirmStopped: () => Promise.resolve(true) },
  };
}
export function observe(session: Session): Event[] {
  const events: Event[] = []; void (async () => { for await (const event of session.observe()) {events.push(event);} })(); return events;
}
export const input = (n = 1) => ({ inputId: `input-${n}`, operationRef: `operation-${n}`, content: `TEST prompt ${n}` });
export async function opened(fake = new FakeQuery(), c = config()) {
  const { openClaudeSession } = await import('../src/claude/index.ts');
  const result = await openClaudeSession(c, undefined, fake.boundary); assert(result.ok); return { session: result.value, fake };
}
