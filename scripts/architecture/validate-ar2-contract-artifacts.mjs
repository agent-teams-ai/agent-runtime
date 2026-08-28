import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";

export { validateOfficialSemantics } from "./validate-claude-official-semantics.mjs";
import { validateOfficialSemantics } from "./validate-claude-official-semantics.mjs";

const inventoryPath = new URL("../../docs/architecture/legacy-feature-inventory.json", import.meta.url);
const inventorySchemaPath = new URL("../../docs/architecture/legacy-feature-inventory.schema.json", import.meta.url);
const freezePath = new URL("../../docs/architecture/claude-code-setup-freeze.json", import.meta.url);
const freezeSchemaPath = new URL("../../docs/architecture/claude-code-setup-freeze.schema.json", import.meta.url);
const fixtureRoot = new URL("../../packages/contexts/runtime-configuration/tests/fixtures/claude-code-settings/", import.meta.url);
const fixtureManifestPath = new URL("manifest.json", fixtureRoot);
const negativeFixturesPath = new URL("negative-fixtures.json", fixtureRoot);
const contractCoveragePath = new URL("contract-coverage.json", fixtureRoot);
const packagePath = new URL("../../package.json", import.meta.url);
const roadmapPath = new URL("../../docs/architecture/provider-setup-delivery-roadmap.md", import.meta.url);
const readinessPath = new URL("../../docs/architecture/readiness.md", import.meta.url);
const runtimeAccessPath = new URL("../../packages/apps/embedded-runtime/src/contracts/runtime-access.ts", import.meta.url);
const repositoryRoot = new URL("../../", import.meta.url);

const readJson = async path => JSON.parse(await readFile(path, "utf8"));
const exactKeys = (value, keys, label) => {
  assert.deepEqual(Object.keys(value).toSorted(), [...keys].toSorted(), `${label} keys`);
};
const unique = (values, label) => {
  assert.equal(new Set(values).size, values.length, `${label} must be unique`);
};
const sha256 = value => createHash("sha256").update(value).digest("hex");
const escapeRegExp = value => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
const validateSchema = (schema, value, label) => {
  const validate = new Ajv2020({ allErrors: true, strict: true, strictTypes: false }).compile(schema);
  assert.equal(validate(value), true, `${label} schema errors: ${JSON.stringify(validate.errors)}`);
};

const fixtureProjection = ({ id, expected, diagnostic }) => ({
  ...(diagnostic === undefined ? {} : { diagnostic }),
  ...(expected === undefined ? {} : { expected }),
  id,
});

export const EXPECTED_FIXTURE_MATRIX = Object.freeze([
  { id: "installation-absent", expected: "observed-with-install-action" },
  { id: "installation-one-alias", expected: "found-unverified" },
  { id: "installation-multiple-aliases", expected: "identity-grouped" },
  { id: "source-user-only", expected: "source-bound-intent" },
  { id: "source-shared-project-only", expected: "source-bound-intent" },
  { id: "source-project-local-only", expected: "source-bound-intent" },
  { id: "sources-conflict", expected: "two-observations-no-winner" },
  { id: "malformed-higher-precedence", expected: "unrelated-source-preserved" },
  { id: "duplicate-json-keys", diagnostic: "config_duplicate_key" },
  { id: "bom", diagnostic: "config_parse_failed" },
  { id: "invalid-utf8", diagnostic: "config_invalid_utf8" },
  { id: "oversized-json", diagnostic: "config_too_large" },
  { id: "deep-json", diagnostic: "config_parse_failed" },
  { id: "unsupported-effort-max", diagnostic: "setting_value_unsupported" },
  { id: "provider-route-model", expected: "provider-deployment-deferred" },
  { id: "secret-sentinels", diagnostic: "secret_setting_rejected" },
  { id: "credential-material", diagnostic: "credential_material_rejected" },
  { id: "untrusted-workspace", diagnostic: "source_untrusted" },
  { id: "stale-source", diagnostic: "source_epoch_stale" },
  { id: "unsupported-platform", diagnostic: "unsupported_platform" },
  { id: "unsupported-dialect", diagnostic: "configuration_dialect_unsupported" },
  { id: "access-scope-limit-exceeded", diagnostic: "access_scope_limit_exceeded" },
  { id: "capability-unavailable", diagnostic: "capability_unavailable" },
  { id: "model-default-special", expected: "provider-default" },
  { id: "model-exact-name", expected: "exact-name" },
  { id: "model-arbitrary-selector-deferred", expected: "unclassified-selector-deferred" },
]);

const packageTestCoordinates = testFile => {
  const match = /^(packages\/[^/]+\/[^/]+)\/(tests\/[^/]+\.test\.ts)$/u.exec(testFile);
  assert.ok(match, `${testFile} must be a package-owned top-level test file`);
  return { packageRoot: match[1], relativeTestFile: match[2] };
};

const testScriptExecutes = (script, relativeTestFile) => script
  .split(/\s+/u)
  .some(token => {
    const pattern = escapeRegExp(token).replaceAll("\\*", "[^/]+");
    return new RegExp(`^${pattern}$`, "u").test(relativeTestFile);
  });

export const validateContractCoverage = ({
  contractCoverage,
  fixtureMatrix,
  negativeGroups,
  packageTestScripts,
  testSources,
}) => {
  exactKeys(contractCoverage, ["schemaVersion", "contractId", "cases"], "contract coverage");
  assert.equal(contractCoverage.schemaVersion, 2);
  assert.equal(contractCoverage.contractId, "ar-2-claude-code-setup-preview@2");
  assert.equal(contractCoverage.cases.length, 26, "contract coverage row count");
  assert.equal(fixtureMatrix.length, 26, "frozen fixture row count");
  assert.deepEqual(fixtureMatrix, EXPECTED_FIXTURE_MATRIX, "frozen fixture matrix");
  assert.deepEqual(negativeGroups, fixtureMatrix, "freeze/negative fixture correspondence");
  assert.deepEqual(
    contractCoverage.cases.map(fixtureProjection),
    fixtureMatrix,
    "every frozen fixture has exactly one executable coverage entry",
  );
  unique(contractCoverage.cases.map(entry => entry.id), "contract coverage IDs");

  for (const entry of contractCoverage.cases) {
    exactKeys(
      entry,
      ["id", entry.diagnostic === undefined ? "expected" : "diagnostic", "testFile", "testName"],
      `contract coverage ${entry.id}`,
    );
    const source = testSources.get(entry.testFile);
    assert.equal(typeof source, "string", `${entry.id} test source must be retained by the validator`);
    const declaration = new RegExp(
      `\\btest\\(\\s*${escapeRegExp(JSON.stringify(entry.testName))}\\s*,`,
      "gu",
    );
    assert.equal(
      [...source.matchAll(declaration)].length,
      1,
      `${entry.id} must name exactly one declared Node test in ${entry.testFile}`,
    );
    const { packageRoot, relativeTestFile } = packageTestCoordinates(entry.testFile);
    const packageTestScript = packageTestScripts.get(packageRoot);
    assert.equal(typeof packageTestScript, "string", `${packageRoot} must declare a test script`);
    assert.equal(
      testScriptExecutes(packageTestScript, relativeTestFile),
      true,
      `${entry.id} test file must be executed by ${packageRoot}/package.json`,
    );
  }
};

export const validateClaudeDiagnosticParity = (frozenDiagnostics, runtimeAccessSource) => {
  const declaration = /export type ClaudeCodeSetupDiagnosticCode =(?<members>[\s\S]*?);/u
    .exec(runtimeAccessSource);
  assert.ok(declaration?.groups?.members, "public Claude diagnostic union must be declared");
  const members = [...declaration.groups.members.matchAll(/^\s*\|\s*"([a-z0-9_]+)"\s*$/gmu)]
    .map(match => match[1]);
  assert.equal(
    declaration.groups.members.replace(/^\s*\|\s*"[a-z0-9_]+"\s*$/gmu, "").trim(),
    "",
    "public Claude diagnostic union must contain only literal diagnostic codes",
  );
  unique(frozenDiagnostics, "frozen Claude diagnostics");
  unique(members, "public Claude diagnostic union members");
  assert.deepEqual(
    [...frozenDiagnostics].toSorted(),
    members.toSorted(),
    "Claude runtime/freeze diagnostic set parity",
  );
};

const loadContractCoverageEvidence = async contractCoverage => {
  const testFiles = [...new Set(contractCoverage.cases.map(entry => entry.testFile))];
  const testSources = new Map(await Promise.all(testFiles.map(async testFile => [
    testFile,
    await readFile(new URL(testFile, repositoryRoot), "utf8"),
  ])));
  const packageRoots = [...new Set(testFiles.map(testFile => packageTestCoordinates(testFile).packageRoot))];
  const packageTestScripts = new Map(await Promise.all(packageRoots.map(async packageRoot => {
    const packageManifest = await readJson(new URL(`${packageRoot}/package.json`, repositoryRoot));
    return [packageRoot, packageManifest.scripts?.test];
  })));
  return { packageTestScripts, testSources };
};

const LEGACY_COMMIT = "f6afac73cced62d943a0e891ad08d7b8f88f802f";
const CURRENT_COMMIT = "493c6c37e247f021fc110c5fc624b72f1502d743";
const BOUNDED_CONTEXT_IDS = new Set([
  "runtime-configuration", "runtime-security", "provider-access", "agent-execution",
]);
const hostedAbsolutePath = /\/(?:home|Users)\//u;
const secretShapedValue = /(?:-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bAKIA[0-9A-Z]{16}\b|\b(?:sk|xox[baprs]|gh[opusr])-[A-Za-z0-9_-]{16,}\b|\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\b)/u;

const providerForId = capabilityId => {
  if (capabilityId.startsWith("CODEX-")) {return "codex";}
  if (capabilityId.startsWith("CLF-")) {return "claude-code";}
  if (capabilityId.startsWith("OC-")) {return "opencode";}
  assert.fail(`unknown capability ID prefix: ${capabilityId}`);
};

const evidenceEntries = inventory => [
  ...inventory.crossCuttingInvariants.flatMap(invariant => invariant.acceptanceEvidence.map(entry => entry.evidence)),
  ...inventory.items.flatMap(item => [
    ...item.legacyFact.evidence,
    ...item.currentProviderFact.evidence,
    ...item.architectureAuthority.evidence,
    ...item.acceptanceEvidence.map(entry => entry.evidence),
  ]),
];

export const validateInventory = inventory => {
  assert.equal(inventory.schemaVersion, 2);
  assert.equal(inventory.legacyCommit, LEGACY_COMMIT);
  assert.equal(inventory.currentCommit, CURRENT_COMMIT);
  const capabilityIds = inventory.items.map(item => item.capabilityId);
  unique(capabilityIds, "capability IDs");
  const capabilityIdSet = new Set(capabilityIds);
  unique(inventory.crossCuttingInvariants.map(invariant => invariant.id), "cross-cutting invariant IDs");
  const providerCounts = Object.fromEntries(
    ["codex", "claude-code", "opencode"].map(provider => [
      provider,
      inventory.items.filter(item => item.provider === provider).length,
    ]),
  );
  for (const item of inventory.items) {
    assert.equal(item.provider, providerForId(item.capabilityId), `${item.capabilityId} provider/ID consistency`);
    for (const owner of item.owners) {
      if (owner.kind === "bounded-context") {
        assert.ok(BOUNDED_CONTEXT_IDS.has(owner.id), `${item.capabilityId} bounded-context owner ID`);
      } else if (owner.kind === "application-composition") {
        assert.equal(owner.id, "embedded-runtime", `${item.capabilityId} application-composition owner ID`);
      } else if (owner.kind === "external-consumer") {
        assert.equal(owner.id, "desktop", `${item.capabilityId} external-consumer owner ID`);
      } else {
        assert.fail(`${item.capabilityId} unknown owner kind ${owner.kind}`);
      }
    }
    for (const relatedId of [...item.supersededBy, ...item.relatedCapabilities, ...item.priority.dependencies]) {
      assert.ok(capabilityIdSet.has(relatedId), `${item.capabilityId} relationship ${relatedId} must exist`);
      assert.notEqual(relatedId, item.capabilityId, `${item.capabilityId} cannot relate to itself`);
    }
    if (item.lifecycleStatus === "superseded") {
      assert.equal(item.implementationStatus, "not_applicable", `${item.capabilityId} superseded implementation`);
      assert.equal(item.backlogDisposition, "not_applicable", `${item.capabilityId} superseded backlog`);
      assert.ok(
        item.supersededBy.length > 0 || /INV-[A-Z0-9-]+/u.test(item.architectureAuthority.claim),
        `${item.capabilityId} supersession target`,
      );
    } else {
      assert.equal(item.supersededBy.length, 0, `${item.capabilityId} active row cannot be superseded`);
    }
    if (item.implementationStatus === "implemented") {
      assert.notEqual(item.qualificationStatus, "not_applicable", `${item.capabilityId} implementation qualification axis`);
      assert.equal(item.architectureAuthority.status, "accepted", `${item.capabilityId} implementation authority`);
      assert.equal(item.backlogDisposition, "not_applicable", `${item.capabilityId} implemented backlog axis`);
      assert.ok(
        item.acceptanceEvidence.some(entry =>
          entry.kind === "observed_current"
          && /\/tests\//u.test(entry.evidence.path)
          && entry.evidence.locator.startsWith("test:")
        ),
        `${item.capabilityId} exact current test evidence`,
      );
    } else if (item.implementationStatus === "not_implemented") {
      assert.equal(item.qualificationStatus, "not_applicable", `${item.capabilityId} absent implementation qualification`);
      assert.equal(
        item.acceptanceEvidence.some(entry => entry.kind === "observed_current"),
        false,
        `${item.capabilityId} absent implementation cannot claim observed acceptance`,
      );
    }
    if (["observed", "verified"].includes(item.legacyFact.status)) {
      assert.ok(item.legacyFact.evidence.length > 0, `${item.capabilityId} observed legacy fact evidence`);
      assert.ok(item.legacyFact.evidence.every(entry => entry.repository === "legacy"), `${item.capabilityId} legacy evidence repository`);
    }
    if (item.currentProviderFact.status === "verified") {
      assert.ok(item.currentProviderFact.evidence.length > 0, `${item.capabilityId} verified current-provider evidence`);
      assert.ok(item.currentProviderFact.evidence.every(entry => entry.repository === "current"), `${item.capabilityId} current-provider repository`);
    }
    const serialized = JSON.stringify(item);
    assert.doesNotMatch(serialized, hostedAbsolutePath, `${item.capabilityId} hosted absolute path`);
    assert.doesNotMatch(serialized, secretShapedValue, `${item.capabilityId} secret-shaped value`);
  }
  for (const entry of evidenceEntries(inventory)) {
    assert.equal(entry.commit, entry.repository === "legacy" ? LEGACY_COMMIT : CURRENT_COMMIT, `${entry.path} evidence commit/repository consistency`);
    assert.doesNotMatch(entry.path, /^(?:\/|\.\.?\/)|\\/u, `${entry.path} repository-relative evidence path`);
    assert.doesNotMatch(entry.claim, hostedAbsolutePath, `${entry.path} evidence claim hosted path`);
  }
  return {
    capabilityIds,
    providerCounts,
    implemented: inventory.items.filter(item => item.implementationStatus === "implemented").map(item => item.capabilityId).toSorted(),
    superseded: inventory.items.filter(item => item.lifecycleStatus === "superseded").map(item => item.capabilityId).toSorted(),
  };
};

const resolveJsonPointer = (value, pointer) => pointer
  .slice(1)
  .split("/")
  .reduce((current, token) => current?.[token.replaceAll("~1", "/").replaceAll("~0", "~")], value);

const validateEvidenceAnchor = async (entry, evidenceRoot) => {
  const path = new URL(entry.path, evidenceRoot);
  let source;
  await assert.doesNotReject(async () => {
    source = await readFile(path, "utf8");
  }, `${entry.repository}:${entry.path} evidence path must exist`);
  const [kind, coordinate] = entry.locator.split(/:(.*)/su, 2);
  if (kind === "line") {
    assert.ok(Number(coordinate) <= source.split("\n").length, `${entry.path}:${coordinate} line must exist`);
  } else if (kind === "symbol") {
    assert.ok(source.includes(coordinate), `${entry.path} symbol ${coordinate} must exist`);
  } else if (kind === "test") {
    assert.ok(source.includes(coordinate), `${entry.path} test ${coordinate} must exist`);
  } else if (kind === "heading") {
    assert.match(source, new RegExp(`^#{1,6}\\s+${escapeRegExp(coordinate)}\\s*$`, "mu"), `${entry.path} heading ${coordinate}`);
  } else if (kind === "json-pointer") {
    assert.notEqual(resolveJsonPointer(JSON.parse(source), coordinate), undefined, `${entry.path} JSON pointer ${coordinate}`);
  } else {
    assert.fail(`${entry.path} unsupported locator ${entry.locator}`);
  }
};

const asDirectoryUrl = root => {
  const url = root instanceof URL ? new URL(root) : pathToFileURL(resolve(root));
  if (!url.pathname.endsWith("/")) {url.pathname += "/";}
  return url;
};

const validateInventoryEvidenceFor = async (inventory, repository, evidenceRoot) => {
  const entries = evidenceEntries(inventory).filter(entry => entry.repository === repository);
  await Promise.all(entries.map(entry => validateEvidenceAnchor(entry, evidenceRoot)));
  return entries.length;
};

export const auditLegacyInventoryEvidence = async (exactLegacyRoot, inventoryOverride) => {
  assert.ok(exactLegacyRoot, "an explicit exact legacy root is required");
  const inventory = inventoryOverride ?? await readJson(inventoryPath);
  validateInventory(inventory);
  return validateInventoryEvidenceFor(inventory, "legacy", asDirectoryUrl(exactLegacyRoot));
};

const validateFreeze = async freeze => {
  assert.equal(freeze.schemaVersion, 2);
  assert.equal(freeze.contractId, "ar-2-claude-code-setup-preview@2");
  assert.equal(freeze.dialect.id, "claude-code-settings@2026-08-28");
  assert.equal(freeze.dialect.qualifiesExecutable, false);
  assert.deepEqual(freeze.entryPoint, {
    member: "RuntimeAccessHandle.claudeCodeSetup.inspect",
    productInput: "none",
    cancellation: "options.signal",
  });
  assert.equal(freeze.sourceModel.contract, "claude-code-observed-source-plan/v1");
  assert.equal(freeze.sourceModel.claim, "observed-files-only");
  assert.equal(freeze.sourceModel.precedence, "not-evaluated");
  assert.equal(freeze.sourceModel.compatibility, "unqualified");
  assert.equal(freeze.sourceModel.arrayOrder, "presentation-only");
  assert.deepEqual(freeze.sourceModel.hostComposed, [
    "collector", "custodyRoots", "sourcePaths", "sourceIds", "rootIds", "roles", "trust", "selectionBases",
  ]);
  assert.equal(freeze.sourceModel.staticPreviewSelectionBasis, "static-preview");
  assert.deepEqual(freeze.sourceModel.forbiddenDiscovery, [
    "process.cwd", "process.env.CLAUDE_CONFIG_DIR", "git-discovery",
    "binary-revision-inference", "arbitrary-caller-ranks",
  ]);
  assert.deepEqual(freeze.strictJson, {
    encoding: "utf-8",
    root: "object",
    reject: [
      "bom", "comments", "trailing-commas", "duplicate-keys-at-any-depth",
      "invalid-utf8", "non-object-root",
    ],
  });
  assert.deepEqual(freeze.portableIntent.effortValues, ["low", "medium", "high", "xhigh"]);
  assert.equal(freeze.portableIntent.modelDefault, "default");
  assert.deepEqual(freeze.portableIntent.modelAliases, [
    "best", "fable", "sonnet", "opus", "haiku", "sonnet[1m]",
    "opus[1m]", "opusplan",
  ]);
  assert.deepEqual(freeze.portableIntent.deferredModelForms,
    ["provider-deployment", "unclassified-selector"]);
  assert.equal(freeze.portableIntent.exactNameSyntax,
    "^claude-[a-z0-9]+(?:-[a-z0-9]+)*(?:\\[1m\\])?$");
  assert.match(freeze.portableIntent.exactNameClaim, /syntax-only/u);
  assert.equal(freeze.portableIntent.deferredObservation, "value-free");
  assert.equal(freeze.routeVocabulary.revision, "claude-code-provider-route-vocabulary/v2");
  for (const routeKey of [
    "AWS_DEFAULT_REGION", "ANTHROPIC_BEDROCK_REGION_PREFIX", "ANTHROPIC_BEDROCK_SERVICE_TIER",
    "CLAUDE_CODE_USE_MANTLE", "CLAUDE_CODE_SKIP_MANTLE_AUTH", "ANTHROPIC_BEDROCK_MANTLE_BASE_URL",
  ]) {assert.ok(freeze.routeVocabulary.retainedBedrockKeys.includes(routeKey), routeKey);}
  assert.deepEqual(freeze.expectedLimitations, {
    managedPolicy: "unobserved",
    sessionOverrides: "unobserved",
    interactiveShellPath: "unobserved",
    modelCompatibility: "unobserved",
    executableCompatibility: "unqualified",
    precedence: "not-evaluated",
  });
  assert.equal(freeze.budgets.sourceSlots, 16);
  assert.equal(freeze.budgets.rootSlots, 16);
  assert.equal(freeze.budgets.aggregateSourceBytes, 1048576);
  assert.deepEqual(freeze.resultSemantics.futureHandoff,
    ["qualified-topology-dialect", "ProfileDraft", "ProfileRevision"]);
  assert.ok(freeze.resultSemantics.sections.includes("observedPortableIntent"));
  assert.ok(freeze.resultSemantics.sections.includes("deferredObservations"));
  unique(freeze.snapshot.documents.map(document => document.id), "snapshot document IDs");
  const semanticArtifactUrl = new URL(`../../${freeze.snapshot.semanticArtifact.path}`, import.meta.url);
  const semanticArtifactBytes = await readFile(semanticArtifactUrl);
  assert.equal(sha256(semanticArtifactBytes), freeze.snapshot.semanticArtifact.sha256, "official semantic artifact content hash");
  const semanticArtifact = JSON.parse(semanticArtifactBytes.toString("utf8"));
  const frozenFacts = await validateOfficialSemantics(semanticArtifact);
  assert.deepEqual(
    semanticArtifact.documents.map(({ id, finalUrl: url, rawResponseSha256, artifactPath }) => ({
      artifactPath,
      id,
      rawResponseSha256,
      url,
    })),
    freeze.snapshot.documents,
    "freeze raw response authorities correspond exactly to the semantic artifact",
  );
  assert.deepEqual(Object.fromEntries(Object.entries(frozenFacts).map(([name, fact]) => [name, fact.value])), {
    portableSourcesLowToHigh: ["user", "shared-project", "project-local"],
    portablePaths: [
      "~/.claude/settings.json", "<workspace>/.claude/settings.json",
      "<workspace>/.claude/settings.local.json",
    ],
    portableKeys: ["model", "effortLevel"],
    modelAliases: freeze.portableIntent.modelAliases,
    modelDefaultIsNotAlias: true,
    exactModelNamesAreValidSettings: true,
    effortValues: freeze.portableIntent.effortValues,
    managedPolicySeparateFromPortableIntent: true,
    routeAccountFactsProviderAccessOwned: true,
    modelSettingsMayContainProviderDeployments: true,
    providerDeploymentsDeferredUntilRouteBinding: true,
  });
};

export const validateAr2ContractArtifacts = async () => {
  const [
    inventory, inventorySchema, freeze, freezeSchema, fixtureManifest,
    negativeFixtures, contractCoverage, rootPackage, roadmap, readiness, runtimeAccessSource,
  ] = await Promise.all([
    readJson(inventoryPath),
    readJson(inventorySchemaPath),
    readJson(freezePath),
    readJson(freezeSchemaPath),
    readJson(fixtureManifestPath),
    readJson(negativeFixturesPath),
    readJson(contractCoveragePath),
    readJson(packagePath),
    readFile(roadmapPath, "utf8"),
    readFile(readinessPath, "utf8"),
    readFile(runtimeAccessPath, "utf8"),
  ]);
  validateSchema(inventorySchema, inventory, "legacy inventory");
  validateSchema(freezeSchema, freeze, "Claude freeze");
  const { capabilityIds, implemented, providerCounts, superseded } = validateInventory(inventory);
  await validateInventoryEvidenceFor(inventory, "current", repositoryRoot);

  for (const [label, document] of [
    ["inventory", JSON.stringify(inventory)],
    ["freeze", JSON.stringify(freeze)],
    ["roadmap", roadmap],
    ["readiness", readiness],
  ]) {
    assert.doesNotMatch(document, /\bPacket[ -]?A\b/iu, `${label} retired label`);
  }
  assert.match(roadmap, /passive macOS synthetic preview only/u);
  assert.match(roadmap, /It does not inspect or prove\s+a real Claude Code installation/u);
  assert.doesNotMatch(roadmap, /implementation\s+`[0-9a-f]{40}`/u);
  assert.match(roadmap, /implementation present in the current repository tree/u);
  assert.match(readiness, /AR-2 implementation present; synthetic evidence present; qualification open/u);
  assert.match(readiness, /does not prove\s+a real Claude Code installation/u);

  await validateFreeze(freeze);
  validateClaudeDiagnosticParity(freeze.diagnostics, runtimeAccessSource);

  assert.equal(fixtureManifest.contractId, freeze.contractId);
  assert.equal(fixtureManifest.dialect, freeze.dialect.id);
  assert.equal(fixtureManifest.classifierContract, "claude-code-portable-intent@2");
  assert.equal(fixtureManifest.classifierRevision,
    "claude-code-settings-2026-08-28-semantic-classifier/2");
  assert.equal(fixtureManifest.semanticDigest, "claude-code-configuration-semantic-digest/v2");
  assert.equal(fixtureManifest.providerRouteVocabularyRevision, freeze.routeVocabulary.revision);
  assert.equal(fixtureManifest.contractCoverage, "./contract-coverage.json");
  assert.equal(fixtureManifest.negativeManifest, "./negative-fixtures.json");
  const coverageEvidence = await loadContractCoverageEvidence(contractCoverage);
  validateContractCoverage({
    contractCoverage,
    fixtureMatrix: freeze.fixtureMatrix,
    negativeGroups: negativeFixtures.groups,
    ...coverageEvidence,
  });
  const checkInvocations = rootPackage.scripts.check.match(/pnpm test:ar2-contract/gu) ?? [];
  assert.equal(checkInvocations.length, 1, "pnpm check runs the AR-2 test exactly once");
  assert.match(rootPackage.scripts.check, /\bpnpm product:check\b/u, "pnpm check runs package tests");
  assert.match(rootPackage.scripts["product:check"], /\brun test\b/u, "product check executes package test scripts");
  assert.equal(JSON.stringify(freeze).includes("interactive-shell"), false);
  assert.equal(JSON.stringify(freeze).includes("managed-settings.json"), false);
  return {
    capabilityIds: capabilityIds.toSorted(),
    implemented,
    inventoryItems: inventory.items.length,
    providerCounts,
    semanticArtifactSha256: freeze.snapshot.semanticArtifact.sha256,
    snapshotDocuments: freeze.snapshot.documents.length,
    superseded,
  };
};

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const result = await validateAr2ContractArtifacts();
  process.stdout.write(`AR-2 contract artifacts valid (${result.inventoryItems} inventory items, ${result.snapshotDocuments} snapshots)\n`);
}
