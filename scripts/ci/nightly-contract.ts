import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { requiredJobs } from './policy.ts';

function object(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}

// Closed caller policy; the existing full validator owns commands and platform hashes.
export function validateNightlyWorkflow(value: unknown, runtime: unknown, platform: Record<string, string>): void {
  assert.deepEqual(value, {
    name: 'CI Nightly',
    on: { schedule: [{ cron: '17 1 * * *' }], workflow_dispatch: {} },
    permissions: { contents: 'read' },
    jobs: {
      runtime: { uses: './.github/workflows/ci.yml' },
      'docs-protocol': {
        permissions: { contents: 'read', 'id-token': 'write' },
        uses: 'agent-teams-ai/.github/.github/workflows/docs-protocol-check.yml@b30455e32cf5d54ade6d8301637701347e4ce57c',
      },
    },
  }, 'nightly must unconditionally reuse full CI and the exact central Docs pin');
  const workflow = object(runtime);
  assert.deepEqual(object(workflow.on).workflow_call, {}, 'full CI must be callable without inputs');
  const jobs = object(workflow.jobs);
  assert.deepEqual(Object.keys(jobs).toSorted(), [...requiredJobs, 'check', 'postgres-durability', 'runtime-macos'].toSorted(),
    'nightly must retain every full runtime and platform job');
  for (const [name, entry] of Object.entries(jobs)) {
    const job = object(entry);
    assert.equal(job.if, name === 'check' ? '${{ always() }}' : undefined, `${name} must not skip coverage`);
    assert.equal(job['continue-on-error'], undefined, `${name} must fail closed`);
  }
  for (const name of ['postgres-durability', 'runtime-macos']) {
    const digest = createHash('sha256').update(JSON.stringify(jobs[name])).digest('hex');
    assert.equal(digest, platform[name], `${name} platform contract changed`);
  }
}
