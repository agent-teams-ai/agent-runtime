import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const inventoryPath = new URL("../../docs/architecture/legacy-feature-inventory.json", import.meta.url);
const freezePath = new URL("../../docs/architecture/claude-code-setup-freeze.json", import.meta.url);

const readJson = async path => JSON.parse(await readFile(path, "utf8"));
const exactKeys = (value, keys, label) => {
  assert.deepEqual(Object.keys(value).toSorted(), [...keys].toSorted(), `${label} keys`);
};
const unique = (values, label) => {
  assert.equal(new Set(values).size, values.length, `${label} must be unique`);
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
const LEGACY_COMMIT = "f6afac73cced62d943a0e891ad08d7b8f88f802f";
const hostedAbsolutePath = /\/(?:home|Users)\//u;
const secretShapedValue = /(?:-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bAKIA[0-9A-Z]{16}\b|\b(?:sk|xox[baprs]|gh[opusr])-[A-Za-z0-9_-]{16,}\b|\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\b)/u;

export const validateAr2ContractArtifacts = async () => {
  const inventory = await readJson(inventoryPath);
  const freeze = await readJson(freezePath);
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
  assert.deepEqual(approvals, [...EXPECTED_APPROVALS].toSorted(), "approved-now Claude preview rows");

  assert.equal(freeze.schemaVersion, 1);
  assert.equal(freeze.dialect.id, "claude-code-settings@2026-08-28");
  assert.equal(freeze.dialect.qualifiesExecutable, false);
  assert.deepEqual(freeze.candidateOrder, [
    "explicit-paths", "supplied-path-entries", "~/.local/bin/claude",
    "/opt/homebrew/bin/claude", "/usr/local/bin/claude",
  ]);
  assert.deepEqual(freeze.precedenceHighToLow, ["project-local", "shared-project", "user"]);
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
    bytesPerSource: 131072,
    depth: 16,
    nodes: 4096,
    objectKeys: 1024,
    arrayItems: 1024,
    keyLength: 256,
    stringLength: 16384,
    classifierValueLength: 256,
    sourceSlots: 3,
    explicitPaths: 16,
    suppliedPathEntries: 64,
    totalCandidates: 256,
    diagnostics: 1024,
  });
  unique(freeze.snapshot.documents.map(document => document.url), "snapshot URLs");
  for (const document of freeze.snapshot.documents) {
    assert.match(document.sha256, /^[0-9a-f]{64}$/u);
  }
  assert.equal(JSON.stringify(freeze).includes("interactive-shell"), false);
  assert.equal(JSON.stringify(freeze).includes("managed-settings.json"), false);
  return {
    approvals,
    capabilityIds: capabilityIds.toSorted(),
    inventoryItems: inventory.items.length,
    providerCounts,
    snapshotDocuments: freeze.snapshot.documents.length,
  };
};

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const result = await validateAr2ContractArtifacts();
  process.stdout.write(`AR-2 contract artifacts valid (${result.inventoryItems} inventory items, ${result.snapshotDocuments} snapshots)\n`);
}
