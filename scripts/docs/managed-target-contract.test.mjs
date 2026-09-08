import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { glob, link, lstat, mkdir, mkdtemp, open, readFile, realpath, rename, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MAX_TARGET_CAPTURE_BYTES, readRetainedTargetCapture } from "./managed-target-captures.mjs";

const root = new URL("../../", import.meta.url);
const read = path => readFile(new URL(path, root), "utf8");
const hash = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const contract = JSON.parse(await read("scripts/docs/managed-target-contract.json"));

test("managed projection is exact registry dev-only tooling with immutable scenario 2", async () => {
  const manifest = JSON.parse(await read("package.json"));
  assert.equal(manifest.packageManager, contract.packageManager);
  const workspace = await read("pnpm-workspace.yaml");
  const policy = await read("architecture/foundation/dependency-declarations.yaml");
  for (const [name, version] of Object.entries(contract.directDevelopmentPackages)) {
    assert.equal(manifest.devDependencies[name], version);
    for (const section of ["dependencies", "optionalDependencies", "peerDependencies"]) {
      assert.equal(Object.hasOwn(manifest[section] ?? {}, name), false);
    }
    assert.ok(workspace.includes(`  - "${name}@${version}"`));
    assert.ok(policy.split("exactRegistryDevelopmentOnlyPackages:\n")[1].includes(`    - "${name}"`));
  }
  const exclusions = workspace.split("minimumReleaseAgeExclude:\n")[1].split("\n")
    .map(line => line.trim().replace(/^- ["']/u, "").replace(/["']$/u, ""))
    .filter(value => value.startsWith("@agent-teams/"));
  assert.deepEqual(exclusions.sort(), Object.entries({
    ...contract.directDevelopmentPackages, ...contract.transitiveCohortPackages
  }).map(([name, version]) => `${name}@${version}`).sort());
  for (const name of Object.keys(contract.transitiveCohortPackages)) {
    assert.equal(Object.hasOwn(manifest.devDependencies, name), false);
  }
  for await (const path of glob(["packages/**/package.json", "experiments/**/package.json"], { cwd: root })) {
    const child = JSON.parse(await read(path));
    for (const section of ["dependencies", "optionalDependencies", "peerDependencies"]) {
      for (const name of Object.keys(contract.directDevelopmentPackages)) {
        assert.equal(Object.hasOwn(child[section] ?? {}, name), false, `${path}: ${section}: ${name}`);
      }
    }
  }
  const scenario = await read(contract.scenario.path);
  assert.equal(hash(scenario), contract.scenario.sha256);
  assert.equal(JSON.parse(scenario).schemaVersion, 2);
  assert.equal(JSON.parse(scenario).scenarios.length, 5);
  assert.deepEqual(contract.target, { consumerIntegration: 3, cohort: 2, managedState: 2, qualificationReceipt: 3, scenario: 2 });
  assert.equal(contract.custodyPrerequisite.maxBytes, MAX_TARGET_CAPTURE_BYTES);
  assert.deepEqual(contract.custodyPrerequisite.independentlySelectedArguments,
    ["expectedSha256", "authority.retainedRoot", "authority.mutableTargetRoot", "authority.cleanupRoots"]);
  assert.equal(contract.gateInvocation, null);
  assert.equal(contract.status, "pending-installed-evidence");
});

test("retained target binding rejects missing, transplanted and changed evidence", async () => {
  const fixture = await realpath(await mkdtemp(join(tmpdir(), "runtime-managed-capture-")));
  try {
    const authority = {
      retainedRoot: join(fixture, "retained"),
      mutableTargetRoot: join(fixture, "target"),
      cleanupRoots: [join(fixture, "cleanup")],
    };
    for (const path of [authority.retainedRoot, authority.mutableTargetRoot, ...authority.cleanupRoots]) {
      await mkdir(path);
    }
    // Arbitrary bytes exercise custody only; these are not fabricated product receipts.
    for (const binding of contract.requiredIndependentBindings) {
      const path = join(authority.retainedRoot, binding);
      const bytes = `disposable ${binding} capture\n`;
      const expected = hash(bytes);
      await writeFile(path, bytes);
      const capture = { path, sha256: expected };
      assert.equal((await readRetainedTargetCapture(capture, expected, authority)).toString(), bytes);
      await assert.rejects(readRetainedTargetCapture(null, expected, authority), /missing target evidence/u);
      await assert.rejects(readRetainedTargetCapture(capture, hash("another target"), authority), /mismatched target evidence selection/u);
      for (const excluded of [authority.mutableTargetRoot, ...authority.cleanupRoots]) {
        const source = join(excluded, binding);
        await writeFile(source, bytes);
        const directoryAlias = join(authority.retainedRoot, "directory-alias");
        const hardlinkAlias = join(authority.retainedRoot, "hardlink-alias");
        const leafAlias = join(authority.retainedRoot, "leaf-alias");
        await symlink(excluded, directoryAlias, "dir");
        await link(source, hardlinkAlias);
        await symlink(source, leafAlias);
        for (const alias of [join(directoryAlias, binding), hardlinkAlias, leafAlias, source]) {
          await assert.rejects(readRetainedTargetCapture({ path: alias, sha256: expected }, expected, authority),
            /symbolic links|exactly one link|escapes retained root/u);
        }
        for (const alias of [directoryAlias, hardlinkAlias, leafAlias]) {await rm(alias);}
      }
      await writeFile(path, "tampered");
      await assert.rejects(readRetainedTargetCapture(capture, expected, authority), /mismatched target evidence bytes/u);
      await rm(path);
      await assert.rejects(readRetainedTargetCapture(capture, expected, authority), { code: "ENOENT" });
    }
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

const custodyFixture = async run => {
  const fixture = await realpath(await mkdtemp(join(tmpdir(), "runtime-custody-regression-")));
  try {
    const authority = {
      retainedRoot: join(fixture, "retained"), mutableTargetRoot: join(fixture, "target"),
      cleanupRoots: [join(fixture, "cleanup"), join(fixture, "second-cleanup")],
    };
    for (const path of [authority.retainedRoot, authority.mutableTargetRoot, ...authority.cleanupRoots]) {
      await mkdir(path);
    }
    const bytes = Buffer.from("Independent disposable custody observation; not a receipt.\n");
    const expected = hash(bytes);
    const path = join(authority.retainedRoot, "capture");
    await writeFile(path, bytes);
    await run({ fixture, authority, bytes, expected, capture: { path, sha256: expected } });
  } finally {await rm(fixture, { recursive: true, force: true });}
};

test("canonical retained-root and complete exclusion authority are mandatory", () => custodyFixture(async ctx => {
  const { fixture, authority, capture, expected, bytes } = ctx;
  for (const invalid of [undefined, {}, { ...authority, cleanupRoots: [] },
    { ...authority, mutableTargetRoot: undefined }, { ...authority, retainedRoot: fixture },
    { ...authority, retainedRoot: authority.mutableTargetRoot },
    { ...authority, cleanupRoots: [fixture] },
    { ...authority, cleanupRoots: [...authority.cleanupRoots, authority.retainedRoot] },
    { ...authority, retainedRoot: `${authority.retainedRoot}/../retained` },
    { ...authority, cleanupRoots: [join(fixture, "missing")] },
  ]) {
    await assert.rejects(readRetainedTargetCapture(capture, expected, invalid));
  }
  for (const key of ["retainedRoot", "mutableTargetRoot", "cleanupRoots"]) {
    const alias = join(fixture, "root-alias");
    await symlink(key === "cleanupRoots" ? authority.cleanupRoots[0] : authority[key], alias, "dir");
    const invalid = { ...authority, [key]: key === "cleanupRoots" ? [alias] : alias };
    await assert.rejects(readRetainedTargetCapture(capture, expected, invalid));
    await rm(alias);
  }
  // Root ancestors are checked too, including exclusions supplied through aliases.
  const ancestor = join(fixture, "ancestor-alias");
  await symlink(fixture, ancestor, "dir");
  await assert.rejects(readRetainedTargetCapture(capture, expected,
    { ...authority, cleanupRoots: [join(ancestor, "cleanup")] }), /symbolic links/u);
  await assert.rejects(readRetainedTargetCapture(
    { ...capture, path: join(ancestor, "retained", "capture") }, expected,
    { ...authority, retainedRoot: join(ancestor, "retained") }), /symbolic links/u);
  const sibling = join(fixture, "retained-sibling");
  await mkdir(sibling);
  await writeFile(join(sibling, "capture"), bytes);
  await assert.rejects(readRetainedTargetCapture({ ...capture, path: join(sibling, "capture") }, expected, authority),
    /escapes retained root/u);
  assert.deepEqual(await readRetainedTargetCapture(capture, expected, authority), bytes);
}));

test("reviewer malformed and non-regular capture regressions fail closed", () => custodyFixture(async ctx => {
  const { capture, expected, authority } = ctx;
  for (const invalid of [null, undefined, {}, { path: capture.path }, { ...capture, extra: true },
    { ...capture, authority }, { ...capture, path: "relative" },
    { ...capture, path: authority.retainedRoot }, { ...capture, path: join(authority.retainedRoot, "missing") }]) {
    await assert.rejects(readRetainedTargetCapture(invalid, expected, authority));
  }
  for (const digest of [undefined, null, "bad", `sha256:${"A".repeat(64)}`]) {
    await assert.rejects(readRetainedTargetCapture(capture, digest, authority));
  }
}));

test("capture byte budget is enforced before allocation and at the read boundary", () => custodyFixture(async ctx => {
  const { capture, expected, authority, bytes } = ctx;
  for (const maxBytes of [0, -1, NaN, Infinity, 1.5, MAX_TARGET_CAPTURE_BYTES + 1]) {
    await assert.rejects(readRetainedTargetCapture(capture, expected, authority, { maxBytes }), /byte budget/u);
  }
  await assert.rejects(readRetainedTargetCapture(capture, expected, authority, { maxBytes: bytes.length - 1 }), /byte budget/u);
  assert.deepEqual(await readRetainedTargetCapture(capture, expected, authority, { maxBytes: bytes.length }), bytes);
  await truncate(capture.path, MAX_TARGET_CAPTURE_BYTES + 1);
  await assert.rejects(readRetainedTargetCapture(capture, expected, authority), /byte budget/u);
}));

// Deterministic race injection around real descriptors; no clocks or timing luck.
for (const mutation of ["replace-before-open", "ancestor-before-open", "hardlink-during-read",
  "replace-during-read", "ancestor-during-read", "grow-during-read", "cleanup-during-read"]) {
  test(`descriptor custody rejects ${mutation} and closes the handle`, () => custodyFixture(async ctx => {
    const { authority, capture, expected, bytes, fixture } = ctx;
    let closed = false;
    let reads = 0;
    const replaceFile = async () => {
      await rename(capture.path, `${capture.path}.old`);
      await writeFile(capture.path, bytes);
    };
    const replaceAncestor = async () => {
      await rename(authority.retainedRoot, `${authority.retainedRoot}.old`);
      await symlink(`${authority.retainedRoot}.old`, authority.retainedRoot, "dir");
    };
    const fileSystem = { lstat, realpath, open: async (path, flags) => {
      const { constants } = await import("node:fs");
      assert.ok((flags & constants.O_NOFOLLOW) !== 0);
      assert.ok((flags & constants.O_NONBLOCK) !== 0);
      if (mutation === "replace-before-open") {await replaceFile();}
      if (mutation === "ancestor-before-open") {await replaceAncestor();}
      const handle = await open(path, flags);
      return {
        stat: options => handle.stat(options),
        close: async () => {closed = true; await handle.close();},
        read: async (...args) => {
          reads += 1;
          if (reads === 1) {
            if (mutation === "hardlink-during-read") {await link(capture.path, join(authority.mutableTargetRoot, "alias"));}
            if (mutation === "replace-during-read") {await replaceFile();}
            if (mutation === "ancestor-during-read") {await replaceAncestor();}
            if (mutation === "grow-during-read") {await truncate(capture.path, bytes.length + 1);}
            if (mutation === "cleanup-during-read") {
              await rename(authority.cleanupRoots[1], join(fixture, "old-cleanup"));
              await mkdir(authority.cleanupRoots[1]);
            }
          }
          return handle.read(...args);
        },
      };
    } };
    await assert.rejects(readRetainedTargetCapture(capture, expected, authority,
      { fileSystem, maxBytes: bytes.length }), /changed|symbolic links|singly-linked|byte budget/u);
    assert.equal(closed, true);
    if (mutation.endsWith("before-open")) {assert.equal(reads, 0);}
  }));
}
