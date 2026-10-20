import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {posix} from 'node:path';
import {pathToFileURL} from 'node:url';
import {parseSync} from 'oxc-parser';

const require = createRequire(new URL('../../packages/apps/embedded-runtime/package.json', import.meta.url));
const {checkModuleLayout} = await import(pathToFileURL(require.resolve('@get-modular/conformance')).href);
export const hostFeature = 'packages/apps/embedded-runtime/src/features/interactive-session-runtime';
export const hostAuthority = 'docs/decisions/0091-interactive-agent-session-synthetic-vertical-slice.md';
export const hostRoot = 'packages/apps/embedded-runtime/src/composition/interactive-session-host.root.ts';
export const hostFactory = 'packages/apps/embedded-runtime/src/composition/interactive-session-host.ts';
export const hostTests = 'packages/apps/embedded-runtime/tests/features/interactive-session-runtime/host.test.ts';
const composition = `${hostFeature}/composition`;
const names = ['store', 'provider', 'authority', 'custody', 'context', 'ownership'];
export const hostEvidencePaths = [hostAuthority, hostRoot, hostFactory, hostTests,
  `${hostFeature}/contracts/interactive-session-host.ts`, `${hostFeature}/application/ports/outbound/interactive-host-ports.ts`,
  `${hostFeature}/application/use-cases/create-session-host.ts`, `${hostFeature}/domain/session-host.ts`,
  `${composition}/interactive-session-runtime.contracts.ts`, `${composition}/interactive-session-runtime.group.ts`,
  `${composition}/interactive-session-runtime.inputs.ts`, `${composition}/host.module.ts`, `${composition}/host.declaration.ts`,
  ...names.map(name => `${composition}/${name}.declaration.ts`),
  'packages/apps/embedded-runtime/tests/features/interactive-session-runtime/host-contract-suite.ts',
  'packages/apps/embedded-runtime/scripts/run-package-tests.mjs'];
const property = (node, name) => node?.properties?.find(p => (p.key?.name ?? p.key?.value) === name)?.value;
const unwrap = node => node?.type === 'TSAsExpression' ? node.expression : node;
const variables = program => program.body.flatMap(node => (node.declaration ?? node).declarations ?? []);
const walk = (node, visit) => {
  if (!node || typeof node !== 'object') {return;}
  visit(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {value.forEach(item => walk(item, visit));} else {walk(value, visit);}
  }
};
const callee = node => node?.callee?.name;
const parse = (path, source) => {
  const parsed = parseSync(path, source); assert.equal(parsed.errors.length, 0, `interactive Host parse: ${path}`); return parsed.program;
};
const product = 'agent-runtime/interactive-host/';

/** Closed, independently enumerated seven-provider graph. The executable module test also checks the compiled plan. */
export function verifyInteractiveHostComposition(mapping, decisions, get, sourcePaths = hostEvidencePaths) {
  assert.equal(mapping.authority, 'ADR-0091', 'interactive Host authority drift');
  assert.ok(decisions.some(d => d.id === 'ADR-0091' && d.path === hostAuthority), 'interactive Host accepted authority missing');
  assert.equal(mapping.entrypoint, hostFeature + '/internal.ts', 'interactive Host entrypoint mapping drift');
  assert.equal(mapping.implementation, hostRoot, 'interactive Host root mapping drift');
  assert.equal(mapping.declarations, `${composition}/host.declaration.ts`, 'interactive Host declaration mapping drift');
  assert.equal(mapping.profile, hostRoot, 'interactive Host profile mapping drift');
  assert.equal(mapping.factories, `${composition}/host.module.ts`, 'interactive Host factory mapping drift');
  assert.ok(mapping.tests.includes(hostTests), 'interactive Host qualification omitted');
  const paths = [...new Set([...hostEvidencePaths, ...sourcePaths.filter(path => path.startsWith(hostFeature + '/') && path.endsWith('.ts'))])];
  const programs = new Map(paths.filter(path => /\.(?:ts|mjs)$/.test(path)).map(path => [path, parse(path, get(path))]));
  verifyHostGraph(programs);
  verifyHostRoot(programs);
  for (const path of [`${hostFeature}/contracts/interactive-session-host.ts`, `${hostFeature}/application/ports/outbound/interactive-host-ports.ts`]) {
    walk(programs.get(path), node => assert.notEqual(node.type, 'TSMethodSignature', 'interactive Host ports use arrow function properties'));
  }
  const layout = verifyHostLayout(programs);
  const tests = get(hostTests), suite = get('packages/apps/embedded-runtime/tests/features/interactive-session-runtime/host-contract-suite.ts');
  for (const call of ['checkWiring(', 'checkNamespaces(', 'isolate(', 'smoke(', 'registerHostContractSuite(test)']) {
    assert.ok(tests.includes(call), `interactive Host qualification missing ${call}`);
  }
  assert.ok(suite.includes('runContractSuite(hostContractSuite') && suite.includes('independent owner fake'), 'interactive Host reusable contract suite missing');
  assert.ok(get('packages/apps/embedded-runtime/scripts/run-package-tests.mjs').includes('tests/features/interactive-session-runtime/host.test.ts'), 'interactive Host mandatory runner omitted');
  return layout;
}

function verifyHostGraph(programs) {
  const descriptorVariables = variables(programs.get(`${composition}/interactive-session-runtime.contracts.ts`))
    .filter(v => callee(v.init?.callee) === 'defineContract');
  assert.deepEqual(descriptorVariables.map(v => [property(v.init.arguments[0], 'id')?.value, property(v.init.arguments[0], 'revision')?.value]).toSorted(),
    [...names, 'host'].map(name => [product + name, 1]).toSorted(), 'interactive Host descriptor census drift');
  for (const name of [...names, 'host']) {
    const declared = variables(programs.get(`${composition}/${name}.declaration.ts`)).filter(v => callee(v.init) === 'declareModule');
    assert.equal(declared.length, 1, 'interactive Host one declaration per file');
    const body = declared[0].init.arguments[0];
    assert.equal(property(body, 'moduleId')?.value, product + name, 'interactive Host module identity drift');
    assert.equal(property(body, 'implementationId')?.value, `${product}${name}/${name === 'host' ? 'default' : 'input'}`, 'interactive Host implementation drift');
    const provides = property(body, 'provides')?.elements;
    assert.deepEqual(provides?.map(node => [node.callee?.object?.name, node.callee?.property?.name]), [[name[0].toUpperCase() + name.slice(1), 'provide']], 'interactive Host provided capability drift');
    const slots = property(body, 'slots')?.elements;
    assert.deepEqual(slots?.map(node => [node.callee?.object?.name, node.callee?.property?.name, node.arguments[0]?.value, callee(node.arguments[1])]),
      name === 'host' ? names.map(slot => [slot[0].toUpperCase() + slot.slice(1), 'slot', slot, 'required']) : [], 'interactive Host required slots drift');
  }
  const groups = variables(programs.get(`${composition}/interactive-session-runtime.group.ts`)).filter(v => callee(v.init) === 'group');
  assert.equal(groups.length, 1, 'interactive Host group count drift');
  assert.equal(groups[0].init.arguments[0]?.value, 'interactive-session-runtime', 'interactive Host group identity drift');
  assert.deepEqual(groups[0].init.arguments[1]?.elements.map(n => n.name), ['hostModule'], 'interactive Host group members drift');
  const inputs = variables(programs.get(`${composition}/interactive-session-runtime.inputs.ts`)).filter(v => callee(v.init?.callee) === 'input');
  assert.deepEqual(inputs.map(v => [v.id.name, v.init.arguments[0]?.name]), names.map(name => [name + 'Input', name + 'Declaration']), 'interactive Host input census drift');
}

function verifyHostRoot(programs) {
  const rootVariables = variables(programs.get(hostRoot));
  assert.deepEqual(unwrap(rootVariables.find(v => v.id.name === 'interactiveHostModules')?.init)?.elements.map(n => n.name), ['interactiveSessionRuntimeGroup'], 'interactive Host static root group drift');
  const root = rootVariables.find(v => v.id.name === 'composeInteractiveSessionHost')?.init?.body;
  assert.equal(root?.callee?.property?.name, 'prepare', 'interactive Host root must prepare');
  const config = root.arguments[0];
  assert.equal(property(config, 'profileId')?.value, 'agent-runtime/interactive-session-host/v1', 'interactive Host profile identity drift');
  assert.equal(property(config, 'modules')?.name, 'interactiveHostModules', 'interactive Host modules drift');
  assert.deepEqual(property(config, 'roots')?.properties.map(p => [p.key.name, p.value.name]), [['host', 'hostModule']], 'interactive Host roots drift');
  assert.deepEqual(property(config, 'inputs')?.properties.map(p => [p.key.name, p.value.name]), names.map(n => [n, n + 'Input']), 'interactive Host root inputs drift');
}

function verifyHostLayout(programs) {
  const files = [...programs.keys()].filter(path => path.startsWith(hostFeature + '/') || path === hostRoot);
  const imports = [], useCaseExports = {};
  for (const path of files) {
    const program = programs.get(path);
    for (const node of program.body) {
      if (node.type === 'ImportDeclaration' && node.source.value.startsWith('.')) {
        imports.push({from: path, to: posix.normalize(posix.join(posix.dirname(path), node.source.value)).replace(/\.js$/, '.ts'),
          mode: node.importKind === 'type' || node.specifiers.length > 0 && node.specifiers.every(s => s.importKind === 'type') ? 'type' : 'value'});
      }
    }
    if (path.includes('/application/use-cases/')) {
      useCaseExports[path] = program.body.filter(n => n.type === 'ExportNamedDeclaration' && n.exportKind !== 'type').flatMap(n => {
        const declaration = n.declaration;
        return declaration?.type === 'FunctionDeclaration' ? [{name: declaration.id.name, kind: 'function'}]
          : (declaration?.declarations ?? []).map(v => ({name: v.id.name, kind: ['ArrowFunctionExpression', 'FunctionExpression'].includes(v.init?.type) ? 'function' : 'value'}));
      });
    }
  }
  const layout = checkModuleLayout({files, imports, useCaseExports});
  assert.deepEqual(layout.violations, [], 'interactive Host CMS module layout');
  assert.equal(layout.featureCount, 1, 'interactive Host CMS feature count');
  assert.equal(layout.moduleCount, 1, 'interactive Host CMS module count');
  return layout;
}
