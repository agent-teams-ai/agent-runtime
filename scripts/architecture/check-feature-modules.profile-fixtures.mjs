export const authority = {
  id: "agent-teams.feature-module-standard",
  version: "v1",
  repository: "agent-teams-ai/.github",
  path: "docs/architecture/feature-module-standard/v1.md",
  gitBlob: "d0bfff2033faf544fe65268c1dcdfd524d093015",
  sha256: "851653f96643cf0466b67ab22963661976b00de44840fa3144a48a8c054f95fa",
};

const productionModule = (overrides = {}) => ({
  id: "fixture-runtime",
  role: "bounded-context",
  moduleRoot: ".",
  sourceRoot: "src",
  packageName: "@fixture/runtime",
  ownerDocument: "ADR-0005",
  curatedExports: [".", "./composition"],
  adoption: "active",
  activationAuthority: "ADR-0005",
  ...overrides,
});

export const feature = (id, roles = ["domain"]) => ({
  id,
  root: `src/features/${id}`,
  roles,
  entrypoints: { public: `src/features/${id}/index.ts`, internal: `src/features/${id}/internal.ts` },
});

const fixtureActivation = (status) => status === "active"
  ? { blockers: [], acceptance: ["zero diagnostics"], authority: { acceptedAdr: "ADR-0013", decisionPath: "docs/decisions/0013-feature-module-standard-v1-candidate-adoption.md", owner: "architecture", governedRecords: [] }, evidence: { fixtureCommand: "pnpm test:feature-modules", candidateCommand: "pnpm architecture:feature-modules:candidate", productionDiagnostics: 0 } }
  : { blockers: ["fix diagnostics"], acceptance: ["zero diagnostics"], authority: null, evidence: null };

const applyFixtureProfileOverrides = (profile, fixture) => {
  if (fixture.secondFeature) {profile.features.push(feature("beta", fixture.secondRoles));}
  if (fixture.activation) {profile.activation = fixture.activation;}
  if (fixture.activeGovernedRecords) {profile.activation.authority.governedRecords = fixture.activeGovernedRecords;}
  if (fixture.omitActiveAdoption) {delete profile.adoption;}
  for (const path of fixture.activeAdoptionOmit ?? []) {omitNestedField(profile.adoption, path);}
  for (const [path, value] of Object.entries(fixture.activeAdoptionSet ?? {})) {setNestedField(profile.adoption, path, value);}
  for (const path of fixture.activeAdoptionReverse ?? []) {
    const segments = path.split("."), key = segments.pop();
    let parent = profile.adoption;
    for (const segment of segments) {parent = parent[segment];}
    parent[key].reverse();
  }
  if (fixture.omitSchemaMarker) {delete profile.$schema;}
};

const fixtureActiveAdoption = () => ({
  moduleRoots: ["."],
  applicationRoots: [],
  excludedRoots: ["excluded"],
  abstractLayout: {
    modules: [{
      moduleRoot: ".",
      sourceRoot: "src",
      featuresRoot: "src/features",
      moduleComposition: "src/composition.ts",
      publicEntrypoint: "src/index.ts",
      testRoot: "tests",
      featureTestsRoot: "tests/features",
      moduleTestsRoot: "tests/package",
    }],
    applications: [],
  },
  localExtensions: {
    language: { sourceExtensions: [".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts"] },
    packaging: { manifest: "package.json", curatedExports: [".", "./composition"] },
    transport: { publicContractRole: "contracts" },
    composition: {
      moduleFiles: ["index.ts", "composition.ts"],
      featureEntrypoints: ["index.ts", "internal.ts"],
      syntax: "imports-and-named-reexports-only",
    },
  },
  localOwnership: {
    architectureDocument: { path: "docs/architecture/feature-module-standard-v1-candidate.md", owner: "architecture" },
    decisionRecords: [
      { id: "ADR-0013", path: "docs/decisions/0013-feature-module-standard-v1-candidate-adoption.md", owner: "architecture" },
      { id: "ADR-0017", path: "docs/decisions/0017-feature-module-production-scope-roles.md", owner: "architecture" },
    ],
  },
});

const omitNestedField = (object, path) => {
  const segments = path.split("."), key = segments.pop();
  let parent = object;
  for (const segment of segments) {parent = parent[segment];}
  delete parent[key];
};

const setNestedField = (object, path, value) => {
  const segments = path.split("."), key = segments.pop();
  let parent = object;
  for (const segment of segments) {parent = parent[segment];}
  parent[key] = value;
};

export const fixtureProfile = (fixture) => {
  const status = fixture.status ?? "candidate";
  const profile = {
    $schema: fixture.schemaMarker ?? "./profile.schema.json",
    schemaVersion: 1,
    status,
    authority: { ...authority, id: fixture.authorityId ?? authority.id, ...fixture.authorityExtra },
    scope: {
      workspaceContainers: fixture.workspaceContainers ?? [],
      productionModules: fixture.productionModules ?? [productionModule()],
      productionRoots: ["src"],
      outOfScope: ["everything else"],
    },
    moduleRoles: ["contracts", "domain", "application", "adapters", "composition"],
    features: [feature("alpha", fixture.alphaRoles)],
    assemblyFiles: ["src/index.ts", "src/composition.ts"],
    featureEdges: fixture.edges ?? [],
    extensions: fixture.extensions ?? [], deviations: fixture.deviations ?? [], exceptions: fixture.exceptions ?? [],
    enforcement: { candidate: "pnpm architecture:feature-modules:candidate", active: "pnpm architecture:feature-modules:active", fixtures: "pnpm test:feature-modules" },
    activation: fixtureActivation(status),
    adoption: status === "active" ? fixtureActiveAdoption() : undefined,
    ...fixture.profileExtra,
  };
  applyFixtureProfileOverrides(profile, fixture);
  return profile;
};

