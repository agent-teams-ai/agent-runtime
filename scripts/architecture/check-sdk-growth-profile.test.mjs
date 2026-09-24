import assert from "node:assert/strict";
import { parse, stringify } from "yaml";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { checkSdkGrowthProfile, normalizeWorkspaceManifestPaths } from "./check-sdk-growth-profile.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const contractPath = "architecture/c0/ar-owned-lifetime/contract.json";
const contract = JSON.parse(readFileSync(join(root, contractPath), "utf8"));
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "ar-sdk-profile-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const path of [contractPath, "pnpm-workspace.yaml", "architecture/sdk-growth", "architecture/get-modular/consumer-profile.json", "architecture/get-modular/evidence/consumer-module-standard.md", "architecture/get-modular/evidence/a3-cms-pin-review.json", "architecture/get-modular/evidence/sdk-growth-standard-review.json", "architecture/get-modular/evidence/sdk-growth-current-standard.md", "architecture/consumer-module-standard/contained-turn-profile.json", ...contract.inventory.packages.map(pkg => pkg.manifest)]) {
    mkdirSync(dirname(join(directory, path)), { recursive: true });
    cpSync(join(root, path), join(directory, path), { recursive: true });
  }
  return directory;
}
function mutate(directory, path, change) {
  const destination = join(directory, path);
  const value = parse(readFileSync(destination, "utf8"));
  change(value);
  writeFileSync(destination, path.endsWith(".yaml") ? stringify(value) : `${JSON.stringify(value, null, 2)}\n`);
}

test("exact EF 1.6.0 package enrollment keeps historical EF 1.5.1 observation separate and current admission blocked", t => {
  assert.deepEqual(checkSdkGrowthProfile(fixture(t)), { status: "pending-authority-qualification", packages: 6, metadataRoots: 1, releaseEligible: false });
});
for (const script of ["sdk-growth:profile", "test:sdk-growth:profile", "test:sdk-growth:packed"]) {
  for (const replacement of [undefined, "node -e 'process.exit(0)'"]) {
    test(`reject missing/no-op ${script}: ${replacement}`, t => {
      const directory = fixture(t);
      mutate(directory, "package.json", value => { value.scripts[script] = replacement; });
      assert.throws(() => checkSdkGrowthProfile(directory), /SDK_ENFORCEMENT_MISSING_OR_NOOP/u);
    });
  }
}
for (const script of ["check", "check:fast"]) {
  test(`reject bypass in ${script}`, t => {
    const directory = fixture(t);
    mutate(directory, "package.json", value => { value.scripts[script] = "pnpm lint"; });
    assert.throws(() => checkSdkGrowthProfile(directory), /SDK_ENFORCEMENT_MISSING_OR_NOOP/u);
  });
}
test("reject package removed from profile but retained in workspace", t => {
  const directory = fixture(t);
  mutate(directory, "architecture/sdk-growth/profile.yaml", value => { value.packages.pop(); });
  assert.throws(() => checkSdkGrowthProfile(directory), /SDK_PROFILE_SCOPE_DRIFT/u);
});
test("reject physical package deletion", t => {
  const directory = fixture(t);
  rmSync(join(directory, "packages/platform/filesystem-custody"), { recursive: true });
  assert.throws(() => checkSdkGrowthProfile(directory), /SDK_SCOPE_DRIFT/u);
});
test("reject package hidden by workspace glob", t => {
  const directory = fixture(t);
  const path = join(directory, "pnpm-workspace.yaml");
  writeFileSync(path, readFileSync(path, "utf8").replace('  - "packages/platform/*"\n', ""));
  assert.throws(() => checkSdkGrowthProfile(directory), /SDK_SCOPE_DRIFT/u);
});
test("reject newly discovered package", t => {
  const directory = fixture(t);
  mkdirSync(join(directory, "packages/contexts/new-sdk"));
  writeFileSync(join(directory, "packages/contexts/new-sdk/package.json"), '{"name":"new-sdk","private":true}');
  assert.throws(() => checkSdkGrowthProfile(directory), /SDK_SCOPE_DRIFT/u);
});
test("reject same-change frozen C0 mutation", t => {
  const directory = fixture(t);
  mutate(directory, contractPath, value => { value.inventory.packages.pop(); });
  assert.throws(() => checkSdkGrowthProfile(directory), /SDK_C0_BASE_MUTATION/u);
});
test("reject root SDK added under metadata classification", t => {
  const directory = fixture(t);
  mutate(directory, "package.json", value => { value.exports = "./index.js"; });
  assert.throws(() => checkSdkGrowthProfile(directory), /SDK_ROOT_CLASSIFICATION_DRIFT/u);
});
test("reject an unclassified workspace package executable", t => {
  const directory = fixture(t);
  mutate(directory, "packages/apps/embedded-runtime/package.json", value => {
    value.bin = { "ar-sdk-check": "./dist/index.js" };
  });
  assert.throws(() => checkSdkGrowthProfile(directory), /SDK_BIN_CLASSIFICATION_DRIFT/u);
});
test("normalize Windows workspace discovery paths before scope comparison", () => {
  assert.deepEqual(normalizeWorkspaceManifestPaths([
    "packages\\contexts\\provider-access\\package.json",
    "packages\\apps\\embedded-runtime\\package.json"
  ]), [
    "packages/apps/embedded-runtime/package.json",
    "packages/contexts/provider-access/package.json"
  ]);
});
for (const pkg of contract.inventory.packages.filter(value => value.exports !== null)) {
  test(`reject lost branch or condition reorder: ${pkg.name}`, t => {
    const directory = fixture(t);
    mutate(directory, pkg.manifest, value => {
      const branch = value.exports["."];
      value.exports["."] = { import: branch.import, types: branch.types };
    });
    assert.throws(() => checkSdkGrowthProfile(directory), /SDK_EXPORT_MATRIX_DRIFT/u);
  });
}

test("reject profile redirected to another package root", t => {
  const directory = fixture(t);
  mutate(directory, "architecture/sdk-growth/profile.yaml", value => { value.packages[0].packageRoot = "packages/contexts/agent-execution"; });
  assert.throws(() => checkSdkGrowthProfile(directory), /SDK_PACKAGE_ROOT_DRIFT/u);
});
test("reject changed supplied CMS bytes under retained review", t => {
  const directory = fixture(t);
  writeFileSync(join(directory, "architecture/get-modular/evidence/sdk-growth-current-standard.md"), "changed\n");
  assert.throws(() => checkSdkGrowthProfile(directory), /SDK_CMS_REVIEW_DRIFT/u);
});
test("reject drift in the preserved historical A3 CMS review", t => {
  const directory = fixture(t);
  mutate(directory, "architecture/get-modular/evidence/sdk-growth-standard-review.json", value => { value.activeSha256 = "0".repeat(64); });
  assert.throws(() => checkSdkGrowthProfile(directory), /SDK_CMS_REVIEW_DRIFT/u);
});
test("reject the current CMS pin detached from the fresh migration review", t => {
  const directory = fixture(t);
  mutate(directory, "architecture/get-modular/evidence/a3-cms-pin-review.json", value => { value.after.sha256 = "0".repeat(64); });
  assert.throws(() => checkSdkGrowthProfile(directory), /SDK_CMS_PIN_DRIFT/u);
});
test("reject exported runner omitted from actual package files", t => {
  const directory = fixture(t);
  mutate(directory, "packages/apps/embedded-runtime/package.json", value => { value.files = ["dist"]; });
  assert.throws(() => checkSdkGrowthProfile(directory), /SDK_PACKAGE_FILES_DRIFT/u);
});
test("reject a package qualification that omits a public import", t => {
  const directory = fixture(t);
  mutate(directory, "architecture/sdk-growth/qualification.json", value => { value.publicImports.pop(); });
  assert.throws(() => checkSdkGrowthProfile(directory), /SDK_PUBLIC_IMPORT_QUALIFICATION_DRIFT/u);
});
test("reject a package qualification promoted to release evidence", t => {
  const directory = fixture(t);
  mutate(directory, "architecture/sdk-growth/qualification.json", value => { value.releaseEligible = true; });
  assert.throws(() => checkSdkGrowthProfile(directory), /SDK_ADMISSION_OVERCLAIM/u);
});
test("reject a packed-candidate observation promoted to release evidence", t => {
  const directory = fixture(t);
  mutate(directory, "architecture/sdk-growth/qualification.json", value => { value.historicalCandidateQualification.releaseEligible = true; });
  assert.throws(() => checkSdkGrowthProfile(directory), /SDK_ADMISSION_OVERCLAIM/u);
});
test("reject published registry identity drift", t => {
  const directory = fixture(t);
  mutate(directory, "architecture/sdk-growth/activation.json", value => { value.registry.version = "1.5.1"; });
  assert.throws(() => checkSdkGrowthProfile(directory), /SDK_REGISTRY_IDENTITY_DRIFT/u);
});
test("reject root EF pin detached from the exact registry artifact", t => {
  const directory = fixture(t);
  mutate(directory, "package.json", value => { value.devDependencies["@agent-teams/engineering-foundation"] = "1.5.1"; });
  assert.throws(() => checkSdkGrowthProfile(directory), /SDK_EF_VERSION_DRIFT/u);
});
test("reject an old archive relabeled as current", t => {
  const directory = fixture(t);
  mutate(directory, "architecture/sdk-growth/qualification.json", value => {
    value.packages[0].archiveSha256 = "bbfcbe3c7228fa4929adbf93d69f8d723fdb599af9cce3ccd4894f46582ce1c3";
  });
  assert.throws(() => checkSdkGrowthProfile(directory), /SDK_CURRENT_ARCHIVES_DRIFT/u);
});
test("reject an omitted current pack receipt", t => {
  const directory = fixture(t);
  mutate(directory, "architecture/sdk-growth/qualification.json", value => { value.packEvidence.runSha256.pop(); });
  assert.throws(() => checkSdkGrowthProfile(directory), /SDK_PACK_EVIDENCE_DRIFT/u);
});
test("reject substituted current pack receipt bytes", t => {
  const directory = fixture(t);
  const path = join(directory, "architecture/sdk-growth/evidence/ef160-pack-run-a.txt");
  writeFileSync(path, `${readFileSync(path, "utf8")}\nchanged\n`);
  assert.throws(() => checkSdkGrowthProfile(directory), /SDK_PACK_EVIDENCE_DRIFT/u);
});
test("reject historical EF 1.5.1 observation relabeled as current", t => {
  const directory = fixture(t);
  mutate(directory, "architecture/sdk-growth/qualification.json", value => { value.historicalCandidateQualification.version = "1.6.0"; });
  assert.throws(() => checkSdkGrowthProfile(directory), /SDK_EF_CANDIDATE_DRIFT/u);
});
test("reject current observation promoted without source-bound evidence", t => {
  const directory = fixture(t);
  mutate(directory, "architecture/sdk-growth/qualification.json", value => { value.successorCandidateQualification.releaseEligible = true; });
  assert.throws(() => checkSdkGrowthProfile(directory), /SDK_CURRENT_OBSERVATION_OVERCLAIM/u);
});
test("reject removal of the observed typed qualification blocker", t => {
  const directory = fixture(t);
  mutate(directory, "architecture/sdk-growth/qualification.json", value => { value.historicalCandidateQualification.typedObservationFailures = []; });
  assert.throws(() => checkSdkGrowthProfile(directory), /SDK_TYPED_FAILURE_EVIDENCE_DRIFT/u);
});
test("reject drift in the direct typed entrypoint audit", t => {
  const directory = fixture(t);
  mutate(directory, "architecture/sdk-growth/qualification.json", value => { value.historicalCandidateQualification.entrypointAudits[0].strictErrors += 1; });
  assert.throws(() => checkSdkGrowthProfile(directory), /SDK_TYPED_ENTRYPOINT_AUDIT_DRIFT/u);
});

test("reject nondeterministic rich models", t => {
  const directory = fixture(t);
  mutate(directory, "architecture/sdk-growth/qualification.json", value => { value.historicalCandidateQualification.richModelsDeterministic = false; });
  assert.throws(() => checkSdkGrowthProfile(directory), /SDK_TYPED_ENTRYPOINT_AUDIT_DRIFT/u);
});
