import { randomUUID } from 'node:crypto';
import type { CanUseTool, Options, Query, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { CloseReceipt, Event, EventPayload, FailureCode, Handoff, Input, InteractionReply, Reply, Session } from '../draft-contracts/index.ts';
import { compatibility, options, SDK_REVISION } from './config.ts';
import type { ClaudeConfig } from './config.ts';
import { Interactions } from './interactions.ts';
import { Normalizer, OutputLimitError, record } from './normalize.ts';
import { bounded, deferred, EventFeed, fail } from './primitives.ts';
export type QueryHandle = Pick<Query, 'interrupt' | 'close' | 'mcpServerStatus'> & AsyncIterable<unknown>;
export type QueryFactory = (args: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => QueryHandle;
type PendingInput = { input: Input; nativeRef: ReturnType<typeof randomUUID>; receipt: ReturnType<typeof deferred<Reply<Handoff>>>; interactionsCancelled: boolean };
export class ClaudeSession implements Session {
  readonly sessionRef: string;
  private state: 'open' | 'unavailable' | 'closed' = 'open';
  private readonly feed: EventFeed<Event>;
  private readonly normalizer: Normalizer;
  private readonly backgroundNormalizer: Normalizer;
  private readonly interactions: Interactions;
  private readonly query: QueryHandle;
  private readonly readLoop: Promise<void>;
  private queued: PendingInput[] = [];
  private active: PendingInput | undefined;
  private messageOwners = new Map<string, Input>();
  private toolOwners = new Map<string, Input>();
  private streamRef: string | undefined;
  private foregroundBound = false;
  private turnBytes = 0;
  private turnEvents = 0;
  private knownTerminal: Extract<Event, { kind: 'result' }> | undefined;
  private wakeup = deferred<void>();
  private control: Promise<Reply<{ requested: true; terminal: 'unconfirmed' }>> | undefined;
  private closing?: Promise<CloseReceipt>;
  private readiness: Promise<Reply<void>> | undefined;
  private failure: FailureCode | undefined;
  private readonly config: ClaudeConfig;
  private readonly nativeSession: string;
  constructor(config: ClaudeConfig, nativeSession: string, restore: boolean, factory: QueryFactory) {
    this.config = config; this.nativeSession = nativeSession;
    this.sessionRef = config.sessionRef;
    this.feed = new EventFeed(config.limits.outputEvents, config.limits.outputBytes);
    this.normalizer = new Normalizer(config.limits.outputBytes);
    this.backgroundNormalizer = new Normalizer(config.limits.outputBytes);
    this.interactions = new Interactions(config.limits.pendingInteractions, config.limits.timeoutMs, (event) => {
      if (!this.active || this.active.interactionsCancelled || this.state !== 'open') { this.interactions.cancel(); return; }
      this.emit(event, this.active.input);
    });
    this.query = factory({ prompt: this.inputs(), options: { ...options(config, nativeSession, restore), canUseTool: this.requestInteraction } });
    this.readLoop = this.read();
  }
  submit(input: Input): Promise<Reply<Handoff>> {
    if (this.state !== 'open') {return Promise.resolve(fail(this.failure ?? 'unavailable'));}
    if (!input.inputId || !input.operationRef || !input.content || Buffer.byteLength(input.content) > this.config.limits.inputBytes) {return Promise.resolve(fail('backpressure'));}
    if ((this.active?.input.operationRef === input.operationRef || this.active?.input.inputId === input.inputId) || this.queued.some((v) => v.input.operationRef === input.operationRef || v.input.inputId === input.inputId)) {return Promise.resolve(fail('stale'));}
    if (this.queued.length >= this.config.limits.queuedInputs) {return Promise.resolve(fail('backpressure'));}
    const pending: PendingInput = { input: { ...input }, nativeRef: randomUUID(), receipt: deferred<Reply<Handoff>>(), interactionsCancelled: false };
    this.queued.push(pending); this.wake(); return pending.receipt.promise;
  }
  observe(): AsyncIterable<Event> { return this.feed; }
  respondToInteraction(ref: string, reply: InteractionReply): Reply<void> {
    if (this.active?.interactionsCancelled) { return fail('stale'); }
    return this.state === 'open' ? this.interactions.reply(ref, reply) : fail('unavailable');
  }
  private readonly requestInteraction: CanUseTool = (...args) => {
    if (this.state !== 'open' || !this.active || this.active.interactionsCancelled) {
      return Promise.resolve({ behavior: 'deny', message: 'Interaction unavailable for this operation' });
    }
    return this.interactions.request(...args);
  };
  checkReadiness(): Promise<Reply<void>> {
    if (this.state === 'closed' || (this.failure && this.failure !== 'dependency-unavailable')) {return Promise.resolve(fail(this.failure ?? 'unavailable'));}
    if (!this.readiness) {this.readiness = this.probe().finally(() => { this.readiness = undefined; });}
    return this.readiness;
  }
  private async probe(): Promise<Reply<void>> {
    const abort = new AbortController();
    try {
      const healthy = await bounded((async () => {
        // Observe initial pending connections within the owner deadline. This does not reconnect.
        while (!abort.signal.aborted) {
          const statuses = await this.query.mcpServerStatus();
          let pending = false;
          for (const [server, required] of Object.entries(this.config.requiredTools)) {
            const status = statuses.find((item) => item.name === server);
            if (!status || status.status === 'pending') { pending = true; continue; }
            if (status.status !== 'connected' || !required.every((tool) => status.tools?.some((item) => item.name === tool))) { return false; }
          }
          if (!pending) { return this.config.probe(abort.signal); }
          await new Promise<void>((resolve) => { setTimeout(resolve, 20); });
        }
        return false;
      })(), this.config.limits.timeoutMs);
      if (!healthy || this.state === 'closed') {
        if (this.state !== 'closed') { this.unavailable('dependency-unavailable'); }
        return fail('dependency-unavailable');
      }
      if (this.failure === 'dependency-unavailable') { this.failure = undefined; this.state = 'open'; this.wake(); }
      return { ok: true, value: undefined };
    } catch { this.unavailable('dependency-unavailable'); return fail('dependency-unavailable'); }
    finally { abort.abort(); }
  }
  interrupt(operationRef: string): Promise<Reply<{ requested: true; terminal: 'unconfirmed' }>> {
    if (this.state !== 'open') {return Promise.resolve(fail('unavailable'));}
    if (!this.active || this.active.input.operationRef !== operationRef) {return Promise.resolve(fail('stale'));}
    if (this.control) {return this.control;}
    // Install the fence synchronously. A result cannot release the next handoff until this settles.
    const done = deferred<Reply<{ requested: true; terminal: 'unconfirmed' }>>(); this.control = done.promise;
    this.active.interactionsCancelled = true;
    this.interactions.cancel();
    void this.sendInterrupt(done);
    return done.promise;
  }
  private async sendInterrupt(done: ReturnType<typeof deferred<Reply<{ requested: true; terminal: 'unconfirmed' }>>>): Promise<void> {
    try {
      await bounded(this.query.interrupt(), this.config.limits.timeoutMs);
      done.resolve({ ok: true, value: { requested: true, terminal: 'unconfirmed' } });
      this.control = undefined; this.wake();
    } catch { this.unavailable('unknown'); done.resolve(fail('unknown')); }
  }
  checkpoint(): Reply<unknown> {
    if (this.active || this.queued.length || this.control || this.failure) {return fail('unavailable');}
    return { ok: true, value: { version: 1, engine: SDK_REVISION, nativeSession: this.nativeSession, compatibility: compatibility(this.config) } };
  }
  close(): Promise<CloseReceipt> {
    if (this.closing) {return this.closing;}
    // Seal before the first await, including interaction and iterable admission.
    this.unavailable('unknown'); this.state = 'closed'; this.interactions.close(); this.rejectQueued('unavailable'); this.wake();
    this.closing = this.shutdown(); return this.closing;
  }
  private async shutdown(): Promise<CloseReceipt> {
    try {
      this.query.close();
      await bounded(this.readLoop, this.config.limits.timeoutMs);
      const stopped = await bounded(this.config.custody.confirmStopped(), this.config.limits.timeoutMs);
      return { logicallyClosed: true, cleanup: stopped ? 'confirmed' : 'unknown' };
    } catch { return { logicallyClosed: true, cleanup: 'unknown' }; }
    finally { this.feed.end(); }
  }
  private async *inputs(): AsyncGenerator<SDKUserMessage> {
    while (this.state !== 'closed') {
      if (this.state !== 'open' || this.active || this.control || !this.queued.length) { await this.wakeup.promise; continue; }
      const ready = await this.checkReadiness();
      if (!ready.ok) { this.unavailable(ready.code); continue; }
      if (this.state !== 'open' || this.control || this.active) {continue;}
      const pending = this.queued.shift();
      if (!pending) {continue;}
      this.active = pending; this.foregroundBound = false; this.messageOwners.clear(); this.toolOwners.clear(); this.streamRef = undefined; this.turnBytes = 0; this.turnEvents = 0; this.normalizer.reset(); this.backgroundNormalizer.reset();
      pending.receipt.resolve({ ok: true, value: { inputId: pending.input.inputId, operationRef: pending.input.operationRef, delivery: 'sdk-consumed', providerAcceptance: 'unknown' } });
      yield { type: 'user', message: { role: 'user', content: pending.input.content }, parent_tool_use_id: null, session_id: this.nativeSession, uuid: pending.nativeRef };
    }
  }
  private async read(): Promise<void> {
    try {
      for await (const message of this.query) {
        if (this.state === 'closed') {break;}
        this.accept(message);
      }
      if (this.state !== 'closed') { this.emit({ kind: 'diagnostic', code: 'iterator-ended' }); this.unavailable('unknown'); }
    } catch (error) { if (this.state !== 'closed') {
      const code = error instanceof OutputLimitError ? 'output-limit' : 'provider-failure';
      this.emit({ kind: 'diagnostic', code }); this.unavailable(code);
    } }
    finally { this.feed.end(); }
  }
  private accept(message: unknown): void {
    const m = record(message);
    if (m.session_id && m.session_id !== this.nativeSession) { this.unavailable('unknown'); return; }
    const input = this.correlate(m);
    const { facts, terminal, failure } = (input ? this.normalizer : this.backgroundNormalizer).normalize(message);
    this.knownTerminal = terminal && input ? { sessionRef: this.sessionRef, inputId: input.inputId, operationRef: input.operationRef, kind: 'result', outcome: terminal, ...(failure ? { code: failure } : {}) } : undefined;
    for (const fact of facts) {
      if (input && fact.kind === 'tool') {this.toolOwners.set(fact.toolRef, input);}
      this.emit(fact, input);
    }
    if (terminal && input && (this.active?.input.operationRef === input.operationRef || this.active?.input.inputId === input.inputId)) {
      this.emit({ kind: 'result', outcome: terminal, ...(failure ? { code: failure } : {}) }, input);
      this.active = undefined; this.interactions.cancel(); this.wake();
      if (terminal === 'unknown') {this.unavailable(failure ?? 'unknown');}
    } else if (terminal) { this.emit({ kind: 'result', outcome: 'unknown', code: 'unknown' }); this.unavailable('unknown'); }
    this.knownTerminal = undefined;
    if (m.type === 'system' && m.subtype === 'init') {
      if (m.permissionMode !== 'default') {this.unavailable('unsupported');}
      if (Array.isArray(m.mcp_servers) && m.mcp_servers.some((s) => { const server = record(s); return Object.hasOwn(this.config.requiredTools, String(server.name)) && !['connected', 'pending'].includes(String(server.status)); })) {this.unavailable('dependency-unavailable');}
    }
  }
  private correlate(m: Record<string, unknown>): Input | undefined {
    if (!this.active || m.parent_tool_use_id || m.agent_id || m.resume_reason) { return undefined; }
    const echoed = m.user_message_uuid === this.active.nativeRef || (Array.isArray(m.user_message_uuids) && m.user_message_uuids.includes(this.active.nativeRef));
    if (!echoed && (typeof m.user_message_uuid === 'string' || Array.isArray(m.user_message_uuids))) {
      if (m.type === 'stream_event' && m.parent_tool_use_id === null && record(m.event).type === 'message_start') { this.streamRef = undefined; }
      return undefined;
    }
    const nested = record(m.message); const partial = record(record(m.event).message);
    const id = typeof nested.id === 'string' ? nested.id : typeof partial.id === 'string' ? partial.id : undefined;
    const foregroundFrame = m.type === 'assistant' || m.type === 'stream_event';
    if (echoed && foregroundFrame) { this.foregroundBound = true; }
    // SDK 0.3.305 echoes only the first frame of a foreground turn. Explicit
    // main-thread frames in later tool rounds retain that established binding.
    if (id && (echoed || (this.foregroundBound && foregroundFrame && m.parent_tool_use_id === null))) {
      this.messageOwners.set(id, this.active.input);
      if (m.type === 'stream_event') { this.streamRef = id; }
    }
    if (echoed) { return this.active.input; }
    if (id) { return this.messageOwners.get(id); }
    if (m.type === 'stream_event' && m.parent_tool_use_id === null && this.streamRef) { return this.messageOwners.get(this.streamRef); }
    return m.type === 'user' ? this.toolResultOwner(nested.content) : undefined;
  }
  private toolResultOwner(content: unknown): Input | undefined {
    if (!this.active || !Array.isArray(content)) { return undefined; }
    const owners = content.filter((block) => record(block).type === 'tool_result').map((block) => this.toolOwners.get(String(record(block).tool_use_id)));
    return owners.length && owners.every((owner) => owner?.operationRef === this.active?.input.operationRef) ? this.active.input : undefined;
  }
  private emit(fact: EventPayload, input?: Input): void {
    this.turnBytes += Buffer.byteLength(JSON.stringify(fact)); this.turnEvents += 1;
    if (this.turnBytes > this.config.limits.outputBytes || this.turnEvents > this.config.limits.outputEvents) { this.unavailable('output-limit'); return; }
    if (!this.feed.push(structuredClone({ ...fact, sessionRef: this.sessionRef, ...(input ? { inputId: input.inputId, operationRef: input.operationRef } : {}) }))) {this.unavailable('output-limit');}
  }
  private unavailable(code: FailureCode): void {
    if (this.state === 'closed' || this.failure === 'output-limit') {return;}
    this.state = 'unavailable';
    // A disappeared dependency during an accepted turn does not prove the turn stopped.
    this.failure = this.active && code === 'dependency-unavailable' ? 'unknown' : code;
    if (this.active) {
      // Exactly one unknown outcome for an accepted input; never auto-replay.
      const event: Event = { sessionRef: this.sessionRef, inputId: this.active.input.inputId, operationRef: this.active.input.operationRef, kind: 'result', outcome: 'unknown', code };
      if (code === 'output-limit') {this.feed.finishWith(this.knownTerminal ? { ...this.knownTerminal, code: 'output-limit' } : event);} else {this.feed.push(event);}
      this.active = undefined;
    }
    if (code === 'output-limit') {
      this.feed.finishWith({ sessionRef: this.sessionRef, kind: 'diagnostic', code });
      this.query.close();
    }
    this.interactions.cancel(); this.rejectQueued(code); this.wake();
  }
  private rejectQueued(code: FailureCode): void { for (const pending of this.queued.splice(0)) {pending.receipt.resolve(fail(code));} }
  private wake(): void { this.wakeup.resolve(); this.wakeup = deferred<void>(); }
}
