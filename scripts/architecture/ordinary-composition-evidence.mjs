import assert from 'node:assert/strict';
import {parseSync} from 'oxc-parser';

export const ordinaryCompositionPath = 'packages/apps/embedded-runtime/src/features/ordinary-session-runtime/composition/ordinary-runtime-assembly.ts';
export const ordinaryAuthorityPath = 'docs/decisions/0021-ordinary-user-session-codex-execution-profile.md';
const property = (node, name) => node?.properties?.find(p => (p.key?.name ?? p.key?.value) === name)?.value;
const literal = node => node?.value;
const string = (node, name) => literal(property(node, name));
const list = node => node?.elements ?? [];
const unwrap = node => node?.type === 'TSAsExpression' ? node.expression : node;
const expected = {
  'ordinary/store': [], 'ordinary/security': [], 'ordinary/provider-access': ['register-secrets:ordinary/register-secrets'],
  'ordinary/workspace': [], 'ordinary/artifacts': [], 'ordinary/process': [], 'ordinary/provider': [],
  'ordinary/turn': ['operation-store:ordinary/store', 'security:ordinary/security', 'provider-access:ordinary/provider-access',
    'workspace:ordinary/workspace', 'artifacts:ordinary/artifacts', 'process:ordinary/process', 'provider:ordinary/provider'],
};

/** Literal declarations retain the reviewed eight-owner slice. Dynamic graph
 * generation, undeclared capabilities and weakened cardinality fail closed.
 * Runtime rejecting tests additionally prove compile/prepare zero-call behavior.
 */
export function verifyOrdinaryGraph(source) {
  const parsed = parseSync(ordinaryCompositionPath, source);
  assert.equal(parsed.errors.length, 0, 'ordinary graph parse failure');
  const variables = parsed.program.body.flatMap(n => (n.declaration ?? n).declarations ?? []);
  const modules = variables.filter(v => v.init?.type === 'CallExpression' && v.init.callee?.name === 'defineModule');
  assert.equal(modules.length, 8, 'ordinary graph must declare exactly eight modules');
  const ids = [];
  for (const entry of modules) {
    const object = entry.init.arguments[0], id = string(object, 'moduleId'); ids.push(id);
    assert.ok(Object.hasOwn(expected, id), 'unknown ordinary module');
    assert.equal(string(object, 'implementationId'), id, 'ordinary implementation drift');
    const capabilities = list(property(object, 'provides')).map(p => string(p, 'capabilityId')).toSorted();
    assert.deepEqual(capabilities, (id === 'ordinary/security' ? [id, 'ordinary/register-secrets'] : [id]).toSorted(), 'ordinary capability drift');
    const slots = list(property(object, 'slots'));
    assert.deepEqual(slots.map(s => `${string(s, 'slotId')}:${string(s, 'capabilityId')}`).toSorted(), [...expected[id]].toSorted(), 'ordinary dependency slots drift');
    for (const item of [...list(property(object, 'provides')), ...slots]) {
      assert.equal(property(item, 'compatibility')?.name, 'compatibility', 'ordinary compatibility reference drift');
    }
    for (const slot of slots) {assert.equal(string(property(slot, 'cardinality'), 'kind'), 'required', 'ordinary slot must be required');}
  }
  assert.deepEqual(ids.toSorted(), Object.keys(expected).toSorted(), 'ordinary module census drift');
  const compatibility = unwrap(variables.find(v => v.id?.name === 'compatibility')?.init);
  assert.equal(string(compatibility, 'family'), 'exact');
  assert.equal(literal(property(compatibility, 'familyVersion')), 1);
  assert.equal(string(compatibility, 'token'), 'agent-runtime/ordinary-v1');
  const hostSlot = unwrap(variables.find(v => v.id?.name === 'ordinaryTurnHostSlot')?.init);
  assert.equal(string(hostSlot, 'slotId'), 'ordinary-turn', 'ordinary Host slot drift');
  assert.equal(string(hostSlot, 'capabilityId'), 'ordinary/turn', 'ordinary Host capability drift');
  assert.equal(string(property(hostSlot, 'cardinality'), 'kind'), 'required', 'ordinary Host slot must be required');
  assert.equal(property(hostSlot, 'compatibility')?.name, 'compatibility', 'ordinary Host token reference drift');
  const declarations = unwrap(variables.find(v => v.id?.name === 'ordinaryRuntimeDeclarations')?.init);
  assert.deepEqual(list(declarations).map(e => e.name).toSorted(), modules.map(v => v.id.name).toSorted(), 'ordinary declaration export census drift');
  const bindings = list(unwrap(variables.find(v => v.id?.name === 'ordinaryRuntimeBindings')?.init)).map(b =>
    `${string(b, 'consumerImplementationId')}:${string(b, 'slotId')}:${list(property(b, 'providerImplementationIds')).map(literal).join(',')}`);
  const wanted = expected['ordinary/turn'].map(slot => `ordinary/turn:${slot}`);
  wanted.push('ordinary/provider-access:register-secrets:ordinary/security', 'agent-runtime/runtime-host:ordinary-turn:ordinary/turn');
  assert.deepEqual(bindings.toSorted(), wanted.toSorted(), 'ordinary exact binding mapping drift');
}
