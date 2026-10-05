import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { tmpdir } from 'node:os';
import { commandExit, enumerateExecutionFiles, executionSelection, observeLine, packages,
  partitionExecutionFiles, runCommand, selectShard, shardIds, validateInventory, validatePlatform } from './package-execution.ts';
import type { Observation } from './package-execution.ts';

const reporter = resolve('scripts/ci/package-execution.ts');
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'ae-partition-TEST-'));
  const packageRoot = join(root, packages[0].root);
  const paths = ['tests/features/runtime-installation-discovery/a.test.ts',
    'tests/features/runtime-installation-discovery/b.test.ts',
    'tests/features/contained-agent-turn/a.test.ts', 'tests/features/contained-agent-turn/b.test.ts',
    'tests/features/contained-agent-turn/c.test.ts',
    'tests/features/contained-agent-turn/contained-turn-live-canary-lifecycle.test.mjs',
    'tests/package/a.test.ts', 'tests/package/b.test.ts'];
  await mkdir(packageRoot, { recursive: true });
  await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ type: 'module', scripts: { test: packages[0].test } }));
  for (const [index, path] of paths.entries()) {
    await mkdir(join(packageRoot, path.slice(0, path.lastIndexOf('/'))), { recursive: true });
    // Each file proves isolation: a process-global mutation cannot leak to another file.
    await writeFile(join(packageRoot, path), `import assert from 'node:assert/strict';\nimport {test, describe} from 'node:test';\ntest('identity-${index}', () => { assert.equal(process.env.FIXTURE_OWNER, undefined); process.env.FIXTURE_OWNER = '${index}'; });\n`
      + (index === 0 ? "test('skipped-identity', {skip: 'TEST skip preserved'}, () => {});\n" : '')
      + (index === 1 ? "describe('suite-identity', () => { test('nested-identity', () => {}); });\n" : ''));
  }
  return { root, packageRoot, paths: paths.toSorted() };
}

const identities = (events: Record<string, unknown>[]) => events.map(e => JSON.stringify([e.file, e.line, e.column, e.name, e.nesting, e.kind, e.status])).toSorted();

export function registerPackageExecutionTests(): void {
test('original four patterns include the literal mjs, exclude nested/helpers/dotfiles, and repartition additions', async t => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
  await writeFile(join(f.packageRoot, 'tests/package/.hidden.test.ts'), '');
  await writeFile(join(f.packageRoot, 'tests/package/helper.ts'), '');
  await mkdir(join(f.packageRoot, 'tests/package/nested'));
  await writeFile(join(f.packageRoot, 'tests/package/nested/ignored.test.ts'), '');
  assert.deepEqual(await enumerateExecutionFiles(f.root), f.paths);
  const before = await executionSelection(f.root, selectShard('agent-execution-1'));
  await assert.rejects(executionSelection(f.root, { ...selectShard('agent-execution-1'), partitionCount: 1 }), /shard contract/);
  const added = 'tests/features/contained-agent-turn/new-test.test.ts';
  await writeFile(join(f.packageRoot, added), '');
  const after = await executionSelection(f.root, selectShard('agent-execution-1'));
  assert.ok(before && after); assert.notEqual(before.universeHash, after.universeHash);
  const partitions = await Promise.all([1, 2, 3].map(n => executionSelection(f.root, selectShard(`agent-execution-${n}`))));
  const union = partitions.flatMap(p => { assert.ok(p); return p.files; });
  assert.equal(new Set(union).size, union.length); assert.deepEqual(union.toSorted(), [...f.paths, added].toSorted());
  assert.equal(partitions.filter(p => p?.files.includes('tests/features/contained-agent-turn/contained-turn-live-canary-lifecycle.test.mjs')).length, 1);
});

test('empty pattern, runner option drift, symlink input and unsupported matched filename fail closed', async t => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
  const manifest = join(f.packageRoot, 'package.json'), original = await readFile(manifest);
  await writeFile(manifest, JSON.stringify({ scripts: { test: packages[0].test.replace('concurrency=1', 'concurrency=2') } }));
  await assert.rejects(enumerateExecutionFiles(f.root), /runner drift/); await writeFile(manifest, original);
  const literal = join(f.packageRoot, 'tests/features/contained-agent-turn/contained-turn-live-canary-lifecycle.test.mjs');
  const bytes = await readFile(literal); await rm(literal);
  await assert.rejects(enumerateExecutionFiles(f.root), /unmatched original/); await writeFile(literal, bytes);
  const link = join(f.packageRoot, 'tests/package/link.test.ts'); await symlink(literal, link);
  await assert.rejects(enumerateExecutionFiles(f.root), /regular file/); await rm(link);
  await writeFile(join(f.packageRoot, 'tests/package/unreviewed name.test.ts'), '');
  await assert.rejects(enumerateExecutionFiles(f.root), /unsupported test path/);
});

test('eight literal shards and Linux platform contract reject unknown, array, whole-AE and unsupported runners', () => {
  assert.equal(shardIds.length, 8);
  assert.deepEqual(shardIds.slice(0, 3).map(id => selectShard(id).partitionIndex), [0, 1, 2]);
  for (const bad of [undefined, [], 'agent-execution', 'agent-execution-4', '@agent-teams/agent-execution', 'provider-access runtime-security'])
    { assert.throws(() => selectShard(bad)); }
  assert.throws(() => partitionExecutionFiles(['c', 'a', 'b'], 0), /ordering/);
  assert.throws(() => partitionExecutionFiles(['a', 'a', 'b'], 0), /duplicate/);
  assert.throws(() => partitionExecutionFiles(['a', 'b'], 0), /empty/);
  assert.throws(() => partitionExecutionFiles(['a', 'b', 'c'], 3), /index/);
  validatePlatform('linux', 'x64', 'Linux', 'X64');
  assert.throws(() => validatePlatform('darwin', 'arm64', 'macOS', 'ARM64'));
  assert.throws(() => validatePlatform('linux', 'x64', 'macOS', 'X64'));
});

test('source inventory rejects missing sixth build, added package, test change and lifecycle hook', () => {
  const clean = `node -e "const fs=require('node:fs'); for (const path of ['dist','.cache']) fs.rmSync(path, { recursive: true, force: true })"`;
  const entries = packages.map(p => ({ root: p.root, manifest: { name: p.name, scripts: { clean, build: p.build, test: p.test } } }));
  const root = { scripts: { 'product:build': "pnpm --filter './packages/**' -r run build" } };
  validateInventory(entries, root);
  assert.throws(() => validateInventory(entries.slice(1), root));
  assert.throws(() => validateInventory([...entries, { root: 'packages/contexts/new', manifest: {} }], root));
  const changed = structuredClone(entries); changed[0]!.manifest.scripts.test += ' --test-name-pattern=canary';
  assert.throws(() => validateInventory(changed, root), /test script/);
  const hook = structuredClone(entries); Object.assign(hook[0]!.manifest.scripts, { pretest: 'echo skipped' });
  assert.throws(() => validateInventory(hook, root), /lifecycle hook/);
});

test('actual Node full run and three partitions preserve file completion, identities/statuses and process isolation', async t => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
  const universe = await enumerateExecutionFiles(f.root);
  const selection = await executionSelection(f.root, selectShard('agent-execution-1')); assert.ok(selection);
  const env = { ...process.env }; delete env.NODE_OPTIONS; delete env.NODE_TEST_CONTEXT;
  const run = (paths: string[], label: string, withReporter = true) => runCommand(process.execPath,
    ['--test', '--test-concurrency=1', ...(withReporter ? [`--test-reporter=${reporter}`] : []), ...paths],
    f.packageRoot, env, join(f.root, label));
  const full = await run(selection.fullArgv.slice(2), 'full');
  assert.equal(commandExit(full, 1, universe.map(p => join(f.packageRoot, p))), 0);
  const shards = [];
  for (let index = 0; index < 3; index++) {
    const paths = partitionExecutionFiles(universe, index);
    const result = await run(paths, `shard-${index}`);
    assert.equal(commandExit(result, 1, paths.map(p => join(f.packageRoot, p))), 0); shards.push(result);
  }
  assert.deepEqual(identities(shards.flatMap(s => s.observation.events)), identities(full.observation.events));
  const silent = await run(universe, 'silent', false);
  assert.equal(silent.exitCode, 0); assert.equal(commandExit(silent, 1), 1, 'no observer cannot qualify exit-zero tests');
  const missing = structuredClone(full); missing.observation.completedFiles.pop();
  assert.equal(commandExit(missing, 1, universe.map(p => join(f.packageRoot, p))), 1);
  const missingEvent = structuredClone(full); missingEvent.observation.events.shift();
  assert.equal(commandExit(missingEvent, 1), 1, 'summary alone cannot cover a missing emitted identity');
  const missingSummary = structuredClone(full); missingSummary.observation.summaries.length = 0;
  assert.equal(commandExit(missingSummary, 1), 1);
  const duplicate = structuredClone(full); duplicate.observation.completedFiles.push(duplicate.observation.completedFiles[0]!);
  assert.equal(commandExit(duplicate, 1, universe.map(p => join(f.packageRoot, p))), 1);
  const extra = structuredClone(full); extra.observation.completedFiles.push(join(f.packageRoot, 'other.test.ts'));
  assert.equal(commandExit(extra, 1, universe.map(p => join(f.packageRoot, p))), 1);
  const failing = 'tests/package/failing.test.ts';
  await writeFile(join(f.packageRoot, failing), "import test from 'node:test'; test('real failure', () => { throw Error('TEST assertion failed'); });\n");
  const failed = await run([failing], 'failed');
  assert.notEqual(failed.exitCode, 0); assert.equal(commandExit(failed, 1), 1);
  const observation: Observation = { events: [], summaries: [], completedFiles: [] };
  assert.throws(() => observeLine('PACKAGE_SUMMARY {"tests":1}', observation), /invalid Node summary/);
  if (process.env.CI_FOCUSED_EVIDENCE_DIR) { await writeFile(join(process.env.CI_FOCUSED_EVIDENCE_DIR, 'synthetic-package-processes.json'), JSON.stringify({
    scope: 'synthetic TEST only; not current product-suite qualification', full, shards, silent, failed,
  }, null, 2) + '\n'); }
});

}
