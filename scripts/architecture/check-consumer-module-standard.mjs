import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, posix, relative, resolve } from "node:path";
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
    proposedAdr: "ADR-0015",
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

const occurrences = (source, pattern) => [...source.matchAll(pattern)].length;
const compareText = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const getModularPackage = /^@get-modular\/(?:core|assembly)(?:\/|$)/u;
const factoryName = "createContainedTurnFeature";
const internalPath = "packages/contexts/agent-execution/src/features/contained-agent-turn/internal.ts";
const factoryExportPaths = new Set([factoryPath, internalPath, "packages/contexts/agent-execution/src/composition.ts"]);
const staticString = node => {
  if (node.type === "Identifier") {return node.name;}
  if (node.type === "Literal" && typeof node.value === "string") {return node.value;}
  if (node.type === "TemplateLiteral" && node.expressions.length === 0) {
    return node.quasis[0]?.value.cooked ?? node.quasis[0]?.value.raw;
  }
  if (node.type === "BinaryExpression" && node.operator === "+") {
    const left = staticString(node.left);
    const right = staticString(node.right);
    return left === undefined || right === undefined ? undefined : left + right;
  }
  return undefined;
};
const staticModuleRequest = node => {
  if (node.type === "Literal" && typeof node.value === "string") {return node.value;}
  if (node.type === "TemplateLiteral" && node.expressions.length === 0) {
    return node.quasis[0]?.value.cooked ?? node.quasis[0]?.value.raw;
  }
  if (node.type === "BinaryExpression" && node.operator === "+") {
    const left = staticModuleRequest(node.left);
    const right = staticModuleRequest(node.right);
    return left === undefined || right === undefined ? undefined : left + right;
  }
  return undefined;
};
const walkAst = (node, visit, parent = undefined, key = undefined) => {
  if (node === null || typeof node !== "object") {return;}
  if (typeof node.type === "string") {visit(node, parent, key);}
  for (const [childKey, child] of Object.entries(node)) {
    if (childKey === "parent" || childKey === "start" || childKey === "end") {continue;}
    if (Array.isArray(child)) {
      for (const item of child) {walkAst(item, visit, node, childKey);}
    } else {walkAst(child, visit, node, childKey);}
  }
};
const factoryModule = (path, request) => {
  if (request === "@agent-teams/agent-execution/composition") {return true;}
  if (!request.startsWith(".")) {return false;}
  const target = posix.normalize(posix.join(posix.dirname(path), request)).replace(/\.js$/u, ".ts");
  return factoryExportPaths.has(target);
};
const patternIdentifiers = pattern => {
  const identifiers = [];
  walkAst(pattern, (node, parent, key) => {
    if (node.type === "Identifier" && (parent?.type !== "Property" || key === "value" || parent.shorthand)) {
      identifiers.push(node);
    }
  });
  return identifiers;
};

const inspectTypeScript = (path, source) => {
  const parsed = parseSync(path, source);
  assert.deepEqual(parsed.errors, [], `Oxc could not parse ${path}`);
  const imports = [
    ...parsed.module.staticImports.map(entry => entry.moduleRequest.value),
    ...parsed.module.staticExports.flatMap(entry => entry.entries)
      .flatMap(entry => entry.moduleRequest === null ? [] : [entry.moduleRequest.value]),
  ];
  const unresolvedImports = [];
  const factoryBindings = new Set();
  const namespaceBindings = new Set();
  const factoryAliases = [];
  const excludedIdentifiers = new Set();
  let factoryIdentifiers = 0;
  for (const node of parsed.program.body) {
    if (node.type === "ExportAllDeclaration" && factoryModule(path, node.source.value)) {
      factoryAliases.push(node);
    } else if (node.type === "ImportDeclaration" && factoryModule(path, node.source.value)) {
      for (const specifier of node.specifiers) {
        if (specifier.type === "ImportNamespaceSpecifier") {
          namespaceBindings.add(specifier.local.name);
          excludedIdentifiers.add(specifier.local);
          factoryAliases.push(specifier);
        } else if (specifier.type === "ImportSpecifier" && staticString(specifier.imported) === factoryName) {
          factoryBindings.add(specifier.local.name);
          excludedIdentifiers.add(specifier.imported);
          excludedIdentifiers.add(specifier.local);
          factoryIdentifiers += 1 + (specifier.local.name === factoryName ? 1 : 0);
          if (specifier.local.name !== factoryName) {factoryAliases.push(specifier);}
        }
      }
    } else if (node.type === "ExportNamedDeclaration" && node.source !== null &&
        factoryModule(path, node.source.value)) {
      for (const specifier of node.specifiers) {
        if (staticString(specifier.local) !== factoryName) {continue;}
        excludedIdentifiers.add(specifier.local);
        excludedIdentifiers.add(specifier.exported);
        factoryIdentifiers += 1 + (staticString(specifier.exported) === factoryName ? 1 : 0);
        if (staticString(specifier.exported) !== factoryName) {factoryAliases.push(specifier);}
      }
    } else if (path === factoryPath && node.type === "ExportNamedDeclaration" &&
        node.declaration?.type === "VariableDeclaration") {
      for (const declaration of node.declaration.declarations) {
        if (declaration.id.type === "Identifier" && declaration.id.name === factoryName) {
          factoryBindings.add(factoryName);
          excludedIdentifiers.add(declaration.id);
          factoryIdentifiers += 1;
        }
      }
    }
  }
  walkAst(parsed.program, node => {
    if (node.type !== "TSImportEqualsDeclaration" || node.id.type !== "Identifier") {return;}
    const expression = node.moduleReference.type === "TSExternalModuleReference"
      ? node.moduleReference.expression : undefined;
    if (expression?.type === "Literal" && typeof expression.value === "string" &&
        factoryModule(path, expression.value)) {
      namespaceBindings.add(node.id.name);
      excludedIdentifiers.add(node.id);
      factoryAliases.push(node);
    }
  });
  const isNamespaceFactoryMember = node => node.type === "MemberExpression" &&
    node.object.type === "Identifier" && namespaceBindings.has(node.object.name) &&
    staticString(node.property) === factoryName;
  const classifiedPatterns = new Set();
  const classifyPattern = (pattern, sourceIsNamespace) => {
    if (!sourceIsNamespace || pattern.type !== "ObjectPattern") {return false;}
    let changed = false;
    for (const property of pattern.properties) {
      if (property.type !== "Property" || staticString(property.key) !== factoryName ||
          property.value.type !== "Identifier" || classifiedPatterns.has(property)) {continue;}
      classifiedPatterns.add(property);
      factoryBindings.add(property.value.name);
      excludedIdentifiers.add(property.value);
      factoryAliases.push(property);
      factoryIdentifiers += 1;
      changed = true;
    }
    return changed;
  };
  let changed = true;
  while (changed) {
    changed = false;
    walkAst(parsed.program, node => {
      const left = node.type === "VariableDeclarator" ? node.id
        : node.type === "AssignmentExpression" ? node.left : undefined;
      const right = node.type === "VariableDeclarator" ? node.init
        : node.type === "AssignmentExpression" ? node.right : undefined;
      if (left === undefined || right === null || right === undefined) {return;}
      if (right.type === "Identifier" && namespaceBindings.has(right.name)) {
        if (left.type === "Identifier" && !namespaceBindings.has(left.name)) {
          namespaceBindings.add(left.name);
          excludedIdentifiers.add(left);
          changed = true;
        }
        if (classifyPattern(left, true)) {changed = true;}
      } else if ((right.type === "Identifier" && factoryBindings.has(right.name)) ||
          isNamespaceFactoryMember(right)) {
        if (left.type === "Identifier" && !factoryBindings.has(left.name)) {
          factoryBindings.add(left.name);
          excludedIdentifiers.add(left);
          factoryAliases.push(node);
          changed = true;
        }
      }
    });
  }
  const shadowBindings = [];
  if (factoryBindings.has(factoryName) || path === entrypointPath) {
    walkAst(parsed.program, node => {
      const patterns = node.type === "VariableDeclarator" ? [node.id]
        : /^(?:ArrowFunctionExpression|FunctionDeclaration|FunctionExpression)$/u.test(node.type) ? node.params
          : node.type === "CatchClause" && node.param !== null ? [node.param] : [];
      for (const pattern of patterns) {
        for (const identifier of patternIdentifiers(pattern)) {
          if (identifier.name === factoryName && !excludedIdentifiers.has(identifier)) {shadowBindings.push(identifier);}
        }
      }
    });
  }
  let directFactoryCalls = 0;
  new Visitor({
    CallExpression(node) {
      if ((node.callee.type === "Identifier" && factoryBindings.has(node.callee.name)) ||
          isNamespaceFactoryMember(node.callee)) {
        directFactoryCalls += 1;
      }
      const argument = node.arguments[0];
      if (node.callee.type !== "Identifier" || node.callee.name !== "require") {return;}
      const request = argument === undefined || argument.type === "SpreadElement"
        ? undefined : staticModuleRequest(argument);
      if (node.arguments.length === 1 && request !== undefined) {
        imports.push(request);
        if (factoryModule(path, request)) {factoryAliases.push(node);}
      } else {unresolvedImports.push("require");}
    },
    MemberExpression(node) {
      if (isNamespaceFactoryMember(node)) {factoryIdentifiers += 1;}
    },
    ImportExpression(node) {
      const request = staticModuleRequest(node.source);
      if (request !== undefined) {
        imports.push(request);
        if (factoryModule(path, request)) {factoryAliases.push(node);}
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
  walkAst(parsed.program, (node, parent, key) => {
    if (node.type !== "Identifier" || !factoryBindings.has(node.name) || excludedIdentifiers.has(node)) {return;}
    if (parent?.type === "MemberExpression" && key === "property") {return;}
    factoryIdentifiers += 1;
  });
  return { directFactoryCalls, factoryAliases, factoryIdentifiers, imports, shadowBindings, unresolvedImports };
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
  assert.equal(decision, undefined, "proposed ADR-0015 cannot enter the immutable accepted-decision registry");
  const decisionSource = inputs.decisionBytes.toString("utf8");
  const frontmatterMatch = /^---\n([\s\S]*?)\n---/u.exec(decisionSource);
  const frontmatter = frontmatterMatch?.[1] ?? "";
  assert.deepEqual([...frontmatter.matchAll(/^status:\s*(.+)$/gmu)].map(match => match[1]), ["proposed"],
    "ADR-0015 frontmatter must declare proposed exactly once");
  const body = decisionSource.slice(frontmatterMatch?.[0].length ?? 0);
  assert.deepEqual([...body.matchAll(/^Status:\s*(.+)$/gmu)].map(match => match[1]), ["proposed"],
    "ADR-0015 body must declare proposed exactly once");

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
    assert.deepEqual(inspected.factoryAliases, [], `contained-turn factory aliases are not classified: ${path}`);
    assert.deepEqual(inspected.shadowBindings, [], `contained-turn factory binding is shadowed: ${path}`);
    assert.deepEqual(inspected.unresolvedImports, [], `non-literal production import: ${path}`);
    if (inspected.factoryIdentifiers > 0) {boundaryReferences.push(path);}
    if (path.includes("/domain/") || path.includes("/application/")) {
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
