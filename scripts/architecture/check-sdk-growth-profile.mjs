import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { globSync, readFileSync } from "node:fs";
import { posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const directory = "architecture/sdk-growth";
const root = fileURLToPath(new URL("../../", import.meta.url));
const command = "node scripts/architecture/check-sdk-growth-profile.mjs";

export function normalizeWorkspaceManifestPaths(paths) {
  return paths.map(path => path.replaceAll("\\", "/")).toSorted();
}

function checkPackedQualification(repository, qualification, profile, json) {
  assert.equal(qualification.packagesDeterministic, true, "SDK_PACKAGE_QUALIFICATION_DRIFT");
  assert.deepEqual(qualification.packages.map(pkg => pkg.packageName).toSorted(), profile.packages.map(pkg => pkg.packageName).toSorted(), "SDK_QUALIFICATION_SCOPE_DRIFT");
  assert.deepEqual(qualification.packages.map(({ packageName, archiveSha256, members }) => [packageName, archiveSha256, members]), [
    ["@agent-teams/embedded-runtime", "0ee0aad987e973bf6ffabee775dd6150366ecb2b995262cf5e5b96021ca736b3", 356],
    ["@agent-teams/agent-execution", "0b3401fc33bfdb3f12e60ffbd72eba1e857e1ca68cd972f6ab5a2615e38c9214", 1241],
    ["@agent-teams/provider-access", "3e0675ca6ac65c11bfb44d70d770f7d254bf30eb261db0acd620616e956d6799", 241],
    ["@agent-teams/runtime-configuration", "92207cfd475dfa0bd14f35be8912c13c7a3fded336373a76e99ac36ebc0ab656", 112],
    ["@agent-teams/runtime-security", "9a02fd5b15231620ea2e0e97fde7a4c43a6ff220a80efcca756dc3aa8af47577", 352],
    ["@agent-teams/filesystem-custody", "b0a569272d49e1b89372c0700b2978ecb3d9849054595b71bc3465269dfaa4bb", 35]
  ], "SDK_CURRENT_ARCHIVES_DRIFT");
  assert.deepEqual(qualification.packEvidence, {
    status: "two-deterministic-runs",
    runSha256: ["aa565ee638760039bb3429a25c13bfdbcc7e55656343cc61e10d07e7e61a7c61", "2f282b1d16a00cda7fde860aa12a388c2669b89c2cf8a83d0b3f5d21334b1973"],
    archiveHashesMatch: true, publicImportsMatch: true
  }, "SDK_PACK_EVIDENCE_DRIFT");
  for (const pkg of qualification.packages) {
    assert.match(pkg.archiveSha256, /^[a-f0-9]{64}$/u, "SDK_PACKAGE_QUALIFICATION_DRIFT");
    assert.ok(Number.isSafeInteger(pkg.members) && pkg.members > 0, "SDK_PACKAGE_QUALIFICATION_DRIFT");
  }
  const expectedImports = profile.packages.flatMap(pkg => {
    const exports = Object.keys(json(pkg.manifestPath).exports);
    return exports.map(exportPath => `${pkg.packageName}${exportPath === "." ? "" : exportPath.slice(1)}`);
  });
  assert.deepEqual(qualification.publicImports.toSorted(), expectedImports.toSorted(), "SDK_PUBLIC_IMPORT_QUALIFICATION_DRIFT");
  for (const [index, name] of ["ef160-pack-run-a.txt", "ef160-pack-run-b.txt"].entries()) {
    const bytes = readFileSync(resolve(repository, `${directory}/evidence/${name}`));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), qualification.packEvidence.runSha256[index], "SDK_PACK_EVIDENCE_DRIFT");
    const log = bytes.toString("utf8");
    const start = log.lastIndexOf('{\n  "schemaVersion"');
    assert.ok(start >= 0, "SDK_PACK_EVIDENCE_DRIFT");
    const receipt = JSON.parse(log.slice(start));
    assert.equal(receipt.releaseEligible, false, "SDK_ADMISSION_OVERCLAIM");
    assert.deepEqual(receipt.packages.map(({ packageName, archiveSha256, members }) => ({ packageName, archiveSha256, members })), qualification.packages, "SDK_PACK_EVIDENCE_DRIFT");
    assert.deepEqual(receipt.publicImports, qualification.publicImports, "SDK_PACK_EVIDENCE_DRIFT");
  }
}

function checkRegistryIdentity(activation) {
  assert.deepEqual(activation.registry, {
    status: "published-exact", packageName: "@agent-teams/engineering-foundation", version: "1.6.0",
    tarballSha256: "842f81ca68e9c3207a0da967eb599229d4d30ea32cd69a9a1686f2eb240f54eb",
    integrity: "sha512-E6ytO+3xhZsaPTo49DRuhldQBRMFlF06EGqqERuGHrc4q11eLssTA9fsbEGCm1e4B8n/i8AsMt2ZkQklFeolWA==",
    tarballUrl: "https://registry.npmjs.org/@agent-teams/engineering-foundation/-/engineering-foundation-1.6.0.tgz",
    publishedAt: "2026-09-24T00:19:03.115Z",
    distMetadataRetained: true, publicAuthorityImport: "passed"
  }, "SDK_REGISTRY_IDENTITY_DRIFT");
}

function checkRootClassification(repository, manifest, activation, json) {
  assert.equal(manifest.name, "@vioxen/agent-runtime");
  assert.equal(manifest.private, true);
  for (const key of ["exports", "main", "types", "bin"]) {
    assert.equal(manifest[key], undefined, "SDK_ROOT_CLASSIFICATION_DRIFT");
  }
  const classificationPath = `${directory}/metadata-root.json`;
  const classification = {
    schemaVersion: "foundation:sdk-growth:metadata-root:1",
    kind: "non-release-metadata-root",
    packageName: manifest.name,
    rootPath: ".",
    manifestPath: "package.json",
    decisionId: "AR-SDK-ROOT-001",
    ownerRef: "architecture/tooling",
    releaseHistory: "none"
  };
  assert.deepEqual(json(classificationPath), classification, "SDK_ROOT_CLASSIFICATION_DRIFT");
  const canonicalBytes = JSON.stringify(Object.fromEntries(Object.keys(classification).toSorted().map(key => [key, classification[key]])));
  assert.equal(readFileSync(resolve(repository, classificationPath), "utf8"), canonicalBytes, "SDK_ROOT_CLASSIFICATION_DRIFT");
  assert.deepEqual(activation.metadataRoots, [{ packageName: manifest.name, rootPath: ".", manifestPath: "package.json", classificationPath, classification: "private-tooling-root-no-supported-sdk", releaseObligation: false }], "SDK_ROOT_CLASSIFICATION_DRIFT");
}

// This checks consumer enrollment, not SDK admission. EF owns observation,
// comparison and approval; a candidate-controlled checker cannot grant trust.
export function checkSdkGrowthProfile(repository = root) {
  const json = path => JSON.parse(readFileSync(resolve(repository, path), "utf8"));
  const profile = parse(readFileSync(resolve(repository, `${directory}/profile.yaml`), "utf8"));
  const activation = json(`${directory}/activation.json`);
  assert.equal(createHash("sha256").update(readFileSync(resolve(repository, "architecture/c0/ar-owned-lifetime/contract.json"))).digest("hex"), "4c88c378c6d54303fd4910f521480e6fe120743dfcdc618007efb1395a684c05", "SDK_C0_BASE_MUTATION");
  const frozen = json("architecture/c0/ar-owned-lifetime/contract.json");
  const manifest = json("package.json");
  const workspace = parse(readFileSync(resolve(repository, "pnpm-workspace.yaml"), "utf8"));
  const discovered = normalizeWorkspaceManifestPaths(
    globSync(workspace.packages.map(pattern => `${pattern}/package.json`), { cwd: repository })
  );
  const accepted = frozen.inventory.packages.filter(pkg => pkg.manifest !== "package.json");
  assert.deepEqual(discovered, accepted.map(pkg => pkg.manifest).toSorted(), "SDK_SCOPE_DRIFT");
  assert.deepEqual(profile.packages.map(pkg => pkg.manifestPath).toSorted(), discovered, "SDK_PROFILE_SCOPE_DRIFT");
  assert.equal(profile.schemaVersion, 2);
  assert.equal(profile.sdkGrowth.contractRevision, "foundation:sdk-growth:c0:5");
  assert.equal(profile.sdkGrowth.policyVersion, "foundation:sdk-growth:policy:1");
  assert.equal(activation.contractRevision, frozen.contractRevision);
  assert.equal(activation.status, "pending-authority-qualification");
  checkRegistryIdentity(activation);
  assert.equal(activation.authority.candidateWorkflowIsAuthority, false);
  const review = json("architecture/get-modular/evidence/sdk-growth-standard-review.json");
  const migrationReview = json("architecture/get-modular/evidence/a3-cms-pin-review.json");
  const consumerProfile = json("architecture/get-modular/consumer-profile.json");
  assert.equal(migrationReview.historicalReview,
    "architecture/get-modular/evidence/sdk-growth-standard-review.json", "SDK_CMS_REVIEW_DRIFT");
  assert.equal(review.activeCommit, migrationReview.before.commit, "SDK_CMS_REVIEW_DRIFT");
  assert.equal(review.activeSha256, migrationReview.before.sha256, "SDK_CMS_REVIEW_DRIFT");
  assert.equal(consumerProfile.standard.commit, migrationReview.after.commit, "SDK_CMS_PIN_DRIFT");
  assert.equal(consumerProfile.standard.sha256, migrationReview.after.sha256, "SDK_CMS_PIN_DRIFT");
  assert.equal(createHash("sha256").update(readFileSync(resolve(repository,
    consumerProfile.standard.evidencePath))).digest("hex"), migrationReview.after.sha256, "SDK_CMS_PIN_DRIFT");
  assert.equal(review.suppliedCurrentCommit, null, "SDK_CMS_CURRENT_IDENTITY_UNPROVEN");
  assert.equal(createHash("sha256").update(readFileSync(resolve(repository,
    review.suppliedCurrentEvidencePath))).digest("hex"), review.suppliedCurrentSha256,
  "SDK_CMS_REVIEW_DRIFT");
  for (const path of ["architecture/get-modular/consumer-profile.json", "architecture/consumer-module-standard/contained-turn-profile.json"]) {
    assert.deepEqual(json(path).sdkGrowth, { profile: `${directory}/profile.yaml`, activation: `${directory}/activation.json`, status: activation.status, compositionChange: false }, "SDK_CONSUMER_PROFILE_DRIFT");
  }
  assert.equal(activation.qualificationInput.version, "1.6.0", "SDK_EF_VERSION_DRIFT");
  assert.equal(manifest.devDependencies["@agent-teams/engineering-foundation"], activation.qualificationInput.version, "SDK_EF_VERSION_DRIFT");
  assert.equal(activation.qualificationInput.archiveSha256, activation.registry.tarballSha256, "SDK_EF_ARCHIVE_DRIFT");
  assert.equal(activation.qualificationInput.npmIntegrity, activation.registry.integrity, "SDK_EF_INTEGRITY_DRIFT");
  assert.equal(activation.qualificationInput.tarballUrl, activation.registry.tarballUrl, "SDK_EF_URL_DRIFT");
  assert.equal(activation.qualificationInput.publishedAt, activation.registry.publishedAt, "SDK_EF_PUBLICATION_DRIFT");
  assert.equal(activation.qualificationInput.sourceMergeCommit, "49402509372e3f4a96c534401636fb12ff5dbee2", "SDK_EF_SOURCE_DRIFT");
  assert.equal(activation.qualificationInput.sourceReleaseCommit, "852cd5130cad84d750788b080f0e358ac5210355", "SDK_EF_SOURCE_DRIFT");
  checkRootClassification(repository, manifest, activation, json);
  for (const pkg of profile.packages) {
    const actual = json(pkg.manifestPath);
    const prior = accepted.find(entry => entry.manifest === pkg.manifestPath);
    assert.equal(pkg.packageRoot, posix.dirname(prior.manifest), "SDK_PACKAGE_ROOT_DRIFT");
    assert.equal(pkg.packageName, prior.name, "SDK_PACKAGE_IDENTITY_DRIFT");
    assert.equal(actual.name, prior.name, "SDK_PACKAGE_IDENTITY_DRIFT");
    assert.equal(actual.private, true);
    assert.equal(actual.version, "0.0.0");
    assert.deepEqual(actual.bin ?? null, prior.bin, "SDK_BIN_CLASSIFICATION_DRIFT");
    const runnerFiles = actual.name === "@agent-teams/embedded-runtime" ? ["scripts/run-package-tests.mjs"] : [];
    assert.deepEqual(actual.files, [...prior.files, ...runnerFiles], "SDK_PACKAGE_FILES_DRIFT");
    assert.equal(JSON.stringify(actual.exports), JSON.stringify(prior.exports), "SDK_EXPORT_MATRIX_DRIFT");
    assert.deepEqual(pkg.entrypoints, [".", "./composition"].map(exportPath => ({ exportPath, declarationEntryPoint: `${pkg.packageRoot}/${actual.exports[exportPath].types.slice(2)}` })));
    assert.deepEqual(pkg.nonTypeExports, actual.name === "@agent-teams/embedded-runtime" ? [{ exportPath: "./scripts/run-package-tests.mjs", kind: "runtime" }] : []);
    assert.equal(pkg.tsconfigPath, `${pkg.packageRoot}/tsconfig.json`);
  }
  assert.deepEqual(activation.packageQualification, { status: "passed-membership-and-imports", evidencePath: `${directory}/qualification.json`, cleanRegistryInstall: true }, "SDK_PACKAGE_QUALIFICATION_DRIFT");
  assert.deepEqual(activation.sdkAdmission, { status: "blocked-current-typed-observation", releaseEligible: false }, "SDK_ADMISSION_OVERCLAIM");
  const qualification = json(activation.packageQualification.evidencePath);
  assert.equal(qualification.historicalSourceCheckpoint, "5a9eb460400f968a7683c75f5f43a8329cad1196", "SDK_QUALIFICATION_BASE_DRIFT");
  assert.equal(qualification.qualification, "package-membership-and-public-imports", "SDK_PACKAGE_QUALIFICATION_DRIFT");
  assert.equal(qualification.releaseEligible, false, "SDK_ADMISSION_OVERCLAIM");
  assert.equal(qualification.efCandidateSha256, activation.qualificationInput.archiveSha256, "SDK_EF_CANDIDATE_DRIFT");
  checkPackedQualification(repository, qualification, profile, json);
  const current = qualification.successorCandidateQualification;
  assert.deepEqual(current, {
    status: "pending-current-typed-observation", version: activation.qualificationInput.version,
    sourceBase: "e88f879e8e9cdedbb5954932399b5207033cd0e9",
    typedObservationStatus: "not-captured", strictExtractionStatus: "not-captured",
    authorityStatus: "not-invoked-current-typed-observation-pending", releaseEligible: false
  }, "SDK_CURRENT_OBSERVATION_OVERCLAIM");
  assert.equal(activation.sdkAdmission.status, "blocked-current-typed-observation", "SDK_ADMISSION_OVERCLAIM");
  assert.equal(activation.sdkAdmission.releaseEligible, false, "SDK_ADMISSION_OVERCLAIM");
  assert.equal(activation.authority.status, current.authorityStatus, "SDK_ADMISSION_OVERCLAIM");
  assert.equal(qualification.efCandidateSha256, activation.registry.tarballSha256, "SDK_EF_ARCHIVE_DRIFT");
  const candidate = qualification.historicalCandidateQualification;
  assert.equal(candidate.status, "qualified-rich-observation-strict-extraction-blocked", "SDK_EF_CANDIDATE_OBSERVATION_MISSING");
  assert.equal(candidate.version, "1.5.1", "SDK_EF_CANDIDATE_DRIFT");
  for (const value of [candidate.toolArtifactDigest, candidate.topologyDigest, candidate.lockDigest, candidate.toolchainDigest, candidate.surfaceDigest, ...candidate.artifactDigests]) {
    assert.match(value, /^sha256:[a-f0-9]{64}$/u, "SDK_EF_CANDIDATE_REPORT_DRIFT");
  }
  assert.deepEqual(candidate.observedPackages.toSorted(), [...profile.packages.map(pkg => pkg.packageName), ...activation.metadataRoots.map(entry => entry.packageName)].toSorted(), "SDK_QUALIFICATION_SCOPE_DRIFT");
  assert.equal(candidate.verdict, "incomplete", "SDK_ADMISSION_OVERCLAIM");
  assert.equal(candidate.releaseEligible, false, "SDK_ADMISSION_OVERCLAIM");
  assert.equal(candidate.authorityStatus, "not-invoked-strict-extraction-blocked", "SDK_ADMISSION_OVERCLAIM");
  assert.equal(candidate.problemCode, "SDK_GROWTH_EVIDENCE_INCOMPLETE", "SDK_EF_CANDIDATE_OBSERVATION_MISSING");
  assert.equal(candidate.richEntrypointAuditArtifactSha256, "5d33a306870b7df7cd009f72991b001d7f3ce00b45497e9ccf339d5a28f20030", "SDK_TYPED_ENTRYPOINT_AUDIT_DRIFT");
  assert.equal(candidate.richEntrypointAuditExtractorVersion, "7.58.12", "SDK_TYPED_ENTRYPOINT_AUDIT_DRIFT");
  assert.equal(candidate.richEntrypointAuditTypeScriptVersion, "5.9.3", "SDK_TYPED_ENTRYPOINT_AUDIT_DRIFT");
  assert.equal(candidate.richModelsDeterministic, true, "SDK_TYPED_ENTRYPOINT_AUDIT_DRIFT");
  assert.equal(candidate.richOnlyForgottenExportErrors, true, "SDK_TYPED_ENTRYPOINT_AUDIT_DRIFT");
  assert.deepEqual(candidate.typedObservationFailures.map(row => row.packages.length), [5], "SDK_TYPED_FAILURE_EVIDENCE_DRIFT");
  assert.deepEqual(candidate.entrypointAudits.map(row => [row.packageName, row.exportPath, row.strictErrors, row.richErrors]).toSorted(), [
    ["@agent-teams/agent-execution", ".", 0, 0],
    ["@agent-teams/agent-execution", "./composition", 311, 686],
    ["@agent-teams/embedded-runtime", ".", 0, 0],
    ["@agent-teams/embedded-runtime", "./composition", 31, 93],
    ["@agent-teams/filesystem-custody", ".", 0, 0],
    ["@agent-teams/filesystem-custody", "./composition", 0, 0],
    ["@agent-teams/provider-access", ".", 0, 0],
    ["@agent-teams/provider-access", "./composition", 37, 92],
    ["@agent-teams/runtime-configuration", ".", 0, 0],
    ["@agent-teams/runtime-configuration", "./composition", 13, 52],
    ["@agent-teams/runtime-security", ".", 0, 0],
    ["@agent-teams/runtime-security", "./composition", 54, 94],
  ], "SDK_TYPED_ENTRYPOINT_AUDIT_DRIFT");
  assert.equal(candidate.entrypointAudits.reduce((total, row) => total + row.strictErrors, 0), 446, "SDK_TYPED_ENTRYPOINT_AUDIT_DRIFT");
  assert.ok(candidate.entrypointAudits.filter(row => row.exportPath === ".").every(row => row.strictErrors === 0), "SDK_TYPED_ENTRYPOINT_AUDIT_DRIFT");
  for (const row of candidate.entrypointAudits) {
    assert.match(row.modelSha256, /^[a-f0-9]{64}$/u, "SDK_TYPED_ENTRYPOINT_AUDIT_DRIFT");
  }
  assert.deepEqual(qualification.registryQualification, {
    packageName: activation.registry.packageName, version: activation.registry.version,
    tarballUrl: activation.registry.tarballUrl, publishedAt: activation.registry.publishedAt,
    tarballSha256: activation.registry.tarballSha256, npmIntegrity: activation.registry.integrity,
    sourceMergeCommit: activation.qualificationInput.sourceMergeCommit,
    sourceReleaseCommit: activation.qualificationInput.sourceReleaseCommit,
    distMetadataMatched: true, publicAuthorityImport: "passed",
    networkRegistryInstall: "passed-fresh-sandbox", retainedRegistryArtifactInstall: "passed"
  }, "SDK_REGISTRY_QUALIFICATION_DRIFT");
  assert.deepEqual(profile.sdkGrowth.comparison.released.map(entry => [entry.packageName, entry.kind]).toSorted(), profile.packages.map(pkg => [pkg.packageName, "initial-unreleased"]).toSorted());
  assert.equal(manifest.scripts["sdk-growth:profile"], command, "SDK_ENFORCEMENT_MISSING_OR_NOOP");
  assert.equal(manifest.scripts["test:sdk-growth:profile"], "node --test scripts/architecture/check-sdk-growth-profile.test.mjs", "SDK_ENFORCEMENT_MISSING_OR_NOOP");
  assert.equal(manifest.scripts["test:sdk-growth:packed"], "node --test scripts/architecture/qualify-sdk-packages.test.mjs", "SDK_ENFORCEMENT_MISSING_OR_NOOP");
  for (const name of ["check", "check:fast"]) {
    const chain = manifest.scripts[name].split(/\s*&&\s*/u);
    for (const step of ["pnpm sdk-growth:profile", "pnpm test:sdk-growth:profile", "pnpm test:sdk-growth:packed"]) {
      assert.ok(chain.includes(step), "SDK_ENFORCEMENT_MISSING_OR_NOOP");
    }
  }
  return { status: activation.status, packages: profile.packages.length, metadataRoots: 1, releaseEligible: false };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(checkSdkGrowthProfile()));
}
