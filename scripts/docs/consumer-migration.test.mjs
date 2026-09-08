import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import test from "node:test";
import { parseDocument } from "yaml";

const root = new URL("../../", import.meta.url);
const read = path => readFile(new URL(path, root), "utf8");
const json = async path => JSON.parse(await read(path));
const yaml = async path => {
  const document = parseDocument(await read(path), { uniqueKeys: true });
  assert.deepEqual(document.errors, []);
  return document.toJS();
};

test("portable v3 preserves strict Authoring v3 authority and both semantic validators", async () => {
  assert.deepEqual(await yaml("architecture/foundation/docs-protocol.yaml"), {
    schemaVersion: 3,
    protocol: { id: "agent-teams.docs-protocol", version: 1 },
    foundationProfile: { path: "architecture/foundation/document-authoring.yaml", schemaVersion: 3,
      metadataSidecarPolicy: "foundation-profile-v3-strict-merge" },
    agentWorkflow: { adoption: "portable-v1", skillPath: ".agents/skills/docs-authoring/SKILL.md" },
    semanticValidatorIds: ["runtime.documentation-governance", "runtime.qualification-evidence-integrity"],
  });
  const authoring = await yaml("architecture/foundation/document-authoring.yaml");
  assert.equal(authoring.schemaVersion, 3);
  assert.deepEqual(authoring.authoring.artifactTypes.map(({ type }) => type),
    ["index", "architecture", "adr", "evidence", "qualification-plan"]);
});

test("projected direct tooling pins and exact transitive age exceptions preserve the package manager", async () => {
  const manifest = await json("package.json"), workspace = await yaml("pnpm-workspace.yaml");
  assert.equal(manifest.packageManager, "pnpm@11.18.0");
  assert.deepEqual(manifest.engines, { node: ">=24.18.0 <25", pnpm: "11.18.0" });
  assert.equal(manifest.devDependencies["@agent-teams/engineering-foundation"], "1.1.0");
  assert.equal(manifest.devDependencies["@agent-teams/docs-protocol"], "0.6.0");
  assert.equal(manifest.devDependencies["@agent-teams/docs-protocol-agent-teams"], "0.2.0");
  for (const section of ["dependencies", "optionalDependencies", "peerDependencies"]) {
    assert.equal(Object.hasOwn(manifest[section] ?? {}, "@agent-teams/docs-protocol-agent-teams"), false);
  }
  const policy = await yaml("architecture/foundation/dependency-declarations.yaml");
  assert.ok(policy.policies.exactRegistryDevelopmentOnlyPackages.includes("@agent-teams/docs-protocol-agent-teams"));
  for (const name of ["docs-protocol-mcp", "document-authoring", "repository-mutation"]) {
    assert.equal(Object.hasOwn(manifest.devDependencies, `@agent-teams/${name}`), false);
  }
  assert.deepEqual(workspace.minimumReleaseAgeExclude.filter(value => value.startsWith("@agent-teams/")).toSorted(), [
    "@agent-teams/docs-protocol-agent-teams@0.2.0",
    "@agent-teams/docs-protocol@0.6.0", "@agent-teams/document-authoring@0.3.0",
    "@agent-teams/engineering-foundation@1.1.0", "@agent-teams/repository-mutation@0.2.0",
  ]);
  assert.match(await read("scripts/architecture/feature-module-config.mjs"), /const FOUNDATION_VERSION = "1\.1\.0";/u);
});

test("Skill commands are executable installed CLI calls with reviewed digest binding and full gate", async () => {
  const skill = await read(".agents/skills/docs-authoring/SKILL.md");
  for (const command of ["find", "new", "context", "check"]) {
    assert.ok(skill.includes(`pnpm exec docs-protocol ${command} --consumer . --profile architecture/foundation/docs-protocol.yaml`));
  }
  assert.match(skill, /--apply --expect "DIGEST"/u);
  assert.match(skill, /manual-required.*markdownLink.*indexPath/u);
  assert.match(skill, /full consumer gate `pnpm docs:protocol:check`/u);
  assert.match(skill, /supersession explicitly/u);
  const manifest = await json("package.json");
  assert.equal(manifest.scripts["docs:protocol:check"], "pnpm docs:check && pnpm docs:governance && pnpm docs:qualification");
});

test("Source Dependencies keeps its eight v1 roots and uses the supported installed CLI", async () => {
  const policy = await yaml("architecture/foundation/source-dependencies.yaml");
  assert.equal(policy.schemaVersion, 1);
  assert.deepEqual(policy.governedRoots, ["experiments", "packages/apps/embedded-runtime/src",
    "packages/contexts/agent-execution/src", "packages/contexts/provider-access/src",
    "packages/contexts/runtime-configuration/src", "packages/contexts/runtime-security/src",
    "packages/platform/filesystem-custody/src", "scripts/foundation"]);
  const source = await read("scripts/architecture/source-dependency-adapter-boundaries.test.mjs");
  assert.doesNotMatch(source, /engineering-foundation\/dist\/capabilities/u);
  assert.match(source, /foundationManifest\.bin\["agent-teams-foundation"\]/u);
  assert.match(source, /"architecture\.source-dependencies", "--consumer", root, "--json"/u);
});

test("historical integration, managed state and scenario contract remain byte-exact non-admission evidence", async () => {
  const expected = {
    "architecture/foundation/docs-consumer-integration.json": "0899fc2f0cf5838a34c401bfa004386c72100d483641e2627496170ea9b6cd23",
    "architecture/foundation/docs-protocol-managed-state.json": "901d5a4ea3c1de8cba2bec491ec919124c3b30bb29ea195692e1eb3d6279f658",
    "architecture/foundation/docs-protocol-qualification.json": "1f7e50ec5b0e6ecc991668b83790b2367062240043c4b885c58377855968969b",
    "architecture/foundation/document-authoring.yaml": "d6f5ba4b178e742e122f6711c9d989d52a77768eb68527b0ecdf3c9a9699c6d2",
    // Current migration evidence: reviewed scaffold source-policy overlay.
    "architecture/foundation/source-dependencies.yaml": "a40a5aac433c3bad0642aa7b1ed3b8d93af53c2bc36e9023a5c32287a3c3ed3a"
};
  for (const [path, digest] of Object.entries(expected)) {
    assert.equal(createHash("sha256").update(await read(path)).digest("hex"), digest, path);
  }
  const scenarios = await json("architecture/foundation/docs-protocol-qualification.json");
  assert.equal(scenarios.schemaVersion, 2);
  assert.equal(scenarios.scenarios.length, 5);
  const suite = await read("scripts/docs/docs-protocol-adoption.test.mjs");
  assert.doesNotMatch(suite, /Reflect\.get|runDocsProtocolQualificationV2/u);
  assert.match(suite, /for \(const scenario of scenarioContract\.scenarios\)/u);
});
