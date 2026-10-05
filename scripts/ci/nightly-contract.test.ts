import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { object } from './conformance.ts';
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
  'runtime-macos': 'e418a0a0d11498738295dc4d32eec9bbe1126041906a5475389b7c95fe659139',
};
const validate = ({ nightly, runtime }: Fixture) => validateNightlyWorkflow(nightly, runtime, platform);

export function registerNightlyContractTests(): void {
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
      ['architecture', 'check', 'docs', 'foundation', 'postgres-durability', 'product', 'quick', 'runtime-macos']);
    assert.equal(job(value.runtime, 'runtime-macos')['runs-on'], 'macos-15');
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
    for (const name of ['quick', 'foundation', 'architecture', 'docs', 'product', 'check', 'postgres-durability', 'runtime-macos']) {
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
