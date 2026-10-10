import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, open, readFile, readdir, readlink, realpath } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve as resolvePath, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageName = '@agent-teams/ci-input-proof';
const packageVersion = '0.1.0';
const packageRequest = `${packageName}@${packageVersion}`;
const optimizerEntrypoint = 'dist/index.js';
const expectedPackageManager = 'pnpm@11.18.0';
const expectedVirtualStoreDir = '.pnpm';
export const installationMetadataMaxBytes = 64 * 1024;
const groups = ['quick', 'foundation', 'architecture', 'docs'] as const;
type Group = typeof groups[number];

const publishedPackage = {
  integrity: 'sha512-PA2/mlS1Ko2dyg79fmveKwNKszCBDhMexAZx82WfY2NjccwCxCOqXT5XWMFuYUzFXDzQSgPq4xF2YbDsXJeBwQ==',
  archiveSha256: '463da396e04acb4fbe19ddff7a4e88e576b1834faa49eeed7334a5ebf4a4f0a3',
  files: {
    'CHANGELOG.md': '7659580d7da0fe6601e7fd9090bbd466056bca3f6c83f34041c67eb738b36b4c',
    'LICENSE': 'c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4',
    'README.md': '69d9924e046b9061847ab48bc830a1582f6b28822a819cc0da8d44bafff25196',
    'dist/features/input-comparison/application/compare-leaf-inventories.d.ts': 'a36d5140341daa691cf718b7a9ec19ac319cd5f26fdd5abaa6978897daf5a3ec',
    'dist/features/input-comparison/application/compare-leaf-inventories.d.ts.map': '793914a89fff6db521db675f53e0755bec6cb1e1b4ac0a7d4c49c4ffe18db8f8',
    'dist/features/input-comparison/application/compare-leaf-inventories.js': 'd7ef5d81d988531a9cf8fddfd2f1e9582eb153fffac405bdfaa5774b18dd17ee',
    'dist/features/input-comparison/application/compare-leaf-inventories.js.map': '512ca3deb0c754bf08913e6e4eb4c3eb4b4c28437061a9a6e77eb0a2f4c892c3',
    'dist/index.d.ts': '4812320d2fd19162084c78db8402b23ede3ffa838ee2c051709348f9a1142412',
    'dist/index.d.ts.map': '09602ae7e769956a924f2163beafb2452c55ee67e93bb060e654ce8c6d911948',
    'dist/index.js': 'ffbd3ebad0cc8596888a9c7b94d2048f88c946e72f055f59d485291cc3d68ab0',
    'dist/index.js.map': '2416200c4f896cb6da1c524d7514beb3291a4e77470ca692a2737dda6db71cb2',
    'package.json': 'eaefcb0451b322108fc6dc6d4aa90fd94a92606c9d25b6146b0d4fa1adae5ffd',
  },
} as const;

const controlPaths = [
  '.github/workflows/ci-foundation-route.yml',
  '.github/workflows/ci-pr-regressions.yml',
  '.github/workflows/ci-lane.yml',
  '.github/workflows/ci.yml',
  'architecture/foundation/ci-pr-regressions.json',
  'architecture/foundation/source-dependencies.yaml',
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'scripts/ci/contracts.test.ts',
  'scripts/ci/conformance.ts',
  'scripts/ci/measure.ts',
  'scripts/ci/pr-regression-bootstrap.ts',
  'scripts/ci/pr-regression-bootstrap.test.ts',
  'scripts/ci/pr-regression-command.ts',
  'scripts/ci/pr-regression-inputs.ts',
  'scripts/ci/pr-regression-inputs.test.ts',
  'scripts/docs/consumer-migration.test.mjs',
  'scripts/sdk-growth-source/fixtures',
] as const;

const packageRoots = ['packages/apps/embedded-runtime', 'packages/contexts/agent-execution',
  'packages/contexts/provider-access', 'packages/contexts/runtime-configuration', 'packages/contexts/runtime-security',
  'packages/platform/filesystem-custody'] as const;

interface Leaf { path: string; mode: string; type: string; oid: string }
interface SourceSnapshot { tree: string; leaves: Leaf[] }
interface InstalledEntry { path: string; kind: 'file' | 'directory' | 'link'; mode: number; digest?: string; target?: string }
type InventoryRelation = { status: 'compatible-inputs'; changedContentPaths: readonly string[] }
  | { status: 'rejected'; reason: 'malformed-inventory' | 'unsupported-version' | 'unsupported-scheme' | 'scheme-mismatch'
    | 'duplicate-input' | 'incomplete-inputs' | 'invalid-content-permission' | 'input-structure-changed'
    | 'closed-input-changed' | 'exceeded-limit' };
type InventoryComparator = (base: unknown, head: unknown, structuralPaths: readonly string[]) => InventoryRelation;

const sha256 = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const within = (path: string, root: string) => path.startsWith(`${root}/`);
const object = (value: unknown): Record<string, unknown> => {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
};
function exportValues(value: unknown): string[] {
  return typeof value === 'string' ? [value]
    : value !== null && typeof value === 'object' ? Object.values(value).flatMap(exportValues) : [];
}

interface JsonCursor { index: number }
interface JsonStringToken { raw: string; value: string }

function skipJsonWhitespace(source: string, cursor: JsonCursor): void {
  while (cursor.index < source.length && [0x09, 0x0a, 0x0d, 0x20].includes(source.charCodeAt(cursor.index))) {cursor.index++;}
}

function parseJsonString(source: string, cursor: JsonCursor): JsonStringToken {
  assert.equal(source[cursor.index], '"', 'installed metadata string expected');
  const start = cursor.index++;
  while (cursor.index < source.length) {
    const code = source.charCodeAt(cursor.index++);
    if (code === 0x22) {
      const raw = source.slice(start, cursor.index);
      return { raw, value: JSON.parse(raw) as string };
    }
    if (code !== 0x5c) {
      assert.ok(code >= 0x20, 'installed metadata string contains an unescaped control character');
      continue;
    }
    assert.ok(cursor.index < source.length, 'installed metadata string escape is incomplete');
    const escape = source[cursor.index++]!;
    if (escape !== 'u') {
      assert.ok('"\\/bfnrt'.includes(escape), 'installed metadata string escape is invalid');
      continue;
    }
    assert.ok(cursor.index + 4 <= source.length, 'installed metadata Unicode escape is incomplete');
    for (const digit of source.slice(cursor.index, cursor.index + 4)) {
      assert.ok((digit >= '0' && digit <= '9') || (digit >= 'a' && digit <= 'f') || (digit >= 'A' && digit <= 'F'),
        'installed metadata Unicode escape is invalid');
    }
    cursor.index += 4;
  }
  throw new Error('installed metadata string is incomplete');
}

function scanJsonValue(source: string, cursor: JsonCursor, keys: JsonStringToken[]): void {
  skipJsonWhitespace(source, cursor);
  const value = source[cursor.index];
  assert.ok(value !== undefined, 'installed metadata value is incomplete');
  if (value === '{') {scanJsonObject(source, cursor, keys); return;}
  if (value === '[') {scanJsonArray(source, cursor, keys); return;}
  if (value === '"') {parseJsonString(source, cursor); return;}
  const start = cursor.index;
  while (cursor.index < source.length && !',]}'.includes(source[cursor.index]!)
    && ![0x09, 0x0a, 0x0d, 0x20].includes(source.charCodeAt(cursor.index))) {cursor.index++;}
  assert.ok(cursor.index > start, 'installed metadata value is empty');
}

function scanJsonObject(source: string, cursor: JsonCursor, keys: JsonStringToken[]): void {
  cursor.index++;
  skipJsonWhitespace(source, cursor);
  if (source[cursor.index] === '}') {cursor.index++; return;}
  while (true) {
    skipJsonWhitespace(source, cursor);
    keys.push(parseJsonString(source, cursor));
    skipJsonWhitespace(source, cursor);
    assert.equal(source[cursor.index], ':', 'installed metadata property separator');
    cursor.index++;
    scanJsonValue(source, cursor, keys);
    skipJsonWhitespace(source, cursor);
    const separator = source[cursor.index];
    assert.ok(separator === ',' || separator === '}', 'installed metadata object is incomplete');
    cursor.index++;
    if (separator === '}') {return;}
  }
}

function scanJsonArray(source: string, cursor: JsonCursor, keys: JsonStringToken[]): void {
  cursor.index++;
  skipJsonWhitespace(source, cursor);
  if (source[cursor.index] === ']') {cursor.index++; return;}
  while (true) {
    scanJsonValue(source, cursor, keys);
    skipJsonWhitespace(source, cursor);
    const separator = source[cursor.index];
    assert.ok(separator === ',' || separator === ']', 'installed metadata array is incomplete');
    cursor.index++;
    if (separator === ']') {return;}
  }
}

function jsonObjectKeys(source: string): JsonStringToken[] {
  const cursor: JsonCursor = { index: 0 }, keys: JsonStringToken[] = [];
  scanJsonValue(source, cursor, keys);
  skipJsonWhitespace(source, cursor);
  assert.equal(cursor.index, source.length, 'installed metadata has trailing content');
  return keys;
}

export function parseInstallationMetadata(bytes: Buffer): { packageManager: string; virtualStoreDir: string } {
  assert.ok(bytes.byteLength <= installationMetadataMaxBytes, 'installed metadata exceeds bounded parse');
  const source = bytes.toString('utf8');
  assert.equal(Buffer.byteLength(source, 'utf8'), bytes.byteLength, 'installed metadata is not UTF-8');
  const sourceKeys = jsonObjectKeys(source);
  const identityKeys = (name: 'packageManager' | 'virtualStoreDir' | 'virtualStoreOnly'): readonly string[] =>
    sourceKeys.filter(key => key.value === name).map(key => key.raw);
  const packageManagerKeys = identityKeys('packageManager');
  const virtualStoreDirKeys = identityKeys('virtualStoreDir');
  const virtualStoreOnlyKeys = identityKeys('virtualStoreOnly');
  assert.equal(packageManagerKeys.length, 1, 'installed pnpm identity key drift');
  assert.equal(virtualStoreDirKeys.length, 1, 'installed store layout key drift');
  assert.ok(virtualStoreOnlyKeys.length <= 1, 'installed virtual-store-only key drift');
  assert.equal(packageManagerKeys[0], '"packageManager"', 'installed pnpm identity key spelling drift');
  assert.equal(virtualStoreDirKeys[0], '"virtualStoreDir"', 'installed store layout key spelling drift');
  assert.ok(virtualStoreOnlyKeys.length === 0 || virtualStoreOnlyKeys[0] === '"virtualStoreOnly"',
    'installed virtual-store-only key spelling drift');
  const parsed: unknown = JSON.parse(source);
  assert.ok(parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed), 'installed metadata is not a JSON object');
  const metadata = parsed as Record<string, unknown>;
  assert.equal(metadata.packageManager, expectedPackageManager, 'installed pnpm identity drift');
  assert.equal(metadata.virtualStoreDir, expectedVirtualStoreDir, 'installed store layout drift');
  assert.ok(metadata.virtualStoreOnly === undefined || metadata.virtualStoreOnly === false,
    'installed virtual-store-only layout cannot admit the optimizer');
  return { packageManager: expectedPackageManager, virtualStoreDir: expectedVirtualStoreDir };
}

async function readInstallationMetadata(path: string): Promise<Buffer> {
  assert.ok((await lstat(path)).isFile(), 'installed metadata kind');
  const handle = await open(path, 'r');
  try {
    const bytes = Buffer.allocUnsafe(installationMetadataMaxBytes + 1);
    let length = 0;
    while (length < bytes.byteLength) {
      const read = await handle.read(bytes, length, bytes.byteLength - length, length);
      if (read.bytesRead === 0) {break;}
      length += read.bytesRead;
    }
    assert.ok(length <= installationMetadataMaxBytes, 'installed metadata exceeds bounded parse');
    return Buffer.from(bytes.subarray(0, length));
  } finally {
    await handle.close();
  }
}

function git(root: string, args: readonly string[], input?: Buffer): Buffer {
  return execFileSync('git', [...args], { cwd: root, input, maxBuffer: 32 * 1024 * 1024 });
}

function spawnStatus(child: ReturnType<typeof spawn>): Promise<number | null> {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
}

function snapshot(root: string, sha: string): SourceSnapshot {
  const raw = git(root, ['ls-tree', '-r', '-z', '--full-tree', sha]);
  const source = raw.toString('utf8');
  assert.ok(Buffer.from(source).equals(raw), 'unsupported Git path encoding');
  assert.ok(source.endsWith('\0'), 'incomplete tracked leaf census');
  const leaves = source.slice(0, -1).split('\0').map(row => {
    const match = /^(\d{6}) (blob|commit) ([a-f0-9]{40})\t([\s\S]+)$/u.exec(row);
    assert.ok(match, 'tracked leaf record');
    const [, mode, type, oid, path] = match;
    assert.ok(mode && type && oid && path && !path.startsWith('/') && !path.split('/').some(part => part === '..' || part === '.' || part === ''), 'tracked path');
    return { mode, type, oid, path };
  });
  assert.equal(new Set(leaves.map(leaf => leaf.path)).size, leaves.length);
  const objects = git(root, ['cat-file', '--batch-check'], Buffer.from(`${leaves.map(leaf => leaf.oid).join('\n')}\n`)).toString('utf8').trim().split('\n');
  assert.equal(objects.length, leaves.length);
  for (const [index, line] of objects.entries()) {
    assert.match(line, new RegExp(`^${leaves[index]!.oid} ${leaves[index]!.type} [0-9]+$`, 'u'), 'missing snapshot object');
  }
  return { tree: git(root, ['rev-parse', `${sha}^{tree}`]).toString('utf8').trim(), leaves };
}

function ordinaryBody(path: string): boolean {
  return packageRoots.some(root => within(path, `${root}/src`) || within(path, `${root}/tests`))
    && /\.(?:[cm]?[jt]s)$/u.test(path)
    && !/(?:^|\/)(?:AGENTS|CLAUDE|GEMINI|package|tsconfig|[^/]*profile|[^/]*config)\.(?:md|json|ya?ml)$/iu.test(path);
}

function changedControlPath(base: Leaf[], head: Leaf[]): boolean {
  const before = new Map(base.map(leaf => [leaf.path, leaf])), after = new Map(head.map(leaf => [leaf.path, leaf]));
  for (const path of new Set([...before.keys(), ...after.keys()])) {
    const left = before.get(path), right = after.get(path);
    if (!left || !right || left.mode !== right.mode || left.type !== right.type) {return true;}
    if (left.oid !== right.oid && (controlPaths.some(control => path === control || within(path, `${control}/`)) || !ordinaryBody(path))) {return true;}
  }
  return false;
}

async function assertCheckout(root: string, head: string, leaves: readonly Leaf[]): Promise<void> {
  assert.equal(git(root, ['rev-parse', 'HEAD']).toString('utf8').trim(), head, 'checkout identity');
  assert.equal(git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=normal']).length, 0, 'unclosed worktree');
  for (const leaf of leaves) {
    const path = resolvePath(root, leaf.path);
    assert.ok(relative(root, path).split(sep).every(part => part !== '..'), 'tracked path escapes root');
    const stat = await lstat(path);
    if (leaf.mode === '120000') {
      assert.ok(leaf.type === 'blob' && stat.isSymbolicLink(), 'unsupported source kind');
      const target = await readlink(path);
      const bytes = Buffer.from(target);
      const oid = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
      assert.equal(oid, leaf.oid, 'actual checkout link target differs from H');
      continue;
    }
    assert.ok(leaf.type === 'blob' && ['100644', '100755'].includes(leaf.mode) && stat.isFile(), 'unsupported source kind');
    assert.equal((stat.mode & 0o111) !== 0, leaf.mode === '100755', 'checkout executable mode');
    const bytes = await readFile(path);
    const oid = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
    assert.equal(oid, leaf.oid, 'actual checkout bytes differ from H');
  }
}

async function validateEvent(root: string, env: NodeJS.ProcessEnv, base: string, head: string): Promise<void> {
  const expected = { GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'pull_request', GITHUB_REPOSITORY: 'agent-teams-ai/agent-runtime',
    RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'Linux', RUNNER_ARCH: 'X64', ImageOS: 'ubuntu24', PR_REGRESSION_FROZEN_INSTALL: 'verified' };
  const override = Object.entries(env).some(([key, value]) => Boolean(value) &&
    /^(?:NODE_OPTIONS|NODE_PATH|NODE_TEST_|NAPI_RS_|OXC_|LD_|DYLD_|TS_NODE_|TSX_|AGENT_TEAMS_|FOUNDATION_FIXTURE_|GIT_(?:OBJECT|ALTERNATE|REPLACE|SHALLOW|INDEX|WORK_TREE|DIR|CONFIG_COUNT|CONFIG_PARAMETERS)|PNPM_(?:HOME|PACKAGE|SUPPORTED)|npm_config_(?:node_options|node_linker|virtual_store|ignore_scripts|force|verify_store|platform|arch|libc|userconfig|globalconfig)|pnpm_config_(?:node_options|node_linker|virtual_store|platform|arch|libc))/iu.test(key));
  const fixtureOverride = Object.keys(env).some(key => /^(?:CI_ER_|AE_ADOPTION_|CI_FOCUSED_EVIDENCE_DIR|FIXTURE_OWNER)/u.test(key));
  assert.ok(!override && !fixtureOverride && process.execArgv.length === 0 && process.version === 'v24.21.0'
    && process.platform === 'linux' && process.arch === 'x64' && /^\d{8}\.\d+(?:\.\d+)?$/u.test(env.ImageVersion ?? '')
    && Object.entries(expected).every(([key, value]) => env[key] === value), 'unsupported runner/environment');
  assert.match(base, /^[a-f0-9]{40}$/u); assert.match(head, /^[a-f0-9]{40}$/u); assert.notEqual(base, head);
  const event = object(JSON.parse((await readFile(resolvePath(root, env.GITHUB_EVENT_PATH ?? ''))).toString('utf8')));
  const pr = object(event.pull_request), baseObject = object(pr.base), headObject = object(pr.head);
  assert.ok(['opened', 'reopened', 'synchronize', 'ready_for_review'].includes(String(event.action)), 'unsupported PR action');
  assert.ok(Number.isSafeInteger(event.number) && Number(event.number) > 0, 'PR number'); assert.equal(pr.number, event.number);
  for (const repo of [event.repository, baseObject.repo, headObject.repo]) {assert.equal(object(repo).full_name, env.GITHUB_REPOSITORY, 'untrusted PR repository');}
  assert.equal(object(headObject.repo).fork, false, 'fork PR is FULL');
  assert.equal(baseObject.ref, 'main'); assert.equal(baseObject.sha, base); assert.equal(headObject.sha, head);
  assert.equal(env.GITHUB_REF, `refs/pull/${String(event.number)}/merge`);
  assert.equal(env.GITHUB_WORKFLOW_REF, `${env.GITHUB_REPOSITORY}/.github/workflows/ci.yml@refs/pull/${String(event.number)}/merge`, 'only the direct CI PR caller');
}

async function installedEntries(root: string): Promise<InstalledEntry[]> {
  const modules = resolvePath(root, 'node_modules'), store = join(modules, '.pnpm'), entries: InstalledEntry[] = [];
  const visit = async (path: string): Promise<void> => {
    const stat = await lstat(path), name = relative(modules, path).replaceAll(sep, '/');
    if (stat.isSymbolicLink()) {
      const target = await realpath(path);
      assert.ok(within(target, store) || packageRoots.some(packageRoot => target === resolvePath(root, packageRoot)), 'unqualified installed link');
      entries.push({ path: name, kind: 'link', mode: stat.mode & 0o777, target: await readlink(path) });
    } else if (stat.isDirectory()) {
      entries.push({ path: name, kind: 'directory', mode: stat.mode & 0o777 });
      for (const child of (await readdir(path)).toSorted()) {await visit(join(path, child));}
    } else {
      assert.ok(stat.isFile(), 'unqualified installed kind');
      entries.push({ path: name, kind: 'file', mode: stat.mode & 0o777, digest: sha256(await readFile(path)) });
    }
  };
  await visit(modules);
  return entries;
}

async function packageEntries(packageDirectory: string): Promise<InstalledEntry[]> {
  const entries: InstalledEntry[] = [];
  const visit = async (path: string): Promise<void> => {
    const stat = await lstat(path), name = relative(packageDirectory, path).replaceAll(sep, '/');
    if (stat.isSymbolicLink()) {throw new Error('optimizer package contains a symlink');}
    if (stat.isDirectory()) {
      entries.push({ path: name, kind: 'directory', mode: stat.mode & 0o777 });
      for (const child of (await readdir(path)).toSorted()) {await visit(join(path, child));}
    } else if (stat.isFile()) {
      entries.push({ path: name, kind: 'file', mode: stat.mode & 0o777, digest: sha256(await readFile(path)) });
    } else {throw new Error('optimizer package contains an unsupported kind');}
  };
  await visit(packageDirectory);
  return entries;
}

async function packageSource(root: string): Promise<{ directory: string; entries: InstalledEntry[]; integrity: string; entrypoints: string[] }> {
  const modules = await realpath(resolvePath(root, 'node_modules'));
  const publicDirectory = join(modules, ...packageName.split('/'));
  const manifestPath = join(publicDirectory, 'package.json');
  assert.ok((await lstat(publicDirectory)).isSymbolicLink(), 'optimizer public package link missing');
  const storeDirectory = join(modules, '.pnpm', '@agent-teams+ci-input-proof@0.1.0', 'node_modules', ...packageName.split('/'));
  const directory = await realpath(storeDirectory);
  assert.equal(directory, storeDirectory, 'optimizer target escapes the expected pnpm store');
  assert.equal(await realpath(publicDirectory), directory, 'optimizer public link target drift');
  assert.equal(await realpath(manifestPath), join(directory, 'package.json'), 'optimizer manifest target drift');
  assert.equal(await readlink(publicDirectory), relative(dirname(publicDirectory), directory).replaceAll(sep, '/'), 'optimizer public link spelling drift');
  assert.ok((await lstat(directory)).isDirectory(), 'optimizer store package kind');
  const entries = await packageEntries(directory);
  const actualFiles = Object.fromEntries(entries.filter(entry => entry.kind === 'file')
    .map(entry => [entry.path, entry.digest]).toSorted(([left], [right]) => left!.localeCompare(right!)));
  assert.deepEqual(actualFiles, Object.fromEntries(Object.entries(publishedPackage.files)
    .toSorted(([left], [right]) => left!.localeCompare(right!))), 'published optimizer source census drift');
  const manifestPathInStore = join(directory, 'package.json');
  const manifestBytes = await readFile(manifestPathInStore);
  assert.equal(sha256(manifestBytes), publishedPackage.files['package.json'], 'optimizer manifest anchor drift');
  const manifest = object(JSON.parse(manifestBytes.toString('utf8')));
  assert.equal(manifest.name, packageName); assert.equal(manifest.version, packageVersion);
  const lock = (await readFile(resolvePath(root, 'pnpm-lock.yaml'))).toString('utf8');
  assert.equal((await readFile(resolvePath(root, 'node_modules/.pnpm/lock.yaml'))).toString('utf8'), lock, 'installed lock drift');
  const integrity = new RegExp(`${packageRequest.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}[\\s\\S]*?integrity: (sha512-[A-Za-z0-9+/=]+)`, 'u').exec(lock)?.[1];
  assert.equal(integrity, publishedPackage.integrity, 'optimizer lock integrity anchor drift');
  const rootExport = manifest.exports !== null && typeof manifest.exports === 'object'
    ? object(manifest.exports)['.'] ?? manifest.exports : manifest.exports ?? manifest.main ?? manifest.module;
  const entrypoints = exportValues(rootExport).map(path => path.replace(/^\.\//u, ''))
    .filter(path => ['.js', '.mjs', '.cjs'].includes(extname(path))).toSorted();
  assert.deepEqual(entrypoints, [optimizerEntrypoint], 'optimizer entrypoint drift');
  const staticImport = /(?:import|export)\s+(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)|require\(\s*["']([^"']+)["']\s*\)/gu;
  const pending = [...entrypoints], closed = new Set<string>();
  while (pending.length > 0) {
    const path = pending.pop()!; if (closed.has(path)) {continue;} closed.add(path);
    assert.ok(entries.some(entry => entry.path === path && entry.kind === 'file'), `optimizer entry source missing: ${path}`);
    const bytes = await readFile(join(directory, path));
    assert.equal(sha256(bytes), publishedPackage.files[path as keyof typeof publishedPackage.files],
      `optimizer control source anchor drift: ${path}`);
    const source = bytes.toString('utf8');
    for (const match of source.matchAll(staticImport)) {
      const request = match[1] ?? match[2] ?? match[3];
      assert.ok(request, 'optimizer import request');
      if (match[2] || match[3]) {throw new Error('optimizer control source must be statically closed');}
      assert.ok(request.startsWith('./') || request.startsWith('../'), 'optimizer control source has an external import');
      const target = relative(directory, resolvePath(dirname(join(directory, path)), request)).replaceAll(sep, '/');
      assert.ok(!target.startsWith('../') && entries.some(entry => entry.path === target && entry.kind === 'file'), `optimizer import escapes closure: ${request}`);
      pending.push(target);
    }
  }
  assert.deepEqual([...closed].toSorted(), Object.keys(publishedPackage.files).filter(path => path.endsWith('.js')).toSorted(),
    'optimizer executable source closure is incomplete');
  return { directory, entries, integrity, entrypoints };
}

async function bindInstallation(root: string): Promise<{ digest: string; optimizer: Awaited<ReturnType<typeof packageSource>> }> {
  const rootLock = await readFile(resolvePath(root, 'pnpm-lock.yaml'));
  assert.ok(rootLock.equals(await readFile(resolvePath(root, 'node_modules/.pnpm/lock.yaml'))), 'installed lock drift');
  parseInstallationMetadata(await readInstallationMetadata(resolvePath(root, 'node_modules/.modules.yaml')));
  const optimizer = await packageSource(root);
  return { digest: sha256(JSON.stringify(await installedEntries(root))), optimizer };
}

async function runFull(group: Group, root: string, env: NodeJS.ProcessEnv): Promise<number> {
  const fullEnv = { ...env };
  for (const key of ['FOUNDATION_FIXTURE_PROTOCOL', 'FOUNDATION_FIXTURE_INDEX', 'FOUNDATION_FIXTURE_COUNT']) {delete fullEnv[key];}
  const child = spawn(process.execPath, ['scripts/ci/measure.ts', `check:ci:${group}`], { cwd: root, env: fullEnv, stdio: ['ignore', 'inherit', 'inherit'] });
  return (await spawnStatus(child)) ?? 1;
}

export async function runBootstrap(group: Group, root = process.cwd(), env: NodeJS.ProcessEnv = process.env): Promise<number> {
  assert.ok(groups.includes(group), 'known PR group');
  const base = env.EXPECTED_BASE_REVISION ?? '', head = env.EXPECTED_REVISION ?? '';
  let admitted: Awaited<ReturnType<typeof bindInstallation>> | undefined;
  try {
    await validateEvent(root, env, base, head);
    const before = snapshot(root, base), after = snapshot(root, head);
    assert.equal(git(root, ['rev-parse', `${base}^{commit}`]).toString('utf8').trim(), base);
    assert.equal(git(root, ['rev-parse', `${head}^{commit}`]).toString('utf8').trim(), head);
    assert.ok(!changedControlPath(before.leaves, after.leaves), 'bootstrap/control source changed or uncertain');
    await assertCheckout(root, head, after.leaves);
    admitted = await bindInstallation(root);
  } catch {
    return runFull(group, root, env);
  }
  try {
    const comparator = await import('@agent-teams/ci-input-proof') as
      { compareLeafInventories: InventoryComparator };
    assert.equal(typeof comparator.compareLeafInventories, 'function', 'optimizer kernel missing');
    const inputModule = await import('./pr-regression-inputs.ts') as
      { currentPrInput: (root: string, env: NodeJS.ProcessEnv) => Promise<unknown>; classifyPrRegressions: (root: string, input: unknown, compare: InventoryComparator) => Promise<{ mode: 'full' | 'affected-pr' }> };
    const commandModule = await import('./pr-regression-command.ts') as
      { runPrRegressions: (group: Group, output: string, compare: InventoryComparator, input: unknown) => Promise<void> };
    const input = await inputModule.currentPrInput(root, env);
    const compare = comparator.compareLeafInventories;
    const plan = await inputModule.classifyPrRegressions(root, input, compare);
    const afterImport = await bindInstallation(root);
    assert.equal(afterImport.digest, admitted.digest, 'installed optimizer/control source drift before execution');
    if (plan.mode === 'full') {return runFull(group, root, env);}
    await commandModule.runPrRegressions(group, env.CI_EVIDENCE_DIR ?? 'tmp/root-export-evidence/pr-regressions', compare, input);
    const beforeLeaves = snapshot(root, env.EXPECTED_BASE_REVISION!), headLeaves = snapshot(root, env.EXPECTED_REVISION!);
    assert.ok(!changedControlPath(beforeLeaves.leaves, headLeaves.leaves), 'source drift during sampled execution');
    await assertCheckout(root, env.EXPECTED_REVISION!, headLeaves.leaves);
    assert.equal((await bindInstallation(root)).digest, admitted.digest, 'installed drift during sampled execution');
    return 0;
  } catch {
    return runFull(group, root, env);
  }
}

if (process.argv[1] && resolvePath(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const group = process.argv[2]?.replace('check:ci:', '') as Group | undefined;
  process.exitCode = await runBootstrap(group ?? ('unknown' as Group));
}
