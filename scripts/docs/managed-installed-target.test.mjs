import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, cp, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { parse } from "yaml";
import { applyConsumerIntegration, checkConsumerIntegration, describeCanonicalConsumerAssets,
  planNodeConsumerIntegration } from "@agent-teams/docs-protocol-agent-teams";
import { observeDocsProtocolQualificationV3Lockfile, runDocsProtocolQualificationV3 }
  from "@agent-teams/docs-protocol-agent-teams/qualification";
import { readRetainedTargetCapture } from "./managed-target-captures.mjs";

const repository = new URL("../../", import.meta.url);
const digest = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const read = path => readFile(new URL(path, repository));

// This fresh synthetic target exercises installed contracts only. It never grants
// central Cohort authority, restores historical state, or changes consumer status.
test("installed managed target bootstrap, receipt and refusals remain TEST-only", async () => {
  const allocation = await realpath(await mkdtemp(join(tmpdir(), "TEST-runtime-managed-")));
  const consumerRoot = join(allocation, "target");
  const retainedRoot = join(allocation, "retained");
  const cleanupRoot = join(allocation, "cleanup");
  const authority = { retainedRoot, mutableTargetRoot: consumerRoot, cleanupRoots: [consumerRoot, cleanupRoot] };
  const captures = [];
  const retain = async (name, value) => {
    const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
    const expected = digest(bytes);
    const capture = { path: join(retainedRoot, name), sha256: expected };
    await writeFile(capture.path, bytes, { mode: 0o400, flag: "wx" });
    assert.deepEqual(await readRetainedTargetCapture(capture, expected, authority), bytes);
    captures.push(capture);
  };
  try {
    for (const root of [consumerRoot, retainedRoot, cleanupRoot]) {await mkdir(root);}
    execFileSync("git", ["init", "--quiet", consumerRoot]);
    const lockfileBytes = await read("pnpm-lock.yaml");
    const lock = parse(lockfileBytes.toString());
    const contract = JSON.parse(await read("scripts/docs/managed-target-contract.json"));
    const historical = JSON.parse(await read("architecture/foundation/docs-consumer-integration.json"));
    const coordinates = {
      repositoryMutation: "repository-mutation", documentAuthoring: "document-authoring",
      docsProtocol: "docs-protocol", docsProtocolAgentTeams: "docs-protocol-agent-teams",
      engineeringFoundation: "engineering-foundation",
    };
    const versions = { ...contract.directDevelopmentPackages, ...contract.transitiveCohortPackages };
    const packages = Object.fromEntries(Object.entries(coordinates).map(([key, suffix]) => {
      const name = `@agent-teams/${suffix}`, version = versions[name];
      return [key, { version, integrity: lock.packages[`${name}@${version}`].resolution.integrity }];
    }));
    const cohort = { ...historical.cohort, schemaVersion: 2,
      cohortId: "test-runtime-installed-bootstrap", packages,
      recordDigest: digest("TEST-only synthetic record"),
      qualificationEventDigest: digest("TEST-only synthetic qualification event"),
      schemas: { consumerIntegration: 3, managedState: 2, docsProtocol: 1 },
    };
    cohort.assets = describeCanonicalConsumerAssets(cohort);
    const profile = { ...historical, schemaVersion: 3,
      repository: { provider: "github", id: "1", nameWithOwner: "TEST/runtime-managed" }, cohort };
    const observation = await observeDocsProtocolQualificationV3Lockfile({ profile, lockfileBytes });
    cohort.runtime = { ...cohort.runtime, runtimeClosureDigest: observation.runtimeClosureDigest };
    const receipt = await runDocsProtocolQualificationV3({ profile, lockfileBytes,
      evidence: { packages, schemas: cohort.schemas, runtimeClosureDigest: observation.runtimeClosureDigest } });
    assert.equal(receipt.schemaVersion, 3);
    assert.equal(receipt.profileSchemaVersion, 3);
    assert.equal(receipt.cohort.schemaVersion, 2);
    assert.equal(receipt.schemas.managedState, 2);
    await retain("bootstrap-receipt.json", { authority: "TEST-only", receipt });
    for (const path of [".node-version", "pnpm-lock.yaml", "package.json", "architecture/foundation/docs-protocol.yaml"]) {
      await mkdir(dirname(join(consumerRoot, path)), { recursive: true });
      await cp(new URL(path, repository), join(consumerRoot, path));
    }
    await writeFile(join(consumerRoot, "architecture/foundation/docs-consumer-integration.json"), `${JSON.stringify(profile, null, 2)}\n`);
    const plan = await planNodeConsumerIntegration({ consumerRoot, to: cohort.cohortId });
    await retain("plan.json", plan);
    assert.equal(plan.outcome, "change-required", JSON.stringify(plan));
    const sourceSnapshot = async () => Promise.all([
      "package.json", "pnpm-lock.yaml", "architecture/foundation/docs-consumer-integration.json"
    ].map(async path => ({ path, bytes: (await readFile(join(consumerRoot, path))).toString("base64"),
      mode: (await stat(join(consumerRoot, path))).mode })));
    const beforeStale = await sourceSnapshot();
    const absentAssets = plan.plan.assets.filter(asset => asset.state === "absent");
    const stale = await applyConsumerIntegration({ consumerRoot, expect: digest("stale") });
    assert.equal(stale.outcome, "blocked", JSON.stringify(stale));
    assert.ok(stale.issues.some(issue => issue.code === "DOCS_CONSUMER_STALE_PLAN"));
    assert.deepEqual(await sourceSnapshot(), beforeStale);
    for (const asset of absentAssets) {
      await assert.rejects(readFile(join(consumerRoot, asset.path)), { code: "ENOENT" });
    }
    const applied = await applyConsumerIntegration({ consumerRoot, expect: plan.plan.planDigest });
    assert.equal(applied.outcome, "applied", JSON.stringify(applied));
    assert.equal(JSON.parse(await readFile(join(consumerRoot, profile.managedStatePath))).schemaVersion, 2);
    const snapshot = async () => Promise.all(plan.plan.assets.map(async asset => {
      const path = join(consumerRoot, asset.path);
      return { path: asset.path, bytes: (await readFile(path)).toString("base64"), mode: (await stat(path)).mode };
    }));
    const before = await snapshot();
    const current = await checkConsumerIntegration({ consumerRoot });
    assert.equal(current.outcome, "current", JSON.stringify(current));
    const repeated = await applyConsumerIntegration({ consumerRoot, expect: current.plan.planDigest });
    assert.equal(repeated.outcome, "current", JSON.stringify(repeated));
    assert.deepEqual(await snapshot(), before);
    await writeFile(join(consumerRoot, profile.skillPath), "TEST unknown asset\n");
    await chmod(join(consumerRoot, profile.skillPath), 0o600);
    const modified = await snapshot();
    const unknownPlan = await checkConsumerIntegration({ consumerRoot });
    const unknown = await applyConsumerIntegration({ consumerRoot, expect: unknownPlan.plan.planDigest });
    assert.equal(unknown.outcome, "blocked", JSON.stringify(unknown));
    assert.ok(unknown.issues.some(issue => issue.code === "DOCS_CONSUMER_UNKNOWN_MANAGED_ASSET"
      && issue.subject === profile.skillPath));
    assert.deepEqual(await snapshot(), modified);
    await retain("results.json", { authority: "TEST-only", applied, current, repeated, stale, unknown });
    assert.equal(captures.length, 3);
  } finally {await rm(allocation, { recursive: true, force: true });}
});
