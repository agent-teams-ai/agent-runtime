import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, readlink, realpath } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { parse } from 'yaml';
import type { ComparisonResult, LeafInventory } from '@agent-teams/ci-input-proof';

export const regressionIds = ['foundation-negative', 'fms', 'cms-regression', 'ci-selftests', 'docs-portable'] as const;
export type RegressionId = typeof regressionIds[number];
export const packageRoots = ['packages/apps/embedded-runtime', 'packages/contexts/agent-execution',
  'packages/contexts/provider-access', 'packages/contexts/runtime-configuration', 'packages/contexts/runtime-security',
  'packages/platform/filesystem-custody'] as const;
export const policyPath = 'architecture/foundation/ci-pr-regressions.json';
const schedulingClosure = [policyPath, 'scripts/ci/pr-regression-inputs.ts', 'scripts/ci/pr-regression-inputs.test.ts',
  'scripts/ci/pr-regression-command.ts', 'scripts/ci/pr-regression-bootstrap.ts', 'scripts/ci/pr-regression-bootstrap.test.ts',
  '.github/workflows/ci-foundation-route.yml', '.github/workflows/ci-pr-regressions.yml'];
interface Policy {
  schemaVersion: number; packageRoots: string[]; foundationAnchors: string[]; cmsBodyRoots: string[]; docsBodyAnchors: string[];
  regressions: Record<RegressionId, string>;
}
export const regressionCommands = {
  'foundation-negative': 'pnpm foundation:boundaries:negative',
  fms: 'pnpm test:feature-modules',
  'cms-regression': 'node --test scripts/architecture/check-consumer-module-standard.test.mjs',
  'ci-selftests': 'node --test scripts/ci/contracts.test.ts',
  'docs-portable': 'pnpm docs:qualification:portable',
} as const satisfies Record<RegressionId, string>;
export interface RuntimeFacts { node: string; pnpm: string; platform: string; arch: string; glibc: string; execArgv: string[] }
export interface PrInput {
  base: string; head: string; event: unknown; environment: NodeJS.ProcessEnv; runtime: RuntimeFacts; installation?: string;
}
export interface PrPlan {
  protocol: 'pr-regression-sampling/1'; mode: 'full' | 'affected-pr'; base: string; head: string;
  baseTree?: string; headTree?: string; changed: string[]; run: RegressionId[]; deferred: RegressionId[];
  reason: string; installation?: string; scopes?: Record<string, string>;
}
interface Leaf { path: string; mode: string; type: string; oid: string }
export type LeafInventoryComparator = (base: LeafInventory, head: LeafInventory, structuralPaths: readonly string[]) => ComparisonResult;
const sha256 = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const object = (value: unknown): Record<string, unknown> => {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value), 'event object');
  return value as Record<string, unknown>;
};
const within = (path: string, root: string) => path.startsWith(`${root}/`);

export function supportedPrEnvironment(env: NodeJS.ProcessEnv, facts: RuntimeFacts): boolean {
  const expected = { GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'pull_request', GITHUB_REPOSITORY: 'agent-teams-ai/agent-runtime',
    RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'Linux', RUNNER_ARCH: 'X64', ImageOS: 'ubuntu24', PR_REGRESSION_FROZEN_INSTALL: 'verified' };
  const override = Object.entries(env).some(([key, value]) => Boolean(value) &&
    /^(?:NODE_OPTIONS|NODE_PATH|NODE_TEST_|NAPI_RS_|OXC_|LD_|DYLD_|TS_NODE_|TSX_|AGENT_TEAMS_|FOUNDATION_FIXTURE_|GIT_(?:OBJECT|ALTERNATE|REPLACE|SHALLOW|INDEX|WORK_TREE|DIR|CONFIG_COUNT|CONFIG_PARAMETERS)|PNPM_(?:HOME|PACKAGE|SUPPORTED)|npm_config_(?:node_options|node_linker|virtual_store|ignore_scripts|force|verify_store|platform|arch|libc|userconfig|globalconfig)|pnpm_config_(?:node_options|node_linker|virtual_store|platform|arch|libc))/iu.test(key));
  // These selftest inputs distinguish empty strings from absence (?? / undefined).
  const fixtureOverride = Object.keys(env).some(key => /^(?:CI_ER_|AE_ADOPTION_|CI_FOCUSED_EVIDENCE_DIR|FIXTURE_OWNER)/u.test(key));
  return !override && !fixtureOverride && facts.execArgv.length === 0 && facts.node === 'v24.21.0' && facts.pnpm === '11.18.0'
    && facts.platform === 'linux' && facts.arch === 'x64' && facts.glibc === '2.39'
    && Object.entries(expected).every(([key, value]) => env[key] === value)
    && /^\d{8}\.\d+(?:\.\d+)?$/u.test(env.ImageVersion ?? '');
}

function validateEvent(input: PrInput): void {
  assert.ok(supportedPrEnvironment(input.environment, input.runtime), 'unsupported runner/environment');
  assert.match(input.installation ?? '', /^[a-f0-9]{64}$/u, 'unclosed frozen installation');
  for (const sha of [input.base, input.head]) {assert.match(sha, /^[a-f0-9]{40}$/u, 'immutable SHA');}
  assert.notEqual(input.base, input.head, 'no candidate delta');
  const event = object(input.event), pr = object(event.pull_request), base = object(pr.base), head = object(pr.head);
  assert.ok(['opened', 'reopened', 'synchronize', 'ready_for_review'].includes(String(event.action)), 'unsupported PR action');
  assert.ok(Number.isSafeInteger(event.number) && Number(event.number) > 0, 'PR number');
  assert.equal(pr.number, event.number);
  for (const repo of [event.repository, base.repo, head.repo]) {assert.equal(object(repo).full_name, input.environment.GITHUB_REPOSITORY, 'untrusted PR repository');}
  assert.equal(object(head.repo).fork, false, 'fork PR is FULL');
  assert.equal(base.ref, 'main'); assert.equal(base.sha, input.base); assert.equal(head.sha, input.head);
  const ref = `refs/pull/${String(event.number)}/merge`;
  assert.equal(input.environment.GITHUB_REF, ref);
  assert.equal(input.environment.GITHUB_WORKFLOW_REF, `${input.environment.GITHUB_REPOSITORY}/.github/workflows/ci.yml@${ref}`, 'only the direct CI PR caller');
}

function snapshot(root: string, sha: string): { tree: string; leaves: Leaf[] } {
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, maxBuffer: 32 * 1024 * 1024 });
  assert.equal(git('rev-parse', `${sha}^{commit}`).toString().trim(), sha, 'commit identity');
  const raw = git('ls-tree', '-r', '-z', '--full-tree', sha);
  const source = raw.toString('utf8'); assert.ok(Buffer.from(source).equals(raw), 'unsupported Git path encoding');
  assert.ok(source.endsWith('\0'), 'incomplete tracked leaf census');
  const leaves = source.slice(0, -1).split('\0').map(row => {
    const match = /^(\d{6}) (blob|commit) ([a-f0-9]{40})\t([\s\S]+)$/u.exec(row);
    assert.ok(match, 'tracked leaf record');
    const [, mode, type, oid, path] = match;
    assert.ok(mode && type && oid && path && !path.startsWith('/') && !path.split('/').some(part => part === '..' || part === '.' || part === ''), 'tracked path');
    return { mode, type, oid, path };
  });
  assert.equal(new Set(leaves.map(leaf => leaf.path)).size, leaves.length);
  const objects = execFileSync('git', ['cat-file', '--batch-check'], { cwd: root, input: leaves.map(leaf => leaf.oid).join('\n') + '\n', encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }).trim().split('\n');
  assert.equal(objects.length, leaves.length);
  for (const [i, line] of objects.entries()) {assert.match(line, new RegExp(`^${leaves[i]!.oid} ${leaves[i]!.type} [0-9]+$`, 'u'), 'missing snapshot object');}
  return { tree: git('rev-parse', `${sha}^{tree}`).toString().trim(), leaves };
}

async function verifyCheckout(root: string, head: string, leaves: Leaf[]): Promise<void> {
  assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), head, 'checkout identity');
  assert.equal(execFileSync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=normal'], { cwd: root }).length, 0, 'unclosed worktree');
  const directories = new Set<string>();
  for (const leaf of leaves) {
    const parts = leaf.path.split('/');
    for (let i = 1; i < parts.length; i++) {directories.add(parts.slice(0, i).join('/'));}
    const stat = await lstat(join(root, leaf.path));
    if (leaf.mode === '120000') {
      assert.ok(leaf.type === 'blob' && stat.isSymbolicLink(), 'unsupported source kind');
      const bytes = Buffer.from(await readlink(join(root, leaf.path)));
      const oid = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
      assert.equal(oid, leaf.oid, 'actual checkout link target differs from H');
      continue;
    }
    assert.ok(leaf.type === 'blob' && ['100644', '100755'].includes(leaf.mode) && stat.isFile(), 'unsupported source kind');
    assert.equal((stat.mode & 0o111) !== 0, leaf.mode === '100755', 'checkout executable mode');
    const bytes = await readFile(join(root, leaf.path));
    const oid = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
    assert.equal(oid, leaf.oid, 'actual checkout bytes differ from H');
  }
  for (const path of directories) {assert.ok((await lstat(join(root, path))).isDirectory(), 'source parent kind');}
  const sourcePolicy = object(parse(await readFile(join(root, 'architecture/foundation/source-dependencies.yaml'), 'utf8')));
  assert.ok(Array.isArray(sourcePolicy.boundaries) && Array.isArray(sourcePolicy.governedRoots));
  const roots: unknown[] = [...sourcePolicy.governedRoots, ...sourcePolicy.boundaries.flatMap(value => {
    const boundary = object(value); assert.ok(Array.isArray(boundary.roots)); return boundary.roots;
  })];
  const paths = new Set(leaves.map(leaf => leaf.path));
  for (const path of roots) {
    assert.ok(typeof path === 'string' && !path.startsWith('/') && !path.split('/').includes('..'), 'policy root path');
    const stat = await lstat(join(root, path)).catch(error => {
      assert.equal((error as NodeJS.ErrnoException).code, 'ENOENT', 'unobserved root kind'); return null;
    });
    if (paths.has(path)) { assert.ok(stat?.isFile(), 'live policy file kind'); }
    else if (directories.has(path)) { assert.ok(stat?.isDirectory(), 'live policy directory kind'); }
    else { assert.equal(stat, null, 'unexpected ignored/untracked policy root'); }
  }
}

function ordinaryBody(path: string): boolean {
  return packageRoots.some(root => within(path, `${root}/src`) || within(path, `${root}/tests`))
    && /\.(?:[cm]?[jt]s)$/u.test(path)
    && !/(?:^|\/)(?:AGENTS|CLAUDE|GEMINI|package|tsconfig|[^/]*profile|[^/]*config)\.(?:md|json|ya?ml)$/iu.test(path);
}
function assertUniverse(leaves: Leaf[], policy: Policy): void {
  const manifests = leaves.filter(leaf => leaf.path === 'package.json' || leaf.path.endsWith('/package.json')).map(leaf => leaf.path).toSorted();
  assert.deepEqual(manifests, ['package.json', ...packageRoots.map(root => `${root}/package.json`)].toSorted(), 'fixed six roots / nested marker');
  for (const anchor of [...policy.foundationAnchors, ...policy.docsBodyAnchors, ...schedulingClosure]) {assert.ok(leaves.some(leaf => leaf.path === anchor && leaf.type === 'blob' && leaf.mode === '100644'), 'missing regression input');}
}
const scopeDigest = (leaves: Leaf[], select: (leaf: Leaf) => boolean) => sha256(JSON.stringify(leaves.filter(select)));
const leafInventory = (leaves: readonly Leaf[]): LeafInventory => ({ version: 1, digestScheme: 'git-object-sha1',
  inputs: leaves.map(leaf => {
    const membership = ordinaryBody(leaf.path) ? 'structural' : 'closed';
    if (leaf.type === 'blob' && (leaf.mode === '100644' || leaf.mode === '100755')) {
      return { path: leaf.path, type: 'file', mode: leaf.mode, membership, content: leaf.oid };
    }
    if (leaf.type === 'blob' && leaf.mode === '120000') {
      return { path: leaf.path, type: 'symlink', mode: leaf.mode, membership, content: leaf.oid };
    }
    if (leaf.type === 'commit' && leaf.mode === '160000') {
      return { path: leaf.path, type: 'gitlink', mode: leaf.mode, membership, content: leaf.oid };
    }
    throw new Error('public inventory mode');
  }),
});

export async function classifyPrRegressions(root: string, input: PrInput, compareLeafInventories: LeafInventoryComparator): Promise<PrPlan> {
  const full: PrPlan = { protocol: 'pr-regression-sampling/1', mode: 'full', base: input.base, head: input.head,
    changed: [], run: [...regressionIds], deferred: [], reason: 'uncertain inputs', installation: input.installation };
  try {
    const policy: Policy = JSON.parse(await readFile(join(root, policyPath), 'utf8'));
    assert.equal(policy.schemaVersion, 1);
    assert.deepEqual(policy.packageRoots, packageRoots);
    assert.equal(policy.foundationAnchors.length, 16);
    assert.equal(new Set(policy.foundationAnchors).size, 16);
    assert.deepEqual(Object.keys(policy.regressions), regressionIds);
    assert.deepEqual(policy.regressions, regressionCommands, 'regression command policy drift');
    validateEvent(input);
    const base = snapshot(root, input.base), head = snapshot(root, input.head);
    full.baseTree = base.tree; full.headTree = head.tree;
    assertUniverse(base.leaves, policy); assertUniverse(head.leaves, policy);
    const relation = compareLeafInventories(leafInventory(base.leaves), leafInventory(head.leaves),
      base.leaves.filter(leaf => ordinaryBody(leaf.path)).map(leaf => leaf.path));
    if (relation.status === 'rejected') {throw new Error(`input comparison rejected: ${relation.reason}`);}
    assert.equal(relation.status, 'compatible-inputs', 'unsupported public comparator relation');
    const contentChanges = new Set(relation.changedContentPaths);
    // Preserve the consumer's Git inventory order; the kernel owns comparison only.
    full.changed = head.leaves.filter(leaf => contentChanges.has(leaf.path)).map(leaf => leaf.path);
    assert.ok(full.changed.length > 0, 'no ordinary body delta');
    await verifyCheckout(root, input.head, head.leaves);
    const changed = new Set(full.changed);
    const selects: Record<RegressionId, (leaf: Leaf) => boolean> = {
      'foundation-negative': leaf => policy.foundationAnchors.includes(leaf.path),
      fms: () => false,
      'cms-regression': leaf => policy.cmsBodyRoots.some(bodyRoot => within(leaf.path, bodyRoot)),
      // CI fixtures execute synthetic bodies; actual runner/test/policy inputs
      // are common. Membership/kinds/modes and the installed envelope close above.
      'ci-selftests': leaf => !ordinaryBody(leaf.path),
      'docs-portable': leaf => policy.docsBodyAnchors.includes(leaf.path),
    };
    const scopes = { common: scopeDigest(head.leaves, leaf => !ordinaryBody(leaf.path)),
      baseCommon: scopeDigest(base.leaves, leaf => !ordinaryBody(leaf.path)),
      structure: sha256(JSON.stringify(head.leaves.map(({ path, mode, type }) => ({ path, mode, type })))) };
    const deferred = regressionIds.filter(id => !head.leaves.some(leaf => changed.has(leaf.path) && selects[id](leaf)));
    for (const id of regressionIds) {Object.assign(scopes, { [id]: scopeDigest(head.leaves, selects[id]), [`base:${id}`]: scopeDigest(base.leaves, selects[id]) });}
    return { ...full, mode: 'affected-pr', run: regressionIds.filter(id => !deferred.includes(id)), deferred, scopes,
      reason: 'Complete B/H membership, modes, common bytes and whole regression inputs unchanged; all product obligations remain FULL.' };
  } catch (error) {
    return { ...full, reason: error instanceof Error ? error.message.split('\n')[0]! : 'uncertain inputs' };
  }
}

// Current installation observation, never a fingerprint of an unobserved past run.
// Walk actual files once; record known pnpm links without traversing their source
// targets. Published files (including both native parser versions) are included.
export async function installationFingerprint(root: string): Promise<string> {
  const modules = resolve(root, 'node_modules'), store = join(modules, '.pnpm');
  const entries: unknown[] = [];
  const visit = async (path: string): Promise<void> => {
    const stat = await lstat(path), name = relative(modules, path);
    if (stat.isSymbolicLink()) {
      const target = await realpath(path);
      assert.ok(within(target, store) || packageRoots.some(packageRoot => target === resolve(root, packageRoot)), 'unqualified installed link');
      entries.push([name, 'link', await readlink(path), relative(root, target)]);
    } else if (stat.isDirectory()) {
      entries.push([name, 'directory', stat.mode & 0o777]);
      for (const child of (await readdir(path)).toSorted()) {await visit(join(path, child));}
    } else {
      assert.ok(stat.isFile(), 'unqualified installed kind');
      entries.push([name, 'file', stat.mode & 0o777, sha256(await readFile(path))]);
    }
  };
  await visit(modules);
  return sha256(JSON.stringify(entries));
}

export async function currentPrInput(root: string, env: NodeJS.ProcessEnv): Promise<PrInput> {
  const runtime: RuntimeFacts = { node: process.version, platform: process.platform, arch: process.arch,
    pnpm: execFileSync('pnpm', ['--version'], { cwd: root, encoding: 'utf8' }).trim(), execArgv: process.execArgv,
    glibc: String(object(process.report.getReport()).header && object(object(process.report.getReport()).header).glibcVersionRuntime || '') };
  const input: PrInput = { base: env.EXPECTED_BASE_REVISION ?? '', head: env.EXPECTED_REVISION ?? '', environment: env, runtime, event: {} };
  try {
    input.event = JSON.parse(await readFile(env.GITHUB_EVENT_PATH ?? '', 'utf8'));
    assert.ok(supportedPrEnvironment(env, runtime));
    assert.deepEqual(parse(await readFile(join(root, 'pnpm-lock.yaml'), 'utf8')), parse(await readFile(join(root, 'node_modules/.pnpm/lock.yaml'), 'utf8')), 'installed lock drift');
    const modules = object(parse(await readFile(join(root, 'node_modules/.modules.yaml'), 'utf8')));
    assert.equal(modules.packageManager, 'pnpm@11.18.0'); assert.equal(modules.virtualStoreDir, '.pnpm');
    assert.ok(modules.virtualStoreOnly === undefined || modules.virtualStoreOnly === false,
      'installed virtual-store-only layout cannot admit the optimizer');
    input.installation = await installationFingerprint(root);
  } catch { /* Absence, stale installation or unsupported ambient always select FULL. */ }
  return input;
}
