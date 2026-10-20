import { randomUUID } from 'node:crypto';
import type { CanUseTool, PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import type { EventPayload, InteractionReply, Reply } from '../draft-contracts/index.ts';
import { fail } from './primitives.ts';
type Pending = { kind: 'question' | 'permission'; input: Record<string, unknown>; finish: (result: PermissionResult) => void };
export class Interactions {
  private pending = new Map<string, Pending>();
  private sealed = false;
  private readonly max: number;
  private readonly timeoutMs: number;
  private readonly emit: (event: EventPayload) => void;
  constructor(max: number, timeoutMs: number, emit: (event: EventPayload) => void) { this.max = max; this.timeoutMs = timeoutMs; this.emit = emit; }
  readonly request: CanUseTool = (tool, input, { signal }) => {
    if (this.sealed || signal.aborted) { return Promise.resolve({ behavior: 'deny', message: 'Interaction unavailable' }); }
    if (this.pending.size >= this.max) {
      this.emit({ kind: 'diagnostic', code: 'backpressure' });
      return Promise.resolve({ behavior: 'deny', message: 'Interaction capacity unavailable' });
    }
    input = structuredClone(input);
    const ref = randomUUID(); const kind = tool === 'AskUserQuestion' ? 'question' : 'permission';
    return new Promise<PermissionResult>((resolve) => {
      const abort = () => finish({ behavior: 'deny', message: 'Interaction expired' });
      const timer = setTimeout(abort, this.timeoutMs);
      const finish = (result: PermissionResult) => {
        if (!this.pending.delete(ref)) {return;}
        clearTimeout(timer); signal.removeEventListener('abort', abort); resolve(result);
      };
      this.pending.set(ref, { kind, input, finish }); signal.addEventListener('abort', abort, { once: true });
      this.emit({ kind: 'interaction', interactionRef: ref, request: kind === 'question' ? { kind, questions: input.questions } : { kind, tool, input } });
    });
  };
  reply(ref: string, reply: InteractionReply): Reply<void> {
    if (this.sealed) {return fail('unavailable');}
    const pending = this.pending.get(ref);
    if (!pending) {return fail('stale');}
    if (reply.kind !== pending.kind) {return fail('unsupported');}
    const updatedInput = reply.kind === 'question' ? { ...pending.input, answers: reply.answers } : pending.input;
    pending.finish(reply.kind === 'permission' && reply.decision === 'deny' ? { behavior: 'deny', message: 'Denied by authority' } : { behavior: 'allow', updatedInput });
    return { ok: true, value: undefined };
  }
  cancel(): void { for (const p of this.pending.values()) {p.finish({ behavior: 'deny', message: 'Interaction cancelled' });} }
  close(): void { this.sealed = true; this.cancel(); }
}
