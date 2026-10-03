import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { parse } from 'yaml';
import { commandInventory } from './script-routing.ts';
import type { Scripts } from './script-routing.ts';

export async function readScripts(path: string | URL): Promise<Scripts> {
  const manifest: { scripts?: unknown } = JSON.parse(await readFile(path, 'utf8'));
  assert.ok(manifest.scripts !== null && typeof manifest.scripts === 'object');
  const scripts: Record<string, string> = {};
  for (const [name, command] of Object.entries(manifest.scripts)) {
    assert.equal(typeof command, 'string');
    scripts[name] = command;
  }
  return scripts;
}

// Capture from the untouched supplied checkout before routing changes. Retain
// exact leaf commands; observed test identities/statuses come from measure.ts.
if (process.argv[1]?.endsWith('/inventory.ts') && process.argv[2] === 'platform') {
  const [root, output] = process.argv.slice(3);
  assert.ok(root && output);
  const yaml: { jobs: Record<string, unknown> } = parse(await readFile(join(root, '.github/workflows/ci.yml'), 'utf8'));
  const hashes: Record<string, string> = {};
  for (const name of ['postgres-durability', 'runtime-macos']) {
    hashes[name] = createHash('sha256').update(JSON.stringify(yaml.jobs[name])).digest('hex');
  }
  for (const path of ['.github/workflows/docs-protocol.yml', '.github/workflows/commit-author-identity.yml']) {
    hashes[path] = createHash('sha256').update(await readFile(join(root, path))).digest('hex');
  }
  await writeFile(output, `${JSON.stringify(hashes, null, 2)}\n`);
} else if (process.argv[1]?.endsWith('/inventory.ts')) {
  const [input, output] = process.argv.slice(2);
  assert.ok(input && output, 'usage: inventory.ts package.json output.json');
  const scripts = await readScripts(input);
  const inventory = commandInventory(scripts, 'check');
  await writeFile(output, `${JSON.stringify({ scripts, inventory }, null, 2)}\n`);
}
