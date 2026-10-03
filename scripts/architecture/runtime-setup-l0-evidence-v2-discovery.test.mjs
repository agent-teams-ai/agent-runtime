import {v2Inputs, v2InputsAtRevision} from "./runtime-setup-l0-evidence-v2-inputs.mjs";
import assert from "node:assert/strict";
import {test} from "node:test";
import {execFileSync, spawnSync} from "node:child_process";
import * as fs from "node:fs";
import {constants, cpSync, mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join, resolve} from "node:path";

const git = (root, ...args) => execFileSync("git", args, {cwd: root, encoding: "utf8"}).trim();

export function registerSourceDiscoveryTests() {
test("SOURCE rejects every real Foundation manifest and topology observation", async t => {
  // This clone is a NEW disposable project. The checker runs with the pinned
  // installed Foundation reader; each case must first alter its real result.
  const root = mkdtempSync(join(tmpdir(), "v2-source-discovery-"));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  execFileSync("git", ["clone", "--quiet", "--shared", "--no-hardlinks", process.cwd(), root]);
  // Keep the disposable checkout's installation physically independent.
  cpSync(resolve("node_modules"), resolve(root, "node_modules"),
    {recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE});
  const {checkAdoption} = await import("./check-get-modular-adoption.mjs");
  const revision = git(root, "rev-parse", "HEAD");
  const baseline = v2Inputs(root, revision);
  assert.equal((await checkAdoption(root)).status, "verified");
  const put = (path, content) => {
    fs.mkdirSync(resolve(root, path, ".."), {recursive: true});
    if (content === null) {fs.mkdirSync(resolve(root, path));}
    else {writeFileSync(resolve(root, path), content);}
  };
  const remove = path => rmSync(resolve(root, path), {recursive: true, force: true});
  const cases = [
    // Removing either manifest observation from the guard makes these red:
    // Foundation sees an authority outside packageRoots, but SOURCE stays equal.
    ["scripts/package.json", '{"name":"@review/ancestor","type":"module"}', /WORKSPACE_PACKAGE_OUTSIDE_PACKAGE_ROOTS/u],
    ["packages/package.json", '{"name":"@review/ancestor","type":"module"}', /WORKSPACE_PACKAGE_OUTSIDE_PACKAGE_ROOTS/u],
    ["packages/apps/package.json", '{"name":"@review/ancestor","type":"module"}', /WORKSPACE_PACKAGE_OUTSIDE_PACKAGE_ROOTS/u],
    ["packages/contexts/package.json", '{"name":"@review/ancestor","type":"module"}', /WORKSPACE_PACKAGE_OUTSIDE_PACKAGE_ROOTS/u],
    ["packages/platform/package.json", '{"name":"@review/ancestor","type":"module"}', /WORKSPACE_PACKAGE_OUTSIDE_PACKAGE_ROOTS/u],
    ["scripts/package.json", null, /PACKAGE_MANIFEST_INVALID/u],
    // The invalid and non-file variants prove absence and regular-file identity.
    ["scripts/ci/.cache/package.json", "{invalid", /PACKAGE_MANIFEST_INVALID/u],
    ["scripts/ci/.cache/package.json", null, /PACKAGE_MANIFEST_INVALID/u],
  ];
  for (const [path, content, diagnostic] of cases) {await t.test(`observed manifest: ${path} (${content === null ? "directory" : "file"})`, async () => {
    put(path, content);
    try {
      await assert.rejects(checkAdoption(root), diagnostic);
      assert.throws(() => v2Inputs(root, revision), /source discovery|package manifest|discovered input|committed and clean/u);
      assert.deepEqual(v2InputsAtRevision(root, revision), baseline);
    } finally {remove(path);}
  });}
  if (process.platform !== "win32") {await t.test("ignored FIFO manifest rejects regular-file identity", async () => {
    const path = "scripts/ci/.cache/package.json";
    fs.mkdirSync(resolve(root, path, ".."), {recursive: true});
    const created = spawnSync("mkfifo", [resolve(root, path)]);
    assert.equal(created.status, 0, "disposable FIFO fixture must be created");
    try {
      await assert.rejects(checkAdoption(root), /SOURCE_DIRECTORY_INVALID/u);
      assert.throws(() => v2Inputs(root, revision), /package manifest must be a regular file/u);
    } finally {remove(path);}
  });}
  const topology = [
    // Each empty-directory case is invisible to a source-extension scan.
    ["workspace case", ["packages/apps/EMBEDDED-RUNTIME"], /PACKAGE_PATH_CASE_COLLISION/u],
    ["workspace NFC", ["packages/apps/r164-unicode/é", "packages/apps/r164-unicode/e\u0301"], /PACKAGE_PATH_CASE_COLLISION/u],
    ["ignored nested case", ["scripts/ci/.cache/r164-case/ONE", "scripts/ci/.cache/r164-case/one"], /PACKAGE_PATH_CASE_COLLISION/u],
    ["repository root case", ["r164-root/ONE", "r164-root/one"], /PACKAGE_PATH_CASE_COLLISION/u],
    ["unsafe directory name", ["packages/apps/r164\\entry"], /WORKSPACE_GLOB_CANDIDATE_INVALID/u],
  ];
  for (const [name, paths, diagnostic] of topology) {await t.test(name, async () => {
    for (const path of paths) {fs.mkdirSync(resolve(root, path), {recursive: true});}
    try {
      await assert.rejects(checkAdoption(root), diagnostic);
      assert.throws(() => v2Inputs(root, revision), /portable collision|unsafe workspace entry/u);
      assert.deepEqual(v2InputsAtRevision(root, revision), baseline);
    } finally {for (const path of paths) {remove(path);}}
  });}
  // A valid ignored nested type scope can pass Foundation; it still changes
  // the observed type map and therefore cannot keep the receipt identity.
  put("scripts/ci/.cache/r164-scope/package.json", '{"type":"module"}');
  try {
    await checkAdoption(root);
    assert.throws(() => v2Inputs(root, revision), /discovered input is not committed/u);
  } finally {remove("scripts/ci/.cache/r164-scope");}
  for (const type of ["module", "commonjs"]) {await t.test(`pure ${type} scope keeps ignored generated source in SOURCE`, async () => {
    const scope = "packages/apps/embedded-runtime/.cache";
    const manifest = `${scope}/package.json`;
    put(manifest, JSON.stringify({type}));
    git(root, "add", "-f", manifest);
    execFileSync("git", ["-c", "user.name=Disposable", "-c", "user.email=disposable@example.invalid",
      "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "disposable module scope"], {cwd: root});
    try {
      const current = git(root, "rev-parse", "HEAD");
      assert.equal((await checkAdoption(root)).status, "verified");
      const scoped = v2Inputs(root, current);
      assert.ok(scoped.inputs.some(input => input.path === manifest));
      for (const output of ["dist", "coverage"]) {
        const source = `${scope}/${output}/unbound.ts`;
        put(source, "export const unbound = 1;\n");
        try {
          await assert.rejects(checkAdoption(root), /architecture\.source-dependencies\.unclassified-source-file/u);
          assert.throws(() => v2Inputs(root, current), /discovered input is not committed/u);
        } finally {remove(`${scope}/${output}`);}
      }
    } finally {git(root, "reset", "--hard", revision); remove(scope);}
  });}
  await t.test("package authority keeps generated output excluded", async () => {
    const scope = "packages/apps/embedded-runtime/.cache";
    const manifest = `${scope}/package.json`;
    put(manifest, '{"name":"@review/nested","type":"module"}');
    git(root, "add", "-f", manifest);
    execFileSync("git", ["-c", "user.name=Disposable", "-c", "user.email=disposable@example.invalid",
      "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "disposable package authority"], {cwd: root});
    try {
      const current = git(root, "rev-parse", "HEAD");
      const owned = v2Inputs(root, current);
      for (const output of ["dist", "coverage"]) {
        put(`${scope}/${output}/generated.ts`, "export const generated = 1;\n");
        try {
          assert.deepEqual(v2Inputs(root, current), owned);
        } finally {remove(`${scope}/${output}`);}
      }
    } finally {git(root, "reset", "--hard", revision); remove(scope);}
  });
  await t.test("selected package authority allows generated output in real checker", async () => {
    for (const output of ["dist", "coverage"]) {
      const generated = `packages/apps/embedded-runtime/${output}/generated.ts`;
      put(generated, "export const generated = 1;\n");
      try {
        assert.equal((await checkAdoption(root)).status, "verified");
        assert.deepEqual(v2Inputs(root, revision), baseline);
      } finally {remove(`packages/apps/embedded-runtime/${output}`);}
    }
  });
  for (const path of ["scripts/package.json", "packages/package.json",
    "packages/apps/package.json", "packages/contexts/package.json", "packages/platform/package.json"]) {
    await t.test(`committed ancestor bound against old revision: ${path}`, () => {
    put(path, '{"name":"@review/ancestor","type":"module"}');
    git(root, "add", path);
    execFileSync("git", ["-c", "user.name=Disposable", "-c", "user.email=disposable@example.invalid",
      "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "disposable manifest"], {cwd: root});
    const current = git(root, "rev-parse", "HEAD");
    assert.ok(v2Inputs(root, current).inputs.some(input => input.path === path));
    assert.throws(() => v2Inputs(root, revision), /source\/input mismatch/u);
    git(root, "reset", "--hard", revision);
  });}
  // With both paths committed, Git's selected inventory contains both. Only
  // the reader's portable source identity rule can make these tests red.
  for (const [name, paths] of [
    ["case", ["scripts/ci/.cache/r164-source/ONE.ts", "scripts/ci/.cache/r164-source/one.ts"]],
    ["NFC", ["scripts/ci/.cache/r164-source/é.ts", "scripts/ci/.cache/r164-source/e\u0301.ts"]],
  ]) {await t.test(`committed source file ${name} collision rejects at own revision`, async () => {
    for (const [index, path] of paths.entries()) {put(path, `export const value${index} = ${index};\n`);}
    git(root, "add", "-f", ...paths);
    execFileSync("git", ["-c", "user.name=Disposable", "-c", "user.email=disposable@example.invalid",
      "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "disposable source collision"], {cwd: root});
    try {
      const current = git(root, "rev-parse", "HEAD");
      await assert.rejects(checkAdoption(root), /SOURCE_PATH_CASE_COLLISION/u);
      assert.throws(() => v2Inputs(root, current), /source file portable collision/u);
      assert.throws(() => v2Inputs(root, revision), /source\/input mismatch/u);
    } finally {git(root, "reset", "--hard", revision);}
  });}
  writeFileSync(resolve(root, "r164-unrelated.txt"), "ordinary file\n");
  assert.deepEqual(v2Inputs(root, revision), baseline, "ordinary unrelated files remain allowed");
  await checkAdoption(root);
});
}
