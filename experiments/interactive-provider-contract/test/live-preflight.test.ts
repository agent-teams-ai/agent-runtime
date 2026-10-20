import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readLiveManifest } from '../harness/live.ts';

test('live preflight accepts only caller-owned private TEST state and explicit API-key environment', async () => {
  const root = await mkdtemp(join(tmpdir(), 'TEST-driver-preflight-'));
  try {
    for (const dir of ['home', 'config', 'tmp']) { await mkdir(join(root, dir)); }
    const manifest = join(root, 'run.json');
    const value = { root, model: 'TEST-model', environment: { HOME: join(root, 'home'), CLAUDE_CONFIG_DIR: join(root, 'config'), TMPDIR: join(root, 'tmp'), PATH: '/usr/bin:/bin', ANTHROPIC_API_KEY: 'TEST-ONLY-FAKE-NOT-FOR-LAUNCH' } };
    await writeFile(manifest, JSON.stringify(value), { mode: 0o600 });
    assert.equal((await readLiveManifest(manifest)).model, 'TEST-model');
    await chmod(manifest, 0o644); await assert.rejects(readLiveManifest(manifest)); await chmod(manifest, 0o600);
    const linked = join(root, 'symlink.json'); await symlink(manifest, linked); await assert.rejects(readLiveManifest(linked));
    await writeFile(manifest, JSON.stringify({ ...value, environment: { ...value.environment, CLAUDE_CODE_OAUTH_TOKEN: 'forbidden-route' } })); await assert.rejects(readLiveManifest(manifest));
    await writeFile(manifest, JSON.stringify({ ...value, environment: { ...value.environment, HOME: '/Users' } })); await assert.rejects(readLiveManifest(manifest));
  } finally { await rm(root, { recursive: true, force: true }); }
});
