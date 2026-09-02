import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  link, lstat, mkdir, mkdtemp, open, readdir, realpath, rm,
  symlink, writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import {
  assertAr2EvidenceCustodyCapability,
  readCustodiedRepositoryFile,
} from "./ar2-evidence-custody.mjs";
import {
  registerAr2EvidenceCustodyRaceTests,
} from "./ar2-evidence-custody-races.test-cases.mjs";
import {
  auditLegacyInventoryEvidence,
  readAr2CoverageTestSource,
  validateAr2ContractArtifacts,
  validateContractCoverage,
  validateClaudeDiagnosticParity,
  validateClaudeExpectedLimitationsParity,
  validateInventory,
  validateOfficialSemantics,
} from "./validate-ar2-contract-artifacts.mjs";

const readRepositoryBytes = (path, allowedRoot = ".") =>
  readCustodiedRepositoryFile(path, { allowedRoot });
const readRepositoryText = async (path, allowedRoot) =>
  (await readRepositoryBytes(path, allowedRoot)).toString("utf8");
const readJson = async (path, allowedRoot) =>
  JSON.parse(await readRepositoryText(path, allowedRoot));

registerAr2EvidenceCustodyRaceTests();

const loadCoverageInputs = async () => {
  const [freeze, negatives, contractCoverage] = await Promise.all([
    readJson("docs/architecture/claude-code-setup-freeze.json", "docs/architecture"),
    readJson("packages/contexts/runtime-configuration/tests/fixtures/claude-code-settings/negative-fixtures.json",
      "packages/contexts/runtime-configuration/tests/fixtures/claude-code-settings"),
    readJson("packages/contexts/runtime-configuration/tests/fixtures/claude-code-settings/contract-coverage.json",
      "packages/contexts/runtime-configuration/tests/fixtures/claude-code-settings"),
  ]);
  const testFiles = [...new Set(contractCoverage.cases.map(entry => entry.testFile))];
  const testSources = new Map(await Promise.all(testFiles.map(async testFile => [
    testFile,
    await readRepositoryText(testFile, /^(packages\/[^/]+\/[^/]+\/tests)\//u.exec(testFile)[1]),
  ])));
  const packageRoots = [...new Set(testFiles.map(testFile => /^(packages\/[^/]+\/[^/]+)\//u.exec(testFile)[1]))];
  const packageTestScripts = new Map(await Promise.all(packageRoots.map(async packageRoot => {
    const packageManifest = await readJson(`${packageRoot}/package.json`, packageRoot);
    return [packageRoot, packageManifest.scripts.test];
  })));
  return {
    contractCoverage,
    fixtureMatrix: freeze.fixtureMatrix,
    negativeGroups: negatives.groups,
    packageTestScripts,
    testSources,
  };
};

test("AR-2 inventory and Claude freeze packet satisfy the frozen contract", async () => {
  const result = await validateAr2ContractArtifacts();
  assert.equal(result.inventoryItems, result.capabilityIds.length);
  assert.equal(
    Object.values(result.providerCounts).reduce((sum, count) => sum + count, 0),
    result.inventoryItems,
  );
  assert.ok(Object.values(result.providerCounts).every(count => count > 0));
  assert.ok(result.implemented.length > 0);
  assert.ok(result.superseded.length > 0);
  assert.equal(
    result.semanticArtifactSha256,
    "150474d9b869fac16169c23e14e6be296f2d0f13fe0c763d509cdd897ff07404",
  );
  assert.equal(result.snapshotDocuments, 5);
});

test("Claude public diagnostics have exact set parity with the freeze", async () => {
  const [freeze, runtimeAccessSource] = await Promise.all([
    readJson("docs/architecture/claude-code-setup-freeze.json", "docs/architecture"),
    readRepositoryText("packages/apps/embedded-runtime/src/contracts/runtime-access.ts",
      "packages/apps/embedded-runtime/src"),
  ]);
  assert.doesNotThrow(() => validateClaudeDiagnosticParity(freeze.diagnostics, runtimeAccessSource));
  assert.throws(
    () => validateClaudeDiagnosticParity(freeze.diagnostics.slice(1), runtimeAccessSource),
    /diagnostic set parity/u,
  );
  assert.throws(
    () => validateClaudeDiagnosticParity([...freeze.diagnostics, "future_drift"], runtimeAccessSource),
    /diagnostic set parity/u,
  );
});

test("Claude public expected limitations have exact field parity with the freeze", async () => {
  const [freeze, runtimeAccessSource] = await Promise.all([
    readJson("docs/architecture/claude-code-setup-freeze.json", "docs/architecture"),
    readRepositoryText("packages/apps/embedded-runtime/src/contracts/runtime-access.ts",
      "packages/apps/embedded-runtime/src"),
  ]);
  assert.doesNotThrow(() => validateClaudeExpectedLimitationsParity(
    freeze.expectedLimitations,
    runtimeAccessSource,
  ));
  assert.throws(
    () => validateClaudeExpectedLimitationsParity(
      { ...freeze.expectedLimitations, precedence: "evaluated" },
      runtimeAccessSource,
    ),
    /expected-limitations parity/u,
  );
});

test("inventory preserves omitted jobs and explicit supersession without defining completeness", async () => {
  const inventory = await readJson(
    "docs/architecture/legacy-feature-inventory.json", "docs/architecture",
  );
  const byId = new Map(inventory.items.map(item => [item.capabilityId, item]));
  for (const capabilityId of ["CODEX-TRUST-01", "CLF-08", "CLF-09"]) {
    assert.equal(byId.get(capabilityId)?.implementationStatus, "not_implemented");
  }
  assert.match(byId.get("CLF-06")?.userJob ?? "", /installed and latest/u);
  assert.match(byId.get("CLF-07")?.userJob ?? "", /disconnect/u);
  for (const capabilityId of ["CLF-05", "CLF-08", "CLF-09"]) {
    assert.equal(byId.get(capabilityId)?.backlogDisposition, "later");
  }
  assert.deepEqual(byId.get("CODEX-DISC-02")?.supersededBy, ["CODEX-DISC-01"]);
  assert.deepEqual(byId.get("OC-11")?.supersededBy, ["OC-12"]);
  assert.match(byId.get("OC-20")?.architectureAuthority.claim ?? "", /INV-REDACTED-TYPED-DIAGNOSTICS/u);
});

test("inventory semantics permit future rows without authored-list or cardinality coupling", async () => {
  const inventory = await readJson(
    "docs/architecture/legacy-feature-inventory.json", "docs/architecture",
  );
  const future = structuredClone(inventory.items.find(item => item.capabilityId === "CODEX-TRUST-01"));
  const codexCount = inventory.items.filter(item => item.provider === "codex").length;
  future.capabilityId = "CODEX-TRUST-99";
  inventory.items.push(future);
  const result = validateInventory(inventory);
  assert.equal(result.capabilityIds.includes("CODEX-TRUST-99"), true);
  assert.equal(result.providerCounts.codex, codexCount + 1);
});

test("default repository validation has no exact-legacy-checkout dependency", async () => {
  const validatorSource = await readRepositoryText(
    "scripts/architecture/validate-ar2-contract-artifacts.mjs", "scripts/architecture",
  );
  assert.doesNotMatch(validatorSource, /legacy-exact|\/home\/agent-runtime-postmerge/u);
  for (const [path, expectedRead] of [
    ["scripts/architecture/validate-claude-official-semantics.mjs", /readCustodiedRepositoryFile\(document\.artifactPath/u],
    ["packages/contexts/runtime-configuration/tests/claude-code-contract.test.ts", /readCustodiedRepositoryFile\(/u],
    ["packages/apps/embedded-runtime/tests/claude-code-setup.e2e.test.ts", /readAr2FixtureJson\(/u],
  ]) {
    const allowedRoot = path.slice(0, path.lastIndexOf("/"));
    const source = await readRepositoryText(path, allowedRoot);
    assert.match(source, /ar2-evidence-custody\.mjs/u, `${path} must use AR-2 descriptor custody`);
    assert.match(source, expectedRead, `${path} must route the reviewed evidence read through custody`);
  }
  await assert.doesNotReject(validateAr2ContractArtifacts());
});

test("optional legacy evidence audit resolves anchors under an explicit fixture root", async t => {
  const exactLegacyRoot = await mkdtemp(join(tmpdir(), "ar2-legacy-audit-"));
  t.after(() => rm(exactLegacyRoot, { recursive: true, force: true }));
  await mkdir(join(exactLegacyRoot, "src"));
  await writeFile(join(exactLegacyRoot, "src", "fixture.ts"), "export const fixtureAnchor = true;\n");

  const inventory = await readJson(
    "docs/architecture/legacy-feature-inventory.json", "docs/architecture",
  );
  const legacyEntries = [
    ...inventory.crossCuttingInvariants.flatMap(invariant =>
      invariant.acceptanceEvidence.map(entry => entry.evidence)),
    ...inventory.items.flatMap(item => [
      ...item.legacyFact.evidence,
      ...item.currentProviderFact.evidence,
      ...item.architectureAuthority.evidence,
      ...item.acceptanceEvidence.map(entry => entry.evidence),
    ]),
  ].filter(entry => entry.repository === "legacy");
  for (const entry of legacyEntries) {
    entry.path = "src/fixture.ts";
    entry.locator = "symbol:fixtureAnchor";
  }

  assert.equal(
    await auditLegacyInventoryEvidence(exactLegacyRoot, inventory),
    legacyEntries.length,
  );
});

test("owner kinds keep four domain contexts separate from composition and Desktop", async () => {
  const inventory = await readJson(
    "docs/architecture/legacy-feature-inventory.json", "docs/architecture",
  );
  const owners = inventory.items.flatMap(item => item.owners);
  assert.deepEqual(
    [...new Set(owners.filter(owner => owner.kind === "bounded-context").map(owner => owner.id))].toSorted(),
    ["agent-execution", "provider-access", "runtime-configuration", "runtime-security"],
  );
  assert.deepEqual(
    [...new Set(owners.filter(owner => owner.kind === "application-composition").map(owner => owner.id))],
    ["embedded-runtime"],
  );
  assert.deepEqual(
    [...new Set(owners.filter(owner => owner.kind === "external-consumer").map(owner => owner.id))],
    ["desktop"],
  );
});

test("inventory semantics reject duplicate IDs, provider drift, and evidence commit drift", async () => {
  const source = await readJson(
    "docs/architecture/legacy-feature-inventory.json", "docs/architecture",
  );

  const duplicate = structuredClone(source);
  duplicate.items.push(structuredClone(duplicate.items[0]));
  assert.throws(() => validateInventory(duplicate), /capability IDs must be unique/u);

  const providerDrift = structuredClone(source);
  providerDrift.items[0].provider = "opencode";
  assert.throws(() => validateInventory(providerDrift), /provider\/ID consistency/u);

  const evidenceDrift = structuredClone(source);
  evidenceDrift.items[0].legacyFact.evidence[0].commit = "0".repeat(40);
  assert.throws(() => validateInventory(evidenceDrift), /evidence commit\/repository consistency/u);
});

test("AR-2 validator rejects gzip metadata drift and a fabricated retained excerpt", async () => {
  const snapshot = await readJson(
    "docs/architecture/claude-code-official-semantics.snapshot.json", "docs/architecture",
  );
  snapshot.documents[0].gzipSha256 = "0".repeat(64);
  await assert.rejects(
    validateOfficialSemantics(snapshot),
    /deterministic gzip hash/u,
  );

  const fabricatedExcerpt = await readJson(
    "docs/architecture/claude-code-official-semantics.snapshot.json", "docs/architecture",
  );
  fabricatedExcerpt.documents[0].retainedBytesUtf8 = fabricatedExcerpt.documents[0]
    .retainedBytesUtf8
    .replace("User |", "Fake |");
  fabricatedExcerpt.documents[0].retainedSha256 = createHash("sha256")
    .update(fabricatedExcerpt.documents[0].retainedBytesUtf8)
    .digest("hex");
  await assert.rejects(
    validateOfficialSemantics(fabricatedExcerpt),
    /retained evidence derivation/u,
  );

  assert.throws(
    () => assertAr2EvidenceCustodyCapability("win32"),
    error => error.message === "AR-2 evidence custody rejected: descriptor-bound no-follow reads are unsupported on this platform",
  );
});

test("AR-2 validator rejects fixture or executed-test mapping drift", async () => {
  const inputs = await loadCoverageInputs();
  const fixtureDrift = structuredClone(inputs);
  for (const matrix of [
    fixtureDrift.fixtureMatrix,
    fixtureDrift.negativeGroups,
    fixtureDrift.contractCoverage.cases,
  ]) {
    matrix[19].diagnostic = "configuration_dialect_unsupported";
  }
  assert.throws(
    () => validateContractCoverage(fixtureDrift),
    /frozen fixture matrix/u,
  );

  const testReferenceDrift = structuredClone(inputs);
  testReferenceDrift.contractCoverage.cases[0].testName = "stale test title";
  assert.throws(
    () => validateContractCoverage(testReferenceDrift),
    /must name exactly one declared Node test/u,
  );
});

test("AR-2 descriptor custody rejects unsafe paths and filesystem objects", async t => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "ar2-evidence-custody-"));
  t.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  const testsRoot = join(fixtureRoot, "packages", "contexts", "example", "tests");
  const nestedRoot = join(testsRoot, "nested");
  const outsideRoot = join(fixtureRoot, "outside");
  await mkdir(nestedRoot, { recursive: true });
  await mkdir(outsideRoot);
  await writeFile(join(nestedRoot, "valid.test.ts"), "export {};\n");
  await writeFile(join(nestedRoot, "oversized.test.ts"), "x".repeat(33));
  await writeFile(join(outsideRoot, "outside.test.ts"), "throw new Error('outside');\n");
  await link(join(nestedRoot, "valid.test.ts"), join(nestedRoot, "hardlinked.test.ts"));
  await symlink(join(outsideRoot, "outside.test.ts"), join(nestedRoot, "linked.test.ts"));
  await symlink(outsideRoot, join(testsRoot, "linked-ancestor"));
  await mkdir(join(nestedRoot, "directory.test.ts"));

  const evidenceRoot = pathToFileURL(`${fixtureRoot}/`);
  const validPath = "packages/contexts/example/tests/nested/valid.test.ts";
  const defaultFileSystem = { lstat, open, readdir, realpath };
  await rm(join(nestedRoot, "hardlinked.test.ts"));
  await assert.doesNotReject(readAr2CoverageTestSource(validPath, { evidenceRoot }));

  await t.test("rejects absolute, Unicode, encoded, case, dot, and backslash aliases", async () => {
    for (const unsafePath of [
      join(fixtureRoot, "outside", "outside.test.ts"),
      "packages/contexts/example/tests/nested/valid.tést.ts",
      "packages/contexts/example/tests/%2e%2e/outside.test.ts",
      "packages/contexts/example/tests/nested/../outside.test.ts",
      "packages\\contexts\\example\\tests\\outside.test.ts",
      "file:///tmp/outside.test.ts",
    ]) {
      await assert.rejects(
        readAr2CoverageTestSource(unsafePath, { evidenceRoot }),
        error => error.message.includes("<invalid> AR-2 evidence custody rejected")
          && !error.message.includes(fixtureRoot),
      );
    }
    await assert.rejects(
      readAr2CoverageTestSource(
        "packages/contexts/example/tests/nested/VALID.test.ts",
        { evidenceRoot },
      ),
      /ambiguous identity/u,
    );
    for (const [platform, fileSystemConstants] of [
      ["win32", { O_RDONLY: 0, O_NOFOLLOW: 131072, O_NONBLOCK: 2048 }],
      ["linux", { O_RDONLY: 0, O_NOFOLLOW: 0, O_NONBLOCK: 2048 }],
      ["linux", { O_RDONLY: 0, O_NOFOLLOW: 131072, O_NONBLOCK: 0 }],
    ]) {
      assert.throws(
        () => assertAr2EvidenceCustodyCapability(platform, fileSystemConstants),
        error => error.message === "AR-2 evidence custody rejected: descriptor-bound no-follow reads are unsupported on this platform"
          && !error.message.includes(validPath),
      );
    }
  });

  await t.test("rejects a symbolic-link evidence file", async () => {
    await assert.rejects(
      readAr2CoverageTestSource(
        "packages/contexts/example/tests/nested/linked.test.ts",
        { evidenceRoot },
      ),
      /symbolic links are forbidden/u,
    );
  });

  await t.test("rejects a symbolic-link ancestor", async () => {
    await assert.rejects(
      readAr2CoverageTestSource(
        "packages/contexts/example/tests/linked-ancestor/outside.test.ts",
        { evidenceRoot },
      ),
      /symbolic links are forbidden/u,
    );
  });

  await t.test("rejects a non-regular evidence target", async () => {
    await assert.rejects(
      readAr2CoverageTestSource(
        "packages/contexts/example/tests/nested/directory.test.ts",
        { evidenceRoot },
      ),
      /evidence target is not a regular file/u,
    );
    await assert.rejects(
      readAr2CoverageTestSource(
        "packages/contexts/example/tests/nested/oversized.test.ts",
        { evidenceRoot, maxBytes: 32 },
      ),
      /evidence target exceeds its byte budget/u,
    );
  });

  await t.test("rejects a multiply-linked evidence target", async () => {
    await link(join(nestedRoot, "valid.test.ts"), join(nestedRoot, "hardlinked.test.ts"));
    await assert.rejects(
      readAr2CoverageTestSource(validPath, { evidenceRoot }),
      /exactly one link/u,
    );
    await rm(join(nestedRoot, "hardlinked.test.ts"));
  });

  await t.test("rejects a canonical realpath escape", async () => {
    await assert.rejects(
      readAr2CoverageTestSource(validPath, {
        evidenceRoot,
        fileSystem: {
          ...defaultFileSystem,
          realpath: async path => path.endsWith("valid.test.ts")
            ? join(outsideRoot, "outside.test.ts")
            : realpath(path),
        },
      }),
      /canonical path escapes its allowed root/u,
    );
  });

  await t.test("does not read content before custody validation succeeds", async () => {
    let contentReads = 0;
    await assert.rejects(
      readAr2CoverageTestSource(
        "packages/contexts/example/tests/nested/linked.test.ts",
        {
          evidenceRoot,
          fileSystem: {
            ...defaultFileSystem,
            open: async (...arguments_) => {
              contentReads += 1;
              return open(...arguments_);
            },
          },
        },
      ),
      /symbolic links are forbidden/u,
    );
    assert.equal(contentReads, 0, "a rejected lineage must never be opened");
  });
});

test("AR-2 package manifest evidence uses descriptor custody", async t => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "ar2-package-custody-"));
  t.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  const packageRoot = "packages/contexts/example";
  const manifestPath = `${packageRoot}/package.json`;
  const packageDirectory = join(fixtureRoot, packageRoot);
  const outside = join(fixtureRoot, "outside.json");
  await mkdir(packageDirectory, { recursive: true });
  await writeFile(outside, "{}\n");
  await symlink(outside, join(packageDirectory, "package.json"));
  const options = { allowedRoot: packageRoot, evidenceRoot: fixtureRoot };
  await assert.rejects(
    readCustodiedRepositoryFile(manifestPath, options),
    /symbolic links are forbidden/u,
  );
  await rm(join(packageDirectory, "package.json"));
  await mkdir(join(packageDirectory, "package.json"));
  await assert.rejects(
    readCustodiedRepositoryFile(manifestPath, options),
    /evidence target is not a regular file/u,
  );
});

test("AR-2 CLI failure boundary emits only its stable repository diagnostic", async () => {
  const moduleUrl = new URL("./validate-ar2-contract-artifacts.mjs", import.meta.url).href;
  const sensitive = `/private/host/${process.pid}/secret-input-content`;
  const program = `
    const { runAr2ContractArtifactsCli } = await import(${JSON.stringify(moduleUrl)});
    process.exitCode = await runAr2ContractArtifactsCli({
      validate: async () => { throw new Error(${JSON.stringify(sensitive)}); },
    });
  `;
  const child = spawn(process.execPath, ["--input-type=module", "--eval", program], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = []; const stderr = [];
  child.stdout.on("data", chunk => stdout.push(chunk));
  child.stderr.on("data", chunk => stderr.push(chunk));
  const status = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  assert.equal(status, 1);
  assert.equal(Buffer.concat(stdout).toString("utf8"), "");
  assert.equal(
    Buffer.concat(stderr).toString("utf8"),
    "AR-2 contract artifact validation failed\n",
  );
  assert.doesNotMatch(Buffer.concat(stderr).toString("utf8"), /private|secret|Error| at /u);
});
