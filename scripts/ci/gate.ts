import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { assertAggregate, assertRevision } from './policy.ts';

if (process.argv[2] === 'revision') {
  const actual = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' });
  assertRevision(actual, process.env.EXPECTED_REVISION ?? '');
  if (['serial', 'parallel'].includes(process.env.BENCHMARK_ARM ?? '')) {
    assertRevision(actual, process.env.GITHUB_WORKFLOW_SHA ?? '');
  }
} else if (process.argv[2] === 'benchmark') {
  const arm = process.env.BENCHMARK_ARM;
  assert.ok(arm === 'serial' || arm === 'parallel');
  const needs: Record<string, { result?: string }> = JSON.parse(process.env.NEEDS ?? 'null');
  const active = arm === 'serial' ? ['serial'] : ['quick', 'foundation', 'architecture', 'docs', 'product'];
  const inactive = arm === 'serial' ? ['quick', 'foundation', 'architecture', 'docs', 'product'] : ['serial'];
  assert.deepEqual(Object.keys(needs).toSorted(), [...active, ...inactive].toSorted());
  for (const name of inactive) { assert.equal(needs[name]?.result, 'skipped'); }
  assertAggregate(Object.fromEntries(active.map(name => [name, needs[name]])), active);
} else {
  assert.equal(process.argv[2], 'aggregate');
  const needs: unknown = JSON.parse(process.env.NEEDS ?? 'null');
  assertAggregate(needs);
}
