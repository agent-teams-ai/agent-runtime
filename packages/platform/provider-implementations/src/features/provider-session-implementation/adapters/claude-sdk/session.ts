import { randomUUID } from 'node:crypto';
import type { CanUseTool, Options, Query, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { CloseReceipt, Event, EventPayload, FailureCode, Handoff, Input, InteractionReply, Reply, Session } from '@agent-teams/provider-session-contracts';
import { compatibility, options, SDK_REVISION } from './config.ts';
import type { ClaudeConfig } from './config.ts';
import { toolBindingHook } from './tool-binding.ts';
import { Interactions } from './interactions.ts';
import { Normalizer, OutputLimitError, record } from './normalize.ts';
import { bounded, deferred, EventFeed } from '../provider-session-io/io.ts';
import { fail } from './primitives.ts';
import { AttachmentFailure, assertSerializedAttachments, prepareAttachments, snapshotInput, validateAttachments } from '../provider-session-io/attachments.ts';
import type { PreparedAttachment } from '../provider-session-io/attachments.ts';
export type QueryHandle = Pick<Query, 'interrupt' | 'close' | 'mcpServerStatus'> & AsyncIterable<unknown>;
export type QueryFactory = (args: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => QueryHandle;
type PendingInput = { input: Input; handed: boolean; nativeRef: ReturnType<typeof randomUUID>; receipt: ReturnType<typeof deferred<Reply<Handoff>>>; interactionsCancelled: boolean; toolRevocation: AbortController };
export class ClaudeSession implements Session {
  readonly sessionRef: string;
  private state: 'open' | 'unavailable' | 'closed' = 'open';
  private readonly feed: EventFeed<Event>;
  private readonly normalizer: Normalizer;
  private readonly backgroundNormalizer: Normalizer;
  private readonly interactions: Interactions;
  private readonly query: QueryHandle;
  private readonly readLoop: Promise<void>;
  private readonly queued: PendingInput[] = [];
  private active: PendingInput | undefined;
  private readonly messageOwners = new Map<string, Input>();
  private readonly toolOwners = new Map<string, { input: Input; name: string }>();
  private readonly nativeToolIdentities = new Map<string, { nativeInput: string; name: string }>();
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
    const preToolUse = config.toolBinding ? toolBindingHook(config.toolBinding, this.sessionRef, nativeSession, (toolId, toolName) => {
      const active = this.active; const owner = this.toolOwners.get(toolId);
      if (active === undefined || !owner || owner.name !== toolName || owner.input !== active.input) { return; }
      return this.state === 'open' && !active.interactionsCancelled ? { ...active.input, nativeRef: active.nativeRef, revoked: active.toolRevocation.signal } : undefined;
    }, config.limits.timeoutMs) : undefined;
    this.query = factory({ prompt: this.inputs(), options: { ...options(config, nativeSession, restore), canUseTool: this.requestInteraction,
      ...(preToolUse ? { hooks: { PreToolUse: [{ hooks: [preToolUse] }] } } : {}) } });
    this.readLoop = this.read();
  }
  submit(input: Input): Promise<Reply<Handoff>> {
    if (this.state !== 'open') {return Promise.resolve(fail(this.failure ?? 'unavailable'));}
    if (!input.inputId || !input.operationRef || !input.content || Buffer.byteLength(input.content) > this.config.limits.inputBytes) {return Promise.resolve(fail('backpressure'));}
    try { input = snapshotInput(input); validateAttachments(input, 'claude', this.config.model, this.config.attachments); }
    catch (error) { return Promise.resolve({ ok: false, code: error instanceof AttachmentFailure ? error.code : 'invalid-config', delivery: 'known-not-sent' }); }
    if ((this.active?.input.operationRef === input.operationRef || this.active?.input.inputId === input.inputId) || this.queued.some((v) => v.input.operationRef === input.operationRef || v.input.inputId === input.inputId)) {return Promise.resolve(fail('stale'));}
    if (this.queued.length >= this.config.limits.queuedInputs) {return Promise.resolve(fail('backpressure'));}
    const pending: PendingInput = { input, handed: false, nativeRef: randomUUID(), receipt: deferred<Reply<Handoff>>(), interactionsCancelled: false, toolRevocation: new AbortController() };
    this.queued.push(pending); this.wake(); return pending.receipt.promise;
  }
  observe(): AsyncIterable<Event> { return this.feed; }
  respondToInteraction(ref: string, reply: InteractionReply): Reply<void> {
    if (this.active?.interactionsCancelled === true) { return fail('stale'); }
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
            if (status.status !== 'connected' || !required.every((tool) => status.tools?.some((item) => item.name === tool) === true)) { return false; }
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
    if (!this.active.handed) {return Promise.resolve(fail('stale'));}
    if (this.control) {return this.control;}
    // Install the fence synchronously. A result cannot release the next handoff until this settles.
    const done = deferred<Reply<{ requested: true; terminal: 'unconfirmed' }>>(); this.control = done.promise;
    this.active.interactionsCancelled = true; this.active.toolRevocation.abort();
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
      if (!this.handoffAvailable()) {continue;}
      const pending = this.queued.shift();
      if (!pending) {continue;}
      this.active = pending; this.foregroundBound = false; this.messageOwners.clear(); this.toolOwners.clear(); this.streamRef = undefined; this.turnBytes = 0; this.turnEvents = 0; this.normalizer.reset(); this.backgroundNormalizer.reset();
      let content: SDKUserMessage['message']['content'] = pending.input.content;
      if (pending.input.attachments?.length) {
        try {
          const attachments = await prepareAttachments(pending.input, { trustedBinding: this.config.trustedBinding, sessionRef: this.sessionRef, port: this.config.attachments, signal: pending.toolRevocation.signal, timeoutMs: this.config.limits.timeoutMs });
          content = claudeContent(pending.input.content, attachments);
          if (this.active !== pending || this.state !== 'open' || pending.interactionsCancelled || this.control) { throw new AttachmentFailure('stale'); }
        } catch (error) {
          pending.toolRevocation.abort(); pending.receipt.resolve({ ok: false, code: error instanceof AttachmentFailure ? error.code : 'unavailable', delivery: 'known-not-sent' });
          if (this.active === pending) { this.active = undefined; } this.wake(); continue;
        }
      }
      pending.handed = true;
      pending.receipt.resolve({ ok: true, value: { inputId: pending.input.inputId, operationRef: pending.input.operationRef, delivery: 'client-consumed', providerAcceptance: 'unknown' } });
      yield { type: 'user', message: { role: 'user', content }, parent_tool_use_id: null, session_id: this.nativeSession, uuid: pending.nativeRef };
    }
  }
  private handoffAvailable(): boolean {
    // This check follows an await; TypeScript's earlier narrowing is not a lifecycle fence.
    return this.state === 'open' && this.control === undefined && this.active === undefined;
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
    if (Boolean(m.session_id) && m.session_id !== this.nativeSession) { this.unavailable('unknown'); return; }
    const input = this.correlate(m);
    if (m.type === 'system' && m.subtype === 'compact_boundary') {
      if (m.session_id !== this.nativeSession || Boolean(m.parent_tool_use_id) || Boolean(m.agent_id) || Boolean(m.resume_reason)) { return; }
      // One session-lifetime dedup owner, independent of foreground/background attribution.
      for (const fact of this.normalizer.normalize(message).facts) { this.emit(fact, input); }
      return;
    }
    if (input && !this.ownPartialTool(m, input)) { return; }
    const { facts, terminal, failure } = (input ? this.normalizer : this.backgroundNormalizer).normalize(message);
    this.knownTerminal = terminal && input ? { sessionRef: this.sessionRef, inputId: input.inputId, operationRef: input.operationRef, kind: 'result', outcome: terminal, ...(failure ? { code: failure } : {}) } : undefined;
    for (const fact of facts) {
      if (input && fact.kind === 'tool') { if (!this.ownTool(fact.toolRef, fact.name, input)) { return; } }
      this.emit(fact, input);
    }
    this.acceptTerminal(terminal, failure, input);
    this.knownTerminal = undefined;
    this.acceptInitialization(m);
  }
  private ownPartialTool(m: Record<string, unknown>, input: Input): boolean {
    if (m.type !== 'stream_event') { return true; }
    const event = record(m.event); const block = record(event.content_block);
    return event.type !== 'content_block_start' || block.type !== 'tool_use' ||
      typeof block.id !== 'string' || typeof block.name !== 'string' || this.ownTool(block.id, block.name, input);
  }
  private acceptTerminal(terminal: 'succeeded' | 'failed' | 'unknown' | undefined,
    failure: FailureCode | undefined, input: Input | undefined): void {
    if (terminal === undefined) { return; }
    const active = this.active;
    if (input && active !== undefined && (active.input.operationRef === input.operationRef || active.input.inputId === input.inputId)) {
      this.emit({ kind: 'result', outcome: terminal, ...(failure ? { code: failure } : {}) }, input);
      active.toolRevocation.abort(); this.active = undefined; this.interactions.cancel(); this.wake();
      if (terminal === 'unknown') {this.unavailable(failure ?? 'unknown');}
    } else { this.emit({ kind: 'result', outcome: 'unknown', code: 'unknown' }); this.unavailable('unknown'); }
  }
  private acceptInitialization(m: Record<string, unknown>): void {
    if (m.type !== 'system' || m.subtype !== 'init') { return; }
    if (m.permissionMode !== (this.config.nativeOptions?.permissionMode ?? 'default')) {this.unavailable('unsupported');}
    if (Array.isArray(m.mcp_servers) && m.mcp_servers.some((s) => { const server = record(s); return Object.hasOwn(this.config.requiredTools, String(server.name)) && !['connected', 'pending'].includes(String(server.status)); })) {this.unavailable('dependency-unavailable');}
  }
  private correlate(m: Record<string, unknown>): Input | undefined {
    const active = this.active;
    if (active === undefined || Boolean(m.parent_tool_use_id) || Boolean(m.agent_id) || Boolean(m.resume_reason)) { return undefined; }
    const echoed = m.user_message_uuid === active.nativeRef || (Array.isArray(m.user_message_uuids) && m.user_message_uuids.includes(active.nativeRef));
    if (this.foreignEcho(m, echoed)) { return undefined; }
    const nested = record(m.message); const partial = record(record(m.event).message);
    const id = typeof nested.id === 'string' ? nested.id : typeof partial.id === 'string' ? partial.id : undefined;
    this.bindMessage(m, id, echoed, active.input);
    if (echoed) { return active.input; }
    if (id !== undefined && id.length > 0) { return this.messageOwners.get(id); }
    if (m.type === 'stream_event' && m.parent_tool_use_id === null && this.streamRef !== undefined && this.streamRef.length > 0) { return this.messageOwners.get(this.streamRef); }
    return m.type === 'user' ? this.toolResultOwner(nested.content) : undefined;
  }
  private foreignEcho(m: Record<string, unknown>, echoed: boolean): boolean {
    if (echoed || (typeof m.user_message_uuid !== 'string' && !Array.isArray(m.user_message_uuids))) { return false; }
    if (m.type === 'stream_event' && m.parent_tool_use_id === null && record(m.event).type === 'message_start') { this.streamRef = undefined; }
    return true;
  }
  private bindMessage(m: Record<string, unknown>, id: string | undefined, echoed: boolean, input: Input): void {
    const foregroundFrame = m.type === 'assistant' || m.type === 'stream_event';
    if (echoed && foregroundFrame) { this.foregroundBound = true; }
    // SDK 0.3.305 echoes only the first frame of a foreground turn. Explicit
    // main-thread frames in later tool rounds retain that established binding.
    if (id !== undefined && id.length > 0 && (echoed || (this.foregroundBound && foregroundFrame && m.parent_tool_use_id === null))) {
      this.messageOwners.set(id, input);
      if (m.type === 'stream_event') { this.streamRef = id; }
    }
  }
  private ownTool(id: string, name: string, input: Input): boolean {
    const nativeInput = this.active?.input === input ? this.active.nativeRef : undefined;
    const prior = this.nativeToolIdentities.get(id);
    if (nativeInput === undefined || nativeInput.length === 0 || (prior && (prior.nativeInput !== nativeInput || prior.name !== name))) { this.unavailable('unknown'); return false; }
    // IDs have no proved global uniqueness contract. Retain bounded tombstones across turns.
    if (!prior && this.nativeToolIdentities.size >= this.config.limits.outputEvents) { this.unavailable('output-limit'); return false; }
    this.nativeToolIdentities.set(id, { nativeInput, name });
    this.toolOwners.set(id, { input, name }); return true;
  }
  private toolResultOwner(content: unknown): Input | undefined {
    if (!this.active || !Array.isArray(content)) { return undefined; }
    const owners = content.filter((block) => record(block).type === 'tool_result').map((block) => this.toolOwners.get(String(record(block).tool_use_id))?.input);
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
      this.active.toolRevocation.abort();
      if (!this.active.handed) { this.active.receipt.resolve({ ok: false, code, delivery: 'known-not-sent' }); this.active = undefined; }
    }
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

function claudeContent(text: string, attachments: readonly PreparedAttachment[]): SDKUserMessage['message']['content'] {
  const blocks: Exclude<SDKUserMessage['message']['content'], string> = [];
  for (const { reference, bytes } of attachments) {
    if (reference.mimeType.startsWith('image/')) {
      blocks.push({ type: 'image', source: { type: 'base64', media_type: reference.mimeType as 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif', data: Buffer.from(bytes).toString('base64') } });
    } else if (reference.mimeType === 'application/pdf') {
      blocks.push({ type: 'document', title: reference.artifactId, source: { type: 'base64', media_type: 'application/pdf', data: Buffer.from(bytes).toString('base64') } });
    } else {
      let data: string;
      try { data = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw new AttachmentFailure('invalid-config'); }
      blocks.push({ type: 'document', title: reference.artifactId, source: { type: 'text', media_type: 'text/plain', data } });
    }
  }
  blocks.push({ type: 'text', text }); assertSerializedAttachments(blocks); return blocks;
}
