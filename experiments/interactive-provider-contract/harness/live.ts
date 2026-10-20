/** Opt-in, caller-provided API-key route. Nothing reads the user's normal Claude state. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, readFile, realpath, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openClaudeSession } from '../src/claude/index.ts';
import type { ClaudeConfig } from '../src/claude/index.ts';
import type { Event, Session } from '../src/draft-contracts/index.ts';
import { startFixtureHost } from './fixture-host.ts';

type Manifest = { root: string; model: string; environment: Record<string, string> };
export async function readLiveManifest(path: string): Promise<Manifest> {
  assert(isAbsolute(path), 'explicit absolute TEST manifest required');
  const stat = await lstat(path); assert(stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o077) === 0, 'TEST manifest must be a private regular file');
  assert(stat.size <= 65536, 'manifest size limit');
  const value: unknown = JSON.parse(await readFile(path, 'utf8'));
  assert(value && typeof value === 'object');
  const v = value as Record<string, unknown>; assert(typeof v.root === 'string' && typeof v.model === 'string');
  const root = await realpath(v.root); assert(/TEST/i.test(basename(root)), 'disposable root name must contain TEST');
  assert(!relative(root, await realpath(path)).startsWith('..'), 'manifest must be inside TEST root');
  assert(v.environment && typeof v.environment === 'object'); const environment = v.environment as Record<string, string>;
  const allowed = new Set(['HOME', 'CLAUDE_CONFIG_DIR', 'PATH', 'ANTHROPIC_API_KEY', 'TMPDIR']);
  assert(Object.entries(environment).every(([key, val]) => allowed.has(key) && typeof val === 'string'), 'explicit environment allowlist');
  assert(environment.ANTHROPIC_API_KEY && environment.PATH, 'caller-provided API key route and PATH required');
  for (const key of ['HOME', 'CLAUDE_CONFIG_DIR', 'TMPDIR']) {
    const statePath = environment[key]; assert(statePath && isAbsolute(statePath));
    const canonical = await realpath(statePath); assert(canonical !== root && !relative(root, canonical).startsWith('..'), 'state must be inside TEST root');
    environment[key] = canonical;
  }
  return { root, model: v.model, environment: { ...environment } };
}
function custody() {
  const children: ChildProcessWithoutNullStreams[] = [];
  return {
    launch: (options: Parameters<ClaudeConfig['custody']['launch']>[0]) => {
      const child = spawn(options.command, options.args, { cwd: options.cwd, env: options.env, stdio: ['pipe', 'pipe', 'pipe'] });
      child.on('error', () => {}); children.push(child); return child;
    },
    confirmStopped: async () => {
      for (const child of children) {
        if (child.exitCode !== null || child.signalCode !== null) {continue;}
        await Promise.race([new Promise<void>((resolve) => { child.once('exit', () => { resolve(); }); }), new Promise<void>((resolve) => { setTimeout(resolve, 3000); })]);
      }
      return children.every((child) => child.exitCode !== null || child.signalCode !== null);
    },
  };
}
async function waitFor(predicate: () => boolean, timeoutMs = 60000) {
  const end = Date.now() + timeoutMs;
  while (!predicate()) { assert(Date.now() < end, 'bounded live assertion timeout'); await new Promise<void>((resolve) => { setTimeout(resolve, 20); }); }
}
export async function runLive(manifest: Manifest) {
  const host = await startFixtureHost({ 'Bearer TEST-A': 'A', 'Bearer TEST-B': 'B' });
  const sessions: Session[] = []; const events: Event[] = []; let queued: Promise<unknown> | undefined; let permissionCount = 0;
  const base = (ref: string): ClaudeConfig => ({
    sessionRef: ref, trustedBinding: `TEST:${ref}`, accountBinding: 'caller-owned-TEST-api-key', configRevision: 'TEST-v1',
    cwd: manifest.root, model: manifest.model, environment: manifest.environment, nativeTools: ['Read', 'AskUserQuestion'], autoAllowedTools: ['mcp__fixture__readiness', 'mcp__fixture__lookup'],
    mcpServers: { fixture: { type: 'http', url: `${host.url}/mcp`, headers: { Authorization: `Bearer TEST-${ref}` } } },
    requiredTools: { fixture: ['readiness', 'fixture_task', 'message_send', 'lookup'] },
    probe: async (signal) => { const response = await fetch(`${host.url}/health`, { signal }); return response.ok && (await response.json() as { revision: string }).revision === 'TEST-v1'; },
    limits: { queuedInputs: 1, inputBytes: 20000, outputBytes: 2000000, outputEvents: 10000, pendingInteractions: 8, timeoutMs: 30000 },
    sessionExists: async (id) => {
      // Explicit selected checkpoint only; no continue-latest or ambient SDK lookup.
      const projectKey = manifest.root.replace(/[^a-zA-Z0-9]/g, '-');
      try { return (await lstat(join(manifest.environment.CLAUDE_CONFIG_DIR!, 'projects', projectKey, `${id}.jsonl`))).isFile(); } catch { return false; }
    },
    custody: custody(),
  });
  const connect = async (config: ClaudeConfig, checkpoint?: unknown) => {
    const opened = await openClaudeSession(config, checkpoint); assert(opened.ok, `session open failed: ${opened.ok ? '' : opened.code}`); const session = opened.value; sessions.push(session);
    void (async () => {
      for await (const event of session.observe()) {
        events.push(event);
        if (event.kind === 'interaction') {
          if (event.request.kind === 'permission') {
            permissionCount += 1;
            if (session.sessionRef === 'A' && !queued) {queued = session.submit({ inputId: 'A-2', operationRef: 'A-2', content: 'Recall the marker from the first turn. Reply exactly TEST-MULTITURN-ALPHA.' });}
            session.respondToInteraction(event.interactionRef, { kind: 'permission', decision: 'allow' });
          } else {session.respondToInteraction(event.interactionRef, { kind: 'question', answers: {} });}
        }
      }
    })(); return session;
  };
  try {
    const aConfig = base('A'); const a = await connect(aConfig); const b = await connect(base('B'));
    assert((await a.submit({ inputId: 'A-1', operationRef: 'A-1', content: 'Remember marker TEST-MULTITURN-ALPHA. Call fixture_task with idempotencyKey TEST-task-1 and label alpha, then message_send with idempotencyKey TEST-message-1, to B and text TEST-HELLO-B. Use the fixture MCP tools. Reply briefly when done.' })).ok);
    assert((await b.submit({ inputId: 'B-1', operationRef: 'B-1', content: 'Reply exactly TEST-SESSION-B.' })).ok);
    await waitFor(() => events.some((e) => e.kind === 'result' && e.operationRef === 'A-2') && events.some((e) => e.kind === 'result' && e.operationRef === 'B-1'));
    assert(permissionCount > 0); await queued;
    assert(host.ledger.snapshot().some((e) => e.tool === 'fixture_task')); assert(host.ledger.snapshot().some((e) => e.tool === 'message_send'));
    assert(events.some((e) => e.kind === 'text' && e.operationRef === 'A-2' && e.text.includes('TEST-MULTITURN-ALPHA')));
    assert(events.some((e) => e.kind === 'tool')); assert(events.some((e) => e.kind === 'tool-result'));
    const checkpoint = a.checkpoint(); assert(checkpoint.ok); assert.equal((await a.close()).cleanup, 'confirmed');
    const restored = await connect({ ...aConfig, custody: custody() }, checkpoint.value);
    assert((await restored.submit({ inputId: 'A-3', operationRef: 'A-3', content: 'Recall the marker. Reply exactly the original TEST marker.' })).ok);
    await waitFor(() => events.some((e) => e.kind === 'result' && e.operationRef === 'A-3'));
    assert(events.some((e) => e.kind === 'text' && e.operationRef === 'A-3' && e.text.includes('TEST-MULTITURN-ALPHA')));
    assert((await restored.submit({ inputId: 'A-4', operationRef: 'A-4', content: 'Explain counting to ten thousand in detail.' })).ok);
    const interrupted = await restored.interrupt('A-4'); assert(interrupted.ok || interrupted.code === 'stale');
    const receipts = await Promise.all(sessions.map((session) => session.close())); assert(receipts.every((receipt) => receipt.cleanup === 'confirmed'));
    const evidence = { classification: 'TEST-only; real-provider SDK proof on caller-owned API-key route; no production qualification', sdk: '0.3.305', bundledCli: '2.1.305', platform: `${process.platform}-${process.arch}`, permissionCount, fixtureEffects: host.ledger.snapshot().length,
      events: events.map((e) => ({ kind: e.kind, sessionRef: e.sessionRef, operationRef: e.operationRef })), cleanup: receipts };
    await writeFile(join(manifest.root, `evidence-${randomUUID()}.json`), JSON.stringify(evidence, null, 2), { mode: 0o600 });
    return { sdk: '0.3.305', permissions: permissionCount, cleanup: 'confirmed' };
  } finally { await Promise.all(sessions.map((session) => session.close())); await host.close(); }
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try { const manifest = await readLiveManifest(process.env.TEST_CLAUDE_INPUT ?? ''); console.log(await runLive(manifest)); }
  catch { console.error('TEST harness failed; no auth/config fallback was attempted'); process.exitCode = 1; }
}
