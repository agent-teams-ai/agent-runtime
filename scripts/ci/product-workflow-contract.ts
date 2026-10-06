import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const shardIds = ['agent-execution-1', 'agent-execution-2', 'agent-execution-3', 'provider-access', 'runtime-configuration', 'runtime-security', 'embedded-runtime', 'filesystem-custody'];
const phaseEntries = ['check:ci:product:root', 'check:ci:product:typed', 'check:ci:product:native'];
const object = (value: unknown): Record<string, unknown> => { assert.ok(value && typeof value === 'object' && !Array.isArray(value)); return value as Record<string, unknown>; };
const array = (value: unknown): unknown[] => { assert.ok(Array.isArray(value)); return value; };
const checkout = 'actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803';
const setup = 'actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38';
const upload = 'actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a';
const download = 'actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c';
const revisionGuard = 'set -euo pipefail\n[[ "$EXPECTED_REVISION" =~ ^[a-f0-9]{40}$ ]]\ntest "$(git rev-parse HEAD)" = "$EXPECTED_REVISION"\n';
const retainedHistory = 'set -euo pipefail\nobject=8e5e859d10981e1623d0617e933afc68a9e8770c\nif ! git cat-file -e "$object^{commit}"; then\n  git fetch --no-tags origin "$object"\nfi\ntest "$(git rev-parse "$object^{commit}")" = "$object"\ngit fsck --connectivity-only --no-reflogs "$object"\n';
const enablePnpm = 'corepack enable\ncorepack install --global pnpm@11.18.0\n';
const rootEvidenceBinding = "set -euo pipefail\nprintf 'CI_EVIDENCE_DIR=%s/ci-product-root\\n' \"$RUNNER_TEMP\" >> \"$GITHUB_ENV\"\n";
const packageEvidenceBinding = "set -euo pipefail\nprintf 'CI_EVIDENCE_DIR=%s/ci-product-shard\\n' \"$RUNNER_TEMP\" >> \"$GITHUB_ENV\"\n";
const aggregateEvidenceBinding = "set -euo pipefail\nprintf 'CI_PACKAGE_REPORT_DIR=%s/ci-product-reports/packages\\n' \"$RUNNER_TEMP\" >> \"$GITHUB_ENV\"\nprintf 'CI_ROOT_REPORT_DIR=%s/ci-product-reports/root\\n' \"$RUNNER_TEMP\" >> \"$GITHUB_ENV\"\n";
function assertProductSteps(steps: Record<string, unknown>[]): void {
  for (const step of steps) {
    assert.ok(Object.keys(step).every(key => ['name', 'run', 'shell', 'uses', 'with', 'if'].includes(key)), 'unreviewed step field');
    assert.equal(step.env, undefined, 'no step environment overrides');
    if (step.run !== undefined) {
      assert.equal(step.if, undefined, 'unconditional full phases');
      assert.ok(!String(step.run).includes('${{'), 'no shell input interpolation');
      assert.equal(step.uses, undefined); assert.equal(step.with, undefined);
      assert.equal(step.shell, [revisionGuard, retainedHistory, rootEvidenceBinding, packageEvidenceBinding, aggregateEvidenceBinding].includes(String(step.run)) ? 'bash' : undefined);
    } else {
      assert.ok([checkout, setup, upload, download].includes(String(step.uses)), 'unadmitted action');
      if (step.uses === upload) {
        assert.ok(['${{ always() }}', '${{ success() }}'].includes(String(step.if)), 'archive/current upload condition');
      } else { assert.equal(step.if, undefined); }
      assert.equal(step.shell, undefined);
    }
  }
}
export function assertProductWorkflow(value: unknown): void {
  const workflow = object(value);
  assert.deepEqual(Object.keys(workflow).toSorted(), ['jobs', 'name', 'on', 'permissions']);
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  assert.deepEqual(workflow.on, { workflow_call: { inputs: { revision: { required: true, type: 'string' }, artifact: { required: true, type: 'string' } } } });
  const jobs = object(workflow.jobs);
  assert.deepEqual(Object.keys(jobs).toSorted(), ['aggregate', 'packages', 'root']);
  const packages = object(jobs.packages);
  assert.deepEqual(packages, { strategy: { 'fail-fast': false, matrix: { shard: [...shardIds] } },
    uses: './.github/workflows/ci-product-shard.yml', with: { shard: '${{ matrix.shard }}', revision: '${{ inputs.revision }}', artifact: '${{ inputs.artifact }}' } });
  for (const name of ['root', 'aggregate']) {
    const job = object(jobs[name]);
    assert.deepEqual(Object.keys(job).toSorted(), name === 'root'
      ? ['env', 'runs-on', 'steps', 'timeout-minutes'] : ['env', 'if', 'needs', 'runs-on', 'steps', 'timeout-minutes']);
    assert.equal(job['runs-on'], 'ubuntu-24.04');
    assert.equal(job['timeout-minutes'], name === 'root' ? 35 : 10);
    assert.equal(job['continue-on-error'], undefined); assert.equal(job.permissions, undefined);
    assert.equal(job.secrets, undefined); assert.equal(job.environment, undefined);
    assert.equal(job.if, name === 'aggregate' ? '${{ always() }}' : undefined);
    assert.deepEqual(job.needs, name === 'aggregate' ? ['packages', 'root'] : undefined);
    const env = object(job.env); assert.equal(env.EXPECTED_REVISION, '${{ inputs.revision }}');
    const steps = array(job.steps).map(object);
    const firstStep = object(steps[0]), guardStep = object(steps[1]), historyStep = object(steps[2]), lastStep = object(steps.at(-1));
    assert.deepEqual(firstStep.with, { ref: '${{ inputs.revision }}', 'persist-credentials': false, 'fetch-depth': 0 });
    assert.equal(firstStep.uses, checkout);
    const guard = String(guardStep.run);
    assert.equal(guardStep.shell, 'bash');
    assert.equal(guard, revisionGuard);
    assert.deepEqual(steps.find(step => step.uses === setup)?.with, { 'node-version-file': '.node-version' });
    assert.equal(historyStep.shell, 'bash'); assert.equal(historyStep.run, retainedHistory);
    assert.equal(steps.filter(step => step.uses === checkout).length, 1);
    assert.equal(steps.filter(step => step.uses === setup).length, 1);
    assert.equal(steps.filter(step => step.uses === upload).length, name === 'root' ? 2 : 0);
    assert.equal(steps.filter(step => step.uses === download).length, name === 'aggregate' ? 2 : 0);
    const runs = steps.filter(step => step.run !== undefined).map(step => step.run);
    const install = runs.indexOf('pnpm install --frozen-lockfile'); assert.ok(install > 0);
    assert.ok(runs.includes(enablePnpm));
    assertProductSteps(steps);
    const sequence = steps.map(step => step.uses ?? step.run);
    const rootSequence = [checkout, revisionGuard, retainedHistory, setup, 'node scripts/ci/gate.ts revision', enablePnpm,
      'pnpm install --frozen-lockfile', rootEvidenceBinding, 'node scripts/ci/product-fanout-contract.ts custody-start',
      "pnpm --filter './packages/**' -r run clean", 'pnpm product:build', ...phaseEntries.map(entry => `node scripts/ci/measure.ts ${entry}`),
      'node scripts/ci/product-fanout-contract.ts custody-end', upload, upload];
    const aggregateSequence = [checkout, revisionGuard, retainedHistory, setup, 'node scripts/ci/product-fanout-contract.ts results', enablePnpm,
      'pnpm install --frozen-lockfile', aggregateEvidenceBinding, download, download, 'node scripts/ci/product-fanout-contract.ts evidence'];
    assert.deepEqual(sequence, name === 'root' ? rootSequence : aggregateSequence);

    if (name === 'root') {
      assert.deepEqual(runs, [revisionGuard, retainedHistory, 'node scripts/ci/gate.ts revision', enablePnpm,
        'pnpm install --frozen-lockfile', rootEvidenceBinding, 'node scripts/ci/product-fanout-contract.ts custody-start',
        'pnpm --filter \'./packages/**\' -r run clean', 'pnpm product:build', ...phaseEntries.map(entry => `node scripts/ci/measure.ts ${entry}`),
        'node scripts/ci/product-fanout-contract.ts custody-end']);
      for (const key of ['AUTHOR', 'COMMITTER']) { assert.equal(env[`GIT_${key}_NAME`], 'iliya'); assert.equal(env[`GIT_${key}_EMAIL`], 'iliyazelenkog@gmail.com'); }
      const archive = object(steps.at(-2));
      assert.equal(archive.uses, upload); assert.equal(archive.if, '${{ always() }}');
      assert.deepEqual(archive.with, { name: 'full-ci-${{ inputs.artifact }}-root-${{ github.run_attempt }}',
        path: '${{ runner.temp }}/ci-product-root/*.json', 'if-no-files-found': 'error', 'retention-days': 14 });
      assert.equal(lastStep.uses, upload); assert.equal(lastStep.if, '${{ success() }}');
      assert.deepEqual(lastStep.with, { name: 'full-ci-${{ inputs.artifact }}-root-current',
        path: '${{ runner.temp }}/ci-product-root/*.json', 'if-no-files-found': 'error', 'retention-days': 14, overwrite: true });
      assert.deepEqual(Object.keys(env).toSorted(), ['EXPECTED_REVISION', 'GIT_AUTHOR_EMAIL', 'GIT_AUTHOR_NAME', 'GIT_COMMITTER_EMAIL', 'GIT_COMMITTER_NAME']);
    } else {
      assert.equal(env.EXECUTION_TARGET, 'linux-x64');
      assert.equal(env.NEEDS, '${{ toJSON(needs) }}');
      assert.deepEqual(runs, [revisionGuard, retainedHistory, 'node scripts/ci/product-fanout-contract.ts results', enablePnpm,
        'pnpm install --frozen-lockfile', aggregateEvidenceBinding, 'node scripts/ci/product-fanout-contract.ts evidence']);
      assert.deepEqual(Object.keys(env).toSorted(), ['EXECUTION_TARGET', 'EXPECTED_REVISION', 'NEEDS']);
      // Exact inputs preserve the action's default same-workflow-run scope:
      // no run-id, repository, token or artifact-id may select another run.
      assert.deepEqual(steps.filter(step => step.uses === download).map(step => step.with), [
        { pattern: 'full-ci-${{ inputs.artifact }}-package-*-current', path: '${{ runner.temp }}/ci-product-reports/packages', 'merge-multiple': false },
        { name: 'full-ci-${{ inputs.artifact }}-root-current', path: '${{ runner.temp }}/ci-product-reports/root' },
      ]);
    }
  }
}

export function assertShardWorkflow(value: unknown): void {
  const workflow = object(value);
  assert.deepEqual(Object.keys(workflow).toSorted(), ['jobs', 'name', 'on', 'permissions']);
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  assert.deepEqual(workflow.on, { workflow_call: { inputs: Object.fromEntries(['shard', 'revision', 'artifact'].map(key =>
    [key, { required: true, type: 'string' }])) } });
  const jobs = object(workflow.jobs); assert.deepEqual(Object.keys(jobs), ['shard']);
  const job = object(jobs.shard);
  assert.deepEqual(Object.keys(job).toSorted(), ['env', 'runs-on', 'steps', 'timeout-minutes']);
  assert.equal(job['runs-on'], 'ubuntu-24.04'); assert.equal(job['timeout-minutes'], 35);
  assert.deepEqual(job.env, { GIT_AUTHOR_NAME: 'iliya', GIT_AUTHOR_EMAIL: 'iliyazelenkog@gmail.com',
    GIT_COMMITTER_NAME: 'iliya', GIT_COMMITTER_EMAIL: 'iliyazelenkog@gmail.com',
    EXPECTED_REVISION: '${{ inputs.revision }}', PACKAGE_SHARD: '${{ inputs.shard }}', EXECUTION_TARGET: 'linux-x64' });
  const steps = array(job.steps).map(item => {
    const { name: _name, ...step } = object(item); return step;
  });
  assert.deepEqual(steps, [
    { uses: checkout, with: { ref: '${{ inputs.revision }}', 'persist-credentials': false, 'fetch-depth': 0 } },
    { shell: 'bash', run: revisionGuard }, { shell: 'bash', run: retainedHistory },
    { uses: setup, with: { 'node-version-file': '.node-version' } },
    { run: 'node scripts/ci/gate.ts revision' }, { run: enablePnpm }, { run: 'pnpm install --frozen-lockfile' },
    { shell: 'bash', run: packageEvidenceBinding },
    { run: 'node scripts/ci/package-execution.ts' },
    { if: '${{ always() }}', uses: upload, with: {
      name: 'full-ci-${{ inputs.artifact }}-package-${{ inputs.shard }}-${{ github.run_attempt }}',
      path: '${{ runner.temp }}/ci-product-shard/receipt.json', 'if-no-files-found': 'error', 'retention-days': 14 } },
    { if: '${{ success() }}', uses: upload, with: {
      name: 'full-ci-${{ inputs.artifact }}-package-${{ inputs.shard }}-current',
      path: '${{ runner.temp }}/ci-product-shard/receipt.json', 'if-no-files-found': 'error', 'retention-days': 14, overwrite: true } },
  ]);
}

const darwinEvidenceBinding = "set -euo pipefail\nprintf 'CI_EVIDENCE_DIR=%s/ci-darwin-shard\\n' \"$RUNNER_TEMP\" >> \"$GITHUB_ENV\"\n";
const darwinAggregateEvidenceBinding = "set -euo pipefail\nprintf 'CI_PACKAGE_REPORT_DIR=%s/ci-darwin-reports/packages\\n' \"$RUNNER_TEMP\" >> \"$GITHUB_ENV\"\n";
const darwinReferenceEvidenceBinding = "set -euo pipefail\nprintf 'CI_EVIDENCE_DIR=%s/ci-darwin-reference\\n' \"$RUNNER_TEMP\" >> \"$GITHUB_ENV\"\n";
const gitOwner = { GIT_AUTHOR_NAME: 'iliya', GIT_AUTHOR_EMAIL: 'iliyazelenkog@gmail.com',
  GIT_COMMITTER_NAME: 'iliya', GIT_COMMITTER_EMAIL: 'iliyazelenkog@gmail.com' };
function custodySteps(revision: string, guardCommand: string): Record<string, unknown>[] {
  return [ { uses: checkout, with: { ref: revision, 'persist-credentials': false, 'fetch-depth': 0 } },
    { shell: 'bash', run: revisionGuard }, { shell: 'bash', run: retainedHistory },
    { uses: setup, with: { 'node-version-file': '.node-version' } }, { run: guardCommand },
    { run: enablePnpm }, { run: 'pnpm install --frozen-lockfile' } ];
}
function archiveSteps(stem: string, path: string): Record<string, unknown>[] {
  return [ { if: '${{ always() }}', uses: upload, with: { name: `${stem}-\${{ github.run_attempt }}`,
    path, 'if-no-files-found': 'error', 'retention-days': 14 } },
  { if: '${{ success() }}', uses: upload, with: { name: `${stem}-current`,
    path, 'if-no-files-found': 'error', 'retention-days': 14, overwrite: true } } ];
}
const strippedSteps = (value: unknown) => array(value).map(item => { const { name: _name, ...step } = object(item); return step; });
export function assertDarwinWorkflow(value: unknown): void {
  const workflow = object(value);
  assert.deepEqual(Object.keys(workflow).toSorted(), ['jobs', 'name', 'on', 'permissions']);
  assert.equal(workflow.name, 'Full Darwin packages'); assert.deepEqual(workflow.permissions, { contents: 'read' });
  assert.deepEqual(workflow.on, { workflow_call: { inputs: { revision: { required: true, type: 'string' } } } });
  const jobs = object(workflow.jobs); assert.deepEqual(Object.keys(jobs), ['packages']);
  const job = object(jobs.packages);
  assert.deepEqual(Object.keys(job).toSorted(), ['env', 'runs-on', 'steps', 'strategy', 'timeout-minutes']);
  assert.equal(job['runs-on'], 'macos-15'); assert.equal(job['timeout-minutes'], 15);
  assert.deepEqual(job.strategy, { 'fail-fast': false, 'max-parallel': 8, matrix: { shard: [...shardIds] } });
  assert.deepEqual(job.env, { ...gitOwner, EXPECTED_REVISION: '${{ inputs.revision }}', EXECUTION_TARGET: 'darwin-arm64',
    PACKAGE_SHARD: '${{ matrix.shard }}' });
  assert.deepEqual(strippedSteps(job.steps), [ ...custodySteps('${{ inputs.revision }}', 'node scripts/ci/gate.ts revision'),
    { shell: 'bash', run: darwinEvidenceBinding }, { run: 'node scripts/ci/package-execution.ts' },
    ...archiveSteps('full-ci-darwin-package-${{ matrix.shard }}', '${{ runner.temp }}/ci-darwin-shard/') ]);
}
export function assertDarwinCaller(jobsValue: unknown, revision: string): void {
  const jobs = object(jobsValue);
  assert.deepEqual(jobs['macos-product'], { uses: './.github/workflows/ci-darwin-packages.yml', with: { revision } }, 'fixed Mac helper caller');
  const job = object(jobs['runtime-macos']);
  assert.deepEqual(Object.keys(job).toSorted(), ['env', 'if', 'name', 'needs', 'runs-on', 'steps', 'timeout-minutes']);
  assert.equal(job.name, 'runtime-macos', 'required Mac context'); assert.equal(job.if, '${{ always() }}');
  assert.deepEqual(job.needs, ['macos-product']); assert.equal(job['runs-on'], 'ubuntu-24.04'); assert.equal(job['timeout-minutes'], 10);
  assert.deepEqual(job.env, { EXPECTED_REVISION: revision, EXECUTION_TARGET: 'darwin-arm64', NEEDS: '${{ toJSON(needs) }}' });
  assert.deepEqual(strippedSteps(job.steps), [ ...custodySteps(revision, 'node scripts/ci/product-fanout-contract.ts darwin-results'),
    { shell: 'bash', run: darwinAggregateEvidenceBinding }, { uses: download, with: { pattern: 'full-ci-darwin-package-*-current', path: '${{ runner.temp }}/ci-darwin-reports/packages', 'merge-multiple': false } },
    { run: 'node scripts/ci/product-fanout-contract.ts darwin-evidence' } ], 'same-run current units and actual Mac gate');
}
export function assertDarwinReference(value: unknown): void {
  const workflow = object(value);
  assert.deepEqual(Object.keys(workflow).toSorted(), ['jobs', 'name', 'on', 'permissions']);
  assert.equal(workflow.name, 'Darwin unsplit reference'); assert.deepEqual(workflow.on, { workflow_dispatch: {} });
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  const jobs = object(workflow.jobs); assert.deepEqual(Object.keys(jobs), ['reference']);
  const job = object(jobs.reference);
  assert.deepEqual(Object.keys(job).toSorted(), ['env', 'runs-on', 'steps', 'timeout-minutes']);
  assert.equal(job['runs-on'], 'macos-15'); assert.equal(job['timeout-minutes'], 15);
  assert.deepEqual(job.env, { ...gitOwner, EXPECTED_REVISION: '${{ github.workflow_sha }}', EXECUTION_TARGET: 'darwin-arm64' });
  assert.deepEqual(strippedSteps(job.steps), [ ...custodySteps('${{ github.workflow_sha }}', 'node scripts/ci/gate.ts revision'),
    { shell: 'bash', run: darwinReferenceEvidenceBinding }, { run: 'node scripts/ci/package-execution.ts reference' },
    ...archiveSteps('full-ci-darwin-reference', '${{ runner.temp }}/ci-darwin-reference/') ]);
}

export type ExecutionTarget = 'linux-x64' | 'darwin-arm64';
export interface WorkflowIdentity { runId: string; attempt: number; workflowSha: string }
export interface PlatformObservation { platform: string; arch: string; uid: number | null; runnerOS: string | null; runnerArch: string | null; execPath: string }
export function validatePlatform(target: ExecutionTarget, observed: PlatformObservation): void {
  assert.ok(['linux-x64', 'darwin-arm64'].includes(target), 'explicit execution target required');
  const mac = target === 'darwin-arm64';
  assert.equal(observed.platform, mac ? 'darwin' : 'linux', 'target platform mismatch');
  assert.equal(observed.arch, mac ? 'arm64' : 'x64', 'target architecture mismatch');
  assert.equal(observed.runnerOS, mac ? 'macOS' : 'Linux', 'runner OS mismatch');
  assert.equal(observed.runnerArch, mac ? 'ARM64' : 'X64', 'runner architecture mismatch');
  if (mac) {
    assert.ok(Number.isSafeInteger(observed.uid) && Number(observed.uid) > 0, 'Mac tests require non-root UID');
    assert.match(observed.execPath, /^\/Users\/runner\/hostedtoolcache\/node\/24\.21\.0\/arm64\/bin\/node$/u, 'pinned Mac toolcache Node required');
  }
}
export function workflowIdentity(env: NodeJS.ProcessEnv): WorkflowIdentity {
  assert.match(env.GITHUB_RUN_ID ?? '', /^[1-9][0-9]*$/u, 'workflow run identity required');
  assert.match(env.GITHUB_RUN_ATTEMPT ?? '', /^[1-9][0-9]*$/u, 'workflow attempt required');
  assert.match(env.GITHUB_WORKFLOW_SHA ?? '', /^[a-f0-9]{40}$/u, 'workflow source identity required');
  const attempt = Number(env.GITHUB_RUN_ATTEMPT); assert.ok(Number.isSafeInteger(attempt));
  return { runId: env.GITHUB_RUN_ID!, attempt, workflowSha: env.GITHUB_WORKFLOW_SHA! };
}
export function verifySource(root: string, revision: string): void {
  assert.match(revision, /^[0-9a-f]{40}$/u, 'exact revision required');
  assert.equal(git(root, 'rev-parse', 'HEAD'), revision, 'checkout revision mismatch');
  assert.equal(git(root, 'status', '--porcelain', '--untracked-files=no'), '', 'tracked source drift');
  assert.equal(git(root, 'ls-files', '--others', '--exclude-standard', '--', 'packages', 'experiments'), '', 'untracked package inputs');
}
