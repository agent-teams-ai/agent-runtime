import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { parseDocument } from "yaml";

const root = new URL("../../", import.meta.url);
const read = path => readFile(new URL(path, root), "utf8");
const json = async path => JSON.parse(await read(path));
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
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

test("projected direct tooling pins and disabled release-age waiting preserve the package manager", async () => {
  const manifest = await json("package.json"), workspace = await yaml("pnpm-workspace.yaml");
  assert.equal(manifest.packageManager, "pnpm@11.18.0");
  assert.deepEqual(manifest.engines, { node: ">=24.18.0 <25 || >=26.10.0 <27", pnpm: "11.18.0" });
  assert.equal(manifest.devDependencies["@agent-teams/engineering-foundation"], "1.6.0");
  assert.equal(manifest.devDependencies["@agent-teams/docs-protocol"], "0.6.1");
  assert.equal(manifest.devDependencies["@agent-teams/docs-protocol-agent-teams"], "0.2.11");
  for (const section of ["dependencies", "optionalDependencies", "peerDependencies"]) {
    assert.equal(Object.hasOwn(manifest[section] ?? {}, "@agent-teams/docs-protocol-agent-teams"), false);
  }
  const policy = await yaml("architecture/foundation/dependency-declarations.yaml");
  assert.ok(policy.policies.exactRegistryDevelopmentOnlyPackages.includes("@agent-teams/docs-protocol-agent-teams"));
  for (const name of ["docs-protocol-mcp", "document-authoring", "repository-mutation"]) {
    assert.equal(Object.hasOwn(manifest.devDependencies, `@agent-teams/${name}`), false);
  }
  assert.equal(workspace.minimumReleaseAge, 0);
  assert.equal(Object.hasOwn(workspace, "minimumReleaseAgeStrict"), false);
  assert.deepEqual(workspace.minimumReleaseAgeExclude, [
    "@agent-teams/repository-mutation@0.2.1",
    "@agent-teams/document-authoring@0.3.1",
    "@agent-teams/docs-protocol@0.6.1",
    "@agent-teams/docs-protocol-agent-teams@0.2.11",
    "@agent-teams/engineering-foundation@1.6.0",
  ]);
  assert.match(await read("scripts/architecture/feature-module-config.mjs"), /const FOUNDATION_VERSION = "1\.6\.0";/u);
});

test("managed Skill remains byte-exact with the selected installed Cohort", async () => {
  const integration = await json("architecture/foundation/docs-consumer-integration.json");
  const skillDigest = `sha256:${createHash("sha256").update(await read(integration.skillPath)).digest("hex")}`;
  assert.equal(skillDigest, integration.cohort.assets.skillDigest);
  const manifest = await json("package.json");
  assert.equal(manifest.scripts["docs:protocol:check"], "pnpm docs:check && pnpm docs:governance && pnpm docs:qualification");
});

test("Source Dependencies uses schema v3 with root package and every workspace package", async () => {
  const policy = await yaml("architecture/foundation/source-dependencies.yaml");
  assert.equal(policy.schemaVersion, 3);
  assert.equal(policy.rootPackage, true);
  assert.equal(Object.hasOwn(policy, "includeRootPackage"), false);
  assert.deepEqual(policy.packageRoots, [
    "packages/apps/embedded-runtime",
    "packages/contexts/agent-execution",
    "packages/contexts/provider-access",
    "packages/contexts/runtime-configuration",
    "packages/contexts/runtime-security",
    "packages/platform/filesystem-custody",
  ]);
  assert.deepEqual(policy.governedRoots, [
    "packages/platform/filesystem-custody/native",
    "experiments",
    "packages/apps/embedded-runtime/src",
    "packages/apps/embedded-runtime/tests",
    "packages/contexts/agent-execution/scripts",
    "packages/contexts/agent-execution/src",
    "packages/contexts/agent-execution/tests",
    "packages/contexts/provider-access/src",
    "packages/contexts/provider-access/tests",
    "packages/contexts/runtime-configuration/src",
    "packages/contexts/runtime-configuration/tests",
    "packages/contexts/runtime-security/src",
    "packages/contexts/runtime-security/tests",
    "packages/platform/filesystem-custody/scripts",
    "packages/platform/filesystem-custody/src",
    "packages/platform/filesystem-custody/tests",
    "scripts/architecture",
    "scripts/sdk-growth-source",
    "scripts/ci",
    "scripts/docs",
    "scripts/foundation",
    "scripts/native-helper",
    "packages/apps/embedded-runtime/scripts",
    "packages/contexts/provider-access/scripts",
    "packages/contexts/runtime-security/scripts",
  ]);
  const source = await read("scripts/architecture/source-dependency-adapter-boundaries.test.mjs");
  assert.doesNotMatch(source, /engineering-foundation\/dist\/capabilities/u);
  assert.match(source, /foundationManifest\.bin\["agent-teams-foundation"\]/u);
  assert.match(source, /"architecture\.source-dependencies", "--consumer", root, "--json"/u);
});

test("qualified stable28 managed state retains exact bytes", async () => {
  const expected = {
    "architecture/foundation/docs-consumer-integration.json": "1fc8cb4431b20d2e51cfb54194ba98fc121cd417bb42541e0bdf87040f759720",
    "architecture/foundation/docs-protocol-managed-state.json": "7b0f900339030d7aab0f17d5b84612d3f5ee35b457283d2755994c4284f36159",
    "architecture/foundation/docs-protocol-qualification.json": "1f7e50ec5b0e6ecc991668b83790b2367062240043c4b885c58377855968969b",
    "architecture/foundation/document-authoring.yaml": "d6f5ba4b178e742e122f6711c9d989d52a77768eb68527b0ecdf3c9a9699c6d2",
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

test("scoped source policy retains both historic edges and its committed amendment", async () => {
  const policyPath = "architecture/foundation/source-dependencies.yaml";
  const gitEnvironment = { ...process.env, GIT_NO_REPLACE_OBJECTS: "1" };
  const git = (...args) => execFileSync("git", args, { cwd: root, env: gitEnvironment });
  const receipt = await json("architecture/foundation/source-policy-node-compatibility-evolution.json");
  assert.deepEqual(receipt, {
    schemaVersion: 1,
    predecessor: {
      revision: "ab8efe2874c0600ea3930b4fe72bfc68d173543d",
      blob: "ae4dd7771d60aaa7ba24bf1e56f553f9826d7a77",
      sha256: "073d904b6ed55ac5ae8d0738d2b50762cc65ef653ed647aa28e98b5d574370b0",
    },
    successor: {
      revision: "98b75f694a0c72ad26d2cab19ff56713676b56a6",
      blob: "0f633e5fc2d2bad14a08ea5467bc0a07d6bad682",
      sha256: "a8ab641089abd81b0bb4387ef47ecf63a193aba2051d6ed87a3b5e2c8fca1c4c",
    },
    committedAmendment: {
      revision: "8b104417d51fe95d77c7dfff623fb484ce3e759b",
      blob: "9beef0450e9f3e86e2819e874faf06e0f94efe5e",
      sha256: "85f4235863df10f71610f21a1ea3854253f19078b0af8b502875c27ddacf6610",
    },
  });
  const verifyEdge = (name, edge) => {
    assert.equal(git("rev-parse", "--verify", `${edge.revision}^{commit}`).toString().trim(), edge.revision, name);
    assert.equal(git("rev-parse", "--verify", `${edge.revision}:${policyPath}`).toString().trim(), edge.blob, name);
    const bytes = git("cat-file", "blob", edge.blob);
    assert.equal(sha256(bytes), edge.sha256, name);
    return bytes;
  };
  const committedBytes = Object.fromEntries(Object.entries(receipt).filter(([name]) => name !== "schemaVersion")
    .map(([name, edge]) => [name, verifyEdge(name, edge)]));
  assert.throws(() => verifyEdge("changed successor digest", {
    ...receipt.successor, sha256: receipt.predecessor.sha256,
  }));
  assert.throws(() => verifyEdge("changed amendment blob", {
    ...receipt.committedAmendment, blob: receipt.successor.blob,
  }));
  git("merge-base", "--is-ancestor", receipt.predecessor.revision, receipt.successor.revision);
  git("merge-base", "--is-ancestor", receipt.successor.revision, receipt.committedAmendment.revision);
  const liveBytes = await readFile(new URL(policyPath, root));
  assert.deepEqual(liveBytes, committedBytes.committedAmendment);
  assert.equal(execFileSync("git", ["hash-object", "--stdin"], { cwd: root, env: gitEnvironment, input: liveBytes }).toString().trim(),
    receipt.committedAmendment.blob);
  const successor = committedBytes.successor.toString("utf8");
  const marker = "- id: tooling.node-compatibility-ci";
  const markerIndex = successor.indexOf(marker);
  assert.ok(markerIndex > 0);
  const expectedAmendment = successor.slice(0, markerIndex) + successor.slice(markerIndex)
    .replace("    - node:assert/strict\n", "    - node:assert/strict\n    - node:child_process\n");
  assert.equal(committedBytes.committedAmendment.toString("utf8"), expectedAmendment);
  assert.notEqual(sha256(committedBytes.predecessor), receipt.successor.sha256);
  assert.notEqual(sha256(committedBytes.successor), receipt.committedAmendment.sha256);
  const policy = await yaml(policyPath);
  const byId = new Map(policy.boundaries.map(boundary => [boundary.id, boundary]));
  assert.deepEqual(byId.get("tooling.ordinary-postgres-ci")?.roots, [
    "scripts/ci/run-ordinary-postgres.mjs",
    "scripts/ci/run-ordinary-postgres.test.mjs",
  ]);
  assert.deepEqual(byId.get("tooling.node-compatibility-ci")?.roots, [
    "scripts/ci/audit-node-engine-compatibility.mjs",
    "scripts/ci/node-engine-compatibility.test.mjs",
    "scripts/ci/node-runtime-compatibility.test.mjs",
  ]);
});
