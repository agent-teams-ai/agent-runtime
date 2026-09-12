import { types } from 'node:util';
import { spawn } from 'node:child_process';
import { open, lstat, realpath } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute, dirname } from 'node:path';
import { capturePrivate, HelperCleanupIndeterminate } from './auth-ipc.ts';
import type { CredentialRenderingSelection, OperationCredentialMaterialAdmission } from '@agent-teams/provider-access/composition';
export const BINARY_SHA256 = 'b973d440acac501fd2594a43e7ca9ce41e0a65b9dfb28d0d7a7837c99e1261e3';
export interface PrivateAuthConfig {
  readonly operationRef: string; readonly executable: string; readonly codexHome: string; readonly sandbox: string;
  readonly generation: number; readonly readGeneration: () => number;
  readonly signal: AbortSignal; readonly deadline: number;
}
const refused = () => new Error('PRIVATE_AUTH_REFUSED');
async function directory(path: string) {
  if (!isAbsolute(path) || await realpath(path) !== path) {throw refused();}
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o077)) {throw refused();}
}
export function createPrivateOfficialAuthOwner(input: PrivateAuthConfig) {
  const config = Object.freeze({...input}); const lifetime = new AbortController(); let attempted = false, disposed = false;
  let held: Awaited<ReturnType<typeof capturePrivate>> | undefined;
  const check = () => {
    if (disposed || config.signal.aborted || performance.now() >= config.deadline ||
        config.readGeneration() !== config.generation) {throw refused();}
  };
  let expiry: ReturnType<typeof setTimeout> | undefined;
  const dispose = () => {lifetime.abort(); clearTimeout(expiry); config.signal.removeEventListener('abort', dispose); disposed = true; held?.token.fill(0); held?.accountId.fill(0); held = undefined;};
  config.signal.addEventListener('abort', dispose, {once: true});
  expiry = setTimeout(dispose, Math.max(1, Math.min(60000, config.deadline - performance.now()))); expiry.unref();
  return Object.freeze({
    async capture() {
      if (attempted) {throw refused();} attempted = true;
      try {
        check();
        if (!Number.isSafeInteger(config.generation) || config.generation < 1 ||
            !Number.isFinite(config.deadline) || config.deadline - performance.now() > 60000) {throw refused();}
        await directory(config.codexHome); await directory(config.sandbox);
        if (config.codexHome === config.sandbox || config.codexHome.startsWith(config.sandbox + '/') ||
            config.sandbox.startsWith(config.codexHome + '/')) {throw refused();}
        if (!isAbsolute(config.executable) || await realpath(config.executable) !== config.executable) {throw refused();}
        // Parent promises exclusive custody throughout verification/spawn. No credential file is opened.
        const file = await open(config.executable, 'r');
        try {
          const stat = await file.stat();
          if (stat.size > 536870912 || !stat.isFile() || (stat.mode & 0o022) || !(stat.mode & 0o111)) {throw refused();}
          const hash = createHash('sha256'); for await (const chunk of file.createReadStream({autoClose: false})) {check(); hash.update(chunk);}
          if (hash.digest('hex') !== BINARY_SHA256) {throw refused();}
        } finally {await file.close();}
        check();
        held = await capturePrivate(spawn(config.executable, ['app-server', '--strict-config', '-c', 'default_permissions="agent-runtime-contained-v1"', '--listen', 'stdio://'], {
          cwd: config.sandbox, env: {HOME: config.codexHome, CODEX_HOME: config.codexHome,
            TMPDIR: config.sandbox, PATH: dirname(config.executable) + ':/usr/bin:/bin'},
          stdio: ['pipe', 'pipe', 'pipe'],
        }), lifetime.signal, config.deadline);
        check();
        return Object.freeze({accountId: held.accountId.toString('utf8'), generation: config.generation, captureRef: randomUUID()});
      } catch (error) {dispose(); if (error instanceof HelperCleanupIndeterminate) {throw error;} throw refused();}
    },
    withCredentialOutputTokens(operationRef: string, consume: (tokens: readonly string[]) => boolean) {
      try {
        check();
        if (!held || operationRef !== config.operationRef || typeof consume !== 'function' ||
            types.isAsyncFunction(consume)) {throw refused();}
        const material = held;
        const sizes = [material.token.byteLength, material.accountId.byteLength];
        if (sizes.length > 256 || sizes.some(size => size < 1 || size > 4096) ||
            sizes.reduce((sum, size) => sum + size, 0) > 65536) {throw refused();}
        const tokens = Object.freeze([material.token.toString('utf8'), material.accountId.toString('utf8')]);
        const accepted = consume(tokens);
        // Observe ordinary native carriers without reading their `then` or rejection.
        // Exclude custom constructor/species carriers before intrinsic observation.
        if (types.isPromise(accepted) && Object.getPrototypeOf(accepted) === Promise.prototype &&
            Object.getOwnPropertyDescriptor(accepted, 'constructor') === undefined) {
          Promise.prototype.then.call(accepted, () => {}, () => {});
        }
        if (accepted !== true) {throw refused();}
        check(); if (held !== material) {throw refused();}
      } catch {dispose(); throw refused();}
    },
    admit(selection: CredentialRenderingSelection, admission: OperationCredentialMaterialAdmission) {
      try {
        check(); if (!held || selection.operationRef !== config.operationRef || selection.recipe !== 'codex-chatgpt' || selection.operationAbortSignal !== config.signal ||
            selection.deadline !== config.deadline || selection.binding.credentialGeneration !== config.generation ||
            selection.binding.providerAccountRef !== held.accountId.toString('utf8')) {throw refused();}
        const material = held; held = undefined; dispose();
        try {
          if (admission.admit({operationRef: selection.operationRef, binding: selection.binding, recipe: selection.recipe,
            fields: [{name: 'token', valueBytes: material.token}, {name: 'accountId', valueBytes: material.accountId}]}).kind !== 'admitted') {throw refused();}
        } finally {if (material.token.byteLength) {material.token.fill(0);} if (material.accountId.byteLength) {material.accountId.fill(0);}}
      } catch {dispose(); throw refused();}
    }, dispose,
  });
}
export type PrivateOfficialAuthOwner = ReturnType<typeof createPrivateOfficialAuthOwner>;
