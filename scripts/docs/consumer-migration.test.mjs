import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import test from "node:test";
import { parseDocument } from "yaml";

const root = new URL("../../", import.meta.url);
const read = path => readFile(new URL(path, root), "utf8");
const json = async path => JSON.parse(await read(path));
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const objectId = (type, bytes) => createHash("sha1")
  .update(Buffer.from(`${type} ${bytes.length}\0`)).update(bytes).digest("hex");
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
  // Retain the small Git commit/tree path proof because the Docs Protocol checkout is depth 1.
  // Git object hashes authenticate each retained object's bytes and bind each policy blob to its commit.
  const fixture = await json("scripts/docs/fixtures/source-policy-historic-git-objects.json");
  assert.equal(fixture.schemaVersion, 1);
  const historicObject = (type, id) => {
    const object = fixture.objects[id];
    assert.equal(object?.type, type, id);
    const bytes = Buffer.from(object.bytes, "base64");
    assert.equal(objectId(type, bytes), id, id);
    return bytes;
  };
  const commitHeader = id => historicObject("commit", id).toString("utf8").split("\n\n", 1)[0];
  const parent = id => {
    const parents = [...commitHeader(id).matchAll(/^parent ([0-9a-f]{40})$/gmu)];
    assert.equal(parents.length, 1, id);
    return parents[0][1];
  };
  const intermediate1 = parent(receipt.committedAmendment.revision);
  const intermediate2 = parent(intermediate1);
  assert.equal(parent(intermediate2), receipt.successor.revision);
  assert.equal(parent(receipt.successor.revision), receipt.predecessor.revision);
  const treeEntry = (treeId, name, mode) => {
    const tree = historicObject("tree", treeId);
    const matches = [];
    for (let offset = 0; offset < tree.length;) {
      const space = tree.indexOf(0x20, offset);
      const nul = tree.indexOf(0, space + 1);
      assert.ok(space > offset && nul > space && nul + 21 <= tree.length, treeId);
      const entryMode = tree.toString("ascii", offset, space);
      const entryName = tree.toString("utf8", space + 1, nul);
      if (entryName === name) {
        matches.push({ mode: entryMode, id: tree.subarray(nul + 1, nul + 21).toString("hex") });
      }
      offset = nul + 21;
    }
    assert.equal(matches.length, 1, `${treeId}:${name}`);
    assert.equal(matches[0].mode, mode, `${treeId}:${name}`);
    return matches[0].id;
  };
  const verifyEdge = (name, edge, bytes) => {
    const tree = /^tree ([0-9a-f]{40})$/mu.exec(commitHeader(edge.revision));
    assert.ok(tree, name);
    const architecture = treeEntry(tree[1], "architecture", "40000");
    const foundation = treeEntry(architecture, "foundation", "40000");
    assert.equal(treeEntry(foundation, "source-dependencies.yaml", "100644"), edge.blob, name);
    assert.equal(objectId("blob", bytes), edge.blob, name);
    assert.equal(sha256(bytes), edge.sha256, name);
    return bytes;
  };
  const liveBytes = await readFile(new URL(policyPath, root));
  const amendment = liveBytes.toString("utf8");
  const marker = "- id: tooling.node-compatibility-ci";
  const markerIndex = amendment.indexOf(marker);
  assert.ok(markerIndex > 0);
  const amendmentLine = "    - node:assert/strict\n    - node:child_process\n";
  assert.equal(amendment.slice(markerIndex).split(amendmentLine).length, 2);
  const successor = amendment.slice(0, markerIndex) + amendment.slice(markerIndex)
    .replace(amendmentLine, "    - node:assert/strict\n");
  const scopedRoots = "  - scripts/ci/run-ordinary-postgres.mjs\n  - scripts/ci/run-ordinary-postgres.test.mjs\n";
  assert.equal(successor.slice(0, markerIndex).split(scopedRoots).length, 2);
  const predecessor = successor.slice(0, markerIndex).replace(scopedRoots, "  - scripts/ci\n");
  const committedBytes = {
    predecessor: verifyEdge("predecessor", receipt.predecessor, Buffer.from(predecessor)),
    successor: verifyEdge("successor", receipt.successor, Buffer.from(successor)),
    committedAmendment: verifyEdge("committed amendment", receipt.committedAmendment, liveBytes),
  };
  assert.throws(() => verifyEdge("changed successor digest", {
    ...receipt.successor, sha256: receipt.predecessor.sha256,
  }, committedBytes.successor));
  assert.throws(() => verifyEdge("changed amendment blob", {
    ...receipt.committedAmendment, blob: receipt.successor.blob,
  }, committedBytes.committedAmendment));
  assert.throws(() => verifyEdge("changed historical bytes", receipt.predecessor,
    Buffer.from(predecessor.replace("  - scripts/ci\n", "  - scripts/ci/altered\n"))));
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
