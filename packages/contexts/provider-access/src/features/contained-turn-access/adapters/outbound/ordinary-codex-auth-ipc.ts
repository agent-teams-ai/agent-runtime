import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { types } from 'node:util';
import { parseAuthFrame, authRecord } from './ordinary-codex-auth-json.js';
import { readOfficialAuth, type AuthMethod, type CapturedAuthBytes } from './ordinary-codex-auth-protocol.js';
import { OrdinaryCodexAuthRefused, OrdinaryCodexAuthCleanupIndeterminate, type OrdinaryCodexAuthObservation } from './ordinary-codex-auth-contracts.js';

export interface AuthHelperSession {
  readonly child: ChildProcessWithoutNullStreams;
  readonly signal: AbortSignal;
  readonly deadline: number;
  readonly home: string;
  readonly source: string;
  readonly captureRef: string;
  readonly record: (observation: OrdinaryCodexAuthObservation) => void;
}
const refusal = () => new OrdinaryCodexAuthRefused();
const pause = (milliseconds: number) => new Promise<void>(resolve => { setTimeout(resolve, Math.max(0, milliseconds)); });
function groupGone(pid: number | undefined): boolean {
  if (!pid || pid <= 1) { return false; }
  try { process.kill(-pid, 0); return false; }
  catch (error) { return error instanceof Error && 'code' in error && error.code === 'ESRCH'; }
}

/** The child must have just been spawned detached by this owner. No persisted PID is accepted. */
export async function captureAuthHelper(input: AuthHelperSession): Promise<CapturedAuthBytes> {
  const { child, signal } = input;
  const frame = Buffer.alloc(65_536);
  let used = 0, total = 0, sequence = 0, exited = false, closed = false, failed = false;
  let exitCode: number | null = null, exitSignal: NodeJS.Signals | null = null;
  let pending: { id: number; resolve(value: Record<string, unknown>): void; reject(error: Error): void } | undefined;
  let held: CapturedAuthBytes | undefined;
  const observation = (outcome: OrdinaryCodexAuthObservation['outcome']): OrdinaryCodexAuthObservation => Object.freeze({
    captureRef: input.captureRef, outcome, exitObserved: exited, closeObserved: closed, processGroupGone: groupGone(child.pid),
  });
  const persist = (outcome: OrdinaryCodexAuthObservation['outcome']) => {
    const result: unknown = input.record(observation(outcome));
    if (types.isPromise(result) && Object.getPrototypeOf(result) === Promise.prototype &&
        Object.getOwnPropertyDescriptor(result, 'constructor') === undefined) {
      Promise.prototype.then.call(result, () => {}, () => {});
    }
    if (result !== undefined) { throw refusal(); }
  };
  const fail = () => { failed = true; pending?.reject(refusal()); pending = undefined; };
  const onExit = (code: number | null, exit: NodeJS.Signals | null) => {
    exited = true; exitCode = code; exitSignal = exit;
    if (pending || code !== 0 || exit !== null) { fail(); }
  };
  const onClose = () => { closed = true; if (pending || used !== 0) { fail(); } };
  const onStderr = (chunk: Buffer) => { total += chunk.length; chunk.fill(0); if (total > 262_144) { fail(); } };
  const onStdout = (chunk: Buffer) => {
    try {
      total += chunk.length;
      if (failed || total > 262_144) { throw refusal(); }
      for (const byte of chunk) {
        if (byte !== 10) { if (used === frame.length) { throw refusal(); } frame[used++] = byte; continue; }
        if (!pending) { throw refusal(); }
        const message = parseAuthFrame(frame.subarray(0, used)); frame.fill(0, 0, used); used = 0;
        const keys = Object.keys(message);
        if (keys.length !== 2 || !keys.includes('id') || !keys.includes('result') || message.id !== pending.id) { throw refusal(); }
        const current = pending; pending = undefined; current.resolve(authRecord(message.result));
      }
    } catch { fail(); } finally { chunk.fill(0); }
  };
  child.on('exit', onExit); child.on('close', onClose); child.on('error', fail);
  child.stdin.on('error', fail); child.stdout.on('error', fail); child.stderr.on('error', fail);
  child.stdout.on('data', onStdout); child.stderr.on('data', onStderr);
  signal.addEventListener('abort', fail, { once: true });
  // Reserve the final second for TERM/KILL/closure, inside the same helper deadline.
  const rpcDeadline = input.deadline - 1000;
  const timer = setTimeout(fail, Math.max(1, rpcDeadline - performance.now()));
  const check = () => {
    if (failed || signal.aborted || closed || performance.now() >= rpcDeadline) { throw refusal(); }
  };
  const request = (method: AuthMethod, params: object): Promise<Record<string, unknown>> => {
    check(); if (pending) { throw refusal(); }
    return new Promise((resolve, reject) => {
      const id = ++sequence; pending = { id, resolve, reject };
      child.stdin.write(JSON.stringify({ id, method, params }) + '\n', error => { if (error) { fail(); } });
    });
  };
  const boundaryClosed = () => exited && closed && groupGone(child.pid);
  const awaitClosure = async (deadline: number) => {
    while (performance.now() < deadline && !boundaryClosed()) {
      await pause(Math.min(20, Math.max(0, deadline - performance.now())));
    }
  };
  const signalOwned = (killSignal: NodeJS.Signals) => {
    // No signalling after observing leader exit: a bare numeric group is insufficient new ownership proof.
    if (!exited && child.pid && child.pid > 1) {
      try { process.kill(-child.pid, killSignal); } catch { /* closure readback decides */ }
    }
  };
  let success = false, cleanupFailure = false;
  const finishSession = async () => {
    clearTimeout(timer); signal.removeEventListener('abort', fail);
    if (!exited || !closed || !groupGone(child.pid)) {
      signalOwned('SIGTERM'); await awaitClosure(Math.min(input.deadline - 500, performance.now() + 300));
      if (!exited || !closed || !groupGone(child.pid)) { signalOwned('SIGKILL'); await awaitClosure(input.deadline); }
    }
    cleanupFailure = !exited || !closed || !groupGone(child.pid);
    frame.fill(0);
    try { persist(cleanupFailure ? 'cleanup-indeterminate' : success ? 'closed' : 'refused'); } catch { success = false; }
    child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
    child.off('exit', onExit); child.off('close', onClose); child.off('error', fail);
    child.stdin.off('error', fail); child.stdout.off('error', fail); child.stderr.off('error', fail);
    child.stdout.off('data', onStdout); child.stderr.off('data', onStderr);
    if (failed || signal.aborted || performance.now() >= input.deadline) { success = false; }
    if (!success || cleanupFailure) { held?.token.fill(0); held?.accountId.fill(0); }
  };
  try {
    check(); persist('started');
    held = await readOfficialAuth({ request, initialized: () => {
      check(); child.stdin.write('{"method":"initialized"}\n');
    } }, input.home, input.source);
    check(); child.stdin.end();
    await awaitClosure(rpcDeadline);
    if (failed || signal.aborted || performance.now() >= rpcDeadline) { throw refusal(); }
    success = exited && closed && groupGone(child.pid) && exitCode === 0 && exitSignal === null && used === 0;
  } catch { success = false; }
  finally {
    await finishSession();
  }
  if (cleanupFailure) { throw new OrdinaryCodexAuthCleanupIndeterminate(observation('cleanup-indeterminate')); }
  if (!success || !held) { throw refusal(); }
  return held;
}
