import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { commandInventory } from './script-routing.ts';
import type { Command } from './script-routing.ts';
import { readScripts } from './inventory.ts';
import { productPhases } from './policy.ts';
const consumerScripts = await readScripts(new URL('../../package.json', import.meta.url));
const expectedEntries = ['check:ci:quick', 'check:ci:foundation', 'check:ci:architecture', 'check:ci:docs', ...Object.keys(productPhases)];
import { assertCmsComposite, cmsBinding, cmsContract, cmsMandatoryCommand, inputPaths, toolchainKeys } from './measure.ts';
import type { CmsComposite, TestResult } from './measure.ts';

export interface Receipt {
  entry: string; sha: string; workflowSha: string; inputTree: string; node: string; pnpm: string; runnerOS: string;
  cachePolicy: string; runnerImage: { os: string; version: string; arch: string }; toolchain: Record<string, string>;
  digests: Record<string, string>; inventory: Command[];
  phases: Array<{ script: string; commands: Command[]; code: number | null; signal: string | null;
    started: string; ended: string; wallMs: number; tests: TestResult[]; unqualifiedRunners?: string[]; cms?: CmsComposite }>;
}
const currentCmsBinding = await cmsBinding();
const currentCmsContract = JSON.parse(await readFile(cmsContract, 'utf8'));
const sorted = (items: readonly unknown[]) => items.map(item => JSON.stringify(item)).toSorted();

const tests = (receipts: readonly Receipt[]) => sorted(receipts.flatMap(receipt => receipt.phases.flatMap(phase =>
  phase.tests.map(test => ({ script: phase.script, ...test })))));
const duration = (receipts: readonly Receipt[]) => {
  const phases = receipts.flatMap(receipt => receipt.phases);
  assert.ok(phases.length > 0);
  return Math.max(...phases.map(phase => Date.parse(phase.ended))) - Math.min(...phases.map(phase => Date.parse(phase.started)));
};

export function compare(serial: readonly Receipt[], parallel: readonly Receipt[]) {
  assert.deepEqual(serial.map(receipt => receipt.entry).toSorted(), [...expectedEntries].toSorted(), 'serial receipt inventory');
  assert.deepEqual(parallel.map(receipt => receipt.entry).toSorted(), [...expectedEntries].toSorted(), 'parallel receipt inventory');
  const reference = serial[0];
  assert.ok(reference && parallel.length > 0);
  const all = [...serial, ...parallel];
  for (const receipt of all) {
    assert.match(receipt.sha, /^[a-f0-9]{40}$/u);
    assert.match(receipt.inputTree, /^[a-f0-9]{40}$/u);
    assert.deepEqual(sorted(receipt.inventory), sorted(commandInventory(consumerScripts, receipt.entry)), 'full consumer phase inventory');
    assert.deepEqual(Object.keys(receipt.digests).toSorted(), [...inputPaths].toSorted());
    assert.ok(Object.values(receipt.digests).every(value => /^[a-f0-9]{64}$/u.test(value)), 'invalid input digest');
    assert.equal(receipt.node, 'v24.21.0', 'pinned Node');
    assert.equal(receipt.pnpm, '11.18.0', 'pinned pnpm');
    assert.deepEqual(Object.keys(receipt.runnerImage).toSorted(), ['arch', 'os', 'version']);
    assert.ok(Object.values(receipt.runnerImage).every(value => typeof value === 'string' && value.length > 0 && value !== 'unobserved'), 'missing runner image evidence');
    assert.deepEqual(Object.keys(receipt.toolchain).toSorted(), toolchainKeys(receipt.entry).toSorted(), 'missing compiler evidence');
    assert.ok(Object.values(receipt.toolchain).every(value => typeof value === 'string' && value.length > 0), 'empty compiler version');
    if (toolchainKeys(receipt.entry).includes('rustc')) {
      assert.match(receipt.toolchain.rustc ?? '', /^rustc 1\.97\.1\b/u, 'pinned Rust');
      assert.match(receipt.toolchain.cargo ?? '', /^cargo 1\.97\.1\b/u, 'pinned Cargo');
    }
    const counterpart = serial.find(value => value.entry === receipt.entry);
    assert.ok(counterpart);
    assert.deepEqual(receipt.toolchain, counterpart.toolchain, 'paired compiler drift');
    assert.equal(receipt.sha, receipt.workflowSha, 'immutable orchestration revision');
    for (const key of ['sha', 'workflowSha', 'inputTree', 'node', 'pnpm', 'runnerOS', 'runnerImage', 'cachePolicy', 'digests'] as const) {
      assert.deepEqual(receipt[key], reference[key], `paired input drift: ${key}`);
    }
    assert.deepEqual(sorted(receipt.phases.flatMap(phase => phase.commands)), sorted(receipt.inventory), 'missing phase/process');
    for (const phase of receipt.phases) {
      const mandatory = phase.commands.filter(command => /\bagent-teams-node-test\b/u.test(command.command));
      if (mandatory.length > 0) {
        assert.equal(phase.script, 'test:consumer-modules', 'other opaque runners remain unqualified');
        assert.deepEqual(mandatory, [{ script: phase.script, command: cmsMandatoryCommand }], 'mandatory command drift');
        assert.deepEqual(phase.commands, commandInventory(consumerScripts, phase.script), 'CMS phase commands');
        assert.ok(phase.cms, 'missing CMS composite observation');
        assertCmsComposite(phase.cms, currentCmsBinding, phase.tests, currentCmsContract);
        for (const path of inputPaths) { assert.equal(phase.cms.direct.before[path], receipt.digests[path], 'CMS code input binding'); }
      } else { assert.equal(phase.cms, undefined, 'unexpected CMS observation'); }
      assert.equal(phase.unqualifiedRunners?.length ?? 0, 0, 'mandatory runner identity evidence requires a public Foundation receipt contract');
      assert.equal(phase.code, 0, `failed phase: ${phase.script}`);
      assert.equal(phase.signal, null, `cancelled phase: ${phase.script}`);
      assert.ok(Number.isFinite(phase.wallMs) && phase.wallMs >= 0);
      assert.ok(Number.isFinite(Date.parse(phase.started)) && Date.parse(phase.ended) >= Date.parse(phase.started));
      if (phase.commands.some(command => /(?:node --test|agent-teams-node-test|\brun test\b)/u.test(command.command))
        || /^(?:test(?::|$)|quality:native$)/u.test(phase.script)) {
        assert.ok(phase.tests.length > 0, `zero test identities: ${phase.script}`);
      }
      assert.ok(phase.tests.every(test => Array.isArray(test.ancestry) && test.ancestry.every(name => typeof name === 'string')
        && typeof test.name === 'string' && typeof test.suite === 'string'), 'missing nested test identity');
      assert.ok(phase.tests.every(test => ['passed', 'skip', 'todo'].includes(test.status)), 'failed test identity');
    }
  }
  assert.deepEqual(sorted(parallel.flatMap(receipt => receipt.inventory)), sorted(serial.flatMap(receipt => receipt.inventory)), 'lost or duplicated full leaf');
  assert.deepEqual(tests(parallel), tests(serial), 'test identity/status drift (including skips/todos)');
  return { sha: reference.sha, serialPhaseSpanMs: duration(serial), parallelPhaseSpanMs: duration(parallel),
    tests: JSON.parse(`[${tests(serial).join(',')}]`) as unknown,
    limitation: 'Phase spans are diagnostic; controller must derive queue-free critical path, setup, all-required readiness and OS runner minutes from Actions timestamps.' };
}

async function readReceipts(directory: string): Promise<Receipt[]> {
  const entries = await readdir(directory, { recursive: true });
  return Promise.all(entries.filter(path => path.endsWith('.json')).map(async path => {
    const receipt: Receipt = JSON.parse(await readFile(join(directory, path), 'utf8'));
    assert.ok(Array.isArray(receipt.inventory) && Array.isArray(receipt.phases), 'invalid phase receipt');
    return receipt;
  }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [serial, parallel] = process.argv.slice(2);
  assert.ok(serial && parallel, 'usage: compare.ts serial-artifacts-directory parallel-artifacts-directory');
  console.log(JSON.stringify(compare(await readReceipts(serial), await readReceipts(parallel)), null, 2));
}
