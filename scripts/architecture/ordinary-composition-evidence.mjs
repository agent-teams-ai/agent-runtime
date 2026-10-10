import assert from 'node:assert/strict';
import {parseSync} from 'oxc-parser';

export const ordinaryCompositionPath = 'packages/apps/embedded-runtime/src/features/ordinary-session-runtime/composition/ordinary-runtime-assembly.ts';
export const ordinaryAuthorityPath = 'docs/decisions/0090-ordinary-user-session-codex-execution-profile.md';
const property = (node, name) => node?.properties?.find(p => (p.key?.name ?? p.key?.value) === name)?.value;
const literal = node => node?.value;
const string = (node, name) => literal(property(node, name));
const list = node => node?.elements ?? [];
const unwrap = node => node?.type === 'TSAsExpression' ? node.expression : node;
const product = 'agent-runtime/ordinary/';
const turnSlots = ['operation-store:store', 'security:security', 'provider-access:provider-access', 'workspace:workspace', 'artifacts:artifacts', 'process:process', 'provider:provider'];
const expectedDescriptors = ['store', 'security', 'register-secrets', 'provider-access', 'workspace', 'artifacts', 'process', 'prepare-launch', 'provider', 'turn'].map(name => `${product}${name}`);
const expectedModules = {
  store: {implementation: 'postgres', provides: ['store'], slots: []},
  security: {implementation: 'postgres', provides: ['security', 'register-secrets'], slots: []},
  'provider-access': {implementation: 'postgres', provides: ['provider-access'], slots: ['register-secrets:register-secrets']},
  workspace: {implementation: 'node', provides: ['workspace'], slots: []},
  artifacts: {implementation: 'node', provides: ['artifacts'], slots: []},
  process: {implementation: 'node', provides: ['process'], slots: ['prepare-launch:prepare-launch']},
  provider: {implementation: 'codex', provides: ['provider', 'prepare-launch'], slots: []},
  turn: {implementation: 'default', provides: ['turn'], slots: turnSlots},
};
const expectedBindings = [
  ...turnSlots.map(slot => `${product}turn/default:${slot.split(':')[0]}:${product}${slot.split(':')[1]}/${expectedModules[slot.split(':')[1]].implementation}`),
  `${product}process/node:prepare-launch:${product}provider/codex`,
  `${product}provider-access/postgres:register-secrets:${product}security/postgres`,
];
const hostTurnProvider = `${product}turn/default`;

const walk = (node, visitor) => {
  if (!node || typeof node !== 'object') {return;}
  visitor(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {value.forEach(item => walk(item, visitor));} else {walk(value, visitor);}
  }
};
const callName = node => node?.type === 'CallExpression' && node.callee?.type === 'Identifier' ? node.callee.name : undefined;
const isCardinality = (node, name) => callName(node) === name && node.arguments.length === 0;
/** `X.provide()` or `X.slot("<slot>", required())` with X a collected descriptor; returns the descriptor name. */
const descriptorCall = (node, method) => {
  assert.equal(node?.type, 'CallExpression', `ordinary declaration entry must call ${method}()`);
  assert.equal(node.callee?.type, 'MemberExpression', `ordinary declaration entry must call ${method}()`);
  assert.equal(node.callee.property?.name, method, `ordinary declaration entry must call ${method}()`);
  assert.equal(node.callee.object?.type, 'Identifier', 'ordinary declaration entry must name a contract descriptor');
  return node.callee.object.name;
};

/** Descriptors and declarations stay literal: the eight-owner slice, one revision-1 descriptor per capability,
 * and required slots. Dynamic graph generation, undeclared capabilities and weakened cardinality fail closed.
 * The compiled-plan test additionally proves the plan-level tokens, providers and slots.
 */
export function verifyOrdinaryGraph(source) {
  const parsed = parseSync(ordinaryCompositionPath, source);
  assert.equal(parsed.errors.length, 0, 'ordinary graph parse failure');
  walk(parsed.program, node => {
    assert.notEqual(callName(node), 'defineModule', 'ordinary graph must use declareModule');
    assert.ok(!(node.type === 'Property' && (node.key?.name ?? node.key?.value) === 'compatibility'), 'ordinary declarations must not spell compatibility');
  });
  const variables = parsed.program.body.flatMap(n => (n.declaration ?? n).declarations ?? []);
  const descriptors = new Map();
  for (const entry of variables.filter(v => v.init?.type === 'CallExpression' && callName(v.init.callee) === 'defineContract')) {
    const object = entry.init.arguments[0];
    assert.equal(literal(property(object, 'revision')), 1, 'ordinary descriptor revision drift');
    descriptors.set(entry.id.name, string(object, 'id'));
  }
  assert.deepEqual([...descriptors.values()].toSorted(), expectedDescriptors.toSorted(), 'ordinary descriptor census drift');
  const resolve = node => node?.type === 'Identifier' ? variables.find(v => v.id?.name === node.name)?.init : node;
  const modules = variables.filter(v => callName(v.init) === 'declareModule');
  assert.equal(modules.length, 8, 'ordinary graph must declare exactly eight modules');
  const ids = [];
  for (const entry of modules) {
    const object = entry.init.arguments[0], id = string(object, 'moduleId'); ids.push(id);
    const wanted = expectedModules[id?.replace(product, '')];
    assert.ok(id?.startsWith(product) && wanted !== undefined, 'unknown ordinary module');
    assert.equal(string(object, 'implementationId'), `${id}/${wanted.implementation}`, 'ordinary implementation drift');
    assert.equal(string(resolve(property(object, 'owner')), 'authority'), 'agent-runtime', 'ordinary owner authority drift');
    const known = name => {assert.ok(descriptors.has(name), 'ordinary declaration names an unknown descriptor'); return descriptors.get(name).replace(product, '');};
    const provides = list(property(object, 'provides')).map(p => known(descriptorCall(p, 'provide')));
    assert.deepEqual(provides.toSorted(), [...wanted.provides].toSorted(), 'ordinary capability drift');
    const slots = list(property(object, 'slots')).map(slot => {
      const name = descriptorCall(slot, 'slot');
      assert.equal(slot.arguments.length, 2, 'ordinary slot must name a slot and a cardinality');
      assert.ok(isCardinality(slot.arguments[1], 'required'), 'ordinary slot must be required');
      return `${literal(slot.arguments[0])}:${known(name)}`;
    });
    assert.deepEqual(slots.toSorted(), [...wanted.slots].toSorted(), 'ordinary dependency slots drift');
  }
  assert.deepEqual(ids.toSorted(), Object.keys(expectedModules).map(name => `${product}${name}`).toSorted(), 'ordinary module census drift');
  const declarations = unwrap(variables.find(v => v.id?.name === 'ordinaryRuntimeDeclarations')?.init);
  assert.deepEqual(list(declarations).map(e => e.name).toSorted(), modules.map(v => v.id.name).toSorted(), 'ordinary declaration export census drift');
  const bindings = list(unwrap(variables.find(v => v.id?.name === 'ordinaryRuntimeBindings')?.init)).map(b =>
    `${string(b, 'consumerImplementationId')}:${string(b, 'slotId')}:${list(property(b, 'providerImplementationIds')).map(literal).join(',')}`);
  assert.deepEqual(bindings.toSorted(), expectedBindings.toSorted(), 'ordinary exact binding mapping drift');
}

/** The Host's physical-closure handoff must be the same closed ordinary root. */
export function verifyOrdinaryHostOwnership(source) {
  const parsed = parseSync('runtime-setup-assembly.ts', source);
  assert.equal(parsed.errors.length, 0, 'ordinary Host handoff parse failure');
  const calls = [];
  const visit = node => {
    if (!node || typeof node !== 'object') {return;}
    if (node.type === 'CallExpression') {calls.push(node);}
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {value.forEach(visit);} else {visit(value);}
    }
  };
  visit(parsed.program);
  const host = calls.filter(call => call.callee?.object?.name === 'factories' && call.callee?.property?.name === 'host');
  assert.equal(host.length, 1, 'ordinary Host factory must be unique');
  assert.equal(host[0].arguments[1]?.object?.name, 'dependencies', 'ordinary Host owner handoff missing');
  assert.equal(host[0].arguments[1]?.property?.value, 'ordinary-turn', 'ordinary Host owner handoff mismatch');
  const construction = calls.filter(call => call.callee?.name === 'createAgentRuntimeHost');
  assert.equal(construction.length, 1, 'ordinary Host construction must be unique');
  assert.equal(construction[0].arguments[1]?.name, 'ordinaryOwner', 'ordinary Host factory dropped ownership');
  const turnSlot = calls.filter(call => call.callee?.object?.name === 'OrdinaryTurn' && call.callee?.property?.name === 'slot' && call.arguments[0]?.value === 'ordinary-turn');
  assert.equal(turnSlot.length, 1, 'ordinary Host turn slot must be unique');
  assert.ok(isCardinality(turnSlot[0].arguments[1], 'required'), 'ordinary Host turn slot must be required');
  const turnBindings = [];
  walk(parsed.program, node => {if (node.type === 'ObjectExpression' && string(node, 'slotId') === 'ordinary-turn') {turnBindings.push(node);}});
  assert.equal(turnBindings.length, 1, 'ordinary Host turn binding must be unique');
  assert.deepEqual(list(property(turnBindings[0], 'providerImplementationIds')).map(literal), [hostTurnProvider], 'ordinary Host turn provider drift');
}
