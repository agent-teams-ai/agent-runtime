import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSync, Visitor } from "oxc-parser";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const profilePath = "architecture/consumer-module-standard/profile.json";
const decisionPath = "docs/decisions/0015-consumer-module-standard-pending-adoption.md";
const decisionRegistryPath = "architecture/decisions/accepted-decisions.json";
const packagePath = "package.json";
const entrypointPath = "packages/apps/embedded-runtime/src/composition/contained-turn-feature-composition.ts";
const declarationPath = "packages/contexts/agent-execution/src/features/contained-agent-turn/application/ports/outbound/contained-turn-ports.ts";
const factoryPath = "packages/contexts/agent-execution/src/features/contained-agent-turn/composition/feature-module-factory.ts";

export const EXPECTED_PROFILE = Object.freeze({
  schemaVersion: 1,
  status: "pending",
  authority: {
    consumerModuleStandard: {
      repository: "agent-teams-ai/get-modular",
      path: "docs/architecture/common-assembly.md",
      anchor: "consumer-module-standard",
      gitCommit: "f1ec0152c34715395685b349844a7d1c18a2f015",
      sha256: "ea54578ebe69fc410bf973b6112dcefc4ad7c163e563e0ee307cd7b5f8b8723d",
    },
    featureModuleStandard: {
      repository: "agent-teams-ai/.github",
      path: "docs/architecture/feature-module-standard/v1.md",
      gitBlob: "d0bfff2033faf544fe65268c1dcdfd524d093015",
      sha256: "851653f96643cf0466b67ab22963661976b00de44840fa3144a48a8c054f95fa",
    },
    acceptedAdr: "ADR-0015",
    decisionPath,
  },
  scope: {
    owner: "architecture",
    productionRoots: [
      "packages/apps/embedded-runtime/src",
      "packages/contexts/agent-execution/src",
    ],
    activeWiringScope: [],
    profilePath,
  },
  adoptedBoundaries: [],
  legacyBoundaries: [{
    id: "contained-agent-turn-seven-port",
    status: "not-adopted",
    owner: "embedded-runtime-host",
    materializedEntrypoint: entrypointPath,
    declarationPath,
    factoryPath,
    mechanism: "static-pure-di",
    dependencySlots: [
      "operationStore", "security", "providerAccess", "workspace",
      "artifacts", "custody", "provider",
    ],
    materializationCallCount: 2,
    referencePaths: [
      entrypointPath,
      "packages/contexts/agent-execution/src/composition.ts",
      factoryPath,
      "packages/contexts/agent-execution/src/features/contained-agent-turn/internal.ts",
    ],
    referenceCounts: {
      [entrypointPath]: 4,
      "packages/contexts/agent-execution/src/composition.ts": 2,
      [factoryPath]: 1,
      "packages/contexts/agent-execution/src/features/contained-agent-turn/internal.ts": 2,
    },
    authority: "ADR-0012",
    rationale: "The existing closed seven-port Pure DI boundary predates Consumer Module Standard adoption and has no Get Modular Assembly declaration or profile.",
    reviewTrigger: "Any new replaceable or cross-module relationship, or any change to the entrypoint, factory, dependency declaration, or exact slot set.",
  }],
  exceptions: [],
  outstandingWork: [
    "Pin reviewed exact Get Modular Core and Assembly package artifacts under package policy.",
    "Replace the legacy direct wiring with consumer-owned declarations, profile bindings, and one Assembly composition root.",
    "Add independent binding parity, preparation failure, cleanup, isolation, typed rejection, and packed-import evidence before changing status to active.",
  ],
  enforcement: {
    topology: "pnpm foundation:check",
    fixtures: "pnpm test:consumer-modules",
    check: "pnpm architecture:consumer-modules",
    gates: ["check", "check:fast"],
  },
});

const expectedScripts = Object.freeze({
  "architecture:consumer-modules": "node scripts/architecture/check-consumer-module-standard.mjs",
  "foundation:check": "agent-teams-foundation check && pnpm foundation:boundaries:negative && pnpm foundation:assert-dev-only && pnpm foundation:assert-registry",
  "test:consumer-modules": "node --test scripts/architecture/check-consumer-module-standard.test.mjs",
});
const gateChain = "pnpm test:consumer-modules && pnpm architecture:consumer-modules";
const requiredPaths = Object.freeze([
  profilePath,
  decisionPath,
  "docs/architecture/consumer-module-standard-adoption.md",
  entrypointPath,
  declarationPath,
  factoryPath,
  "scripts/architecture/check-consumer-module-standard.mjs",
  "scripts/architecture/check-consumer-module-standard.test.mjs",
]);

const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const occurrences = (source, pattern) => [...source.matchAll(pattern)].length;
const compareText = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const getModularPackage = /^@get-modular\/(?:core|assembly)(?:\/|$)/u;

const inspectTypeScript = (path, source) => {
  const parsed = parseSync(path, source);
  assert.deepEqual(parsed.errors, [], `Oxc could not parse ${path}`);
  const imports = [
    ...parsed.module.staticImports.map(entry => entry.moduleRequest.value),
    ...parsed.module.staticExports.flatMap(entry => entry.entries)
      .flatMap(entry => entry.moduleRequest === null ? [] : [entry.moduleRequest.value]),
  ];
  const unresolvedImports = [];
  let directFactoryCalls = 0;
  let factoryIdentifiers = 0;
  new Visitor({
    CallExpression(node) {
      if (node.callee.type === "Identifier" && node.callee.name === "createContainedTurnFeature") {
        directFactoryCalls += 1;
      }
      const argument = node.arguments[0];
      if (node.callee.type !== "Identifier" || node.callee.name !== "require") {return;}
      if (node.arguments.length === 1 && argument?.type === "Literal" && typeof argument.value === "string") {
        imports.push(argument.value);
      } else {unresolvedImports.push("require");}
    },
    Identifier(node) {
      if (node.name === "createContainedTurnFeature") {factoryIdentifiers += 1;}
    },
    ImportExpression(node) {
      if (node.source.type === "Literal" && typeof node.source.value === "string") {
        imports.push(node.source.value);
      } else {unresolvedImports.push("import");}
    },
    TSImportEqualsDeclaration(node) {
      const expression = node.moduleReference.type === "TSExternalModuleReference"
        ? node.moduleReference.expression : undefined;
      if (expression?.type === "Literal" && typeof expression.value === "string") {
        imports.push(expression.value);
      }
    },
    TSImportType(node) {
      if (node.source.type === "Literal" && typeof node.source.value === "string") {
        imports.push(node.source.value);
      } else {unresolvedImports.push("import-type");}
    },
  }).visit(parsed.program);
  const factoryAliases = parsed.program.body.flatMap(node => {
    if (node.type === "ImportDeclaration") {
      return node.specifiers.filter(specifier => specifier.type === "ImportSpecifier" &&
        specifier.imported.type === "Identifier" && specifier.imported.name === "createContainedTurnFeature" &&
        specifier.local.name !== "createContainedTurnFeature");
    }
    if (node.type === "ExportNamedDeclaration") {
      return node.specifiers.filter(specifier => specifier.type === "ExportSpecifier" &&
        specifier.local.type === "Identifier" && specifier.local.name === "createContainedTurnFeature" &&
        (specifier.exported.type !== "Identifier" || specifier.exported.name !== "createContainedTurnFeature"));
    }
    return [];
  });
  return { directFactoryCalls, factoryAliases, factoryIdentifiers, imports, unresolvedImports };
};

const sourceFiles = async (root, path = root) => {
  const entries = await readdir(path, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async entry => {
    const absolute = resolve(path, entry.name);
    if (entry.isDirectory()) {return sourceFiles(root, absolute);}
    return entry.isFile() && entry.name.endsWith(".ts")
      ? [[relative(root, absolute).replaceAll("\\", "/"), await readFile(absolute, "utf8")]]
      : [];
  }));
  return nested.flat();
};

export async function loadConsumerModuleStandardInputs(root = repositoryRoot) {
  const profile = JSON.parse(await readFile(resolve(root, profilePath), "utf8"));
  const packageManifest = JSON.parse(await readFile(resolve(root, packagePath), "utf8"));
  const decisionRegistry = JSON.parse(await readFile(resolve(root, decisionRegistryPath), "utf8"));
  const decisionBytes = await readFile(resolve(root, decisionPath));
  const productionSources = await Promise.all(profile.scope.productionRoots.map(path =>
    sourceFiles(root, resolve(root, path))));
  const sources = new Map(productionSources.flat());
  const pathExistence = new Map(await Promise.all(requiredPaths.map(async path => {
    try { return [path, (await stat(resolve(root, path))).isFile()]; }
    catch { return [path, false]; }
  })));
  return { decisionBytes, decisionRegistry, packageManifest, pathExistence, profile, sources };
}

export function validateConsumerModuleStandard(inputs) {
  assert.deepEqual(inputs.profile, EXPECTED_PROFILE,
    "consumer profile must equal the reviewed pending-adoption record");

  for (const path of requiredPaths) {
    assert.equal(inputs.pathExistence.get(path), true, `required adoption path is missing: ${path}`);
  }

  const decision = inputs.decisionRegistry.decisions?.find(record => record.id === "ADR-0015");
  assert.deepEqual(decision, {
    id: "ADR-0015",
    path: decisionPath,
    immutableDigest: `sha256:${sha256(inputs.decisionBytes)}`,
  }, "ADR-0015 must be accepted at its exact path and bytes");
  const decisionSource = inputs.decisionBytes.toString("utf8");
  assert.match(decisionSource, /^status: accepted$/mu, "ADR-0015 frontmatter must be accepted");
  assert.match(decisionSource, /^Status: accepted$/mu, "ADR-0015 body must be accepted");

  for (const [name, command] of Object.entries(expectedScripts)) {
    assert.equal(inputs.packageManifest.scripts?.[name], command, `${name} must execute the reviewed command`);
  }
  for (const gate of EXPECTED_PROFILE.enforcement.gates) {
    const command = inputs.packageManifest.scripts?.[gate];
    assert.equal(typeof command, "string", `${gate} must exist`);
    assert.equal(occurrences(command, new RegExp(gateChain.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "gu")), 1,
      `${gate} must execute fixtures then the checker exactly once`);
    const topologyIndex = command.indexOf(EXPECTED_PROFILE.enforcement.topology);
    assert.ok(topologyIndex >= 0 && topologyIndex < command.indexOf(gateChain),
      `${gate} must run topology enforcement before the consumer checker`);
  }

  for (const section of [inputs.packageManifest.dependencies, inputs.packageManifest.devDependencies]) {
    assert.equal(Object.hasOwn(section ?? {}, "@get-modular/core"), false,
      "pending adoption cannot install Get Modular Core");
    assert.equal(Object.hasOwn(section ?? {}, "@get-modular/assembly"), false,
      "pending adoption cannot install Get Modular Assembly");
  }

  const declaration = inputs.sources.get(declarationPath);
  assert.equal(typeof declaration, "string", "seven-port declaration source must be loaded");
  const names = /export const CONTAINED_TURN_DEPENDENCY_NAMES = Object\.freeze\(\[([\s\S]*?)\]\s+as const/u.exec(declaration)?.[1];
  assert.ok(names, "seven-port dependency names must remain a literal frozen tuple");
  assert.deepEqual([...names.matchAll(/"([A-Za-z][A-Za-z0-9]*)"/gu)].map(match => match[1]),
    EXPECTED_PROFILE.legacyBoundaries[0].dependencySlots, "seven-port dependency slot drift");

  const boundaryReferences = [];
  for (const [path, source] of inputs.sources) {
    const inspected = inspectTypeScript(path, source);
    if (inspected.factoryIdentifiers > 0) {boundaryReferences.push(path);}
    if (path.includes("/domain/") || path.includes("/application/")) {
      assert.deepEqual(inspected.unresolvedImports, [], `non-literal layer import: ${path}`);
      assert.equal(inspected.imports.some(specifier => getModularPackage.test(specifier)), false,
        `forbidden Get Modular layer import: ${path}`);
    }
  }
  assert.deepEqual(boundaryReferences.toSorted(compareText),
    EXPECTED_PROFILE.legacyBoundaries[0].referencePaths.toSorted(compareText),
    "unknown or missing contained-turn composition boundary reference");
  for (const [path, expected] of Object.entries(EXPECTED_PROFILE.legacyBoundaries[0].referenceCounts)) {
    const inspected = inspectTypeScript(path, inputs.sources.get(path));
    assert.equal(inspected.factoryIdentifiers, expected,
      `contained-turn factory reference count drift: ${path}`);
    assert.deepEqual(inspected.factoryAliases, [],
      `contained-turn factory aliases are not classified: ${path}`);
  }
  assert.equal(inspectTypeScript(entrypointPath, inputs.sources.get(entrypointPath)).directFactoryCalls,
    EXPECTED_PROFILE.legacyBoundaries[0].materializationCallCount,
    "contained-turn materialization call count drift");

  return Object.freeze({ legacyBoundaries: 1, status: "pending" });
}

export async function checkConsumerModuleStandard(root = repositoryRoot) {
  return validateConsumerModuleStandard(await loadConsumerModuleStandardInputs(root));
}

const invokedPath = process.argv[1] === undefined ? undefined : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  checkConsumerModuleStandard().then(
    result => console.log(`Consumer Module Standard: ${result.status}; ${result.legacyBoundaries} legacy boundary.`),
    error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; },
  );
}
