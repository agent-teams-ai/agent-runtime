import assert from 'node:assert/strict';
import { FilesystemSourceTreeReader } from '../../node_modules/@agent-teams/engineering-foundation/dist/source-inventory/adapters/outbound/filesystem/filesystem-source-tree-reader.js';
import { PnpmWorkspaceInventoryReader } from '../../node_modules/@agent-teams/engineering-foundation/dist/workspace-inventory/adapters/outbound/pnpm/pnpm-workspace-inventory-reader.js';
import { OxcSourceDependencyParser } from '../../node_modules/@agent-teams/engineering-foundation/dist/capabilities/source-dependencies/adapters/outbound/oxc/oxc-source-dependency-parser.js';
import { NodeSourceDependencyResolver } from '../../node_modules/@agent-teams/engineering-foundation/dist/capabilities/source-dependencies/adapters/outbound/node/node-source-dependency-resolver.js';
import { buildObservedSourceGraph } from '../../node_modules/@agent-teams/engineering-foundation/dist/capabilities/source-dependencies/application/use-cases/build-observed-source-graph.js';
import { createSourceDependenciesCapability } from '../../node_modules/@agent-teams/engineering-foundation/dist/capabilities/source-dependencies/module.js';

const within = (path, root) => path === root || path.startsWith(`${root}/`);
const unique = values => [...new Set(values)].toSorted();
const feature = path => path.match(/^(.*\/src\/features\/[^/]+)(?:\/|$)/)?.[1] ?? null;
function boundaryFor(path, boundaries) {
  const matches = boundaries.flatMap(boundary => boundary.roots.filter(root => within(path, root)).map(root => ({ boundary, length: root.length }))).toSorted((a, b) => b.length - a.length);
  assert.ok(matches.length, `unclassified production source: ${path}`);
  assert.ok(!matches[1] || matches[0].length !== matches[1].length || matches[0].boundary.id === matches[1].boundary.id, `ambiguous production boundary: ${path}`);
  return matches[0].boundary;
}

/** Foundation supplies all source parsing and resolution. This census only selects
 * the consumer's meaningful topology and exact reviewed dependency relationships.
 */
export async function readSourceCensus(root, policy) {
  const inventory = await new PnpmWorkspaceInventoryReader().read(root, policy.workspaceManifestPath);
  const packages = inventory.packages.filter(pkg => pkg.rootPath.startsWith('packages/'));
  // Discover all conventional production roots independently of governedRoots.
  const productionRoots = packages.map(pkg => `${pkg.rootPath}/src`).toSorted();
  const files = await new FilesystemSourceTreeReader().read(root, productionRoots);
  const parser = new OxcSourceDependencyParser();
  const classifiedFiles = files.map(file => ({ ...file, boundary: boundaryFor(file.path, policy.boundaries),
    workspacePackage: packages.filter(pkg => within(file.path, pkg.rootPath)).toSorted((a, b) => b.rootPath.length - a.rootPath.length)[0], parsed: parser.parse(file) }));
  const graph = buildObservedSourceGraph({ inventory, allSourceFiles: files, classifiedFiles, resolver: new NodeSourceDependencyResolver() });
  assert.equal(graph.parseFailures.length, 0, 'source census parse failure');
  const relationships = Object.fromEntries(policy.boundaries.map(b => [b.id, []]));
  const entrypoints = new Set(policy.boundaries.flatMap(boundary => boundary.entrypoints));
  for (const edge of graph.edges) {
    const target = edge.resolution;
    let to;
    if (target.kind === 'local-file') {
      // Explicit retained composition seams share a policy boundary but are
      // independently composed owners. Other same-feature helpers stay local.
      const compositionSeam = /\/composition\/(?:agent-runtime-host|default-agent-runtime-host|runtime-setup-assembly|host-custodied-agent-runtime-host|contained-turn-feature-composition)\.ts$/.test(target.path);
      // A declared public surface exposes composition regardless of directory
      // layout. In particular, null feature identities do not exempt new barrel
      // exports or wrappers around an existing entrypoint from the census.
      const publicSurface = (feature(edge.fromPath) === null || feature(target.path) === null)
        && (entrypoints.has(edge.fromPath) || entrypoints.has(target.path));
      if (edge.fromBoundaryId === target.targetBoundaryId && feature(edge.fromPath) === feature(target.path) && !compositionSeam && !publicSurface) {continue;}
      to = target.path;
    } else if (target.kind === 'workspace-package' || target.kind === 'self-workspace-package') {
      to = edge.specifier;
    } else {continue;} // Builtins and fixed external libraries remain Foundation policy, not legacy module edges.
    relationships[edge.fromBoundaryId].push({ from: edge.fromPath, to, mode: edge.mode });
  }
  for (const id of Object.keys(relationships)) {relationships[id] = unique(relationships[id].map(edge => JSON.stringify(edge))).map(edge => JSON.parse(edge));}
  return { productionRoots, packageRoots: packages.map(pkg => ({ name: pkg.name, root: pkg.rootPath })).toSorted((a, b) => a.root.localeCompare(b.root)),
    featureRoots: unique(files.map(file => feature(file.path)).filter(Boolean)), relationships };
}

export async function requireSourceDiagnostics(root) {
  const report = await createSourceDependenciesCapability().run({ consumerRoot: root, configPath: 'architecture/foundation/source-dependencies.yaml' });
  assert.equal(report.outcome, 'passed', `source diagnostics failed: ${JSON.stringify(report)}`);
}

const identity = value => JSON.stringify(typeof value === 'string' ? value : Object.fromEntries(Object.entries(value).toSorted(([a], [b]) => a.localeCompare(b))));

export function verifySourceCensus(profile, census) {
  const equal = (actual, expected, label) => assert.deepEqual(unique(actual.map(identity)), unique(expected.map(identity)), label);
  equal(census.productionRoots, profile.productionRoots, 'live production roots drift');
  equal(census.packageRoots, profile.sourceCensus.packageRoots, 'live package census drift');
  equal(census.featureRoots, profile.sourceCensus.featureRoots, 'live feature census drift');
  for (const boundary of profile.boundaries) {equal(census.relationships[boundary.id] ?? [], boundary.relationships, `live relationships drift: ${boundary.id}`);}
}
