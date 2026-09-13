import assert from 'node:assert/strict';
import { chmod, link, lstat, mkdir, mkdtemp, realpath, rename, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { prepareAuthFiles, stableAuthPath } from '../../../dist/features/contained-turn-access/adapters/outbound/ordinary-codex-auth-files.js';
import { OrdinaryCodexAuthRefused } from '../../../dist/features/contained-turn-access/adapters/outbound/ordinary-codex-auth-contracts.js';

async function fixture(t: TestContext, directory: boolean, privateMode = true) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'synthetic-auth-stability-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, directory ? 'source' : 'auth.json');
  if (directory) { await mkdir(path, { mode: 0o700 }); }
  else { await writeFile(path, 'invented-auth-only', { mode: 0o600 }); }
  const guard = await stableAuthPath(path, directory, (await lstat(root)).uid, privateMode);
  t.after(() => guard.handle.close());
  return { root, path, guard };
}

test('unrelated source children may change while pinned auth file remains stable', async t => {
  const { path, guard } = await fixture(t, true, false);
  const authPath = join(path, 'auth.json');
  await writeFile(authPath, 'invented-auth-only', { mode: 0o600 });
  const auth = await stableAuthPath(authPath, false, guard.identity.uid, true);
  t.after(() => auth.handle.close());
  await writeFile(join(path, 'session-state'), 'invented-session');
  await mkdir(join(path, 'logs'));
  // Make timestamp drift deterministic even on filesystems with coarse timestamps.
  await utimes(path, new Date(1000), new Date(2000));
  assert.notEqual((await lstat(path)).mtimeMs, guard.identity.mtimeMs);
  await guard.check(); await auth.check();
  await rename(join(path, 'session-state'), join(path, 'session-state-new'));
  await rm(join(path, 'logs'), { recursive: true });
  await guard.check(); await auth.check();
});

for (const directory of [true, false]) {
  const label = directory ? 'directory' : 'file';
  test(`${label} guard rejects replacement at the same canonical path`, async t => {
    const { root, path, guard } = await fixture(t, directory);
    await rename(path, join(root, 'original'));
    if (directory) { await mkdir(path, { mode: 0o700 }); }
    else { await writeFile(path, 'invented-auth-only', { mode: 0o600 }); }
    await assert.rejects(guard.check(), error => error instanceof OrdinaryCodexAuthRefused && error.reason === 'identity_drift');
  });
  test(`${label} guard rejects permission changes`, async t => {
    const { path, guard } = await fixture(t, directory);
    await chmod(path, directory ? 0o750 : 0o640);
    await assert.rejects(guard.check(), error => error instanceof OrdinaryCodexAuthRefused && error.reason === 'identity_drift');
  });
  test(`${label} guard rejects symlink substitution`, async t => {
    const { root, path, guard } = await fixture(t, directory);
    const original = join(root, 'original');
    await rename(path, original); await symlink(original, path);
    await assert.rejects(guard.check(), error => error instanceof OrdinaryCodexAuthRefused && error.reason === 'identity_drift');
  });
}

test('auth file guard rejects same-size content mutation even if mtime is restored', async t => {
  const { path, guard } = await fixture(t, false);
  const original = await lstat(path);
  await writeFile(path, 'replaced-auth-now!');
  await utimes(path, original.atime, original.mtime);
  assert.equal((await lstat(path)).size, original.size);
  await assert.rejects(guard.check(), error => error instanceof OrdinaryCodexAuthRefused && error.reason === 'identity_drift');
});
test('auth file guard rejects a new hard link', async t => {
  const { root, path, guard } = await fixture(t, false);
  await link(path, join(root, 'alias'));
  await assert.rejects(guard.check(), error => error instanceof OrdinaryCodexAuthRefused && error.reason === 'identity_drift');
});
test('source directory rejects group-writable mode at acquisition', async t => {
  const { path, guard } = await fixture(t, true, false);
  await chmod(path, 0o770);
  await assert.rejects(stableAuthPath(path, true, guard.identity.uid, false), OrdinaryCodexAuthRefused);
});

const unexpected = (): never => {throw new Error('must not inspect any auth path');};
test('Linux ordinary auth refuses before observing any configured source', {skip: process.platform !== 'linux'}, async t => {
  t.mock.method(process, 'getuid', () => 501);
  await assert.rejects(prepareAuthFiles({get source() {return unexpected();}, get executable() {return unexpected();}, get privateRoot() {return unexpected();}, check: unexpected}), error => error instanceof OrdinaryCodexAuthRefused);
});
