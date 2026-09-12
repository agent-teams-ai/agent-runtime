import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {scopedFeaturePrimitives as fms} from './feature-module-analysis.mjs';
import {canonicalRoot, createPathIndex, repositoryPath} from './feature-module-paths.mjs';
import {parseDeterministicJson, readLocalPackageImports} from './feature-module-config.mjs';
import {maintainabilityIssues} from './feature-module-maintainability.mjs';
import {detectCycles, unusedEdgeIssues} from './feature-module-edges.mjs';

const PROFILE = 'architecture/feature-module-standard/ordinary-scope.json';
const FEATURE = 'packages/apps/embedded-runtime/src/features/ordinary-session-runtime';
const RS = 'packages/contexts/runtime-security/src/features/contained-turn-dispatch-authority';
const ordinarySource = path => path.startsWith(`${FEATURE}/`) || /\/[^/]*ordinary[^/]*\.[cm]?[jt]sx?$/.test(path);
export const inboundImportIssues = (path, imported) => path.includes('/adapters/inbound/') && !imported.specifier?.startsWith('.')
  ? [fms.issue('FM_INBOUND_EXTERNAL_IMPORT', path, imported.line, 'inbound adapters cannot import Node or external SDK packages')] : [];
const diagnostic = message => fms.issue('FM_ORDINARY_SCOPE', PROFILE, 1, message);
const edges = value => new Map(value.map(edge => [`${edge.from}->${edge.to}`, new Set(edge.kinds)]));
const same = (a, b) => JSON.stringify([...a].toSorted()) === JSON.stringify([...b].toSorted());

function legacySeamProfileIssues(profile, paths) {
  const issues = [];
  const seams = profile.compositionDependencies;
  if (!Array.isArray(seams) || seams.some(edge => !profile.files.includes(edge.from)
    || !paths.includes(edge.to) || !edge.to.startsWith('packages/apps/embedded-runtime/src/composition/')
    || edge.to.includes('ordinary') || !['runtime', 'type'].includes(edge.kind)
    || !(edge.from.startsWith(`${FEATURE}/composition/`) && edge.facade === undefined
      || edge.from === 'packages/apps/embedded-runtime/src/composition/ordinary-agent-runtime-host.ts' && edge.facade === true)
    || Object.keys(edge).some(key => !['from', 'to', 'kind', 'facade'].includes(key)))) {
    issues.push(diagnostic('legacy Host seams require exact owned composition source, existing target and import kind'));
  }
  if (!same(profile.facades ?? [], ['packages/apps/embedded-runtime/src/composition/ordinary-agent-runtime-host.ts',
    'packages/apps/embedded-runtime/src/composition/ordinary-runtime-assembly.ts'])) {issues.push(diagnostic('ordinary static facade census drift'));}
  return issues;
}

function featureScopeShapeIssues(profile) {
  const issues = [];
  if (profile.feature?.root !== FEATURE || profile.feature?.id !== 'ordinary-session-runtime'
    || !same(profile.feature?.roles ?? [], ['contracts', 'adapters', 'composition'])
    || profile.feature?.entrypoints?.public !== `${FEATURE}/index.ts`
    || profile.feature?.entrypoints?.internal !== `${FEATURE}/internal.ts`) {
    issues.push(diagnostic('ordinary feature ownership, roles or curated entrypoints drift'));
  }
  return issues;
}

export function validateOrdinaryScope(profile, paths, decisions) {
  const issues = [];
  if (profile.schemaVersion !== 1 || profile.status !== 'active' || profile.authority !== 'ADR-0020'
    || !decisions.some(d => d.id === profile.authority && d.path === 'docs/decisions/0020-ordinary-user-session-codex-execution-profile.md')) {
    issues.push(diagnostic('ordinary scope requires accepted ADR-0020 and active v1 profile'));
  }
  if (!Array.isArray(profile.files) || !profile.files.length || new Set(profile.files).size !== profile.files.length
    || profile.files.some(path => !paths.includes(path)) || !same(paths.filter(ordinarySource), profile.files.filter(ordinarySource))) {
    issues.push(diagnostic('exact ordinary production source census drift'));
  }
  issues.push(...featureScopeShapeIssues(profile));
  if (Object.keys(profile).some(key => !['schemaVersion', 'status', 'authority', 'files', 'feature', 'moduleEdges', 'featureEdges', 'facades', 'compositionDependencies'].includes(key))) {
    issues.push(diagnostic('unknown ordinary profile field; exemptions are not supported'));
  }
  issues.push(...legacySeamProfileIssues(profile, paths));
  return issues;
}

/** Additive file adoption in otherwise pending modules. Uses the canonical FMS
 * inventory, resolver, import/layer, ownership, README and maintainability gates.
 * No production diagnostic is filtered or converted into an allowance.
 */
export async function checkOrdinaryFeatureScope({root = fileURLToPath(new URL('../../', import.meta.url))} = {}) {
  root = resolve(root);
  const identity = await canonicalRoot(root);
  const json = async path => parseDeterministicJson(await readFile(resolve(root, path), 'utf8'));
  let scope, baseline, registry;
  try { [scope, baseline, registry] = await Promise.all([json(PROFILE), json('architecture/feature-module-standard/candidate-profile.json'), json('architecture/decisions/accepted-decisions.json')]); }
  catch { return [diagnostic('missing or malformed ordinary scoped adoption evidence')]; }
  const declaredModules = new Map(baseline.scope.productionModules.map(module => [module.sourceRoot, module]));
  const productionRoots = [...declaredModules.keys()];
  const inventory = await fms.collectProductionFiles(identity, productionRoots, {entries: 0, files: 0, sourceBytes: 0});
  const paths = inventory.files.map(path => repositoryPath(identity, path));
  const issues = [...inventory.issues, ...validateOrdinaryScope(scope, paths, registry.decisions)];
  if (issues.length) {return issues;}
  const features = [...baseline.features, scope.feature, {id: 'contained-turn-dispatch-authority', root: RS,
    roles: baseline.moduleRoles, entrypoints: {public: `${RS}/index.ts`, internal: `${RS}/internal.ts`}}];
  const localPackageImports = await readLocalPackageImports({root: identity, productionRoots, issue: fms.issue, pathIndex: createPathIndex(paths), declaredModules});
  issues.push(...localPackageImports.issues);
  issues.push(...await fms.featureStructureIssues(scope.feature, paths, identity, localPackageImports.packageMetadata));
  const declaredEdges = edges([...baseline.featureEdges, ...scope.featureEdges]);
  const declaredModuleEdges = edges([...baseline.moduleEdges, ...scope.moduleEdges]);
  const observedEdges = new Map(), edgeLocations = new Map(), observedModuleEdges = new Map(), moduleEdgeLocations = new Map();
  const resources = {imports: 0};
  const observedCompositionDependencies = new Set();
  for (const path of scope.files) {
    const sourceFeature = fms.featureForPath(features, path), isAssembly = scope.facades.includes(path);
    issues.push(...fms.ownershipIssues(path, sourceFeature, isAssembly, baseline));
    const parsed = await fms.parseFileImports(resolve(root, path), path, resources);
    issues.push(...parsed.issues, ...maintainabilityIssues({comments: parsed.comments, issue: fms.issue, path,
      role: sourceFeature && fms.layerForPath(sourceFeature, path), source: parsed.source}));
    issues.push(...fms.assemblyGrammarIssues({isAssembly, path, sourceFeature, program: parsed.program, source: parsed.source}));
    for (const imported of parsed.imports) {
      issues.push(...fms.inspectImport({features, isAssembly, sourceFeature, path, imported, declaredEdges, observedEdges, edgeLocations,
        localPackageImports, productionRoots, identityPaths: [], declaredModules, declaredModuleEdges, observedModuleEdges, moduleEdgeLocations,
        compositionDependencies: scope.compositionDependencies, observedCompositionDependencies}));
      issues.push(...inboundImportIssues(path, imported));
    }
    if (parsed.overflow) {issues.push(diagnostic('ordinary import analysis overflow')); break;}
  }
  for (const [observed, locations, kind] of [[observedEdges, edgeLocations, 'feature'], [observedModuleEdges, moduleEdgeLocations, 'module']]) {
    const values = [...observed].map(([key, kinds]) => {const [from, to] = key.split('->'); return {from, to, kinds: [...kinds]};});
    for (const mode of ['runtime', 'type']) {issues.push(...detectCycles(fms.issue, values, locations, mode, kind));}
  }
  issues.push(...unusedEdgeIssues(fms.issue, edges(scope.moduleEdges), observedModuleEdges, PROFILE));
  issues.push(...unusedEdgeIssues(fms.issue, edges(scope.featureEdges), observedEdges, PROFILE));
  for (const seam of scope.compositionDependencies) {
    if (!observedCompositionDependencies.has(JSON.stringify(seam))) {issues.push(diagnostic(`stale legacy Host seam: ${seam.from} -> ${seam.to}`));}
  }
  return issues.toSorted(fms.compareIssues);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const issues = await checkOrdinaryFeatureScope({root: process.argv[2]});
  console.log(JSON.stringify(issues));
  if (issues.length) {process.exitCode = 1;}
}
