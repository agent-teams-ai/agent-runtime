import assert from 'node:assert/strict';
import { commandInventory, routedScripts } from './script-routing.ts';
import type { Command, Scripts } from './script-routing.ts';

export const requiredJobs = ['quick', 'foundation', 'architecture', 'docs', 'product'] as const;
export type Group = typeof requiredJobs[number];

export const productPhases = {
  "check:ci:product:packages": [
    "product:check"
  ],
  "check:ci:product:root": [
    "typecheck",
    "test"
  ],
  "check:ci:product:typed": [
    "lint:typed"
  ],
  "check:ci:product:native": [
    "quality:native"
  ]
} as const;

export const groups = {
  quick: ['lint', 'check:node-compat', 'typecheck:ci', 'test:ci'],
  foundation: ['foundation:check', 'foundation:scaffold:check'],
  architecture: ['sdk-growth:profile', 'test:sdk-growth:profile', 'test:sdk-growth:packed',
    'test:sdk-growth:source', 'architecture:get-modular-adoption', 'test:get-modular-adoption',
    'test:feature-modules', 'architecture:feature-modules:active', 'test:consumer-modules',
    'architecture:consumer-modules', 'test:ar2-contract', 'architecture:registry',
    'architecture:operation-oracle'],
  docs: ['docs:protocol:check', 'docs:qualification'],
  product: Object.keys(productPhases),
} as const satisfies Record<Group, readonly string[]>;

export function assertAggregate(needs: unknown, required: readonly string[] = requiredJobs): void {
  assert.ok(needs !== null && typeof needs === 'object');
  assert.deepEqual(Object.keys(needs).toSorted(), [...required].toSorted(), 'required job inventory');
  for (const name of required) {
    const result: unknown = Object.getOwnPropertyDescriptor(needs, name)?.value;
    assert.ok(result !== null && typeof result === 'object', `missing job: ${name}`);
    assert.equal(Object.getOwnPropertyDescriptor(result, 'result')?.value, 'success', `${name} incomplete`);
  }
}

export function assertRevision(actual: string, expected: string): void {
  assert.match(expected, /^[a-f0-9]{40}$/u, 'expected immutable revision');
  assert.equal(actual.trim(), expected, 'checkout revision mismatch');
}

const identities = (entries: readonly Command[]) => entries.map(entry => JSON.stringify(entry)).toSorted();

export function assertFullInventory(scripts: Scripts, baseline: Scripts): void {
  assert.equal(scripts['typecheck:ci'], 'tsc --project scripts/ci/tsconfig.json --noEmit --pretty false', 'CI helper typechecking must remain blocking');
  assert.equal(scripts['test:ci'], 'node --test scripts/ci/contracts.test.ts && node scripts/ci/conformance.ts', 'CI policy enforcement must remain blocking');
  assert.equal(scripts['docs:protocol:check'], 'pnpm docs:check && pnpm docs:governance', 'Docs semantic gate retains check and governance');
  assert.equal(scripts['docs:qualification'], baseline['docs:qualification'], 'Docs qualification retains typecheck, serial and portable routing');
  const fastRoutes = scripts['check:fast']?.split(' && ') ?? [];
  const semanticIndex = fastRoutes.indexOf('pnpm docs:protocol:check');
  assert.ok(semanticIndex >= 0, 'fast gate explicitly runs Docs semantics');
  assert.equal(fastRoutes[semanticIndex + 1], 'pnpm docs:qualification', 'fast gate qualifies Docs immediately after semantics');
  assert.equal(fastRoutes.filter(command => command === 'pnpm docs:qualification').length, 1, 'fast gate qualifies Docs exactly once');
  assert.equal(scripts.check, requiredJobs.map(group => `pnpm check:ci:${group}`).join(' && '));
  for (const [group, commands] of Object.entries({ ...groups, ...productPhases })) {
    assert.equal(scripts[group.startsWith('check:ci:') ? group : `check:ci:${group}`], commands.map(name => `pnpm ${name}`).join(' && '),
      `lane inventory: ${group}`);
  }
  // The frozen contract retains the predecessor's nesting. Compare expanded
  // terminal commands, including multiplicity, to preserve every reviewed leaf.
  const expected = commandInventory(baseline, 'check');
  const actual = commandInventory(scripts, 'check').filter(entry =>
    entry.script !== 'typecheck:ci' && entry.script !== 'test:ci');
  const observation = { script: 'test:consumer-modules', command: 'node --test scripts/architecture/check-cms-pin.test.mjs' };
  const mandatory = 'agent-teams-node-test --contract architecture/foundation/mandatory-node-tests.json -- scripts/architecture/check-cms-pin.test.mjs';
  assert.equal(scripts['test:consumer-modules'], baseline['test:consumer-modules']?.replace(mandatory, `${observation.command} && ${mandatory}`), 'CMS observation immediately before mandatory CLI');
  assert.deepEqual(identities(actual), identities([...expected, observation]), 'full command inventory drift');
  const fast = commandInventory(scripts, 'check:fast').filter(entry => entry.script !== 'typecheck:ci' && entry.script !== 'test:ci');
  assert.deepEqual(identities(fast), identities([...commandInventory(baseline, 'check:fast'), observation]), 'fast command inventory drift');
  const product = routedScripts(scripts, 'check:ci:product');
  assert.deepEqual(product, ['product:check', 'typecheck', 'test', 'lint:typed', 'quality:native'].map(name => `pnpm ${name}`),
    'product build prerequisites');
  assert.deepEqual(commandInventory(scripts, 'product:check'), commandInventory(baseline, 'product:check'),
    'clean/build/test prerequisites');
}
