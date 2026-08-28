import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import Ajv2020 from "ajv/dist/2020.js";

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

const readJson = async path => JSON.parse(await readFile(path, "utf8"));
const exactKeys = (value, keys, label) => {
  assert.deepEqual(Object.keys(value).toSorted(), [...keys].toSorted(), `${label} keys`);
};
const unique = (values, label) => {
  assert.equal(new Set(values).size, values.length, `${label} must be unique`);
};
const sha256 = value => createHash("sha256").update(value).digest("hex");
const validateSchema = (schema, value, label) => {
  const validate = new Ajv2020({ allErrors: true, strict: true, strictTypes: false }).compile(schema);
  assert.equal(validate(value), true, `${label} schema errors: ${JSON.stringify(validate.errors)}`);
};

export const EXPECTED_CAPABILITY_IDS = Object.freeze([
  "CODEX-DISC-01", "CODEX-DISC-02", "CODEX-COMPAT-01",
  "CODEX-CONFIG-01", "CODEX-CONFIG-02", "CODEX-CONFIG-03",
  "CODEX-PROFILE-01", "CODEX-PROFILE-02", "CODEX-INSTALL-01",
  "CODEX-INSTALL-02", "CODEX-INSTALL-03", "CODEX-ACCESS-01",
  "CODEX-ACCESS-02", "CODEX-ACCESS-03", "CODEX-ACCESS-04",
  "CODEX-ACCESS-05", "CODEX-ACCESS-06", "CODEX-ACCESS-07",
  "CODEX-ACCESS-08", "CODEX-MODEL-01", "CODEX-MODEL-02",
  "CODEX-MODEL-03", "CODEX-LAUNCH-01", "CODEX-LAUNCH-02",
  "CODEX-LAUNCH-03", "CODEX-SETUP-01",
  "CLF-01", "CLF-02", "CLF-03", "CLF-04", "CLF-05", "CLF-06", "CLF-07",
  "OC-01", "OC-02", "OC-03", "OC-04", "OC-05", "OC-06", "OC-07",
  "OC-08", "OC-09", "OC-10", "OC-11", "OC-12", "OC-13", "OC-14",
  "OC-15", "OC-16", "OC-17", "OC-18", "OC-19", "OC-20", "OC-21",
  "OC-22", "OC-23",
]);

const EXPECTED_PROVIDER_COUNTS = Object.freeze({
  codex: 26,
  "claude-code": 7,
  opencode: 23,
});
const EXPECTED_APPROVALS = Object.freeze(["CLF-01", "CLF-02", "CLF-03", "CLF-04"]);
const EXPECTED_RECOMMENDED_NEXT = Object.freeze([
  "CODEX-COMPAT-01", "CODEX-INSTALL-01", "CODEX-INSTALL-02",
  "CODEX-INSTALL-03", "CLF-05", "CLF-06",
]);
const EXPECTED_REJECTED = Object.freeze([
  "CODEX-ACCESS-07", "OC-21", "OC-22", "OC-23",
]);
const LEGACY_COMMIT = "f6afac73cced62d943a0e891ad08d7b8f88f802f";
const hostedAbsolutePath = /\/(?:home|Users)\//u;
const secretShapedValue = /(?:-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bAKIA[0-9A-Z]{16}\b|\b(?:sk|xox[baprs]|gh[opusr])-[A-Za-z0-9_-]{16,}\b|\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\b)/u;

const validateInventory = inventory => {
  const itemKeys = [
    "capabilityId", "provider", "userJob", "userValue", "legacyBehavior",
    "exactLegacyEvidence", "failureAndEdgeCases", "reuseDecision", "newOwner",
    "proposedDisposition", "authorityStatus", "acceptanceEvidence", "futureExtensionSeam",
  ];
  const dispositions = new Set([
    "approved_now", "recommended_next", "recommended_later", "rejected", "needs_owner",
  ]);
  const reuseDecisions = new Set([
    "reuse_fixture", "reuse_concept", "refactor_pattern", "keep_provider_specific",
    "reject_legacy_approach",
  ]);
  assert.equal(inventory.schemaVersion, 1);
  assert.equal(inventory.implementationAuthority, "current-repository-tree");
  assert.equal(inventory.legacyCommit, LEGACY_COMMIT);
  assert.equal(inventory.items.length, 56, "inventory row count");
  const capabilityIds = inventory.items.map(item => item.capabilityId);
  unique(capabilityIds, "capability IDs");
  assert.deepEqual(capabilityIds.toSorted(), [...EXPECTED_CAPABILITY_IDS].toSorted(), "capability ID set");
  const providerCounts = Object.fromEntries(
    Object.keys(EXPECTED_PROVIDER_COUNTS).map(provider => [
      provider,
      inventory.items.filter(item => item.provider === provider).length,
    ]),
  );
  assert.deepEqual(providerCounts, EXPECTED_PROVIDER_COUNTS, "provider counts");
  for (const item of inventory.items) {
    exactKeys(item, itemKeys, item.capabilityId);
    for (const key of itemKeys) {
      assert.equal(typeof item[key], "string", `${item.capabilityId}.${key} type`);
      assert.ok(item[key].trim().length > 0, `${item.capabilityId}.${key} non-empty`);
    }
    assert.ok(dispositions.has(item.proposedDisposition), `${item.capabilityId} disposition`);
    assert.ok(reuseDecisions.has(item.reuseDecision), `${item.capabilityId} reuse decision`);
    assert.match(item.exactLegacyEvidence, new RegExp(`^${LEGACY_COMMIT}: `, "u"), `${item.capabilityId} exact legacy commit`);
    assert.match(item.exactLegacyEvidence, /\b(?:src|test)\/[^\s),;]+/u, `${item.capabilityId} repository-relative legacy path`);
    assert.match(item.exactLegacyEvidence, /(?::\d+\b|\b(?:symbol|symbols|test|tests)\b)/iu, `${item.capabilityId} symbol/test anchor`);
    const serialized = JSON.stringify(item);
    assert.doesNotMatch(serialized, hostedAbsolutePath, `${item.capabilityId} hosted absolute path`);
    assert.doesNotMatch(serialized, secretShapedValue, `${item.capabilityId} secret-shaped value`);
  }
  const approvals = inventory.items
    .filter(item => item.proposedDisposition === "approved_now")
    .map(item => item.capabilityId)
    .toSorted();
  const recommendedNext = inventory.items
    .filter(item => item.proposedDisposition === "recommended_next")
    .map(item => item.capabilityId)
    .toSorted();
  const rejected = inventory.items
    .filter(item => item.proposedDisposition === "rejected")
    .map(item => item.capabilityId)
    .toSorted();
  assert.deepEqual(approvals, [...EXPECTED_APPROVALS].toSorted(), "approved-now Claude preview rows");
  assert.deepEqual(recommendedNext, [...EXPECTED_RECOMMENDED_NEXT].toSorted(), "recommended-next inventory rows");
  assert.deepEqual(rejected, [...EXPECTED_REJECTED].toSorted(), "rejected inventory rows");
  assert.equal(
    inventory.items.filter(item => item.proposedDisposition === "recommended_later").length,
    inventory.items.length - approvals.length - recommendedNext.length - rejected.length,
    "all remaining inventory rows stay recommended-later",
  );
  assert.equal(inventory.items.some(item => item.proposedDisposition === "needs_owner"), false, "inventory has no ownerless row");
  return { approvals, capabilityIds, providerCounts };
};

const validateFreeze = async freeze => {
  assert.equal(freeze.schemaVersion, 1);
  assert.equal(freeze.dialect.id, "claude-code-settings@2026-08-28");
  assert.equal(freeze.dialect.qualifiesExecutable, false);
  assert.deepEqual(freeze.entryPoint, {
    member: "RuntimeAccessHandle.claudeCodeSetup.inspect",
    productInput: "none",
    cancellation: "options.signal",
  });
  assert.deepEqual(freeze.trustedScope, {
    supplied: [
      "explicitExecutablePaths", "pathEntries", "dialect", "homeRoot",
      "workspaceRoot", "workspaceTrusted",
    ],
    derivedInComposition: [
      "userSourcePath", "sharedProjectSourcePath", "projectLocalSourcePath",
      "knownExecutablePaths",
    ],
    forbiddenAmbientInputs: [
      "process.env", "process.cwd", "interactiveShellPath", "CLAUDE_CONFIG_DIR",
    ],
  });
  assert.deepEqual(freeze.candidateOrder, [
    "explicit-paths", "supplied-path-entries", "~/.local/bin/claude",
    "/opt/homebrew/bin/claude", "/usr/local/bin/claude",
  ]);
  assert.deepEqual(freeze.sources, [
    { kind: "user", rank: 1, pathTemplate: "~/.claude/settings.json" },
    { kind: "shared-project", rank: 2, pathTemplate: "<workspace>/.claude/settings.json" },
    { kind: "project-local", rank: 3, pathTemplate: "<workspace>/.claude/settings.local.json" },
  ]);
  assert.deepEqual(freeze.precedenceHighToLow, ["project-local", "shared-project", "user"]);
  assert.deepEqual(freeze.strictJson, {
    encoding: "utf-8",
    root: "object",
    reject: [
      "bom", "comments", "trailing-commas", "duplicate-keys-at-any-depth",
      "invalid-utf8", "non-object-root",
    ],
  });
  assert.deepEqual(freeze.portableIntent.effortValues, ["low", "medium", "high", "xhigh"]);
  assert.deepEqual(freeze.portableIntent.modelAliases, [
    "default", "best", "fable", "sonnet", "opus", "haiku", "sonnet[1m]",
    "opus[1m]", "opusplan",
  ]);
  assert.deepEqual(freeze.expectedLimitations, {
    managedPolicy: "unobserved",
    sessionOverrides: "unobserved",
    interactiveShellPath: "unobserved",
  });
  assert.deepEqual(freeze.diagnostics, [
    "candidate_denied", "candidate_invalid", "candidate_unreadable", "candidate_unstable",
    "configuration_dialect_unsupported", "config_duplicate_key", "config_invalid_utf8",
    "config_parse_failed", "config_too_large", "config_unreadable",
    "credential_material_rejected", "provider_route_deferred", "secret_setting_rejected",
    "setting_type_unsupported", "setting_value_unsupported", "source_untrusted",
    "source_epoch_stale", "unsupported_platform",
  ]);
  assert.deepEqual(freeze.budgets, {
    bytesPerSource: 131072, depth: 16, nodes: 4096, objectKeys: 1024,
    arrayItems: 1024, keyLength: 256, stringLength: 16384,
    classifierValueLength: 256, sourceSlots: 3, explicitPaths: 16,
    suppliedPathEntries: 64, totalCandidates: 256, diagnostics: 1024,
  });
  assert.deepEqual(freeze.resultSemantics, {
    sections: [
      "installations", "portableIntent", "sourceObservations",
      "expectedLimitations", "diagnostics", "nextActions",
    ],
    statuses: ["observed", "partial", "denied", "unsupported"],
    installationStatus: "found_unverified",
    partial: "Only actual degradation of the declared V1 scope. Expected limitations, a clean absent optional setting, or no installation do not cause partial.",
    absence: "A clean absent installation is observed and includes install_claude_code as a next action.",
    detached: true,
    deepFrozen: true,
    deterministic: true,
  });
  unique(freeze.snapshot.documents.map(document => document.url), "snapshot URLs");
  const semanticArtifactUrl = new URL(`../../${freeze.snapshot.semanticArtifact.path}`, import.meta.url);
  const semanticArtifactBytes = await readFile(semanticArtifactUrl);
  assert.equal(sha256(semanticArtifactBytes), freeze.snapshot.semanticArtifact.sha256, "official semantic artifact content hash");
  const semanticArtifact = JSON.parse(semanticArtifactBytes.toString("utf8"));
  exactKeys(
    semanticArtifact,
    ["schemaVersion", "snapshotId", "retrieval", "documents", "frozenFacts"],
    "official semantic artifact",
  );
  exactKeys(
    semanticArtifact.retrieval,
    ["method", "date", "exactPriorResponseBytesAvailable", "status", "statement"],
    "official semantic artifact retrieval",
  );
  assert.equal(semanticArtifact.schemaVersion, 1);
  assert.equal(semanticArtifact.snapshotId, "claude-code-settings-semantics@2026-08-28");
  assert.equal(
    semanticArtifact.retrieval.method,
    "HTTPS GET with redirects followed; SHA-256 over response bytes",
  );
  assert.equal(semanticArtifact.retrieval.exactPriorResponseBytesAvailable, false);
  assert.equal(semanticArtifact.retrieval.status, "historical-response-hashes-only");
  assert.match(semanticArtifact.retrieval.statement, /not claimed to be reproducible/u);
  assert.deepEqual(
    semanticArtifact.documents.map(({ url, responseSha256 }) => ({ sha256: responseSha256, url })),
    freeze.snapshot.documents,
    "freeze response hashes correspond exactly to the semantic artifact",
  );
  for (const document of semanticArtifact.documents) {
    exactKeys(document, ["url", "responseSha256", "immutableReference"], document.url);
    assert.equal(document.immutableReference, null);
  }
  assert.deepEqual(semanticArtifact.frozenFacts, {
    portableSourcesLowToHigh: ["user", "shared-project", "project-local"],
    portablePaths: [
      "~/.claude/settings.json", "<workspace>/.claude/settings.json",
      "<workspace>/.claude/settings.local.json",
    ],
    portableKeys: ["model", "effortLevel"],
    modelAliases: freeze.portableIntent.modelAliases,
    effortValues: freeze.portableIntent.effortValues,
    managedPolicySeparateFromPortableIntent: true,
    providerRoutesSeparateFromPortableIntent: true,
  });
};

export const validateAr2ContractArtifacts = async () => {
  const [
    inventory, inventorySchema, freeze, freezeSchema, fixtureManifest,
    negativeFixtures, contractCoverage, rootPackage, roadmap, readiness,
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
  ]);
  validateSchema(inventorySchema, inventory, "legacy inventory");
  validateSchema(freezeSchema, freeze, "Claude freeze");
  const { approvals, capabilityIds, providerCounts } = validateInventory(inventory);

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

  assert.equal(fixtureManifest.contractId, freeze.contractId);
  assert.equal(fixtureManifest.dialect, freeze.dialect.id);
  assert.equal(fixtureManifest.contractCoverage, "./contract-coverage.json");
  assert.equal(fixtureManifest.negativeManifest, "./negative-fixtures.json");
  assert.deepEqual(negativeFixtures.groups, freeze.fixtureMatrix, "freeze/negative fixture correspondence");
  assert.deepEqual(
    contractCoverage.cases.map(({ id, expected, diagnostic }) => ({
      ...(diagnostic === undefined ? {} : { diagnostic }),
      ...(expected === undefined ? {} : { expected }),
      id,
    })),
    freeze.fixtureMatrix,
    "every frozen fixture has an executable coverage entry",
  );
  unique(contractCoverage.cases.map(entry => entry.id), "contract coverage IDs");
  const checkInvocations = rootPackage.scripts.check.match(/pnpm test:ar2-contract/gu) ?? [];
  assert.equal(checkInvocations.length, 1, "pnpm check runs the AR-2 test exactly once");
  assert.equal(JSON.stringify(freeze).includes("interactive-shell"), false);
  assert.equal(JSON.stringify(freeze).includes("managed-settings.json"), false);
  return {
    approvals,
    capabilityIds: capabilityIds.toSorted(),
    inventoryItems: inventory.items.length,
    providerCounts,
    semanticArtifactSha256: freeze.snapshot.semanticArtifact.sha256,
    snapshotDocuments: freeze.snapshot.documents.length,
  };
};

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const result = await validateAr2ContractArtifacts();
  process.stdout.write(`AR-2 contract artifacts valid (${result.inventoryItems} inventory items, ${result.snapshotDocuments} snapshots)\n`);
}
