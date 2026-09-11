import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import * as docsQualification from "@agent-teams/docs-protocol/qualification";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const protocolManifest = fileURLToPath(
  import.meta.resolve("@agent-teams/docs-protocol/package.json")
);
const foundationManifest = fileURLToPath(
  import.meta.resolve("@agent-teams/engineering-foundation/package.json")
);
const protocolCli = join(dirname(protocolManifest), "dist/cli.js");
const protocolProfile = "architecture/foundation/docs-protocol.yaml";

test("canonical qualification v2 covers every Runtime authorable type exactly once", async () => {
  const [integration, qualification, protocolProfileSource, authoringProfileSource, manifest] = await Promise.all([
    readFile(join(repositoryRoot, "architecture/foundation/docs-consumer-integration.json"), "utf8").then(JSON.parse),
    readFile(join(repositoryRoot, "architecture/foundation/docs-protocol-qualification.json"), "utf8").then(JSON.parse),
    readFile(join(repositoryRoot, "architecture/foundation/docs-protocol.yaml"), "utf8"),
    readFile(join(repositoryRoot, "architecture/foundation/document-authoring.yaml"), "utf8"),
    readFile(join(repositoryRoot, "package.json"), "utf8").then(JSON.parse),
  ]);
  assert.equal(integration.schemaVersion, 3);
  assert.equal(integration.cohort.cohortId, "docs-2026-09-10-stable19");
  assert.deepEqual(integration.qualification, {
    contractPath: "architecture/foundation/docs-protocol-qualification.json",
    gateCommand: "pnpm docs:protocol:check"
  });
  assert.equal(manifest.devDependencies["@agent-teams/docs-protocol"], "0.6.0");
  assert.equal(manifest.devDependencies["@agent-teams/engineering-foundation"], "1.2.0");
  assert.match(protocolProfileSource, /^schemaVersion: 3$/mu);
  assert.match(protocolProfileSource, /^  path: architecture\/foundation\/document-authoring\.yaml$/mu);
  assert.match(protocolProfileSource, /^  schemaVersion: 3$/mu);
  assert.match(authoringProfileSource, /^schemaVersion: 3$/mu);
  assert.match(authoringProfileSource, /^  ownerSets:$/mu);
  assert.equal(qualification.schemaVersion, 2);
  assert.deepEqual(Object.keys(qualification).toSorted(), ["scenarios", "schemaVersion"]);
  assert.deepEqual(qualification.scenarios.map(({ type }) => type).toSorted(), [
    "adr", "architecture", "evidence", "index", "qualification-plan"
  ]);
  assert.equal(new Set(qualification.scenarios.map(({ id }) => id)).size, 5);
  for (const scenario of qualification.scenarios) {
    assert.deepEqual(Object.keys(scenario).toSorted(), ["expected", "id", "intent", "type"]);
    assert.equal(scenario.expected.metadataStorage, "frontmatter");
  }
  for (const legacyKey of ["fixtureRoot", "gate", "packages", "paths", "qualificationTests", "tests"]) {
    assert.equal(Object.hasOwn(qualification, legacyKey), false, legacyKey);
  }
  await assert.rejects(
    readFile(join(repositoryRoot, "architecture/foundation/docs-protocol-rollout.yaml"), "utf8"),
    { code: "ENOENT" }
  );
  await assert.rejects(
    readFile(join(repositoryRoot, "architecture/foundation/rollouts/docs-protocol-v2/docs-protocol.yaml"), "utf8"),
    { code: "ENOENT" }
  );
  await assert.rejects(
    readFile(join(repositoryRoot, "architecture/foundation/rollouts/docs-protocol-v2/document-authoring.yaml"), "utf8"),
    { code: "ENOENT" }
  );
});

async function copyFile(source, destination) {
  await mkdir(dirname(destination), { recursive: true });
  await cp(source, destination);
}

async function addRequiredAnchorFixtures(root) {
  await copyFile(join(repositoryRoot, "architecture/feature-module-standard/candidate-profile.json"), join(root, "architecture/feature-module-standard/candidate-profile.json"));
  await copyFile(join(repositoryRoot, "experiments/runtime-profile-behavior/spec/runtime-operation-oracle/contained-turn-v1-contract.json"), join(root, "experiments/runtime-profile-behavior/spec/runtime-operation-oracle/contained-turn-v1-contract.json"));
  await copyFile(join(repositoryRoot, "packages/contexts/agent-execution/tests/live/claude-contained-turn-live-canary.mjs"), join(root, "packages/contexts/agent-execution/tests/live/claude-contained-turn-live-canary.mjs"));
  await copyFile(join(repositoryRoot, "scripts/architecture/check-feature-modules.mjs"), join(root, "scripts/architecture/check-feature-modules.mjs"));
  await copyFile(
    join(repositoryRoot, "architecture/decisions/accepted-decisions.json"),
    join(root, "architecture/decisions/accepted-decisions.json")
  );
  for (const path of [
    "architecture/consumer-module-standard/contained-turn-profile.json",
    "architecture/feature-module-standard/candidate-profile.json",
    "experiments/runtime-profile-behavior/spec/runtime-operation-oracle/contained-turn-v1-contract.json",
    "experiments/runtime-profile-behavior/spec/runtime-operation-oracle/README.md",
    "experiments/rust-system-boundaries/README.md",
    "experiments/sandbox-backend-hosting/README.md",
    "packages/apps/embedded-runtime/src/index.ts",
    "packages/platform/filesystem-custody/src/features/stable-filesystem-custody/README.md",
    "packages/contexts/agent-execution/tests/live/claude-contained-turn-live-canary.mjs",
    "scripts/architecture/check-consumer-module-standard.mjs",
    "scripts/architecture/check-feature-modules.mjs",
    "scripts/architecture/feature-module-edges.mjs"
  ]) {
    const destination = join(root, path);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, "Disposable code-anchor fixture.\n", "utf8");
  }
}

async function attachPublishedTooling(root) {
  const [manifestSource, protocolSource, foundationSource] = await Promise.all([
    readFile(join(root, "package.json"), "utf8"),
    readFile(protocolManifest, "utf8"),
    readFile(foundationManifest, "utf8")
  ]);
  const manifest = JSON.parse(manifestSource);
  const protocol = JSON.parse(protocolSource);
  const foundation = JSON.parse(foundationSource);
  await writeFile(join(root, "package.json"), `${JSON.stringify({
    ...manifest,
    devDependencies: {
      "@agent-teams/docs-protocol": protocol.version,
      "@agent-teams/engineering-foundation": foundation.version
    }
  }, null, 2)}\n`, "utf8");

  const scope = join(root, "node_modules", "@agent-teams");
  await mkdir(scope, { recursive: true });
  const kind = process.platform === "win32" ? "junction" : "dir";
  await Promise.all([
    symlink(dirname(protocolManifest), join(scope, "docs-protocol"), kind),
    symlink(dirname(foundationManifest), join(scope, "engineering-foundation"), kind)
  ]);
}

async function disposableRepository(run, { attachTooling = false } = {}) {
  // macOS temp roots can traverse /var; qualification requires direct physical paths.
  const root = await realpath(await mkdtemp(join(tmpdir(), "atd-r-")));
  try {
    await cp(join(repositoryRoot, "docs"), join(root, "docs"), { recursive: true });
    await mkdir(join(root, "architecture", "foundation"), { recursive: true });
    await cp(
      join(repositoryRoot, "architecture", "foundation", "document-authoring.yaml"),
      join(root, "architecture", "foundation", "document-authoring.yaml")
    );
    await cp(
      join(repositoryRoot, "architecture", "foundation", "docs-protocol.yaml"),
      join(root, "architecture", "foundation", "docs-protocol.yaml")
    );
    await mkdir(join(root, ".agents", "skills", "docs-authoring"), { recursive: true });
    await cp(
      join(repositoryRoot, ".agents", "skills", "docs-authoring", "SKILL.md"),
      join(root, ".agents", "skills", "docs-authoring", "SKILL.md")
    );
    await cp(join(repositoryRoot, "AGENTS.md"), join(root, "AGENTS.md"));
    await cp(join(repositoryRoot, "package.json"), join(root, "package.json"));
    await addRequiredAnchorFixtures(root);
    if (attachTooling) {
      await attachPublishedTooling(root);
    }
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function docs(root, command, ...args) {
  const result = spawnSync(
    process.execPath,
    [
      protocolCli,
      command,
      "--consumer",
      root,
      "--profile",
      protocolProfile,
      "--json",
      ...args
    ],
    { encoding: "utf8" }
  );
  let envelope;
  try {
    envelope = JSON.parse(result.stdout);
  } catch {
    assert.fail(`Docs Protocol did not return JSON. stderr: ${result.stderr}`);
  }
  return { envelope, status: result.status, stderr: result.stderr };
}

test("keeps protocol and frozen-document governance in every repository gate", async () => {
  const manifest = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8"));
  assert.equal(
    manifest.scripts["docs:protocol:check"],
    "pnpm docs:check && pnpm docs:governance && pnpm docs:qualification"
  );
  assert.equal(
    manifest.scripts["docs:governance"],
    "node --test scripts/docs/verify-frozen-document-bytes.test.mjs"
  );
  for (const gate of ["check", "check:fast"]) {
    assert.match(manifest.scripts[gate], /pnpm docs:protocol:check/u);
  }
  assert.equal(manifest.scripts["check:changed"], "agent-teams-foundation agent-workflow changed --consumer .");
});

test("uses owner catalog authority and keeps blocked_by as read compatibility", async () => {
  const schema = JSON.parse(await readFile(join(repositoryRoot, "docs/document-metadata.schema.json"), "utf8"));
  assert.equal(Object.hasOwn(schema.properties.owner, "enum"), false);
  assert.match(schema.properties.blocked_by.$comment, /Read-only compatibility/u);

  const templateRoot = join(repositoryRoot, "docs/templates");
  for (const name of ["index", "architecture", "adr", "evidence", "qualification-plan"]) {
    const source = await readFile(join(templateRoot, `${name}.md`), "utf8");
    assert.doesNotMatch(source, /^blocked_by:/mu, name);
  }
});

// Stable19 authority is independently qualified; portable scenarios supplement managed checks.
// Managed v3 acceptance needs authentic Cohort v2, registry/workflow and package
// integrities. Portable scenarios must never silently substitute for that gate.
const scenarioContract = JSON.parse(await readFile(join(repositoryRoot,
  "architecture/foundation/docs-protocol-qualification.json"), "utf8"));
for (const scenario of scenarioContract.scenarios) {
  test(`portable authoring preserves ${scenario.id}`, async () => {
    await disposableRepository(async (root) => {
      const { related, slug, ...intent } = scenario.intent;
      const args = ["--type", scenario.type, "--id", intent.id, "--title", intent.title,
        "--owner", intent.owner, "--summary", intent.summary,
        ...(slug === undefined ? [] : ["--slug", slug]),
        ...(related ?? []).flatMap(id => ["--related", id])];
      const beforePreview = await docsQualification.fileSnapshot(root);
      const preview = docs(root, "new", ...args, "--dry-run");
      assert.equal(preview.status, 0, JSON.stringify(preview.envelope));
      assert.equal(preview.envelope.result.documentPath, scenario.expected.documentPath);
      assert.equal(scenario.expected.metadataStorage, "frontmatter");
      assert.ok(preview.envelope.result.compiled.frontmatter.length > 0);
      assert.equal(preview.envelope.result.compiled.metadata.owner, intent.owner);
      assert.equal(preview.envelope.result.compiled.metadata.id, intent.id);
      assert.deepEqual(preview.envelope.result.reachability, scenario.expected.reachability);
      const stale = docs(root, "new", ...args, "--apply", "--expect", `sha256:${"0".repeat(64)}`);
      assert.notEqual(stale.status, 0);
      assert.ok(stale.envelope.diagnostics.some(({ ruleId }) => ruleId === "docs.new.plan-digest-stale"), JSON.stringify(stale.envelope));
      await assert.rejects(readFile(join(root, scenario.expected.documentPath)), { code: "ENOENT" });
      assert.deepEqual(await docsQualification.fileSnapshot(root), beforePreview);
      const receipt = await docsQualification.runDocsProtocolQualification({
        fixtureRoot: root,
        profilePath: protocolProfile,
        scenario: {
          find: { query: { id: "ADR-0001" }, expectedIds: ["ADR-0001"] },
          newDocument: { intent: { type: scenario.type, ...intent, ...(slug === undefined ? {} : { slug }) },
            ...(related === undefined ? {} : { related }) }
        }
      });
      assert.equal(receipt.projectId, "agent-runtime");
      assert.equal(receipt.appliedDocumentPath, scenario.expected.documentPath);
      assert.deepEqual(receipt.checks, ["info", "find", "preview", "crash", "doctor", "recover", "receipt", "parent", "apply", "index", "check", "source-unchanged"]);
      const applied = docs(root, "new", ...args, "--apply", "--expect", preview.envelope.result.planDigest);
      assert.equal(applied.status, 0, JSON.stringify(applied.envelope));
      assert.equal(await readFile(join(root, scenario.expected.documentPath), "utf8"),
        preview.envelope.result.compiled.document.content);
      await docsQualification.applyReachability(root, scenario.expected.reachability);
      const context = docs(root, "context", "--id", intent.id);
      assert.equal(context.status, 0, JSON.stringify(context.envelope));
      const check = docs(root, "check");
      assert.equal(check.status, 0, JSON.stringify(check.envelope));
    }, { attachTooling: true });
  });
}

test("fails closed for an unknown owner", async () => {
  await disposableRepository(async (root) => {
    const target = join(root, "docs", "architecture", "README.md");
    const source = await readFile(target, "utf8");
    await writeFile(target, source.replace(
      "owner: architecture",
      "owner: architecture/unknown"
    ));

    const result = docs(root, "check");
    assert.notEqual(result.status, 0);
    assert.equal(result.envelope.outcome, "violation");
    assert.ok(
      result.envelope.diagnostics.some(({ ruleId }) =>
        ruleId === "document.catalog.owner-unknown"
      ),
      JSON.stringify(result.envelope.diagnostics)
    );
  }, { attachTooling: true });
});

test("fails closed for an unresolved relation", async () => {
  await disposableRepository(async (root) => {
    const target = join(root, "docs", "architecture", "README.md");
    const source = await readFile(target, "utf8");
    await writeFile(target, source.replace(
      "related:\n  - ADR-0001",
      "related:\n  - missing.document\n  - ADR-0001"
    ));

    const result = docs(root, "check");
    assert.notEqual(result.status, 0);
    assert.equal(result.envelope.outcome, "violation");
    assert.ok(
      result.envelope.diagnostics.some(({ ruleId }) =>
        ruleId === "docs.metadata.common-semantics"
      ),
      JSON.stringify(result.envelope.diagnostics)
    );
  }, { attachTooling: true });
});

test("fails closed for a stale required code anchor", async () => {
  await disposableRepository(async (root) => {
    const target = join(root, "docs", "architecture", "foundation-adoption.md");
    const source = await readFile(target, "utf8");
    await writeFile(target, source.replace(
      "pattern: architecture/foundation/**",
      "pattern: packages/missing-required-anchor.ts"
    ));

    const result = docs(root, "check");
    assert.notEqual(result.status, 0);
    assert.equal(result.envelope.outcome, "violation");
    assert.ok(
      result.envelope.diagnostics.some(({ ruleId }) =>
        ruleId.includes("anchor")
      ),
      JSON.stringify(result.envelope.diagnostics)
    );
  }, { attachTooling: true });
});
