const requiredDependencies = [
  "@agent-teams/engineering-foundation",
  "typescript",
  "@types/node",
];

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const isText = (value) => typeof value === "string" && value.trim().length > 0;
const requireValid = (condition, detail) => {
  if (!condition) { throw new Error(`Invalid scaffold fixture input: ${detail}`); }
};

const selectDependency = (name, manifest, lock, workspace) => {
  const specifier = manifest.devDependencies?.[name];
  const entry = lock.importers?.["."]?.devDependencies?.[name];
  requireValid(isText(specifier) && isRecord(entry), `missing dependency ${name}`);
  requireValid(entry.specifier === specifier && isText(entry.version), `mismatching or malformed dependency ${name}`);
  if (specifier.startsWith("catalog:")) {
    const catalogName = specifier.slice("catalog:".length) || "default";
    const catalog = catalogName === "default" ? workspace.catalog : workspace.catalogs?.[catalogName];
    const locked = lock.catalogs?.[catalogName]?.[name];
    requireValid(
      isRecord(locked) && isText(catalog?.[name]) && locked.specifier === catalog[name]
        && locked.version === entry.version.split("(")[0],
      `missing or mismatching catalog for ${name}`,
    );
  }
  const packageKey = `${name}@${entry.version.split("(")[0]}`;
  const resolution = lock.packages?.[packageKey]?.resolution;
  requireValid(
    isRecord(resolution) && (isText(resolution.integrity) || isText(resolution.tarball))
      && isRecord(lock.snapshots?.[`${name}@${entry.version}`]),
    `missing or malformed locked resolution for ${name}`,
  );
  return { specifier, entry };
};

const assertDependencyFree = (path, manifest) => {
  requireValid(isRecord(manifest), `malformed generated manifest ${path}`);
  for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
    if (Object.hasOwn(manifest, field)) {
      requireValid(isRecord(manifest[field]) && Object.keys(manifest[field]).length === 0,
        `generated ${path} must have no ${field}`);
    }
  }
  for (const field of ["bundledDependencies", "bundleDependencies"]) {
    if (Object.hasOwn(manifest, field)) {
      requireValid(Array.isArray(manifest[field]) && manifest[field].length === 0,
        `generated ${path} must have no ${field}`);
    }
  }
};

// Only replace importers. Frozen pnpm installation validates the retained closure.
export const projectFixtureLock = (sourceManifest, sourceLock, workspace, generatedPackages) => {
  requireValid(isRecord(sourceManifest) && /^pnpm@\d+\.\d+\.\d+(?:\+.*)?$/.test(sourceManifest.packageManager),
    "missing or malformed pnpm packageManager pin");
  requireValid(isRecord(sourceLock) && String(sourceLock.lockfileVersion) === "9.0",
    "expected lockfileVersion 9.0");
  requireValid(isRecord(workspace) && isRecord(sourceLock.importers?.["."]?.devDependencies)
    && isRecord(sourceManifest.devDependencies) && isRecord(sourceLock.packages)
    && isRecord(sourceLock.snapshots), "malformed root lock or workspace");
  requireValid(isRecord(generatedPackages) && Object.keys(generatedPackages).length === 4,
    "expected four generated packages");
  const devDependencies = {};
  const lockedDependencies = {};
  for (const name of requiredDependencies) {
    const { specifier, entry } = selectDependency(name, sourceManifest, sourceLock, workspace);
    devDependencies[name] = specifier;
    lockedDependencies[name] = structuredClone(entry);
  }
  const importers = { ".": { devDependencies: lockedDependencies } };
  for (const [path, manifest] of Object.entries(generatedPackages)) {
    requireValid(/^packages\/contexts\/[a-z][a-z0-9-]*$/.test(path), `invalid generated path ${path}`);
    assertDependencyFree(path, manifest);
    importers[path] = {};
  }
  return {
    manifest: { name: "runtime-scaffold-fixture", private: true, packageManager: sourceManifest.packageManager, devDependencies },
    lock: { ...structuredClone(sourceLock), importers },
  };
};
