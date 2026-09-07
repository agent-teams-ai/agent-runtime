import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { createEvidenceInputs } from "./runtime-setup-l0-evidence-inputs.mjs";
import { evidenceFiles, evidenceRoots } from "./runtime-setup-l0-evidence-spec.mjs";
import { validateCurrentEvidenceIdentity } from "./runtime-setup-l0-evidence-validation.mjs";

const fixture = async t => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "ar69-l0-inputs-test-"));
  t.after(() => rm(repositoryRoot, { recursive: true, force: true }));
  const env = Object.fromEntries(Object.entries(process.env)
    .filter(([key]) => !key.startsWith("GIT_")));
  const git = (...args) => execFileSync("git", [
    "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false",
    "-c", "user.name=Synthetic Evidence Test", "-c", "user.email=test@example.invalid",
    ...args,
  ], {
    cwd: repositoryRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    env: { ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_NO_LAZY_FETCH: "1" },
  });
  const write = async (path, content = `synthetic input: ${path}\n`) => {
    await mkdir(dirname(join(repositoryRoot, path)), { recursive: true });
    await writeFile(join(repositoryRoot, path), content);
  };
  git("init", "--quiet");
  git("config", "core.fileMode", "true");
  for (const root of Object.values(evidenceRoots).flat()) {
    await write(`${root}/input.ts`);
  }
  for (const path of Object.values(evidenceFiles).flat()) { await write(path); }
  git("add", ".");
  git("commit", "--quiet", "-m", "synthetic baseline");
  const revision = git("rev-parse", "HEAD").trim();
  const inputs = createEvidenceInputs({ repositoryRoot, git });
  const digests = await inputs.artifactDigests();
  const report = { sourceRevision: revision, artifactDigests: digests };
  const validate = async (retained = report, pinned = digests) => validateCurrentEvidenceIdentity(retained, {
    changes: [{ revision }], sourceRevisionArtifactDigests: pinned,
    currentArtifactDigests: await inputs.artifactDigests(),
  });
  await validate();
  inputs.assertEvidenceRootsClean();
  inputs.assertEvidenceRootsMatchRevision(revision);
  return { repositoryRoot, git, write, inputs, revision, digests, report, validate };
};

const mutations = [
  "packages/contexts/provider-access/src/input.ts",
  "packages/contexts/provider-access/tests/input.ts",
  "packages/contexts/agent-execution/tests/fixtures/input.ts",
  ...Object.values(evidenceFiles).flat(),
];

for (const path of mutations) {
  test(`only ${path} changing invalidates retained evidence`, async t => {
    const f = await fixture(t);
    await f.write(path, "changed input only\n");
    await assert.rejects(f.validate(), /no longer match the pinned source revision/u);
    assert.throws(f.inputs.assertEvidenceRootsClean, /must match the source revision/u);
    f.git("add", "--", path);
    assert.throws(f.inputs.assertEvidenceRootsClean, /must match the source revision/u);
    f.git("commit", "--quiet", "-m", "synthetic single input mutation");
    f.inputs.assertEvidenceRootsClean();
    assert.throws(() => f.inputs.assertEvidenceRootsMatchRevision(f.revision),
      /must match the retained product revision/u);
    await assert.rejects(f.validate(), /no longer match the pinned source revision/u);
    // Updating the current pin alone cannot repair a stale captured digest.
    await assert.rejects(f.validate(f.report, await f.inputs.artifactDigests()),
      /captured product source, tests, fixtures, or build inputs drifted/u);
  });
}

test("unchanged inputs remain reusable across unrelated commits; the source SHA stays exact", async t => {
  const f = await fixture(t);
  await f.write("unrelated/note.txt");
  f.git("add", ".");
  f.git("commit", "--quiet", "-m", "synthetic unrelated change");
  await f.validate();
  f.inputs.assertEvidenceRootsClean();
  f.inputs.assertEvidenceRootsMatchRevision(f.revision);
  await assert.rejects(f.validate({ ...f.report, sourceRevision: f.git("rev-parse", "HEAD").trim() }),
    /captured source revision must be the latest retained product change/u);
  await assert.rejects(f.validate({ ...f.report, sourceRevision: "not-a-sha" }), /did not match/u);
});

test("configured directories and files cannot disappear or become untracked silently", async t => {
  const f = await fixture(t);
  const path = "packages/contexts/provider-access/package.json";
  await rm(join(f.repositoryRoot, path));
  await assert.rejects(f.inputs.artifactDigests(), { code: "ENOENT" });
  await f.write(path);
  f.git("rm", "--cached", "--", path);
  await assert.rejects(f.inputs.artifactDigests(), /must be a tracked evidence input/u);
  const configured = createEvidenceInputs({
    repositoryRoot: f.repositoryRoot, git: f.git,
    roots: { ...evidenceRoots, sources: ["missing/src"] },
  });
  await assert.rejects(configured.artifactDigests(), { code: "ENOENT" });
  await mkdir(join(f.repositoryRoot, "missing/src"), { recursive: true });
  await assert.rejects(configured.artifactDigests(), /must contain tracked evidence inputs/u);
});

test("overlapping and reordered inputs preserve one sorted path/mode/content digest", async t => {
  const f = await fixture(t);
  const reordered = createEvidenceInputs({
    repositoryRoot: f.repositoryRoot, git: f.git,
    roots: Object.fromEntries(Object.entries(evidenceRoots).map(([category, roots]) =>
      [category, [...roots.toReversed(), ...roots]])),
    files: {
      ...evidenceFiles,
      sources: [...evidenceFiles.sources.toReversed(), ...evidenceFiles.sources,
        "packages/contexts/provider-access/src/input.ts"],
    },
  });
  assert.deepEqual(await reordered.artifactDigests(), f.digests);
  const expected = createHash("sha256");
  const paths = [...new Set([
    ...evidenceRoots.sources.map(root => `${root}/input.ts`), ...evidenceFiles.sources,
  ])].toSorted((left, right) => left.localeCompare(right));
  for (const path of paths) {
    const sha = createHash("sha256").update(await readFile(join(f.repositoryRoot, path))).digest("hex");
    expected.update(`${path}\0${"100644"}\0${sha}\n`);
  }
  assert.deepEqual(f.digests.sources, { fileCount: paths.length, sha256: expected.digest("hex") });
});

test("untracked PA input is dirty while generated and unrelated paths stay outside the inputs", async t => {
  const f = await fixture(t);
  for (const path of [
    "packages/contexts/provider-access/dist/generated.js",
    "packages/contexts/provider-access/.cache/tsconfig.tsbuildinfo",
    "node_modules/synthetic/index.js", "unrelated/secret.txt",
  ]) { await f.write(path); }
  f.inputs.assertEvidenceRootsClean();
  await f.validate();
  await f.write("packages/contexts/provider-access/src/new.ts");
  assert.throws(f.inputs.assertEvidenceRootsClean, /must match the source revision/u);
});

test("executable mode and path identity participate in the digest", async t => {
  const f = await fixture(t);
  const path = "packages/platform/filesystem-custody/scripts/build-native-helper.mjs";
  await chmod(join(f.repositoryRoot, path), 0o755);
  assert.throws(f.inputs.assertEvidenceRootsClean, /must match the source revision/u);
  f.git("add", "--", path);
  await assert.rejects(f.validate(), /no longer match the pinned source revision/u);
  await chmod(join(f.repositoryRoot, path), 0o644);
  f.git("add", "--", path);
  await f.validate();
  f.git("mv", "packages/contexts/provider-access/src/input.ts",
    "packages/contexts/provider-access/src/renamed.ts");
  await assert.rejects(f.validate(), /no longer match the pinned source revision/u);
});

test("configured input symlinks and unresolved index stages remain rejected", async t => {
  const f = await fixture(t);
  const path = "packages/contexts/provider-access/package.json";
  await rm(join(f.repositoryRoot, path));
  await symlink("tsconfig.json", join(f.repositoryRoot, path));
  await assert.rejects(f.inputs.artifactDigests(), /must be a regular evidence file/u);
  f.git("add", "--", path);
  await assert.rejects(f.inputs.artifactDigests(), /evidence roots allow regular files only/u);
  const conflicted = createEvidenceInputs({
    repositoryRoot: f.repositoryRoot,
    git: () => `100644 ${"a".repeat(40)} 2\t${path}\0`,
  });
  await assert.rejects(conflicted.artifactDigests(), /unresolved Git index stage/u);
});
