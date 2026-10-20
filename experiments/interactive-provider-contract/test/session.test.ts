import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openClaudeSession } from '../src/claude/index.ts';
import type { InteractionReply } from '../src/draft-contracts/index.ts';
import { config, FakeQuery, input, latch, observe, opened, tick } from './support.ts';

test('malformed JavaScript interaction replies fail closed without consuming the pending request', async () => {
  const { session, fake } = await opened(); const events = observe(session);
  try {
    await session.submit(input()); await tick();
    for (const tool of ['Read', 'AskUserQuestion']) {
      let settled = false;
      const pending = fake.options.canUseTool?.(tool, {}, { signal: new AbortController().signal, requestId: tool, toolUseID: tool });
      void pending?.then((result) => { settled = true; return result; }); await tick();
      const interaction = events.filter((event) => event.kind === 'interaction').at(-1); assert(interaction?.kind === 'interaction');
      const invalid = [null, undefined, [], {}, 'allow', { kind: 'unknown' }, { kind: 'permission', decision: 'invalid' },
        { kind: 'permission', decision: true }, { kind: 'question', answers: null }, { kind: 'question', answers: [] },
        { kind: 'question', answers: { choice: 1 } }, { kind: 'question', answers: new Date() },
        { kind: 'question', answers: Object.create({ choice: 'inherited' }) },
        { kind: 'question', answers: { get choice() { throw new Error('must not read accessor'); } } }];
      for (const reply of invalid) { assert.deepEqual(session.respondToInteraction(interaction.interactionRef, reply as InteractionReply), { ok: false, code: 'unsupported' }); }
      await tick(); assert.equal(settled, false);
      const reply: InteractionReply = tool === 'Read' ? { kind: 'permission', decision: 'deny' } : { kind: 'question', answers: { choice: 'A' } };
      assert(session.respondToInteraction(interaction.interactionRef, reply).ok);
      const result = await pending; assert.equal(result?.behavior, tool === 'Read' ? 'deny' : 'allow');
      if (result?.behavior === 'allow') { assert.deepEqual(result.updatedInput?.answers, { choice: 'A' }); }
    }
    fake.result(); await tick();
  } finally { await session.close(); }
});

test('two isolated sessions, serial turns and real normalized text/tool/result contract', async () => {
  const { session: a, fake } = await opened(); const { session: b, fake: fb } = await opened(new FakeQuery(), config('runtime-session-B'));
  const events = observe(a); const bEvents = observe(b);
  try {
    const first = await a.submit(input()); assert(first.ok); assert.equal(first.value.providerAcceptance, 'unknown');
    await b.submit(input()); await tick(); assert.notEqual(fake.options.sessionId, fb.options.sessionId);
    fake.emit({ type: 'stream_event', parent_tool_use_id: null, user_message_uuid: fake.inputs[0]?.uuid, event: { type: 'message_start', message: { id: 'message-1' } } });
    fake.emit({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } });
    fake.emit({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hello' } } });
    fake.emit({ type: 'assistant', message: { id: 'message-1', content: [{ type: 'text', text: 'hello' }] } });
    fake.emit({ type: 'assistant', parent_tool_use_id: null, message: { id: 'message-2', content: [{ type: 'text', text: 'hello' }, { type: 'tool_use', id: 'tool-1', name: 'mcp__fixture__fixture_task', input: { idempotencyKey: 'intent-1' } }] } });
    fake.emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'committed', is_error: false }] } });
    const second = a.submit(input(2)); await tick(); assert.equal(fake.inputs.length, 1);
    fake.result(); assert((await second).ok); await tick(); fake.result(1); fb.result(); await tick();
    assert.equal(events.filter((e) => e.kind === 'result').length, 2);
    const text = events.filter((e) => e.kind === 'text'); assert.equal(text.length, 3);
    assert.equal(text[0]?.messageRef, text[1]?.messageRef); assert.equal(text[0]?.block, text[1]?.block);
    assert.notEqual(text[1]?.messageRef, text[2]?.messageRef);
    assert(events.some((e) => e.kind === 'tool' && e.operationRef === 'operation-1'));
    assert(events.some((e) => e.kind === 'tool-result' && e.operationRef === 'operation-1'));
    const usage = events.find((e) => e.kind === 'usage'); assert(usage?.kind === 'usage'); assert.equal(usage.inputTokens, undefined);
    assert(events.every((e) => e.sessionRef === a.sessionRef)); assert(bEvents.every((e) => e.sessionRef === b.sessionRef));
  } finally { assert.equal((await a.close()).cleanup, 'confirmed'); await b.close(); }
});

test('permission reply is independent of full prompt queue; question, duplicate and abort use distinct APIs', async () => {
  const { session, fake } = await opened(); const events = observe(session);
  try {
    await session.submit(input()); await tick(); const second = session.submit(input(2));
    assert.deepEqual(await session.submit(input(3)), { ok: false, code: 'backpressure' });
    const abort = new AbortController(); const pending = fake.options.canUseTool?.('Read', { path: '/TEST/file' }, { signal: abort.signal, requestId: 'request-test', toolUseID: 'permission-1' });
    await tick(); const interaction = events.find((e) => e.kind === 'interaction'); assert(interaction?.kind === 'interaction');
    assert.deepEqual(session.respondToInteraction(interaction.interactionRef, { kind: 'question', answers: {} }), { ok: false, code: 'unsupported' });
    assert(session.respondToInteraction(interaction.interactionRef, { kind: 'permission', decision: 'allow' }).ok);
    assert.equal((await pending)?.behavior, 'allow'); assert.deepEqual(session.respondToInteraction(interaction.interactionRef, { kind: 'permission', decision: 'allow' }), { ok: false, code: 'stale' });
    const question = fake.options.canUseTool?.('AskUserQuestion', { questions: [{ question: 'Choice?' }] }, { signal: abort.signal, requestId: 'request-test', toolUseID: 'question-1' });
    await tick(); const questions = events.filter((e) => e.kind === 'interaction'); const q = questions.at(-1); assert(q?.kind === 'interaction');
    assert(session.respondToInteraction(q.interactionRef, { kind: 'question', answers: { 'Choice?': 'A' } }).ok);
    const answer = await question; assert(answer?.behavior === 'allow'); assert.deepEqual(answer.updatedInput?.answers, { 'Choice?': 'A' });
    const cancelled = fake.options.canUseTool?.('Read', {}, { signal: abort.signal, requestId: 'request-test', toolUseID: 'cancel-1' }); await tick(); abort.abort(); assert.equal((await cancelled)?.behavior, 'deny');
    fake.result(); assert((await second).ok); await tick(); fake.result(1); await tick();
    assert.equal(fake.inputs.length, 2);
  } finally { await session.close(); }
});

test('delayed interrupt A fences queued B even when result A arrives first', async () => {
  const { session, fake } = await opened(); const events = observe(session); const interrupt = latch<void>(); fake.interruptResult = () => interrupt.promise;
  try {
    await session.submit(input()); await tick(); const second = session.submit(input(2)); const stop = session.interrupt('operation-1');
    fake.result(); await tick(); assert.equal(fake.inputs.length, 1);
    interrupt.resolve(); assert((await stop).ok); assert((await second).ok);
    assert.deepEqual(await session.interrupt('operation-1'), { ok: false, code: 'stale' }); assert.equal(fake.interrupts, 1); await tick();
    fake.result(1); await tick(); assert.equal(events.filter((e) => e.kind === 'result').length, 2);
  } finally { await session.close(); }
});

test('close seals submit and replies before awaiting, is idempotent and reports owner cleanup uncertainty', async () => {
  const c = config(); c.custody.confirmStopped = () => Promise.resolve(false);
  const { session, fake } = await opened(new FakeQuery(), c); const events = observe(session);
  await session.submit(input()); await tick(); const pending = fake.options.canUseTool?.('Read', {}, { signal: new AbortController().signal, requestId: 'request-test', toolUseID: 'close-1' }); await tick();
  const interaction = events.find((e) => e.kind === 'interaction'); assert(interaction?.kind === 'interaction');
  const queued = session.submit(input(2)); const close = session.close(); assert.equal(close, session.close());
  assert.deepEqual(await session.submit(input(3)), { ok: false, code: 'unknown' });
  assert.deepEqual(session.respondToInteraction(interaction.interactionRef, { kind: 'permission', decision: 'allow' }), { ok: false, code: 'unavailable' });
  assert.equal((await pending)?.behavior, 'deny'); assert.equal((await queued).ok, false);
  assert.deepEqual(await close, { logicallyClosed: true, cleanup: 'unknown' }); assert.equal(fake.closed, 1); assert.equal(fake.inputs.length, 1);
});

test('error-result followed by iterator exception produces one outcome and redacted diagnostic', async () => {
  const { session, fake } = await opened(); const events = observe(session);
  await session.submit(input()); await tick(); fake.result(0, 'error_during_execution'); fake.exception(); await tick();
  assert.equal(events.filter((e) => e.kind === 'result').length, 1); assert(events.some((e) => e.kind === 'diagnostic' && e.code === 'provider-failure'));
  assert(!JSON.stringify(events).includes('sensitive')); assert.equal((await session.submit(input(2))).ok, false); await session.close();
});

test('explicit resume selects checkpoint session; incompatible and missing checkpoints never create fresh query', async () => {
  const c = config(); const { session, fake } = await opened(new FakeQuery(), c);
  await session.submit(input()); await tick(); fake.result(); await tick(); const cp = session.checkpoint(); assert(cp.ok); await session.close();
  const restoredFake = new FakeQuery(); const restored = await openClaudeSession(c, cp.value, restoredFake.boundary); assert(restored.ok);
  assert.equal(restoredFake.options.resume, fake.options.sessionId); assert.equal(restoredFake.options.sessionId, undefined); assert.equal(restoredFake.options.continue, undefined); await restored.value.close();
  assert.deepEqual(await openClaudeSession({ ...c, accountBinding: 'other' }, cp.value, new FakeQuery().boundary), { ok: false, code: 'checkpoint-incompatible' });
  const missing = new FakeQuery(); missing.boundary.sessionExists = () => Promise.resolve(false);
  assert.deepEqual(await openClaudeSession(c, cp.value, missing.boundary), { ok: false, code: 'checkpoint-missing' }); assert.equal(missing.options, undefined);
});

test('interrupt fences new interactions and replies through ACK until A terminal, then B remains usable', async () => {
  const { session, fake } = await opened(); const events = observe(session); const ack = latch<void>(); fake.interruptResult = () => ack.promise;
  const request = (id: string) => fake.options.canUseTool?.('Read', {}, { signal: new AbortController().signal, requestId: id, toolUseID: id });
  try {
    await session.submit(input()); await tick();
    const pending = request('before-interrupt'); await tick(); const original = events.find((event) => event.kind === 'interaction'); assert(original?.kind === 'interaction');
    const second = session.submit(input(2)); const interrupted = session.interrupt('operation-1');
    assert.equal((await pending)?.behavior, 'deny');
    assert.equal(session.respondToInteraction(original.interactionRef, { kind: 'permission', decision: 'allow' }).ok, false);
    const during = request('during-interrupt'); await tick();
    assert.equal(events.filter((event) => event.kind === 'interaction').length, 1, 'cancelled A cannot publish another request');
    assert.equal((await during)?.behavior, 'deny');
    ack.resolve(); assert((await interrupted).ok);
    const afterAck = request('after-ACK-before-result'); await tick();
    assert.equal(events.filter((event) => event.kind === 'interaction').length, 1, 'ACK is not A terminal');
    assert.equal((await afterAck)?.behavior, 'deny'); assert.equal(fake.inputs.length, 1);
    fake.result(); assert((await second).ok); await tick();
    const inB = request('B-permission'); await tick(); const current = events.filter((event) => event.kind === 'interaction').at(-1); assert(current?.kind === 'interaction');
    assert.equal(current.operationRef, 'operation-2');
    assert(session.respondToInteraction(current.interactionRef, { kind: 'permission', decision: 'allow' }).ok);
    assert.equal((await inB)?.behavior, 'allow'); fake.result(1); await tick();
  } finally { await session.close(); }
});
