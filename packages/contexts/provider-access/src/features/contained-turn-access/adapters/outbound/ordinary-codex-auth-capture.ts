import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { types } from 'node:util';
import { prepareAuthFiles, authHelperArguments } from './ordinary-codex-auth-files.js';
import { captureAuthHelper } from './ordinary-codex-auth-ipc.js';
import { conservativeTokenExpiry } from './ordinary-codex-auth-json.js';
import type { CapturedAuthBytes } from './ordinary-codex-auth-protocol.js';
import { OrdinaryCodexAuthRefused, OrdinaryCodexAuthCleanupIndeterminate,
  type OrdinaryCodexAuthCapture, type OrdinaryCodexAuthCaptureOptions, type OrdinaryCodexAuthMetadata } from './ordinary-codex-auth-contracts.js';

/** PA-owned one-shot official capture. No user credential file contents are read here. */
export function createOrdinaryCodexAuthCapture(options: OrdinaryCodexAuthCaptureOptions): OrdinaryCodexAuthCapture {
  const input = Object.freeze({ ...options }), captureRef = randomUUID();
  const startedAt = performance.now();
  if (!Number.isSafeInteger(input.generation) || input.generation < 1 || !Number.isFinite(input.deadline) ||
      input.deadline <= startedAt || input.deadline > startedAt + 60_000 || !input.operationRef ||
      input.operationRef.length > 512 || typeof input.record !== 'function' || types.isAsyncFunction(input.record)) { throw new OrdinaryCodexAuthRefused(); }
  const lifetime = new AbortController();
  const signal = AbortSignal.any([input.signal, lifetime.signal]);
  let attempted = false, disposed = false, held: CapturedAuthBytes | undefined, metadata: OrdinaryCodexAuthMetadata | undefined;
  let settle!: () => void;
  const settled = new Promise<void>(resolve => { settle = resolve; });
  const check = () => {
    if (disposed || signal.aborted || performance.now() >= (metadata?.deadline ?? input.deadline)) { throw new OrdinaryCodexAuthRefused(); }
  };
  const erase = () => { held?.token.fill(0); held?.accountId.fill(0); held = undefined; };
  let expiry: ReturnType<typeof setTimeout> | undefined;
  const dispose = () => {
    if (disposed) { return; } disposed = true; lifetime.abort(); erase();
    clearTimeout(expiry); signal.removeEventListener('abort', dispose);
    if (!attempted) { settle(); }
  };
  signal.addEventListener('abort', dispose, { once: true });
  expiry = setTimeout(dispose, input.deadline - startedAt); expiry.unref();
  const capture = async (): Promise<OrdinaryCodexAuthMetadata> => {
    if (attempted) { throw new OrdinaryCodexAuthRefused(); } attempted = true;
    let files: Awaited<ReturnType<typeof prepareAuthFiles>> | undefined;
    let captured: CapturedAuthBytes | undefined;
    let retain = false;
    try {
      check(); files = await prepareAuthFiles({ source: input.sourceDirectory, privateRoot: input.privateRoot, executable: input.executable, check });
      await files.check(); check();
      const deadline = Math.min(input.deadline, performance.now() + 15_000);
      if (deadline - performance.now() <= 1500) { throw new OrdinaryCodexAuthRefused(); }
      const child = spawn('/usr/bin/sandbox-exec', [...authHelperArguments(input.sourceDirectory, input.executable)], {
        cwd: files.home, env: { HOME: files.home, CODEX_HOME: files.home, TMPDIR: files.home + '/tmp', PATH: '/usr/bin:/bin' },
        detached: true, stdio: ['pipe', 'pipe', 'pipe'],
      });
      captured = await captureAuthHelper({ child, signal, deadline, home: files.home, source: input.sourceDirectory, captureRef, record: input.record });
      await files.check(); check();
      metadata = createOrdinaryAuthMetadata(captured, { generation: input.generation, captureRef, sourceIdentity: files.sourceIdentity,
        deadline: input.deadline }, Date.now(), performance.now());
      const effectiveDeadline = metadata.deadline;
      await files.cleanup(); files = undefined; check();
      held = captured; captured = undefined;
      clearTimeout(expiry); expiry = setTimeout(dispose, Math.max(1, effectiveDeadline - performance.now())); expiry.unref();
      return metadata;
    } catch (error) {
      dispose();
      if (error instanceof OrdinaryCodexAuthCleanupIndeterminate) {
        retain = true;
        const observation = Object.freeze({ ...error.observation, ...(files ? { retainedDirectory: files.home } : {}) });
        try { input.record(observation); } catch { /* cleanup indeterminate still takes precedence */ }
        throw new OrdinaryCodexAuthCleanupIndeterminate(observation);
      }
      throw new OrdinaryCodexAuthRefused();
    } finally {
      captured?.token.fill(0); captured?.accountId.fill(0);
      try {
        if (files) { if (retain) { await files.retain(); } else { await files.cleanup(); } }
      } catch {
        dispose();
        // Only non-secret, observed facts are supplied to the host sink.
        try { input.record(Object.freeze({ captureRef, outcome: 'refused', exitObserved: false, closeObserved: false, processGroupGone: false, ...(files ? { retainedDirectory: files.home } : {}) })); } catch { /* refusal remains */ }
        // A cleanup refusal must override a would-be returned capture.
        // oxlint-disable-next-line no-unsafe-finally -- no credential authority escapes failed resource cleanup
        throw new OrdinaryCodexAuthRefused();
      } finally { settle(); }
    }
  };
  return Object.freeze<OrdinaryCodexAuthCapture>({ capture, settled, dispose,
    withCredentialOutputTokens(operationRef, consume) {
      try {
        check();
        if (operationRef !== input.operationRef || !held || typeof consume !== 'function' || types.isAsyncFunction(consume)) { throw new OrdinaryCodexAuthRefused(); }
        const material = held;
        const result: unknown = consume(Object.freeze([material.token.toString('ascii'), material.accountId.toString('ascii')]));
        if (types.isPromise(result) && Object.getPrototypeOf(result) === Promise.prototype &&
            Object.getOwnPropertyDescriptor(result, 'constructor') === undefined) {
          Promise.prototype.then.call(result, () => {}, () => {});
        }
        if (result !== true) { throw new OrdinaryCodexAuthRefused(); }
        check(); if (held !== material) { throw new OrdinaryCodexAuthRefused(); }
      } catch { dispose(); throw new OrdinaryCodexAuthRefused(); }
    },
    admit(selection, admission) {
      try {
        check();
        if (!held || !metadata || selection.operationRef !== input.operationRef || selection.recipe !== 'codex-chatgpt' ||
            selection.operationAbortSignal !== input.signal || !Number.isFinite(selection.deadline) ||
            selection.deadline > metadata.deadline || selection.deadline <= performance.now() ||
            selection.binding.credentialGeneration !== input.generation || selection.binding.providerAccountRef !== metadata.accountId) { throw new OrdinaryCodexAuthRefused(); }
        const material = held; held = undefined; dispose();
        try {
          if (admission.admit({ operationRef: input.operationRef, binding: selection.binding, recipe: selection.recipe,
            fields: [{ name: 'token', valueBytes: material.token }, { name: 'accountId', valueBytes: material.accountId }] }).kind !== 'admitted') { throw new OrdinaryCodexAuthRefused(); }
        } finally {
          if (material.token.byteLength) { material.token.fill(0); }
          if (material.accountId.byteLength) { material.accountId.fill(0); }
        }
      } catch { dispose(); throw new OrdinaryCodexAuthRefused(); }
    },
  });
}

/** Convert the monotonic lifetime into a conservative integer wall-clock expiry for durable PA admission. */
export function createOrdinaryAuthMetadata(captured: CapturedAuthBytes,
  input: { generation: number; captureRef: string; sourceIdentity: string; deadline: number },
  now: number, monotonicNow: number): OrdinaryCodexAuthMetadata {
  const tokenExpiry = conservativeTokenExpiry(captured.token, now);
  const deadline = Math.min(input.deadline, monotonicNow + tokenExpiry - now);
  const expiresAt = Math.floor(Math.min(tokenExpiry, now + deadline - monotonicNow));
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now || deadline <= monotonicNow) { throw new OrdinaryCodexAuthRefused(); }
  return Object.freeze({ accountId: captured.accountId.toString('ascii'), generation: input.generation, captureRef: input.captureRef,
    expiresAt, deadline, sourceIdentity: input.sourceIdentity, modelObserved: true });
}
