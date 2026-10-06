import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { assertNamespaceNativeQualification } from './namespace-qualification-contract.ts';

const root = process.cwd();
const directory = process.env.CI_EVIDENCE_DIR ?? '';
const evidenceRelative = relative(root, resolve(directory));
assert.ok(isAbsolute(directory) && (evidenceRelative === '..' || evidenceRelative.startsWith(`..${sep}`)), 'external evidence directory required');
const observe = (executable: string, argv: string[]) => {
  const startedAt = new Date().toISOString();
  const result = spawnSync(executable, argv, { cwd: root, encoding: 'utf8', timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });
  return { executable, argv, startedAt, endedAt: new Date().toISOString(), exitCode: result.status,
    signal: result.signal, error: result.error?.message ?? null, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
};
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const probes = {
  revision: observe('git', ['rev-parse', 'HEAD']), tree: observe('git', ['rev-parse', 'HEAD^{tree}']),
  sourceDrift: observe('git', ['diff', '--exit-code', 'HEAD', '--']),
  pnpm: observe('pnpm', ['--version']), os: observe('/usr/bin/sw_vers', []), machine: observe('/usr/bin/uname', ['-a']),
  compiler: observe('/usr/bin/clang', ['--version']), compilerPath: observe('/usr/bin/xcrun', ['--find', 'clang']),
  sdkPath: observe('/usr/bin/xcrun', ['--show-sdk-path']), sdkVersion: observe('/usr/bin/xcrun', ['--show-sdk-version']),
};
const nativePath = join(root, 'packages/platform/filesystem-custody/dist/rename-no-replace.node');
const nativeExists = await stat(nativePath).then(value => value.isFile(), (error: unknown) => {
  if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return false; } throw error;
});
const nativeBytes = nativeExists ? await readFile(nativePath) : null;
const native = nativeBytes ? { path: relative(root, nativePath), sha256: sha256(nativeBytes),
  format: observe('/usr/bin/file', [nativePath]), arch: observe('/usr/bin/lipo', ['-archs', nativePath]) } : null;
await mkdir(directory, { recursive: true });
if (nativeBytes) { await writeFile(join(directory, 'rename-no-replace.node'), nativeBytes); }
const workflowPath = '.github/workflows/ci-namespace-qualification.yml';
const report = { schemaVersion: 1, scope: 'on-demand original full product checks; separate from required Darwin fanout receipts',
  productCommand: 'pnpm product:check', productOutcome: process.env.PRODUCT_OUTCOME ?? null,
  expectedRevision: process.env.EXPECTED_REVISION ?? null, workflowSha: process.env.GITHUB_WORKFLOW_SHA ?? null,
  runId: process.env.GITHUB_RUN_ID ?? null, runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
  workflowPath, workflowSha256: sha256(await readFile(join(root, workflowPath))),
  platform: process.platform, arch: process.arch, uid: process.getuid?.() ?? null, node: process.version,
  nodeExecutable: process.execPath, nodeSha256: sha256(await readFile(process.execPath)),
  runner: { name: process.env.RUNNER_NAME ?? null, os: process.env.RUNNER_OS ?? null, arch: process.env.RUNNER_ARCH ?? null,
    imageOS: process.env.ImageOS ?? null, imageVersion: process.env.ImageVersion ?? null }, probes, native };
await writeFile(join(directory, 'qualification.json'), `${JSON.stringify(report, null, 2)}\n`);
assert.match(report.expectedRevision ?? '', /^[a-f0-9]{40}$/u);
assert.equal(probes.revision.stdout.trim(), report.expectedRevision); assert.equal(report.workflowSha, report.expectedRevision);
assert.match(report.runId ?? '', /^[1-9][0-9]*$/u); assert.match(report.runAttempt ?? '', /^[1-9][0-9]*$/u);
assert.ok(['success', 'failure', 'cancelled', 'skipped'].includes(report.productOutcome ?? ''), 'actual product outcome required');
assert.equal(report.platform, 'darwin'); assert.equal(report.arch, 'arm64'); assert.ok(Number(report.uid) > 0);
assert.equal(report.node, 'v24.21.0'); assert.equal(probes.pnpm.stdout.trim(), '11.18.0');
for (const probe of Object.values(probes)) { assert.equal(probe.exitCode, 0, `${probe.executable} ${probe.argv.join(' ')}`); assert.equal(probe.signal, null); }
assertNamespaceNativeQualification(report.productOutcome, native);
