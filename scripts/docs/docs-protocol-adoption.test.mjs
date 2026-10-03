import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { repositoryRoot, disposableRepository, docs } from "./portable-authoring-test-support.mts";
import { routedScripts } from "../ci/script-routing.ts";

test("canonical qualification v2 covers every Runtime authorable type exactly once", async () => {
  const [integration, qualification, protocolProfileSource, authoringProfileSource, manifest] = await Promise.all([
    readFile(join(repositoryRoot, "architecture/foundation/docs-consumer-integration.json"), "utf8").then(JSON.parse),
    readFile(join(repositoryRoot, "architecture/foundation/docs-protocol-qualification.json"), "utf8").then(JSON.parse),
    readFile(join(repositoryRoot, "architecture/foundation/docs-protocol.yaml"), "utf8"),
    readFile(join(repositoryRoot, "architecture/foundation/document-authoring.yaml"), "utf8"),
    readFile(join(repositoryRoot, "package.json"), "utf8").then(JSON.parse),
  ]);
  assert.equal(integration.schemaVersion, 3);
  assert.equal(integration.cohort.cohortId, "docs-2026-10-03-stable31");
  assert.deepEqual(integration.qualification, {
    contractPath: "architecture/foundation/docs-protocol-qualification.json",
    gateCommand: "pnpm docs:protocol:check"
  });
  assert.equal(manifest.devDependencies["@agent-teams/docs-protocol"], "0.6.2");
  assert.equal(manifest.devDependencies["@agent-teams/engineering-foundation"], "1.7.2");
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
    const steps = routedScripts(manifest.scripts, gate);
    for (const command of [
      "pnpm docs:check",
      "pnpm docs:governance",
      "pnpm docs:qualification:typecheck",
      "pnpm docs:qualification:serial",
      "pnpm docs:qualification:portable",
    ]) {
      assert.equal(steps.filter(step => step === command).length, 1, `${gate} runs ${command} exactly once`);
    }
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
