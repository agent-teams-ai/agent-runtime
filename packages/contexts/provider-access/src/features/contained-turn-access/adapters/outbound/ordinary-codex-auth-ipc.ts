import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { types } from 'node:util';
import { parseAuthFrame, authRecord } from './ordinary-codex-auth-json.js';
import { readOfficialAuth, type AuthMethod, type CapturedAuthBytes } from './ordinary-codex-auth-protocol.js';
import { OrdinaryCodexAuthRefused, OrdinaryCodexAuthCleanupIndeterminate, type OrdinaryCodexAuthObservation, type OrdinaryCodexAuthStage, type OrdinaryCodexAuthReason, ORDINARY_AUTH_REFUSAL_REASONS } from './ordinary-codex-auth-contracts.js';

export interface AuthHelperSession {
  readonly child: ChildProcessWithoutNullStreams;
  readonly signal: AbortSignal;
  readonly deadline: number;
  readonly home: string;
  readonly source: string;
  readonly captureRef: string;
  readonly record: (observation: OrdinaryCodexAuthObservation) => void;
}
const refusal = (reason: OrdinaryCodexAuthReason = 'validation') => new OrdinaryCodexAuthRefused(reason);
const reasonOf = (error: unknown): OrdinaryCodexAuthReason => error instanceof OrdinaryCodexAuthRefused &&
    ORDINARY_AUTH_REFUSAL_REASONS.includes(error.reason) ? error.reason : 'validation';
const pause = (milliseconds: number) => new Promise<void>(resolve => { setTimeout(resolve, Math.max(0, milliseconds)); });
function groupGone(pid: number | undefined): boolean {
  if (!pid || pid <= 1) { return false; }
  try { process.kill(-pid, 0); return false; }
  catch (error) { return error instanceof Error && 'code' in error && error.code === 'ESRCH'; }
}

/** Pinned 0.153.4 startup notification. Identity strings are validated, never retained. */
function disabledRemoteControl(message: Record<string, unknown>): boolean {
  if (message.method !== 'remoteControl/status/changed') { return false; }
  const keys = Object.keys(message), params = authRecord(message.params);
  // The official binary adds optional emission time outside its generated notification schema.
  const timestamp = message.emittedAtMs;
  if (keys.some(key => !['method', 'params', 'emittedAtMs'].includes(key)) ||
      !keys.includes('method') || !keys.includes('params') ||
      (Object.hasOwn(message, 'emittedAtMs') && (typeof timestamp !== 'number' || !Number.isSafeInteger(timestamp) || timestamp < 0)) ||
      Object.keys(params).toSorted().join(',') !== 'environmentId,installationId,serverName,status' ||
      params.status !== 'disabled' || params.environmentId !== null ||
      typeof params.installationId !== 'string' || params.installationId.length > 4096 ||
      typeof params.serverName !== 'string' || params.serverName.length > 4096) { throw refusal('rpc_envelope'); }
  return true;
}

/** The child must have just been spawned detached by this owner. No persisted PID is accepted. */
export async function captureAuthHelper(input: AuthHelperSession): Promise<CapturedAuthBytes> {
  const { child, signal } = input;
  const frame = Buffer.alloc(65_536);
  let remoteStatusObserved = false;
  let used = 0, total = 0, sequence = 0, exited = false, closed = false, failed = false;
  let exitCode: number | null = null, exitSignal: NodeJS.Signals | null = null;
  let pending: { id: number; resolve(value: Record<string, unknown>): void; reject(error: Error): void } | undefined;
  let held: CapturedAuthBytes | undefined;
  let stage: OrdinaryCodexAuthStage = 'startup';
  let diagnostic: {stage: OrdinaryCodexAuthStage; reason: OrdinaryCodexAuthReason} | undefined;
  const diagnose = (reason: OrdinaryCodexAuthReason) => { diagnostic ??= {stage, reason}; };
  const observation = (outcome: OrdinaryCodexAuthObservation['outcome']): OrdinaryCodexAuthObservation => Object.freeze({
    captureRef: input.captureRef, outcome, exitObserved: exited, closeObserved: closed, processGroupGone: groupGone(child.pid),
    ...(diagnostic ? diagnostic : {stage}),
  });
  const persist = (outcome: OrdinaryCodexAuthObservation['outcome']) => {
    let result: unknown;
    try { result = input.record(observation(outcome)); } catch { diagnose('journal_failure'); throw refusal('journal_failure'); }
    if (types.isPromise(result) && Object.getPrototypeOf(result) === Promise.prototype &&
        Object.getOwnPropertyDescriptor(result, 'constructor') === undefined) {
      Promise.prototype.then.call(result, () => {}, () => {});
    }
    if (result !== undefined) { diagnose('journal_failure'); throw refusal('journal_failure'); }
  };
  const fail = (reason: OrdinaryCodexAuthReason = 'io_error') => { diagnose(reason); failed = true; pending?.reject(refusal(reason)); pending = undefined; };
  const onError = () => fail('io_error');
  const onAbort = () => fail('aborted');
  const onExit = (code: number | null, exit: NodeJS.Signals | null) => {
    exited = true; exitCode = code; exitSignal = exit;
    if (pending || code !== 0 || exit !== null) { fail('process_exit'); }
  };
  const onClose = () => { closed = true; if (pending || used !== 0) { fail('stream_closed'); } };
  const onStderr = (chunk: Buffer) => { total += chunk.length; chunk.fill(0); if (total > 262_144) { fail('output_limit'); } };
  const onStdout = (chunk: Buffer) => {
    try {
      total += chunk.length;
      if (failed) { return; }
      if (total > 262_144) { throw refusal('output_limit'); }
      for (const byte of chunk) {
        if (byte !== 10) { if (used === frame.length) { throw refusal('output_limit'); } frame[used++] = byte; continue; }
        let message: Record<string, unknown>;
        try { message = parseAuthFrame(frame.subarray(0, used)); } catch { throw refusal('frame_invalid'); }
        frame.fill(0, 0, used); used = 0;
        if (disabledRemoteControl(message)) {
          if (sequence === 0 || remoteStatusObserved) { throw refusal('rpc_unsolicited'); }
          remoteStatusObserved = true; continue;
        }
        if (!pending) { throw refusal('rpc_unsolicited'); }
        const keys = Object.keys(message);
        if (keys.length === 2 && keys.includes('id') && keys.includes('error') && message.id === pending.id) { throw refusal('rpc_error'); }
        if (keys.length !== 2 || !keys.includes('id') || !keys.includes('result') || message.id !== pending.id) { throw refusal('rpc_envelope'); }
        const result = authRecord(message.result);
        const current = pending; pending = undefined; current.resolve(result);
      }
    } catch (error) { fail(reasonOf(error)); } finally { chunk.fill(0); }
  };
  child.on('exit', onExit); child.on('close', onClose); child.on('error', onError);
  child.stdin.on('error', onError); child.stdout.on('error', onError); child.stderr.on('error', onError);
  child.stdout.on('data', onStdout); child.stderr.on('data', onStderr);
  signal.addEventListener('abort', onAbort, { once: true });
  // Reserve the final second for TERM/KILL/closure, inside the same helper deadline.
  const rpcDeadline = input.deadline - 1000;
  const timer = setTimeout(() => fail('timeout'), Math.max(1, rpcDeadline - performance.now()));
  const check = () => {
    if (signal.aborted) { fail('aborted'); }
    if (performance.now() >= rpcDeadline) { fail('timeout'); }
    if (failed || closed) { throw refusal(diagnostic?.reason ?? 'stream_closed'); }
  };
  const request = (method: AuthMethod, params: object): Promise<Record<string, unknown>> => {
    stage = method; check(); if (pending) { throw refusal(); }
    return new Promise((resolve, reject) => {
      const id = ++sequence; pending = { id, resolve, reject };
      child.stdin.write(JSON.stringify({ id, method, params }) + '\n', error => { if (error) { fail('io_error'); } });
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
    clearTimeout(timer); signal.removeEventListener('abort', onAbort);
    if (!exited || !closed || !groupGone(child.pid)) {
      signalOwned('SIGTERM'); await awaitClosure(Math.min(input.deadline - 500, performance.now() + 300));
      if (!exited || !closed || !groupGone(child.pid)) { signalOwned('SIGKILL'); await awaitClosure(input.deadline); }
    }
    cleanupFailure = !exited || !closed || !groupGone(child.pid);
    if (cleanupFailure) { diagnose('cleanup_uncertain'); }
    frame.fill(0);
    try { persist(cleanupFailure ? 'cleanup-indeterminate' : success ? 'closed' : 'refused'); } catch { success = false; }
    child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
    child.off('exit', onExit); child.off('close', onClose); child.off('error', onError);
    child.stdin.off('error', onError); child.stdout.off('error', onError); child.stderr.off('error', onError);
    child.stdout.off('data', onStdout); child.stderr.off('data', onStderr);
    if (failed || signal.aborted || performance.now() >= input.deadline) { success = false; }
    if (!success || cleanupFailure) { held?.token.fill(0); held?.accountId.fill(0); }
  };
  try {
    check(); persist('started');
    held = await readOfficialAuth({ request, initialized: () => {
      stage = 'initialized'; check(); child.stdin.write('{"method":"initialized"}\n');
    } }, input.home, input.source);
    stage = 'closure'; check(); child.stdin.end();
    await awaitClosure(rpcDeadline);
    if (failed || signal.aborted || performance.now() >= rpcDeadline) {
      throw refusal(diagnostic?.reason ?? (signal.aborted ? 'aborted' : 'timeout'));
    }
    success = exited && closed && groupGone(child.pid) && exitCode === 0 && exitSignal === null && used === 0;
  } catch (error) { diagnose(reasonOf(error)); success = false; }
  finally {
    await finishSession();
  }
  if (cleanupFailure) { throw new OrdinaryCodexAuthCleanupIndeterminate(observation('cleanup-indeterminate')); }
  if (!success || !held) { throw refusal(diagnostic?.reason); }
  return held;
}
