// Private auth-only IPC. The test harness alone supplies an invented child.
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { timingSafeEqual, randomUUID } from 'node:crypto';
import { openSync, writeSync, fsyncSync, closeSync } from 'node:fs';
// Fixed owned artifact, never the auth home. No PID, token, account, path or raw error.
const attemptLedger = new URL('./helper-attempts.jsonl', import.meta.url);
export interface HelperObservation {
  readonly attemptRef: string;
  snapshot(): Readonly<{exitObserved: boolean; closeObserved: boolean; recordPersisted: boolean}>;
  readonly settled: Promise<void>;
}
const outstanding = new Map<string, HelperObservation>();
export const pendingHelperObservations = () => Object.freeze([...outstanding.values()]);
export class HelperCleanupIndeterminate extends Error {
  readonly code = 'HELPER_CLEANUP_INDETERMINATE';
  readonly observation: HelperObservation;
  constructor(observation: HelperObservation) {super('HELPER_CLEANUP_INDETERMINATE'); this.observation = observation;}
}

import { decodeCodexResponseEnvelope } from '@agent-teams/agent-execution/dist/features/contained-agent-turn/adapters/outbound/codex-app-server/codex-app-server-jsonl.js';
const refusal = () => new Error('PRIVATE_AUTH_REFUSED');
const record = (x: unknown): Record<string, unknown> => {
  if (!x || typeof x !== 'object' || Array.isArray(x)) {throw refusal();}
  return x as Record<string, unknown>;
};
// Reject duplicate decoded keys (including escaped spellings), before JSON.parse.
function parse(bytes: Buffer) {
  const source = new TextDecoder('utf-8', {fatal: true}).decode(bytes);
  const stack: Array<Set<string> | null> = [];
  const strings = /"(?:[^"\\]|\\.)*"|[{}[\]]/gs;
  for (const match of source.matchAll(strings)) {
    const s = match[0];
    if (s === '{') {stack.push(new Set());}
    else if (s === '[') {stack.push(null);}
    else if (s === '}' || s === ']') {stack.pop();}
    else if (/^\s*:/.test(source.slice(match.index! + s.length))) {
      const key: string = JSON.parse(s); const keys = stack.at(-1);
      if (!keys || keys.has(key)) {throw refusal();} keys.add(key);
    }
    if (stack.length > 32) {throw refusal();}
  }
  return record(JSON.parse(source));
}
// oxlint-disable-next-line complexity -- the auth RPC handshake, frame parsing and bounded-cleanup handling are one deadline-fenced critical section; splitting it would separate state the fencing must see atomically
export async function capturePrivate(child: ChildProcessWithoutNullStreams, signal: AbortSignal, deadline: number) {
  let pending: {id: string; resolve(x: Record<string, unknown>): void; reject(e: Error): void} | undefined;
  let failed = false, exited = false, closed = false, total = 0, used = 0, id = 0;
  const frame = Buffer.alloc(65536); const secrets: Buffer[] = [];
  let returning: {token: Buffer; accountId: Buffer} | undefined;
  let finish!: () => void;
  let interrupt!: () => void;
  const failure = new Promise<void>(resolve => {interrupt = resolve;});
  const closure = new Promise<void>(resolve => {finish = resolve;});
  const attemptRef = randomUUID(); let recordPersisted = true;
  const observation: HelperObservation = Object.freeze({attemptRef,
    snapshot: () => Object.freeze({exitObserved: exited, closeObserved: closed, recordPersisted}), settled: closure});
  outstanding.set(attemptRef, observation);
  const persist = (outcome: string) => {
    let fd: number | undefined;
    try {
      fd = openSync(attemptLedger, 'a', 0o600);
      const bytes = Buffer.from(JSON.stringify({attemptRef, outcome, exitObserved: exited, closeObserved: closed}) + '\n');
      let offset = 0;
      while (offset < bytes.length) {
        const written = writeSync(fd, bytes, offset, bytes.length - offset);
        if (!Number.isInteger(written) || written <= 0 || written > bytes.length - offset) {throw refusal();}
        offset += written;
      }
      fsyncSync(fd);
    } catch {recordPersisted = false;}
    finally {if (fd !== undefined) {try {closeSync(fd);} catch {recordPersisted = false;}}}
  };
  const observe = () => {
    persist(exited && closed ? 'helper-termination-observed' : 'helper-observation-pending');
    if (exited && closed) {outstanding.delete(attemptRef); finish();}
  };
  persist('helper-attempt-started');
  const kill = () => {try {child.kill('SIGKILL');} catch {/* uncertain closure: no material */}};
  const fail = () => {failed = true; interrupt(); pending?.reject(refusal()); pending = undefined; kill();};
  child.once('exit', (code, exitSignal) => {exited = true; if (pending || code !== 0 || exitSignal) {fail();} observe();});
  child.once('close', () => {closed = true; if (pending) {fail();} observe();});
  child.on('error', fail); child.stdin.on('error', fail); child.stdout.on('error', fail); child.stderr.on('error', fail);
  child.stderr.on('data', (chunk: Buffer) => {total += chunk.length; chunk.fill(0); if (total > 262144) {fail();}});
  child.stdout.on('data', (chunk: Buffer) => {
    try {
      total += chunk.length; if (total > 262144 || failed) {throw refusal();}
      for (const byte of chunk) {
        if (byte !== 10) {if (used === frame.length) {throw refusal();} frame[used++] = byte; continue;}
        if (!pending) {throw refusal();}
        const message = parse(frame.subarray(0, used)); frame.fill(0, 0, used); used = 0;
        const envelope = decodeCodexResponseEnvelope(message);
        if (envelope.id !== pending.id || 'error' in message || !('result' in message)) {throw refusal();}
        const current = pending; pending = undefined; current.resolve(record(message.result));
      }
    } catch {fail();} finally {chunk.fill(0);}
  });
  signal.addEventListener('abort', fail, {once: true});
  const timer = setTimeout(fail, Math.max(1, deadline - performance.now()));
  const check = () => {if (!recordPersisted || failed || signal.aborted || performance.now() >= deadline || closed) {throw refusal();}};
  const rpc = (method: 'initialize' | 'account/read' | 'getAuthStatus' | 'account/rateLimits/read', params: object) => {
    check(); if (pending) {throw refusal();}
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      pending = {id: String(++id), resolve, reject}; child.stdin.write(JSON.stringify({id: String(id), method, params}) + '\n');
    });
  };
  const token = (value: Record<string, unknown>) => {
    if (value.authMethod !== 'chatgpt' || value.requiresOpenaiAuth !== true ||
        typeof value.authToken !== 'string' || !/^[\x21-\x7e]{1,16384}$/.test(value.authToken)) {throw refusal();}
    const bytes = Buffer.alloc(Buffer.byteLength(value.authToken)); bytes.write(value.authToken); secrets.push(bytes); value.authToken = null; return bytes;
  };
  const mode = (value: Record<string, unknown>) => {
    if (value.requiresOpenaiAuth !== true || record(value.account).type !== 'chatgpt') {throw refusal();}
    return JSON.stringify(value.account);
  };
  try {
    check(); await rpc('initialize', {clientInfo: {name: 'private-pa-auth', version: '1'}, capabilities: {experimentalApi: true}});
    child.stdin.write('{"method":"initialized"}\n');
    const before = mode(await rpc('account/read', {refreshToken: false}));
    const a = token(await rpc('getAuthStatus', {includeToken: true, refreshToken: false}));
    const limits = await rpc('account/rateLimits/read', {});
    if (typeof limits.accountId !== 'string' || !/^[\x21-\x7e]{1,512}$/.test(limits.accountId)) {throw refusal();}
    const accountId = Buffer.alloc(Buffer.byteLength(limits.accountId)); accountId.write(limits.accountId); secrets.push(accountId); limits.accountId = null;
    const b = token(await rpc('getAuthStatus', {includeToken: true, refreshToken: false}));
    if (a.length !== b.length || !timingSafeEqual(a, b) || before !== mode(await rpc('account/read', {refreshToken: false}))) {throw refusal();}
    check(); child.stdin.end();
    // No material may escape until OS exit AND stdio close are observed.
    await Promise.race([closure, failure]);
    if (!recordPersisted || !exited || failed || used || signal.aborted || performance.now() >= deadline) {throw refusal();}
    b.fill(0); returning = {token: a, accountId}; return returning;
  } catch {throw refusal();}
  finally {
    clearTimeout(timer); signal.removeEventListener('abort', fail);
    if (!closed || !exited) {
      kill(); let grace: ReturnType<typeof setTimeout> | undefined;
      try {await Promise.race([closure, new Promise<void>(resolve => {grace = setTimeout(resolve, 1000);})]);}
      finally {clearTimeout(grace);}
    }
    frame.fill(0); if (!returning) {for (const secret of secrets) {secret.fill(0);}}
    child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
    if (!exited || !closed) {
      persist('helper-cleanup-indeterminate');
      for (const secret of secrets) {secret.fill(0);}
      // Exit/close listeners and the owner observation remain after the bounded return.
      // oxlint-disable-next-line no-unsafe-finally -- intentional: unconfirmed helper exit/close must supersede whatever the try/catch produced, per the documented cleanup-indeterminate contract (exit code 2 takes precedence)
      throw new HelperCleanupIndeterminate(observation);
    }
    persist('helper-cleanup-observed');
    if (!recordPersisted || (returning && (failed || signal.aborted || performance.now() >= deadline))) {
      for (const secret of secrets) {secret.fill(0);}
      // oxlint-disable-next-line no-unsafe-finally -- intentional: a failed cleanup ledger write or a lifetime fence that fired during cleanup must supersede whatever the try/catch produced
      throw refusal();
    }
    secrets.length = 0;
  }
}
