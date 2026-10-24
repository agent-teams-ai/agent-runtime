import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { globSync, readFileSync } from "node:fs";
// import { posix } from "node:path";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { routedScripts } from '../ci/script-routing.ts';
// Disabled with the hardcoded CMS pin chain by owner decision 2026-10-02 (AR-0).
// import { standardReviewPath, standardDeltaPath, validateStandardMigration } from "./consumer-module-standard-pin.mjs";

const directory = "architecture/sdk-growth";
const root = fileURLToPath(new URL("../../", import.meta.url));
const command = "node scripts/architecture/check-sdk-growth-profile.mjs";
const providerPackage = "@agent-teams/provider-implementations";
const providerRoot = "packages/platform/provider-implementations";
const providerExports = [".", "./composition", "./claude", "./codex", "./opencode", "./session-io"];

function checkProviderQualification(repository, profile, json) {
  const extraction = json(`${directory}/provider-session-contracts-extraction.json`);
  const capabilities = json(`${directory}/provider-claude-capabilities.json`);
  const attachments = json(`${directory}/provider-attachments.json`);
  const predecessor = json(`${directory}/provider-codex-mcp-readiness.json`);
  const current = json(`${directory}/provider-migration-program.json`);
  assert.equal(createHash("sha256").update(readFileSync(resolve(repository, `${directory}/provider-codex-mcp-readiness.json`))).digest("hex"), current.predecessorSha256, "SDK_PROVIDER_SOURCE_DRIFT");
  assert.equal(current.qualification, "provider-migration-controlled-source-and-static-public-imports", "SDK_PROVIDER_QUALIFICATION_DRIFT");
  assert.equal(current.authority, "ADR-0093", "SDK_CONTRACT_EXTRACTION_DRIFT");
  assert.equal(predecessor.authority, "ADR-0093", "SDK_CONTRACT_EXTRACTION_DRIFT");
  assert.equal(predecessor.releaseEligible, false, "SDK_PROVIDER_ADMISSION_OVERCLAIM");
  assert.equal(current.releaseEligible, false, "SDK_PROVIDER_ADMISSION_OVERCLAIM");
  assert.equal(createHash("sha256").update(readFileSync(resolve(repository, `${directory}/provider-claude-capabilities.json`))).digest("hex"), attachments.predecessorSha256, "SDK_PROVIDER_SOURCE_DRIFT");
  assert.equal(createHash("sha256").update(readFileSync(resolve(repository, `${directory}/provider-session-contracts-extraction.json`))).digest("hex"), capabilities.predecessorSha256, "SDK_PROVIDER_SOURCE_DRIFT");
  assert.equal(createHash("sha256").update(readFileSync(resolve(repository, `${directory}/provider-attachments.json`))).digest("hex"), predecessor.predecessorSha256, "SDK_PROVIDER_SOURCE_DRIFT");
  const contractName = "@agent-teams/provider-session-contracts";
  const contractRoot = "packages/platform/provider-session-contracts";
  assert.equal(extraction.authority, "ADR-0093", "SDK_CONTRACT_EXTRACTION_DRIFT");
  assert.equal(extraction.releaseEligible, false, "SDK_PROVIDER_ADMISSION_OVERCLAIM");
  const contracts = profile.packages.filter(pkg => pkg.packageName === contractName);
  assert.equal(contracts.length, 1, "SDK_CONTRACT_SCOPE_DRIFT");
  assert.equal(contracts[0].packageRoot, contractRoot, "SDK_CONTRACT_SCOPE_DRIFT");
  assert.deepEqual(contracts[0].entrypoints, [{exportPath: ".", declarationEntryPoint: `${contractRoot}/dist/index.d.ts`}], "SDK_CONTRACT_SCOPE_DRIFT");
  const contractManifest = json(`${contractRoot}/package.json`);
  assert.equal(contractManifest.dependencies, undefined, "SDK_CONTRACT_CLOSURE_DRIFT");
  assert.equal(contractManifest.peerDependencies, undefined, "SDK_CONTRACT_CLOSURE_DRIFT");
  assert.deepEqual(Object.keys(contractManifest.exports), ["."], "SDK_CONTRACT_SCOPE_DRIFT");
  const currentPaths = [providerRoot, contractRoot].flatMap(packageRoot => [
    ...globSync([`${packageRoot}/src/**/*.ts`, `${packageRoot}/tests/**/*.ts`, `${packageRoot}/scripts/**/*.ts`], {cwd: repository}),
    `${packageRoot}/package.json`, `${packageRoot}/tsconfig.json`, `${packageRoot}/tsconfig.test.json`,
  ]).concat(["packages/contexts/agent-execution/package.json",
    "packages/contexts/agent-execution/src/interactive-contracts.ts",
    "packages/contexts/agent-execution/src/features/interactive-agent-session/application/ports/outbound/interactive-provider-driver.ts",
    "packages/contexts/agent-execution/tests/package/interactive-contracts-packed-consumer.test.ts",
    "packages/contexts/agent-execution/src/features/interactive-agent-session/application/ports/outbound/interactive-session-ports.ts",
    "packages/contexts/agent-execution/src/features/interactive-agent-session/contracts/interactive-session.ts",
    "packages/contexts/agent-execution/src/features/interactive-agent-session/domain/session.ts",
    "packages/apps/embedded-runtime/src/features/interactive-session-runtime/contracts/interactive-session-host.ts",
    "packages/apps/embedded-runtime/src/features/interactive-session-runtime/domain/session-host.ts",
    "packages/apps/embedded-runtime/src/features/interactive-session-runtime/composition/interactive-session-runtime.contracts.ts",
    "packages/contexts/agent-execution/tests/features/interactive-agent-session/owner.test.ts"]);
  assert.deepEqual(current.currentInputs.map(input => input.path).toSorted(), currentPaths.toSorted(), "SDK_PROVIDER_SOURCE_DRIFT");
  for (const input of [...current.currentInputs, ...current.evidence, ...predecessor.evidence, ...attachments.evidence, ...capabilities.evidence, ...extraction.evidence]) {
    assert.match(input.sha256, /^[a-f0-9]{64}$/u, "SDK_PROVIDER_SOURCE_DRIFT");
    assert.equal(createHash("sha256").update(readFileSync(resolve(repository, input.path))).digest("hex"), input.sha256, "SDK_PROVIDER_SOURCE_DRIFT");
  }
  assert.deepEqual(extraction.checks, {contractsPacked: true, providerPacked: true, legacyTypeCompatibility: true}, "SDK_CONTRACT_EXTRACTION_DRIFT");
  assert.deepEqual(capabilities.checks, {contractsPacked: true, providerPacked: true, legacyTypeCompatibility: true, claudeSyntheticCapabilities: true}, "SDK_CONTRACT_EXTRACTION_DRIFT");
  assert.deepEqual(attachments.checks, {contractsPacked: true, providerPacked: true, legacyTypeCompatibility: true, attachmentRequestSeams: true}, "SDK_CONTRACT_EXTRACTION_DRIFT");

  assert.deepEqual(predecessor.checks, {providerPacked: true, defaultCheckpointCompatibility: true, codexNativeMcpRequestSeams: true}, "SDK_CONTRACT_EXTRACTION_DRIFT");

  const entry = profile.packages.filter(pkg => pkg.packageName === providerPackage);
  assert.equal(entry.length, 1, "SDK_PROVIDER_SCOPE_DRIFT");
  assert.equal(entry[0].packageRoot, providerRoot, "SDK_PROVIDER_SCOPE_DRIFT");
  assert.equal(entry[0].manifestPath, `${providerRoot}/package.json`, "SDK_PROVIDER_SCOPE_DRIFT");
  assert.deepEqual(entry[0].entrypoints.map(item => item.exportPath), providerExports, "SDK_PROVIDER_SCOPE_DRIFT");
  const manifest = json(`${providerRoot}/package.json`);
  assert.equal(manifest.name, providerPackage, "SDK_PROVIDER_SCOPE_DRIFT");
  assert.equal(manifest.private, true, "SDK_PROVIDER_ADMISSION_OVERCLAIM");
  assert.equal(manifest.version, "0.0.0", "SDK_PROVIDER_ADMISSION_OVERCLAIM");
  assert.equal(manifest.peerDependencies, undefined, "SDK_PROVIDER_SPI_DRIFT");
  assert.equal(manifest.dependencies[contractName], "workspace:*", "SDK_PROVIDER_SPI_DRIFT");
  assert.deepEqual(Object.keys(manifest.exports), providerExports, "SDK_PROVIDER_PUBLIC_IMPORT_DRIFT");
  for (const [index, exportPath] of providerExports.entries()) {
    const stem = exportPath === "." ? "index" : exportPath.slice(2);
    assert.deepEqual(manifest.exports[exportPath], { types: `./dist/${stem}.d.ts`, import: `./dist/${stem}.js` }, "SDK_PROVIDER_PUBLIC_IMPORT_DRIFT");
    assert.equal(entry[0].entrypoints[index].declarationEntryPoint, `${providerRoot}/dist/${stem}.d.ts`, "SDK_PROVIDER_SCOPE_DRIFT");
  }
  // This successor records controlled source tests and inert packed imports only.
  // Historical native qualification and blocked authority admission are unchanged.
  assert.deepEqual(current.engines.map(engine => engine.node), ["v24.21.0", "v26.11.1"], "SDK_PROVIDER_QUALIFICATION_DRIFT");
  const controlledTests = globSync(`${providerRoot}/tests/features/**/*.test.ts`, {cwd: repository}).toSorted();
  const expectedImports = profile.packages.flatMap(pkg => Object.keys(json(pkg.manifestPath).exports)
    .map(path => pkg.packageName + (path === "." ? "" : path.slice(1)))).toSorted();
  const receipts = [];
  for (const engine of current.engines) {
    for (const [kind, tests] of [["provider", 318], ["owner", 26], ["packed", null]]) {
      const proof = engine[kind];
      for (const path of [proof.log, proof.invocation, proof.completion, ...(kind === "packed" ? [proof.receipt] : [])]) {
        assert.ok(current.evidence.some(input => input.path === path), "SDK_PROVIDER_QUALIFICATION_DRIFT");
      }
      const completion = json(proof.completion);
      assert.equal(completion.job.id, proof.jobId, "SDK_PROVIDER_QUALIFICATION_DRIFT");
      assert.equal(completion.job.status, "exited", "SDK_PROVIDER_QUALIFICATION_DRIFT");
      assert.equal(completion.result.exit_code, 0, "SDK_PROVIDER_QUALIFICATION_DRIFT");
      assert.equal(completion.result.signal, null, "SDK_PROVIDER_QUALIFICATION_DRIFT");
      assert.equal(completion.logs_drained, true, "SDK_PROVIDER_QUALIFICATION_DRIFT");
      const invocation = json(proof.invocation);
      assert.equal(invocation.job.id, proof.jobId, "SDK_PROVIDER_QUALIFICATION_DRIFT");
      const args = invocation.command;
      assert.ok(engine.execPath.startsWith("/") && args.includes(engine.execPath), "SDK_PROVIDER_QUALIFICATION_DRIFT");
      assert.match(engine.executableSha256, /^[a-f0-9]{64}$/u, "SDK_PROVIDER_QUALIFICATION_DRIFT");
      if (tests !== null) {
        assert.equal(proof.tests, tests, "SDK_PROVIDER_QUALIFICATION_DRIFT");
        const log = readFileSync(resolve(repository, proof.log), "utf8");
        for (const [name, count] of [["tests", tests], ["pass", tests], ["fail", 0], ["cancelled", 0], ["skipped", 0], ["todo", 0]]) {
          assert.match(log, new RegExp(`(?:^|\\n)ℹ ${name} ${count}(?:\\n|$)`, "u"), "SDK_PROVIDER_QUALIFICATION_DRIFT");
        }
        assert.ok(args.includes("--test-concurrency=1") && args.includes("--test-timeout=60000"), "SDK_PROVIDER_QUALIFICATION_DRIFT");
        const paths = args.filter(arg => arg.endsWith(".test.ts"));
        assert.deepEqual(paths.map(path => `${kind === "provider" ? providerRoot : "packages/contexts/agent-execution"}/${path}`).toSorted(),
          kind === "provider" ? controlledTests : ["packages/contexts/agent-execution/tests/features/interactive-agent-session/owner.test.ts"], "SDK_PROVIDER_QUALIFICATION_DRIFT");
      } else {
        assert.equal(args.at(-1), "scripts/architecture/qualify-sdk-packages.mjs", "SDK_PROVIDER_QUALIFICATION_DRIFT");
        const receipt = json(proof.receipt);
        assert.equal(receipt.node, engine.node, "SDK_PROVIDER_QUALIFICATION_DRIFT");
        assert.equal(receipt.qualification, "package-membership-and-public-imports", "SDK_PROVIDER_QUALIFICATION_DRIFT");
        assert.equal(receipt.releaseEligible, false, "SDK_PROVIDER_ADMISSION_OVERCLAIM");
        assert.deepEqual(receipt.packages.map(pkg => pkg.packageName).toSorted(), profile.packages.map(pkg => pkg.packageName).toSorted(), "SDK_PROVIDER_QUALIFICATION_DRIFT");
        assert.deepEqual(receipt.publicImports.toSorted(), expectedImports, "SDK_PROVIDER_PUBLIC_IMPORT_DRIFT");
        for (const pkg of receipt.packages) {
          assert.match(pkg.archiveSha256, /^[a-f0-9]{64}$/u, "SDK_PROVIDER_QUALIFICATION_DRIFT");
          assert.ok(Number.isSafeInteger(pkg.members) && pkg.members > 0, "SDK_PROVIDER_QUALIFICATION_DRIFT");
        }
        receipts.push(receipt.packages.map(({packageName, archiveSha256, members}) => ({packageName, archiveSha256, members})));
      }
    }
  }
  assert.deepEqual(receipts[0], receipts[1], "SDK_PROVIDER_QUALIFICATION_DRIFT");

  const proof = json(`${directory}/provider-implementations-public-imports.json`);
  assert.equal(proof.qualification, "workspace-provider-package-and-public-imports", "SDK_PROVIDER_QUALIFICATION_DRIFT");
  assert.equal(proof.authority, "ADR-0092", "SDK_PROVIDER_QUALIFICATION_DRIFT");
  assert.equal(proof.sourceRevision, "bc644a5045219bd635d6ea7b3467b9f297033cdf", "SDK_PROVIDER_QUALIFICATION_DRIFT");
  assert.equal(proof.sdkAdmission, "unchanged-blocked-current-typed-observation", "SDK_PROVIDER_ADMISSION_OVERCLAIM");
  assert.equal(proof.releaseEligible, false, "SDK_PROVIDER_ADMISSION_OVERCLAIM");
  assert.deepEqual(proof.publicImports, providerExports.map(path => providerPackage + (path === "." ? "" : path.slice(1))), "SDK_PROVIDER_PUBLIC_IMPORT_DRIFT");
  assert.deepEqual(proof.engines.map(engine => [engine.node, engine.passed]), [["v24.21.0", true], ["v26.11.1", true]], "SDK_PROVIDER_QUALIFICATION_DRIFT");
  for (const engine of proof.engines) {
    assert.equal(engine.tests, 137, "SDK_PROVIDER_QUALIFICATION_DRIFT");
    assert.match(engine.archiveSha256, /^[a-f0-9]{64}$/u, "SDK_PROVIDER_QUALIFICATION_DRIFT");
    assert.match(engine.archiveIntegrity, /^sha512-[A-Za-z0-9+/]{86}==$/u, "SDK_PROVIDER_QUALIFICATION_DRIFT");
  }
  assert.deepEqual(proof.sdkProcess, { node: "v24.21.0", tests: 24, passed: true,
    authentication: "synthetic-localhost-only", publicImport: `${providerPackage}/claude` }, "SDK_PROVIDER_QUALIFICATION_DRIFT");
  const sourcePaths = globSync([`${providerRoot}/src/**/*.ts`, `${providerRoot}/tests/**/*.ts`, `${providerRoot}/scripts/**/*.ts`], { cwd: repository });
  sourcePaths.push(`${providerRoot}/package.json`, `${providerRoot}/tsconfig.json`, `${providerRoot}/tsconfig.test.json`);
  assert.ok(proof.sourceInputs.every(input => sourcePaths.includes(input.path)), "SDK_PROVIDER_SOURCE_DRIFT");
  assert.ok(proof.sourceInputs.length > 0 && new Set(proof.sourceInputs.map(item => item.path)).size === proof.sourceInputs.length, "SDK_PROVIDER_SOURCE_DRIFT");
  assert.equal(createHash("sha256").update(readFileSync(resolve(repository, `${directory}/provider-implementations-public-imports.json`))).digest("hex"), extraction.predecessorSha256, "SDK_PROVIDER_SOURCE_DRIFT");
  // Historical source digests remain frozen; the scoped ADR-0093 successor above binds current inputs.
  for (const input of [{ path: proof.evidencePath, sha256: proof.evidenceSha256 }]) {
    assert.ok(input.path.startsWith(`${providerRoot}/`) || input.path === `${directory}/evidence/provider-implementations-public-imports.txt`, "SDK_PROVIDER_SOURCE_DRIFT");
    assert.match(input.sha256, /^[a-f0-9]{64}$/u, "SDK_PROVIDER_SOURCE_DRIFT");
    assert.equal(createHash("sha256").update(readFileSync(resolve(repository, input.path))).digest("hex"), input.sha256, "SDK_PROVIDER_SOURCE_DRIFT");
  }
  return profile.packages.filter(pkg => pkg.packageName !== providerPackage && pkg.packageName !== contractName);
}

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
  // ADR-0091 qualifies one new erased SPI import independently. The EF 1.6.0
  // archives, public imports and authority status below remain historical.
  const successorPath = `${directory}/interactive-contracts-public-import.json`;
  const successorBytes = readFileSync(resolve(repository, successorPath));
  assert.equal(createHash("sha256").update(successorBytes).digest("hex"), "27898ef1bf9a30897a56dd8cf41235bc812e4344c7ee8f7573bd2eea508fd948", "SDK_SCOPED_IMPORT_PROOF_DRIFT");
  const successor = json(successorPath);
  assert.equal(successor.publicImport, "@agent-teams/agent-execution/interactive-contracts", "SDK_SCOPED_IMPORT_PROOF_DRIFT");
  assert.ok(!qualification.publicImports.includes(successor.publicImport), "SDK_SCOPED_IMPORT_COVERAGE_OVERLAP");
  assert.deepEqual([...qualification.publicImports, successor.publicImport].toSorted(), expectedImports.toSorted(), "SDK_PUBLIC_IMPORT_QUALIFICATION_DRIFT");
  for (const [path, expected] of [
    [successor.evidencePath, successor.evidenceSha256],
  ]) {
    assert.equal(createHash("sha256").update(readFileSync(resolve(repository, path))).digest("hex"), expected, "SDK_SCOPED_IMPORT_PROOF_DRIFT");
  }
  const revalidationPath = `${directory}/interactive-contracts-pg-error-custody-revalidation.json`;
  const revalidationBytes = readFileSync(resolve(repository, revalidationPath));
  assert.equal(createHash("sha256").update(revalidationBytes).digest("hex"), "2e9f31cfd1b71685b0580893c8d073a58874e134ae2ed7341cb8abe4c2e60745", "SDK_SCOPED_IMPORT_REVALIDATION_DRIFT");
  const revalidation = json(revalidationPath);
  assert.equal(revalidation.predecessor.path, successorPath, "SDK_SCOPED_IMPORT_REVALIDATION_DRIFT");
  assert.equal(revalidation.predecessor.sha256, createHash("sha256").update(successorBytes).digest("hex"), "SDK_SCOPED_IMPORT_REVALIDATION_DRIFT");
  assert.equal(revalidation.publicImport, successor.publicImport, "SDK_SCOPED_IMPORT_REVALIDATION_DRIFT");
  for (const [path, expected] of [
    [revalidation.evidencePath, revalidation.evidenceSha256],
  ]) {
    assert.equal(createHash("sha256").update(readFileSync(resolve(repository, path))).digest("hex"), expected, "SDK_SCOPED_IMPORT_REVALIDATION_DRIFT");
  }
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
  // ADR-0092 adds one separately qualified package; the six EF receipts stay immutable.
  const historicalPackages = checkProviderQualification(repository, profile, json);
  assert.equal(createHash("sha256").update(readFileSync(resolve(repository, "architecture/c0/ar-owned-lifetime/contract.json"))).digest("hex"), "4c88c378c6d54303fd4910f521480e6fe120743dfcdc618007efb1395a684c05", "SDK_C0_BASE_MUTATION");
  const frozen = json("architecture/c0/ar-owned-lifetime/contract.json");
  const manifest = json("package.json");
  const lock = parse(readFileSync(resolve(repository, "pnpm-lock.yaml"), "utf8"));
  const identity = json("architecture/c0/ar-owned-lifetime/identity.json");
  assert.equal(identity.artifact, "architecture/c0/ar-owned-lifetime/contract.json", "SDK_C0_IDENTITY_DRIFT");
  assert.equal(identity.sha256, createHash("sha256").update(readFileSync(resolve(repository, identity.artifact))).digest("hex"), "SDK_C0_IDENTITY_DRIFT");
  assert.equal(identity.contractRevision, frozen.contractRevision, "SDK_C0_IDENTITY_DRIFT");
  // Disabled by owner decision 2026-10-02 (AR-S): the inventory and export freeze blocks package growth such as
  // new workspace packages. A new public import such as ./testing on the six qualified packages still requires
  // requalification (SDK_PUBLIC_IMPORT_QUALIFICATION_DRIFT stays enabled). Restore only together with the
  // generated SDK surface report that replaces it (SDK-growth rework lane).
  // const workspace = parse(readFileSync(resolve(repository, "pnpm-workspace.yaml"), "utf8"));
  // const discovered = normalizeWorkspaceManifestPaths(
  //   globSync(workspace.packages.map(pattern => `${pattern}/package.json`), { cwd: repository })
  // );
  // const accepted = frozen.inventory.packages.filter(pkg => pkg.manifest !== "package.json");
  // assert.deepEqual(discovered, accepted.map(pkg => pkg.manifest).toSorted(), "SDK_SCOPE_DRIFT");
  // assert.deepEqual(profile.packages.map(pkg => pkg.manifestPath).toSorted(), discovered, "SDK_PROFILE_SCOPE_DRIFT");
  assert.equal(profile.schemaVersion, 2);
  assert.equal(profile.sdkGrowth.contractRevision, "foundation:sdk-growth:c0:5");
  assert.equal(profile.sdkGrowth.policyVersion, "foundation:sdk-growth:policy:1");
  assert.equal(activation.contractRevision, frozen.contractRevision);
  assert.equal(activation.status, "pending-authority-qualification");
  checkRegistryIdentity(activation);
  assert.equal(activation.authority.candidateWorkflowIsAuthority, false);
  const review = json("architecture/get-modular/evidence/sdk-growth-standard-review.json");
  // AR-0 (owner decision 2026-10-02): the historical A3 to current CMS pin chain
  // below is disabled because every pin step had to rewrite it. The current step
  // is verified by check-cms-pin.mjs through `pnpm architecture:consumer-modules`.
  // Restore it only if the whole pin history must be proved again.
  // const migrationReview = json("architecture/get-modular/evidence/a3-cms-pin-review.json");
  // const consumerProfile = json("architecture/get-modular/consumer-profile.json");
  // assert.equal(migrationReview.historicalReview,
  //   "architecture/get-modular/evidence/sdk-growth-standard-review.json", "SDK_CMS_REVIEW_DRIFT");
  // assert.equal(review.activeCommit, migrationReview.before.commit, "SDK_CMS_REVIEW_DRIFT");
  // assert.equal(review.activeSha256, migrationReview.before.sha256, "SDK_CMS_REVIEW_DRIFT");
  // const currentMigrationReview = json(standardReviewPath);
  // validateStandardMigration(currentMigrationReview,
  //   readFileSync(resolve(repository, standardDeltaPath)));
  // assert.equal(currentMigrationReview.historicalReview,
  //   "architecture/get-modular/evidence/a3-cms-pin-review.json", "SDK_CMS_REVIEW_DRIFT");
  // assert.equal(currentMigrationReview.before.commit, migrationReview.after.commit, "SDK_CMS_REVIEW_DRIFT");
  // assert.equal(currentMigrationReview.before.sha256, migrationReview.after.sha256, "SDK_CMS_REVIEW_DRIFT");
  // assert.equal(consumerProfile.standard.commit, currentMigrationReview.after.commit, "SDK_CMS_PIN_DRIFT");
  // assert.equal(consumerProfile.standard.sha256, currentMigrationReview.after.sha256, "SDK_CMS_PIN_DRIFT");
  // assert.equal(createHash("sha256").update(readFileSync(resolve(repository,
  //   consumerProfile.standard.evidencePath))).digest("hex"), currentMigrationReview.after.sha256, "SDK_CMS_PIN_DRIFT");
  assert.equal(review.suppliedCurrentCommit, null, "SDK_CMS_CURRENT_IDENTITY_UNPROVEN");
  assert.equal(createHash("sha256").update(readFileSync(resolve(repository,
    review.suppliedCurrentEvidencePath))).digest("hex"), review.suppliedCurrentSha256,
  "SDK_CMS_REVIEW_DRIFT");
  for (const path of ["architecture/get-modular/consumer-profile.json", "architecture/consumer-module-standard/contained-turn-profile.json"]) {
    assert.deepEqual(json(path).sdkGrowth, { profile: `${directory}/profile.yaml`, activation: `${directory}/activation.json`, status: activation.status, compositionChange: false }, "SDK_CONSUMER_PROFILE_DRIFT");
  }
  assert.equal(activation.qualificationInput.version, "1.6.0", "SDK_EF_VERSION_DRIFT");
  // Retained qualificationInput/registry receipts authenticate EF 1.6.0 only.
  // A tooling upgrade does not qualify the new SDK surface or grant authority.
  assert.deepEqual(activation.installedTooling, {
    version: "1.7.2",
    npmIntegrity: "sha512-2wmq4g8rWgXQ2qBVY2Tb7HVP9LFsuBAUMcDhgCqixLA0RA9H3OrwXy7b7jK2gS6SggK9XCplNb03mVLR2EyzRg==",
    sourceBase: "a196056fddb01936f16d0d21211e296fc4e06d56",
    typedObservationStatus: "not-captured", strictExtractionStatus: "not-captured",
    authorityStatus: "not-invoked-current-typed-observation-pending", releaseEligible: false
  }, "SDK_INSTALLED_TOOLING_DRIFT");
  assert.equal(manifest.devDependencies["@agent-teams/engineering-foundation"], activation.installedTooling.version, "SDK_EF_VERSION_DRIFT");
  const selected = lock.importers["."].devDependencies;
  const foundation = selected["@agent-teams/engineering-foundation"];
  assert.equal(foundation.specifier, activation.installedTooling.version, "SDK_EF_LOCK_DRIFT");
  assert.equal(foundation.version, `${activation.installedTooling.version}(@types/node@${selected["@types/node"].version})`, "SDK_EF_LOCK_DRIFT");
  assert.equal(lock.packages[`@agent-teams/engineering-foundation@${activation.installedTooling.version}`].resolution.integrity, activation.installedTooling.npmIntegrity, "SDK_EF_LOCK_DRIFT");
  assert.equal(activation.qualificationInput.archiveSha256, activation.registry.tarballSha256, "SDK_EF_ARCHIVE_DRIFT");
  assert.equal(activation.qualificationInput.npmIntegrity, activation.registry.integrity, "SDK_EF_INTEGRITY_DRIFT");
  assert.equal(activation.qualificationInput.tarballUrl, activation.registry.tarballUrl, "SDK_EF_URL_DRIFT");
  assert.equal(activation.qualificationInput.publishedAt, activation.registry.publishedAt, "SDK_EF_PUBLICATION_DRIFT");
  assert.equal(activation.qualificationInput.sourceMergeCommit, "49402509372e3f4a96c534401636fb12ff5dbee2", "SDK_EF_SOURCE_DRIFT");
  assert.equal(activation.qualificationInput.sourceReleaseCommit, "852cd5130cad84d750788b080f0e358ac5210355", "SDK_EF_SOURCE_DRIFT");
  checkRootClassification(repository, manifest, activation, json);
  // Disabled by owner decision 2026-10-02 (AR-S): the inventory and export freeze blocks package growth such as
  // new workspace packages. A new public import such as ./testing on the six qualified packages still requires
  // requalification (SDK_PUBLIC_IMPORT_QUALIFICATION_DRIFT stays enabled). Restore only together with the
  // generated SDK surface report that replaces it (SDK-growth rework lane).
  // for (const pkg of profile.packages) {
  //   const actual = json(pkg.manifestPath);
  //   const prior = accepted.find(entry => entry.manifest === pkg.manifestPath);
  //   assert.equal(pkg.packageRoot, posix.dirname(prior.manifest), "SDK_PACKAGE_ROOT_DRIFT");
  //   assert.equal(pkg.packageName, prior.name, "SDK_PACKAGE_IDENTITY_DRIFT");
  //   assert.equal(actual.name, prior.name, "SDK_PACKAGE_IDENTITY_DRIFT");
  //   assert.equal(actual.private, true);
  //   assert.equal(actual.version, "0.0.0");
  //   assert.deepEqual(actual.bin ?? null, prior.bin, "SDK_BIN_CLASSIFICATION_DRIFT");
  //   const runnerFiles = actual.name === "@agent-teams/embedded-runtime" ? ["scripts/run-package-tests.mjs"] : [];
  //   assert.deepEqual(actual.files, [...prior.files, ...runnerFiles], "SDK_PACKAGE_FILES_DRIFT");
  //   assert.equal(JSON.stringify(actual.exports), JSON.stringify(prior.exports), "SDK_EXPORT_MATRIX_DRIFT");
  //   assert.deepEqual(pkg.entrypoints, [".", "./composition"].map(exportPath => ({ exportPath, declarationEntryPoint: `${pkg.packageRoot}/${actual.exports[exportPath].types.slice(2)}` })));
  //   assert.deepEqual(pkg.nonTypeExports, actual.name === "@agent-teams/embedded-runtime" ? [{ exportPath: "./scripts/run-package-tests.mjs", kind: "runtime" }] : []);
  //   assert.equal(pkg.tsconfigPath, `${pkg.packageRoot}/tsconfig.json`);
  // }
  assert.deepEqual(activation.packageQualification, { status: "passed-membership-and-imports", evidencePath: `${directory}/qualification.json`, cleanRegistryInstall: true }, "SDK_PACKAGE_QUALIFICATION_DRIFT");
  assert.deepEqual(activation.sdkAdmission, { status: "blocked-current-typed-observation", releaseEligible: false }, "SDK_ADMISSION_OVERCLAIM");
  const qualification = json(activation.packageQualification.evidencePath);
  assert.equal(qualification.historicalSourceCheckpoint, "5a9eb460400f968a7683c75f5f43a8329cad1196", "SDK_QUALIFICATION_BASE_DRIFT");
  assert.equal(qualification.qualification, "package-membership-and-public-imports", "SDK_PACKAGE_QUALIFICATION_DRIFT");
  assert.equal(qualification.releaseEligible, false, "SDK_ADMISSION_OVERCLAIM");
  assert.equal(qualification.efCandidateSha256, activation.qualificationInput.archiveSha256, "SDK_EF_CANDIDATE_DRIFT");
  checkPackedQualification(repository, qualification, { ...profile, packages: historicalPackages }, json);
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
  assert.deepEqual(candidate.observedPackages.toSorted(), [...historicalPackages.map(pkg => pkg.packageName), ...activation.metadataRoots.map(entry => entry.packageName)].toSorted(), "SDK_QUALIFICATION_SCOPE_DRIFT");
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
  assert.equal(createHash("sha256").update(readFileSync(resolve(repository, activation.packageQualification.evidencePath))).digest("hex"),
    "94d0858d39c182479874e0b883272741bda713c62e9b35efb7dfb9b0f59bdb28", "SDK_HISTORICAL_QUALIFICATION_DRIFT");
  assert.deepEqual(profile.sdkGrowth.comparison.released.map(entry => [entry.packageName, entry.kind]).toSorted(), profile.packages.map(pkg => [pkg.packageName, "initial-unreleased"]).toSorted());
  assert.equal(manifest.scripts["sdk-growth:profile"], command, "SDK_ENFORCEMENT_MISSING_OR_NOOP");
  assert.equal(manifest.scripts["test:sdk-growth:profile"], "node --test scripts/architecture/check-sdk-growth-profile.test.mjs", "SDK_ENFORCEMENT_MISSING_OR_NOOP");
  assert.equal(manifest.scripts["test:sdk-growth:packed"], "node --test scripts/architecture/qualify-sdk-packages.test.mjs", "SDK_ENFORCEMENT_MISSING_OR_NOOP");
  for (const name of ["check", "check:fast"]) {
    const chain = routedScripts(manifest.scripts, name);
    for (const step of ["pnpm sdk-growth:profile", "pnpm test:sdk-growth:profile", "pnpm test:sdk-growth:packed"]) {
      assert.ok(chain.includes(step), "SDK_ENFORCEMENT_MISSING_OR_NOOP");
    }
  }
  return { status: activation.status, packages: profile.packages.length, metadataRoots: 1, releaseEligible: false };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(checkSdkGrowthProfile()));
}
