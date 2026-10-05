import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import test from 'node:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { authenticatePlatformPredecessor, object } from './conformance.ts';
import { validateNightlyWorkflow } from './nightly-contract.ts';

interface Fixture { nightly: Record<string, unknown>; runtime: Record<string, unknown> }
const readWorkflow = (file: string) => readFile(new URL(`../../.github/workflows/${file}`, import.meta.url), 'utf8');
async function fixture(): Promise<Fixture> {
  return { nightly: object(parse(await readWorkflow('ci-nightly.yml'))), runtime: object(parse(await readWorkflow('ci.yml'))) };
}
const jobs = (workflow: Record<string, unknown>) => object(workflow.jobs);
const job = (workflow: Record<string, unknown>, name: string) => object(jobs(workflow)[name]);
// Literal independent obligations from reviewed main; never derive them from the helper.
const platform = {
  'postgres-durability': '75cb192e996ff0cc6b298c1ac79f6fa358d3905e5ca0454d8870b2c39918e787',
  'runtime-macos': '1f295a3930d3a21f91c0e018177b5242db5b87d941aca75a22cc90608dedceca',
  'macos-product': '9560a3636efbb93c3d5313b0958cfd2eb1c364a837e2339f697a60c9c3b08e17',
};
const validate = ({ nightly, runtime }: Fixture) => validateNightlyWorkflow(nightly, runtime, platform);

const unowned = (value: Record<string, unknown>) => Object.fromEntries(Object.entries(value).filter(([name]) => !['runtime-macos', 'macos-product'].includes(name)));

export function registerNightlyContractTests(): void {
  test('Mac predecessor authenticates full retained workflow and old parsed block before successor policy', async t => {
    await authenticatePlatformPredecessor(process.cwd());
    const retained = JSON.parse(await readFile(new URL('./platform-contract.predecessor.json', import.meta.url), 'utf8'));
    assert.equal(retained.baseCommit, '73c771f254858db430d01d13c3cb433ef18b757d');
    assert.equal(retained.ciSha256, '0c7a76182e5a0cb35d1e7cbb52ea0046741c1ff20f5658fd2a69da53b777fc78');
    assert.equal(retained.parsedJobSha256, 'e418a0a0d11498738295dc4d32eec9bbe1126041906a5475389b7c95fe659139');
    const original = object(object(parse(retained.ciBytes)).jobs);
    assert.equal(object(original['runtime-macos'])['runs-on'], 'macos-15');
    assert.equal((object(original['runtime-macos']).steps as Array<{run?:string}>).at(-1)?.run, 'pnpm product:check');
    const current = jobs((await fixture()).runtime);
    const rootCheckpoint = object(object(parse(execFileSync('git', ['show',
      '61791a71bdbb8c834291eb368f64bdc7a0dcecd0:.github/workflows/ci.yml'], { encoding: 'utf8' }))).jobs);
    assert.deepEqual(unowned(current), unowned(rootCheckpoint), 'all accepted Root6179 Linux/PR/Foundation jobs remain exact');
    const root = await mkdtemp(join(tmpdir(), 'mac-predecessor-TEST-')); t.after(() => rm(root, {recursive:true,force:true}));
    await mkdir(join(root, 'scripts/ci'), {recursive:true});
    await writeFile(join(root, '.git'), `gitdir: ${join(process.cwd(), '.git')}\n`);
    for (const field of ['baseCommit', 'ciSha256', 'ciBytes', 'runtimeMacosBytes', 'parsedJobSha256']) {
      const bad = { ...retained, [field]: `${retained[field]}tampered` };
      await writeFile(join(root, 'scripts/ci/platform-contract.predecessor.json'), JSON.stringify(bad));
      await assert.rejects(authenticatePlatformPredecessor(root));
    }
  });
  test('real nightly preserves daily full runtime/platform coverage and least Docs permissions', async () => {
    const value = await fixture();
    validate(value);
    assert.deepEqual(value.nightly, {
      name: 'CI Nightly', on: { schedule: [{ cron: '17 1 * * *' }], workflow_dispatch: {} },
      permissions: { contents: 'read' },
      jobs: {
        runtime: { uses: './.github/workflows/ci.yml' },
        'docs-protocol': {
          permissions: { contents: 'read', 'id-token': 'write' },
          uses: 'agent-teams-ai/.github/.github/workflows/docs-protocol-check.yml@b30455e32cf5d54ade6d8301637701347e4ce57c',
        },
      },
    });
    assert.deepEqual(Object.keys(jobs(value.runtime)).toSorted(),
      ['architecture', 'check', 'docs', 'foundation', 'macos-product', 'postgres-durability', 'product', 'quick', 'runtime-macos']);
    assert.equal(job(value.runtime, 'runtime-macos')['runs-on'], 'ubuntu-24.04');
    assert.equal(job(value.runtime, 'postgres-durability')['runs-on'], 'ubuntu-24.04');
  });
  test('lost schedule, dispatch or runtime callability cannot silently remove the checkpoint', async () => {
    const faults: Array<(x: Fixture) => void> = [
      x => { delete object(x.nightly.on).schedule; },
      x => { delete object(x.nightly.on).workflow_dispatch; },
      x => { object(x.nightly.on).schedule = [{ cron: '17 1 * * 1' }]; },
      x => { object(x.nightly.on).workflow_dispatch = { inputs: { ref: { default: 'main' } } }; },
      x => { object(x.nightly.on).push = {}; },
      x => { delete object(x.runtime.on).workflow_call; },
      x => { object(x.runtime.on).workflow_call = { inputs: { ref: { type: 'string' } } }; },
    ];
    for (const fault of faults) { const value = await fixture(); fault(value); assert.throws(() => validate(value)); }
  });
  test('every missing runtime lane or platform and bypassed platform fails closed', async () => {
    for (const name of ['quick', 'foundation', 'architecture', 'docs', 'product', 'check', 'postgres-durability', 'macos-product', 'runtime-macos']) {
      const value = await fixture();
      delete jobs(value.runtime)[name];
      assert.throws(() => validate(value), /every full runtime/u);
      for (const field of ['if', 'continue-on-error']) {
        const bypass = await fixture(); job(bypass.runtime, name)[field] = true;
        assert.throws(() => validate(bypass));
      }
    }
    for (const name of ['runtime-macos', 'postgres-durability']) {
      const drift = await fixture(); job(drift.runtime, name).steps = [];
      assert.throws(() => validate(drift), /platform contract changed/u);
    }
  });
  test('nightly rejects skips, swallowed failures, inherited secrets, duplicate commands and revision inputs', async () => {
    for (const name of ['runtime', 'docs-protocol']) {
      for (const [field, setting] of Object.entries({ if: '${{ false }}', 'continue-on-error': true,
        needs: ['other'], secrets: 'inherit', with: { revision: '${{ inputs.ref }}' }, steps: [{ run: 'pnpm check' }] })) {
        const value = await fixture(); job(value.nightly, name)[field] = setting;
        assert.throws(() => validate(value), field);
      }
      const lost = await fixture(); delete jobs(lost.nightly)[name];
      assert.throws(() => validate(lost));
    }
    const extra = await fixture(); jobs(extra.nightly).duplicate = { uses: './.github/workflows/ci.yml' };
    assert.throws(() => validate(extra));
    const cancellation = await fixture(); cancellation.nightly.concurrency = { group: 'nightly', 'cancel-in-progress': true };
    assert.throws(() => validate(cancellation));
    const elevated = await fixture(); object(elevated.nightly.permissions)['id-token'] = 'write';
    assert.throws(() => validate(elevated));
  });
  test('central Docs drift and mutable or redirected runtime revisions are rejected', async () => {
    for (const ref of ['main', 'v1', '${{ inputs.ref }}', 'a'.repeat(40)]) {
      const value = await fixture();
      job(value.nightly, 'docs-protocol').uses = `agent-teams-ai/.github/.github/workflows/docs-protocol-check.yml@${ref}`;
      assert.throws(() => validate(value));
    }
    for (const uses of ['./.github/workflows/ci-lane.yml', './.github/workflows/ci.yml@main', '${{ inputs.workflow }}']) {
      const value = await fixture(); job(value.nightly, 'runtime').uses = uses;
      assert.throws(() => validate(value));
    }
  });
}
if (process.argv[1] === fileURLToPath(import.meta.url)) { registerNightlyContractTests(); }
