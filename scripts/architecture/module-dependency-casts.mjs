import assert from 'node:assert/strict';
import {readdir, readFile} from 'node:fs/promises';
import {join, sep} from 'node:path';
import {parseSync} from 'oxc-parser';

// Add a module's factory or the function it passes its slot values to when a module is added;
// the check fails on a name that no longer exists.
export const MODULE_ENTRY_POINTS = Object.freeze([
  'createAgentRuntimeHost',
  'createNodeOrdinaryProcess',
  'createOrdinaryModuleFactories',
  'createOrdinaryTurnFeature',
  'createPostgresOrdinaryProviderAccessOwner',
]);

const CONFORMANCE = '@get-modular/conformance';
const ERASING_TYPES = new Map([['TSNeverKeyword', 'never'], ['TSAnyKeyword', 'any'], ['TSUnknownKeyword', 'unknown']]);
const HOSTILE = /^\s*hostile-input:\s*(\S.*)?$/u;
// Files without any of these tokens cannot hold an erasing cast or a hostile-input mark; they are not parsed.
const CANDIDATE = /\bas\s+(?:never|any|unknown)\b|<\s*(?:never|any)\s*>|hostile-input/u;

const stripParens = node => {
  let current = node;
  while (current?.type === 'ParenthesizedExpression') {current = current.expression;}
  return current;
};
const isAssertion = node => node?.type === 'TSAsExpression' || node?.type === 'TSTypeAssertion';
const isFactoryDependencies = type => type?.type === 'TSTypeReference' && type.typeName?.name === 'FactoryDependencies';
const calleeName = callee => callee?.type === 'Identifier' ? callee.name : callee?.type === 'MemberExpression' && !callee.computed ? callee.property?.name : undefined;

const visit = (node, callback) => {
  if (node === null || typeof node !== 'object') {return;}
  if (Array.isArray(node)) {node.forEach(item => visit(item, callback)); return;}
  if (typeof node.type === 'string') {callback(node);}
  for (const [key, value] of Object.entries(node)) {if (key !== 'parent') {visit(value, callback);}}
};

/** The kind of a type-erasing assertion, or undefined when the assertion keeps a real type. */
function erasingKind(node) {
  const target = ERASING_TYPES.get(node.typeAnnotation?.type);
  if (node.type === 'TSTypeAssertion') {return target === 'never' || target === 'any' ? `<${target}>` : undefined;}
  if (target === 'never' || target === 'any') {return `as ${target}`;}
  const inner = stripParens(node.expression);
  const through = isAssertion(inner) ? ERASING_TYPES.get(inner.typeAnnotation?.type) : undefined;
  return through === undefined ? undefined : `as ${through} as`;
}

/** Returns `{path, line, kind, entry}` for each type-erasing cast on a module dependency record in one file. */
export function findDependencyRecordCasts(path, source) {
  const parsed = parseSync(path, source);
  if (parsed.errors.length > 0) {return [{path, line: 1, kind: 'parse error', entry: parsed.errors[0].message}];}
  const lineStarts = [0];
  for (let index = 0; index < source.length; index += 1) {if (source[index] === '\n') {lineStarts.push(index + 1);}}
  const lineOf = offset => {
    let low = 0; let high = lineStarts.length - 1;
    while (low < high) {const mid = (low + high + 1) >> 1; if (lineStarts[mid] <= offset) {low = mid;} else {high = mid - 1;}}
    return low + 1;
  };
  const hostileLines = new Set();
  const violations = [];
  for (const comment of parsed.comments) {
    if (comment.type !== 'Line') {continue;}
    const match = HOSTILE.exec(comment.value);
    if (match === null) {continue;}
    if (match[1] === undefined) {violations.push({path, line: lineOf(comment.start), kind: 'empty hostile-input', entry: ''});}
    else {hostileLines.add(lineOf(comment.end));}
  }

  const isolateNames = new Set(); const namespaces = new Set();
  const constants = new Map();
  visit(parsed.program, node => {
    if (node.type === 'ImportDeclaration' && node.source.value === CONFORMANCE) {
      for (const specifier of node.specifiers) {
        if (specifier.type === 'ImportNamespaceSpecifier') {namespaces.add(specifier.local.name);}
        else if (specifier.type === 'ImportSpecifier' && (specifier.imported.name ?? specifier.imported.value) === 'isolate') {isolateNames.add(specifier.local.name);}
      }
    }
    if (node.type === 'VariableDeclaration' && node.kind === 'const') {
      for (const declarator of node.declarations) {
        if (declarator.id.type === 'Identifier' && declarator.init) {constants.set(declarator.id.name, [...constants.get(declarator.id.name) ?? [], declarator.init]);}
      }
    }
  });

  const reported = new Set();
  const report = (node, kind, entry) => {
    if (reported.has(node.start)) {return;}
    reported.add(node.start);
    const line = lineOf(node.start);
    if (hostileLines.has(line) || hostileLines.has(line - 1)) {return;}
    violations.push({path, line, kind, entry});
  };
  /** Looks for erasing assertions in the positions that make up a record value; function bodies and call arguments are not records. */
  const inspect = (node, entry, followIdentifiers) => {
    const current = stripParens(node);
    if (current === null || typeof current !== 'object') {return;}
    switch (current.type) {
      case 'TSAsExpression': case 'TSTypeAssertion': {
        const kind = erasingKind(current);
        if (kind === undefined) {inspect(current.expression, entry, followIdentifiers);} else {report(current, kind, entry);}
        break;
      }
      case 'TSSatisfiesExpression': case 'TSNonNullExpression': inspect(current.expression, entry, followIdentifiers); break;
      case 'SpreadElement': inspect(current.argument, entry, followIdentifiers); break;
      case 'ObjectExpression': current.properties.forEach(property => inspect(property.type === 'SpreadElement' ? property : property.value, entry, followIdentifiers)); break;
      case 'ArrayExpression': current.elements.forEach(element => element && inspect(element, entry, followIdentifiers)); break;
      case 'ConditionalExpression': inspect(current.consequent, entry, followIdentifiers); inspect(current.alternate, entry, followIdentifiers); break;
      case 'LogicalExpression': inspect(current.left, entry, followIdentifiers); inspect(current.right, entry, followIdentifiers); break;
      case 'Identifier': if (followIdentifiers) {(constants.get(current.name) ?? []).forEach(init => inspect(init, entry, false));} break;
      default: break;
    }
  };
  const isIsolate = callee => (callee?.type === 'Identifier' && isolateNames.has(callee.name))
    || (callee?.type === 'MemberExpression' && !callee.computed && callee.object?.type === 'Identifier' && namespaces.has(callee.object.name) && callee.property?.name === 'isolate');

  visit(parsed.program, node => {
    if (node.type === 'CallExpression' || node.type === 'NewExpression') {
      if (isIsolate(node.callee)) {
        const options = stripParens(node.arguments[1]);
        const dependencies = options?.type === 'ObjectExpression' ? options.properties.find(property => property.type === 'Property' && (property.key?.name ?? property.key?.value) === 'dependencies') : undefined;
        if (dependencies !== undefined) {inspect(dependencies.value, 'isolate', true);}
      }
      const name = calleeName(node.callee);
      if (name !== undefined && MODULE_ENTRY_POINTS.includes(name) && node.arguments[0] !== undefined) {inspect(node.arguments[0], name, true);}
    }
    if (node.type === 'TSSatisfiesExpression' && isFactoryDependencies(node.typeAnnotation)) {inspect(node.expression, 'FactoryDependencies', true);}
    if (node.type === 'VariableDeclarator' && node.init && isFactoryDependencies(node.id.typeAnnotation?.typeAnnotation)) {inspect(node.init, 'FactoryDependencies', true);}
  });
  return violations.toSorted((left, right) => left.line - right.line);
}

async function listFiles(directory, test) {
  const found = [];
  for (const entry of await readdir(directory, {recursive: true, withFileTypes: true})) {
    const path = join(entry.parentPath, entry.name);
    if (entry.isFile() && test(path) && !path.split(sep).some(segment => segment === 'node_modules' || segment === 'dist')) {found.push(path);}
  }
  return found.toSorted();
}
const packageFiles = async (root, scope, test) => {
  const files = [];
  for (const group of await readdir(join(root, 'packages'), {withFileTypes: true})) {
    if (!group.isDirectory()) {continue;}
    for (const pack of await readdir(join(root, 'packages', group.name), {withFileTypes: true})) {
      if (pack.isDirectory()) {files.push(...await listFiles(join(root, 'packages', group.name, pack.name, scope), test).catch(error => {if (error?.code === 'ENOENT') {return [];} throw error;}));}
    }
  }
  return files;
};

/** Scans the module test files for casts on dependency records and checks that every entry point still exists. */
export async function checkModuleDependencyCasts(root) {
  const problems = [];
  const sources = (await packageFiles(root, 'src', path => path.endsWith('.ts'))).map(path => readFile(path, 'utf8'));
  const exported = (await Promise.all(sources)).join('\n');
  for (const name of MODULE_ENTRY_POINTS) {
    const pattern = new RegExp(String.raw`export\s*(?:\{[^}]*\b${name}\b[^}]*\}|(?:async\s+)?(?:function\*?|const|class)\s+${name}\b)`, 'u');
    if (!pattern.test(exported)) {problems.push(`stale entry point ${name}: no export in packages/*/*/src`);}
  }
  for (const path of await packageFiles(root, 'tests', file => /\.[cm]?ts$/u.test(file))) {
    const source = await readFile(path, 'utf8');
    if (!CANDIDATE.test(source)) {continue;}
    for (const violation of findDependencyRecordCasts(path, source)) {
      problems.push(`${path.slice(root.length).replace(/^[/\\]/u, '')}:${violation.line} ${violation.kind} (${violation.entry})`);
    }
  }
  assert.deepEqual(problems, [], `type-erasing casts on module dependency records:\n${problems.join('\n')}`);
}
