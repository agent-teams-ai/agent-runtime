import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openClaudeSession } from '../src/claude/index.ts';
import { config, FakeQuery, input, observe, opened, tick } from './support.ts';

test('required MCP/tool discovery and read-only probe fail closed without input or native fallback', async () => {
  for (const failure of ['server', 'tool', 'probe', 'timeout']) {
    const fake = new FakeQuery(); const c = config(); c.limits.timeoutMs = 30;
    if (failure === 'server') {fake.statuses = [];}
    if (failure === 'tool') {fake.statuses[0]!.tools = [];}
    if (failure === 'probe') {c.probe = () => Promise.resolve(false);}
    if (failure === 'timeout') {c.probe = () => new Promise(() => {});}
    assert.deepEqual(await openClaudeSession(c, undefined, fake.boundary), { ok: false, code: 'dependency-unavailable' });
    assert.equal(fake.inputs.length, 0); assert.equal(fake.closed, 1);
  }
});

test('MCP loss blocks handoff; explicit fresh confirmation permits runtime resubmission', async () => {
  const { session, fake } = await opened(); observe(session);
  await session.submit(input()); await tick(); const next = session.submit(input(2)); fake.statuses = []; fake.result();
  assert.deepEqual(await next, { ok: false, code: 'dependency-unavailable' }); assert.equal(fake.inputs.length, 1); await tick();
  fake.statuses = new FakeQuery().statuses; assert((await session.checkReadiness()).ok);
  assert((await session.submit(input(2))).ok); await tick(); assert.equal(fake.inputs.length, 2); await session.close();
});

test('unknown result/control stays unknown and background frames do not borrow active operation', async () => {
  for (const type of ['result', 'control_response']) {
    const { session, fake } = await opened(); const events = observe(session); await session.submit(input()); await tick();
    fake.emit({ type: 'system', subtype: 'notification', text: 'background' });
    fake.emit({ type, subtype: 'new-unknown-outcome', user_message_uuid: fake.inputs[0]?.uuid }); await tick();
    assert(events.some((e) => e.kind === 'diagnostic' && e.operationRef === undefined));
    assert.equal(events.filter((e) => e.kind === 'result' && e.operationRef === 'operation-1').length, 1);
    assert(events.some((e) => e.kind === 'result' && e.outcome === 'unknown'));
    assert.equal((await session.submit(input(2))).ok, false); await session.close();
  }
});

test('output overflow delivers a reserved typed failure to slow observer and closes only owned query', async () => {
  const c = config(); c.limits.outputEvents = 3; const { session, fake } = await opened(new FakeQuery(), c);
  await session.submit(input()); await tick();
  for (let n = 0; n < 10; n += 1) {fake.emit({ type: 'system', subtype: 'notification' });}
  await tick(); const events = observe(session); await tick();
  assert(events.some((e) => (e.kind === 'result' || e.kind === 'diagnostic') && e.code === 'output-limit'));
  assert.equal((await session.submit(input(2))).ok, false); assert(fake.closed > 0); await session.close();
});

test('oversized text normalizer preserves typed output-limit and releases callback', async () => {
  const c = config(); c.limits.outputBytes = 800; const { session, fake } = await opened(new FakeQuery(), c); const events = observe(session);
  await session.submit(input()); await tick();
  fake.emit({ type: 'stream_event', parent_tool_use_id: null, user_message_uuid: fake.inputs[0]?.uuid, event: { type: 'message_start', message: { id: 'm-1' } } });
  fake.emit({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'x'.repeat(801) } } }); await tick();
  assert(events.some((e) => e.kind === 'result' && e.code === 'output-limit')); await session.close();
});

test('parent and child interleaving and per-block repeated wrappers preserve block identity', async () => {
  const { session, fake } = await opened(); const events = observe(session); await session.submit(input()); await tick();
  const parent = { type: 'stream_event', parent_tool_use_id: null, user_message_uuid: fake.inputs[0]?.uuid, event: { type: 'message_start', message: { id: 'parent' } } };
  fake.emit(parent); fake.emit({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'one' } } });
  fake.emit({ type: 'stream_event', parent_tool_use_id: 'child-tool', event: { type: 'message_start', message: { id: 'child' } } });
  fake.emit({ type: 'stream_event', parent_tool_use_id: 'child-tool', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'child' } } });
  fake.emit({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ' two' } } });
  const firstComplete = { type: 'assistant', uuid: 'wrapper-1', message: { id: 'parent', content: [{ type: 'text', text: 'one two' }] } };
  fake.emit(firstComplete); fake.emit(firstComplete);
  fake.emit({ type: 'assistant', uuid: 'wrapper-2', message: { id: 'parent', content: [{ type: 'text', text: 'one two' }] } });
  fake.result(); await tick();
  const parentText = events.filter((e) => e.kind === 'text').filter((e) => e.messageRef === 'parent');
  assert.deepEqual(parentText.map((e) => [e.block, e.text]), [[0, 'one'], [0, 'one two'], [0, 'one two'], [1, 'one two']]);
  const child = events.find((e) => e.kind === 'text' && e.messageRef === 'child'); assert(child); assert.equal(child.operationRef, undefined); await session.close();
});

test('config isolation, stable input identity and SDK callback permission mode are enforced', async () => {
  const c = config(); c.environment.CLAUDE_TEAM_NAME = 'untrusted-ambient-binding'; const bad = new FakeQuery();
  assert.deepEqual(await openClaudeSession(c, undefined, bad.boundary), { ok: false, code: 'invalid-config' }); assert.equal(bad.options, undefined);
  const { session, fake } = await opened(); observe(session); await session.submit(input()); await tick();
  assert.deepEqual(await session.submit({ ...input(), operationRef: 'other-operation' }), { ok: false, code: 'stale' });
  assert.equal(fake.options.permissionMode, 'default'); assert.deepEqual(fake.options.settingSources, []); assert.equal(fake.options.strictMcpConfig, true); assert.equal(fake.options.continue, undefined);
  fake.emit({ type: 'system', subtype: 'init', permissionMode: 'dontAsk' }); await tick();
  assert.deepEqual(await session.submit(input(2)), { ok: false, code: 'unsupported' }); await session.close();
});

test('initial MCP pending is observed until connected within deadline; pending init does not close session', async () => {
  const fake = new FakeQuery(); const statuses = fake.statuses; let observations = 0;
  fake.mcpServerStatus = async () => {
    observations += 1;
    return observations < 3 ? [{ name: 'fixture', status: 'pending', tools: [] }] : statuses;
  };
  fake.emit({ type: 'system', subtype: 'init', permissionMode: 'default', mcp_servers: [{ name: 'fixture', status: 'pending' }] });
  const result = await openClaudeSession(config(), undefined, fake.boundary); assert(result.ok); assert(observations >= 3);
  assert.equal(fake.closed, 0); await result.value.close();
});

test('unknown interrupt completion never releases queued B and late control response cannot reopen it', async () => {
  const c = config(); c.limits.timeoutMs = 30; const { session, fake } = await opened(new FakeQuery(), c); const events = observe(session);
  let finish!: () => void; fake.interruptResult = () => new Promise<void>((resolve) => { finish = resolve; });
  await session.submit(input()); await tick(); const second = session.submit(input(2));
  const interrupted = session.interrupt('operation-1'); fake.result();
  assert.deepEqual(await interrupted, { ok: false, code: 'unknown' }); assert.equal((await second).ok, false);
  finish(); await tick(); assert.equal(fake.inputs.length, 1); assert.equal((await session.submit(input(3))).ok, false);
  assert.equal(events.filter((event) => event.kind === 'result' && event.operationRef === 'operation-1').length, 1); await session.close();
});

test('SDK import/start failure is typed and never leaks raw exception details', async () => {
  const fake = new FakeQuery(); fake.boundary.query = () => { throw new Error('TEST-SECRET-auth-binary-detail'); };
  const result = await openClaudeSession(config(), undefined, fake.boundary);
  assert.deepEqual(result, { ok: false, code: 'provider-failure' }); assert(!JSON.stringify(result).includes('TEST-SECRET'));
});

test('callback expiry releases waiter; a normal prompt and late reply cannot answer it', async () => {
  const c = config(); c.limits.timeoutMs = 30; const { session, fake } = await opened(new FakeQuery(), c); const events = observe(session);
  await session.submit(input()); await tick();
  const callback = fake.options.canUseTool?.('AskUserQuestion', { questions: [{ question: 'Choice?' }] }, { signal: new AbortController().signal, requestId: 'expires-1', toolUseID: 'expires-tool' });
  await tick(); const interaction = events.find((event) => event.kind === 'interaction'); assert(interaction?.kind === 'interaction');
  const second = session.submit(input(2)); assert.equal((await callback)?.behavior, 'deny');
  assert.deepEqual(session.respondToInteraction(interaction.interactionRef, { kind: 'question', answers: { 'Choice?': 'late' } }), { ok: false, code: 'stale' });
  assert.equal(fake.inputs.length, 1); await session.close(); assert.equal((await second).ok, false);
});

test('caller mutation after open cannot change pinned options or session limits', async () => {
  const c = config(); const { session, fake } = await opened(new FakeQuery(), c);
  c.environment.HOME = '/changed'; c.nativeTools.push('Bash'); c.limits.inputBytes = 1;
  assert.equal(fake.options.env?.HOME, '/TEST-disposable/home'); assert.deepEqual(fake.options.tools, ['Read', 'AskUserQuestion']);
  assert((await session.submit(input())).ok); await session.close();
});

test('explicit mid-turn MCP recheck pauses handoff and preserves unknown outcome without replay', async () => {
  const c = config(); c.limits.timeoutMs = 30; const { session, fake } = await opened(new FakeQuery(), c); const events = observe(session);
  await session.submit(input()); await tick(); const next = session.submit(input(2)); fake.statuses = [];
  assert.deepEqual(await session.checkReadiness(), { ok: false, code: 'dependency-unavailable' });
  assert.equal((await next).ok, false); assert.equal(fake.inputs.length, 1);
  assert(events.some((event) => event.kind === 'result' && event.operationRef === 'operation-1' && event.outcome === 'unknown'));
  fake.statuses = new FakeQuery().statuses; assert.deepEqual(await session.checkReadiness(), { ok: false, code: 'unknown' });
  assert.equal(fake.inputs.length, 1); assert.equal((await session.submit(input(3))).ok, false); await session.close();
});

test('output overflow while publishing a known SDK result preserves that turn outcome', async () => {
  const c = config(); c.limits.outputEvents = 1; const { session, fake } = await opened(new FakeQuery(), c);
  await session.submit(input()); await tick();
  fake.emit({ type: 'system', subtype: 'notification' }); fake.result(); await tick();
  const events = observe(session); await tick();
  const terminal = events.find((event) => event.kind === 'result'); assert(terminal?.kind === 'result');
  assert.equal(terminal.outcome, 'succeeded'); assert.equal(terminal.code, 'output-limit'); await session.close();
});

const assistantFrame = (id: string, content: unknown[], extra = {}) => ({ type: 'assistant', parent_tool_use_id: null, message: { id, content }, ...extra });
const toolBlock = (id: string) => ({ type: 'tool_use', id, name: 'mcp__fixture__fixture_task', input: {} });
const toolResultFrame = (id: string) => ({ type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } });

test('one foreground echo binds later tool rounds while explicit background and conflicting echoes stay unbound', async () => {
  const { session, fake } = await opened(); const events = observe(session); await session.submit(input()); await tick();
  fake.emit({ type: 'stream_event', parent_tool_use_id: null, user_message_uuid: fake.inputs[0]?.uuid, event: { type: 'message_start', message: { id: 'round-1' } } });
  fake.emit(assistantFrame('round-1', [toolBlock('tool-1')], { user_message_uuid: fake.inputs[0]?.uuid })); fake.emit(toolResultFrame('tool-1'));
  fake.emit(assistantFrame('child', [{ type: 'text', text: 'background child' }], { parent_tool_use_id: 'child-tool' }));
  fake.emit(assistantFrame('conflict', [{ type: 'text', text: 'conflicting echo' }], { user_message_uuid: 'other-native-input' }));
  fake.emit(assistantFrame('unknown-origin', [{ type: 'text', text: 'unknown origin' }], { parent_tool_use_id: undefined }));
  fake.emit({ type: 'stream_event', parent_tool_use_id: null, user_message_uuid: 'other-native-input', event: { type: 'message_start', message: { id: 'conflicting-stream' } } });
  fake.emit({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'conflicting delta' } } });
  fake.emit(assistantFrame('round-2', [{ type: 'text', text: 'second round' }, toolBlock('tool-2')])); fake.emit(toolResultFrame('tool-2'));
  fake.emit({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_start', message: { id: 'round-3' } } });
  fake.emit({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'final round' } } });
  fake.emit(assistantFrame('round-3', [{ type: 'text', text: 'final round' }])); fake.result(); await tick();
  const foreground = events.filter((event) => (event.kind === 'text' && ['round-2', 'round-3'].includes(event.messageRef)) || (event.kind === 'tool' && event.toolRef === 'tool-2') || (event.kind === 'tool-result' && event.toolRef === 'tool-2'));
  assert(foreground.length >= 5); assert(foreground.every((event) => event.operationRef === 'operation-1'));
  const background = events.filter((event) => event.kind === 'text' && ['child', 'conflict', 'unknown-origin', 'conflicting-stream'].includes(event.messageRef));
  assert.equal(background.length, 4); assert(background.every((event) => event.operationRef === undefined)); await session.close();
});
