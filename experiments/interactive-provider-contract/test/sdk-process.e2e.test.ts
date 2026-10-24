/** Real SDK/CLI + synthetic localhost model/MCP. Not real-provider qualification. */
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { openClaudeSession } from '../src/claude/index.ts';
import type { ClaudeConfig } from '../src/claude/index.ts';
import type { Event, Session } from '../src/draft-contracts/index.ts';
import { startLocalModelFixture } from '../harness/local-anthropic-fixture.ts';

async function deadline<T>(promise: Promise<T>, ms = 25_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('SDK fixture deadline')), ms); })]); }
  finally { clearTimeout(timer); }
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') {return false;} throw error; }
}

function custody(pidPath: string): { port: ClaudeConfig['custody']; forceCleanup: () => Promise<void>; diagnostics: () => string } {
  const children: ChildProcessWithoutNullStreams[] = [];
  let stderr = '';
  async function stopped(): Promise<boolean> {
    if (children.some((child) => child.exitCode === null && child.signalCode === null)) {return false;}
    try { const pid = Number((await readFile(pidPath, 'utf8')).trim()); return Number.isSafeInteger(pid) && pid > 0 && !alive(pid); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') {return true;} throw error; }
  }
  async function confirmStopped(): Promise<boolean> {
    const until = Date.now() + 3_000;
    while (Date.now() < until) { if (await stopped()) {return true;} await new Promise<void>((resolve) => { setTimeout(resolve, 25); }); }
    return stopped();
  }
  return {
    port: {
      launch: (options) => {
        const child = spawn(options.command, options.args, { cwd: options.cwd, env: options.env, stdio: ['pipe', 'pipe', 'pipe'], detached: true, signal: options.signal });
        child.stderr.on('data', (data: Buffer) => { stderr = (stderr + data.toString('utf8')).slice(-3000); });
        children.push(child);
        return child;
      },
      confirmStopped,
    },
    forceCleanup: async () => {
      // Only process groups created by this fixture; never discover or kill user hosts.
      for (const child of children) {
        if (!child.pid) {continue;}
        let ownedGroupIsLive = child.exitCode === null && child.signalCode === null;
        if (!ownedGroupIsLive) {
          try {
            const pid = Number((await readFile(pidPath, 'utf8')).trim());
            if (Number.isSafeInteger(pid) && pid > 0 && alive(pid)) {
              const observation = execFileSync('ps', ['-o', 'pgid=,command=', '-p', String(pid)], { encoding: 'utf8', timeout: 1000 });
              ownedGroupIsLive = Number(observation.trim().split(/\s+/)[0]) === child.pid && observation.includes(pidPath);
            }
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {throw error;}
          }
        }
        if (ownedGroupIsLive) {
          try { process.kill(-child.pid, 'SIGKILL'); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {throw error;} }
        }
      }
      if (!await confirmStopped()) {throw new Error(`fixture cleanup unconfirmed: ${pidPath}`);}
    },
    diagnostics: () => stderr,
  };
}

async function turn(session: Session, iterator: AsyncIterator<Event>, marker: string, operation: string): Promise<Event[]> {
  const sent = await deadline(session.submit({ inputId: `input-${operation}`, operationRef: operation, content: `SDK_FIXTURE_${marker}` }));
  assert.equal(sent.ok, true, `handoff ${operation}`);
  return collectTurn(iterator, operation);
}

async function collectTurn(iterator: AsyncIterator<Event>, operation: string): Promise<Event[]> {
  const events: Event[] = [];
  for (;;) {
    const next = await deadline(iterator.next());
    assert.equal(next.done, false, `event feed ended before ${operation} result`);
    const event = next.value;
    assert.ok(event);
    events.push(event);
    if (event.kind === 'result' && event.operationRef === operation) {
      assert.equal(event.outcome, 'succeeded', JSON.stringify(event));
      return events;
    }
    if (events.length > 300) {throw new Error('SDK fixture event limit');}
  }
}

async function containsSession(directory: string, nativeSession: string, depth = 0): Promise<boolean> {
  if (depth > 5) { return false; }
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isFile() && entry.name === `${nativeSession}.jsonl`) { return true; }
    if (entry.isDirectory() && await containsSession(join(directory, entry.name), nativeSession, depth + 1)) { return true; }
  }
  return false;
}

async function permission(iterator: AsyncIterator<Event>): Promise<{ ref: string; events: Event[] }> {
  const events: Event[] = [];
  for (let count = 0; count < 100; count += 1) {
    const next = await deadline(iterator.next());
    assert.equal(next.done, false);
    assert.ok(next.value);
    events.push(next.value);
    if (next.value.kind === 'interaction') {
      assert.equal(next.value.request.kind, 'permission');
      return { ref: next.value.interactionRef, events };
    }
  }
  throw new Error('real canUseTool callback did not reach the interaction API');
}

test('official SDK process: isolated multi-turn/MCP, queued permission reply, interrupt and explicit resume', { timeout: 120_000, skip: process.platform === 'win32' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'TEST-interactive-sdk-process-'));
  const workspace = join(root, 'workspace'); const home = join(root, 'home'); const configDir = join(root, 'config');
  await Promise.all([workspace, home, configDir].map((path) => mkdir(path, { mode: 0o700 })));
  const model = await startLocalModelFixture();
  const mcpSource = fileURLToPath(new URL('../harness/local-anthropic-fixture.ts', import.meta.url));
  const owners = [custody(join(root, 'a.pid')), custody(join(root, 'b.pid'))];
  const readiness: unknown[] = [];
  const sessions: Session[] = [];
  const configs: ClaudeConfig[] = [];
  let failure: unknown;
  const cleanupFailures: unknown[] = [];
  const environment = {
    HOME: home, CLAUDE_CONFIG_DIR: configDir, TMPDIR: root,
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
    ANTHROPIC_API_KEY: 'TEST-LOCALHOST-ONLY-NOT-A-REAL-KEY', ANTHROPIC_BASE_URL: model.url,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
    DISABLE_AUTOUPDATER: '1', DISABLE_ERROR_REPORTING: '1', DISABLE_TELEMETRY: '1',
    NO_COLOR: '1', TERM: 'dumb',
  };
  try {
    for (const [index, owner] of owners.entries()) {
      assert.ok(owner);
      const tag = index === 0 ? 'a' : 'b';
      const config: ClaudeConfig = {
        sessionRef: `session-${tag}`, trustedBinding: `member-${tag}`, cwd: workspace,
        model: 'claude-sonnet-4-6', accountBinding: 'localhost-test-only', configRevision: 'fixture-1',
        environment, nativeTools: [], autoAllowedTools: index === 0 ? ['mcp__fixture__ping'] : [],
        mcpServers: { fixture: { type: 'stdio', command: process.execPath, args: [mcpSource, '--mcp', join(root, `${tag}.pid`), join(root, `${tag}.calls`)], env: { HOME: home, PATH: environment.PATH } } },
        requiredTools: { fixture: ['ping'] }, probe: async () => true,
        limits: { queuedInputs: 2, inputBytes: 4096, outputBytes: 1_000_000, outputEvents: 300, pendingInteractions: 2, timeoutMs: 20_000 },
        custody: owner.port, sessionExists: (nativeSession) => containsSession(configDir, nativeSession),
      };
      configs.push(config);
      const opened = await deadline(openClaudeSession(config, undefined, {
        query: (args) => {
          const handle = query(args);
          return {
            [Symbol.asyncIterator]: () => handle[Symbol.asyncIterator](),
            interrupt: () => handle.interrupt(), close: () => handle.close(),
            mcpServerStatus: async () => {
              const statuses = await handle.mcpServerStatus();
              readiness.push(statuses.map((status) => ({ name: status.name, status: status.status, tools: status.tools?.map((tool) => tool.name) })));
              return statuses;
            },
          };
        },
        sessionExists: config.sessionExists,
      }), 35_000);
      assert.equal(opened.ok, true, `open ${tag}: ${JSON.stringify(opened)} readiness=${JSON.stringify(readiness)} ${owner.diagnostics()}`);
      if (opened.ok) {sessions.push(opened.value);}
    }
    const a = sessions[0]; const b = sessions[1];
    assert.ok(a); assert.ok(b);
    const aEvents = a.observe()[Symbol.asyncIterator](); const bEvents = b.observe()[Symbol.asyncIterator]();
    const first = await turn(a, aEvents, 'A_ONE', 'a-1');
    const second = await turn(a, aEvents, 'A_TWO', 'a-2');
    const other = await turn(b, bEvents, 'B_ONE', 'b-1');
    assert.ok(first.some((event) => event.kind === 'tool' && event.name.endsWith('__ping')));
    assert.ok(first.some((event) => event.kind === 'tool-result'));
    for (const [events, marker, operation] of [[first, 'A_ONE', 'a-1'], [second, 'A_TWO', 'a-2'], [other, 'B_ONE', 'b-1']] as const) {
      assert.ok(events.some((event) => event.kind === 'text' && event.text === `FIXTURE_DONE_${marker}` && event.operationRef === operation));
    }
    assert.ok(model.requests.some((request) => request.marker === 'A_TWO' && request.hasPriorTurn));
    assert.ok(model.requests.some((request) => request.marker === 'B_ONE' && !request.hasPriorTurn));

    // While the active tool awaits authority, queue the next prompt and reply via
    // interaction API. A prompt queue cannot block the callback that releases it.
    const permissionSend = await deadline(b.submit({ inputId: 'input-b-permission', operationRef: 'b-permission', content: 'SDK_FIXTURE_B_PERMISSION' }));
    assert.equal(permissionSend.ok, true);
    const pending = await permission(bEvents);
    const queued = b.submit({ inputId: 'input-b-after', operationRef: 'b-after', content: 'SDK_FIXTURE_B_AFTER_PERMISSION' });
    assert.equal(model.requests.some((request) => request.marker === 'B_AFTER_PERMISSION'), false);
    assert.equal((await b.respondToInteraction(pending.ref, { kind: 'permission', decision: 'allow' })).ok, true);
    const approved = [...pending.events, ...await collectTurn(bEvents, 'b-permission')];
    assert.ok(approved.some((event) => event.kind === 'text' && event.text === 'FIXTURE_DONE_B_PERMISSION'));
    assert.equal((await deadline(queued)).ok, true);
    const afterPermission = await collectTurn(bEvents, 'b-after');
    assert.ok(afterPermission.some((event) => event.kind === 'text' && event.text === 'FIXTURE_DONE_B_AFTER_PERMISSION'));
    assert.equal((await b.respondToInteraction(pending.ref, { kind: 'permission', decision: 'allow' })).ok, false, 'late duplicate reply cannot grant again');

    const cpA = a.checkpoint(); const cpB = b.checkpoint();
    assert.equal(cpA.ok, true); assert.equal(cpB.ok, true);
    if (cpA.ok && cpB.ok) {assert.notDeepEqual(cpA.value, cpB.value);}
    assert.equal((await readFile(join(root, 'a.calls'), 'utf8')).trim().split('\n').length, 1);
    const beforeCancelCalls = await readFile(join(root, 'b.calls'), 'utf8');
    assert.equal((await deadline(b.submit({ inputId: 'input-b-cancel', operationRef: 'b-cancel', content: 'SDK_FIXTURE_B_CANCEL' }))).ok, true);
    const cancelledPermission = await permission(bEvents);
    assert.equal((await deadline(b.interrupt('b-cancel'))).ok, true);
    assert.equal((await b.respondToInteraction(cancelledPermission.ref, { kind: 'permission', decision: 'allow' })).ok, false);
    assert.equal((await b.close()).cleanup, 'confirmed');
    assert.equal(await readFile(join(root, 'b.calls'), 'utf8'), beforeCancelCalls, 'interrupted pending tool never received a grant');
    const receipts = await Promise.all(sessions.map((session) => session.close()));
    assert.deepEqual(receipts.map((receipt) => receipt.cleanup), ['confirmed', 'confirmed']);
    const configA = configs[0];
    assert.ok(configA); assert.ok(cpA.ok);
    // The same test config/cwd contains A and B histories. Explicit checkpoint
    // must recover A; choosing the latest conversation would recover B instead.
    const restored = await deadline(openClaudeSession(configA, cpA.value), 35_000);
    assert.equal(restored.ok, true, `explicit restore: ${JSON.stringify(restored)}`);
    if (restored.ok) {
      sessions.push(restored.value);
      const restoredEvents = restored.value.observe()[Symbol.asyncIterator]();
      const resumed = await turn(restored.value, restoredEvents, 'A_THREE', 'a-3');
      assert.ok(resumed.some((event) => event.kind === 'text' && event.text === 'FIXTURE_DONE_A_THREE'));
      assert.ok(model.requests.some((request) => request.marker === 'A_THREE' && request.hasPriorTurn));
      assert.deepEqual(restored.value.checkpoint(), cpA);
      assert.equal((await restored.value.close()).cleanup, 'confirmed');
    }
  } catch (error) {
    // Only isolated fixture data; no inherited credentials or user project content.
    failure = new Error(`${error instanceof Error ? error.message : 'SDK fixture failed'}; subprocess: ${owners.map((owner) => owner.diagnostics()).join('\n')}`, { cause: error });
  } finally {
    const closures = await Promise.allSettled(sessions.map((session) => session.close()));
    const cleanups = await Promise.allSettled(owners.map((owner) => owner.forceCleanup()));
    const endpoint = await Promise.allSettled([model.close()]);
    for (const result of [...closures, ...cleanups, ...endpoint]) {
      if (result.status === 'rejected') { cleanupFailures.push(result.reason); }
    }
    if (!cleanupFailures.length) { await rm(root, { recursive: true, force: true }); }
  }
  if (cleanupFailures.length) { throw new AggregateError([...(failure === undefined ? [] : [failure]), ...cleanupFailures], `fixture cleanup failed; retained ${root}`); }
  if (failure !== undefined) { throw failure; }
});
