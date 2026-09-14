// Declared edges are the only permitted relationships between owned units: a
// cross-feature edge inside one module and a cross-module edge between two.
// Both are kind-accurate, rejected when unobserved, and checked for cycles.

export const detectCycles = (issue, edges, edgeLocations, kind, entity = "feature") => {
  const adjacency = new Map();
  for (const edge of edges.filter((candidate) => candidate.kinds.includes(kind))) {
    const targets = adjacency.get(edge.from) ?? [];
    targets.push(edge.to);
    adjacency.set(edge.from, targets.toSorted());
  }
  const cyclic = new Set();
  const visit = (node, stack, active) => {
    if (active.has(node)) {
      const start = stack.indexOf(node);
      const cycle = stack.slice(start);
      for (let index = 0; index < cycle.length; index += 1) {cyclic.add(`${cycle[index]}->${cycle[(index + 1) % cycle.length]}`);}
      return;
    }
    active.add(node); stack.push(node);
    for (const target of adjacency.get(node) ?? []) {visit(target, stack, active);}
    stack.pop(); active.delete(node);
  };
  for (const node of [...adjacency.keys()].toSorted()) {visit(node, [], new Set());}
  return [...cyclic].flatMap((key) => (edgeLocations.get(`${kind}:${key}`) ?? []).map((location) => issue(
    kind === "type" ? "FM_TYPE_CYCLE" : "FM_RUNTIME_CYCLE", location.path, location.line, `${kind} ${entity} edge ${key} participates in a cycle`,
  )));
};

export const recordObservedEdge = ({ key, imported, path, observedEdges, edgeLocations }) => {
  const kinds = observedEdges.get(key) ?? new Set();
  kinds.add(imported.kind);
  observedEdges.set(key, kinds);
  const locationKey = `${imported.kind}:${key}`;
  const locations = edgeLocations.get(locationKey) ?? [];
  locations.push({ path, line: imported.line });
  edgeLocations.set(locationKey, locations);
};

export const unusedEdgeIssues = (issue, declaredEdges, observedEdges, profilePath) => [...declaredEdges].flatMap(([key, kinds]) =>
  [...kinds]
    .filter((kind) => !observedEdges.get(key)?.has(kind))
    .map((kind) => issue("FM_UNUSED_EDGE", profilePath, 1, `${kind} edge ${key} is declared but not observed`)),
);

const moduleForPath = (declaredModules, path) => [...declaredModules.values()]
  .filter((declared) => path === declared.sourceRoot || path.startsWith(`${declared.sourceRoot}/`))
  .toSorted((left, right) => right.sourceRoot.length - left.sourceRoot.length)[0];

// A governed module may consume another governed module only through one of its
// curated assembly entries, only from a layer that is allowed to hold outward
// integrations, and only across a declared module edge. Anything else stays an
// undeclared local dependency.
export const curatedModuleImportIssues = (context) => {
  const { declaredModules, imported, isAssembly, issue, layerForPath, path, sourceFeature, targetPath, declaredModuleEdges, observedModuleEdges, moduleEdgeLocations } = context;
  const target = moduleForPath(declaredModules, targetPath);
  const source = moduleForPath(declaredModules, path);
  if (!target || !source || target.id === source.id) {return;}
  const curatedTargets = target.curatedExports.map((entry) => `${target.sourceRoot}/${entry === "." ? "index.ts" : "composition.ts"}`);
  const issues = [];
  if (!curatedTargets.includes(targetPath)) {
    issues.push(issue("FM_MODULE_DEEP_IMPORT", path, imported.line, `${source.id} must consume ${target.id} through a curated assembly entry`));
  }
  const isFeatureEntrypoint = Object.values(sourceFeature?.entrypoints ?? {}).includes(path);
  const sourceLayer = !isFeatureEntrypoint && sourceFeature ? layerForPath(sourceFeature, path) : undefined;
  // The public package entry exposes only the module's own contracts. Host-app
  // extra composition-directory assembly files are the rest of that module
  // composition surface, so they may carry another module's curated entry.
  const extraHostCompositionAssembly = Boolean(isAssembly) && path.startsWith(`${source.sourceRoot}/composition/`);
  const permitted = isAssembly
    ? path === `${source.sourceRoot}/composition.ts` || extraHostCompositionAssembly
    : ["adapters", "composition"].includes(sourceLayer);
  if (!permitted) {
    const holder = isAssembly ? "the public package entry" : isFeatureEntrypoint ? "a feature entrypoint" : sourceLayer ?? "unowned code";
    issues.push(issue("FM_INVALID_LAYER_DIRECTION", path, imported.line, `${holder} cannot depend on another production module`));
  }
  const key = `${source.id}->${target.id}`;
  if (!declaredModuleEdges.get(key)?.has(imported.kind)) {
    issues.push(issue("FM_UNDECLARED_MODULE_EDGE", path, imported.line, `${imported.kind} module edge ${key} is not declared`));
  }
  recordObservedEdge({ key, imported, path, observedEdges: observedModuleEdges, edgeLocations: moduleEdgeLocations });
  return issues;
};

