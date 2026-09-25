import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, chmodSync, linkSync, mkdtempSync, mkdirSync, readFileSync, readSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, truncateSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import test from "node:test";
import { inspectArchive, readBoundedArchive } from "./archive.mjs";
import { assertExternalOutput, collect, git, inspectSource, installedFiles, inventoryKey } from "./collect.mjs";
import { run, writeProtectedOutput } from "./index.mjs";
import { inspectSurface } from "./surface.mjs";

const repository = resolvePath(dirname(fileURLToPath(import.meta.url)), "../..");
const fixture = readFileSync(new URL("./fixtures/filesystem-custody-retained.tgz", import.meta.url));
const commit = "765bbfbb6a3a59906d052706396309f0cb8a61fc";
const tree = execFileSync("git", ["-C", repository, "rev-parse", `${commit}^{tree}`], { encoding: "utf8" }).trim();
const digest = bytes => createHash("sha256").update(bytes).digest("hex");

function tar(members) {
  const chunks = [];
  for (const { name, bytes = Buffer.from("x"), kind = "0", link = "" } of members) {
    const header = Buffer.alloc(512);
    header.write(name, 0, 100, "ascii");
    header.write("0000644\0", 100, "ascii");
    header.write("0000000\0", 108, "ascii");
    header.write("0000000\0", 116, "ascii");
    header.write(bytes.length.toString(8).padStart(11, "0") + "\0", 124, "ascii");
    header.write("00000000000\0", 136, "ascii");
    header.fill(32, 148, 156);
    header.write(kind, 156, "ascii");
    header.write(link, 157, 100, "ascii");
    header.write("ustar\0", 257, "ascii");
    const sum = header.reduce((total, byte) => total + byte, 0);
    header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, "ascii");
    chunks.push(header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
  }
  chunks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(chunks));
}

test("retained real archive has distinct transport and canonical identities", () => {
  const archive = inspectArchive(fixture);
  assert.equal(archive.files.size, 35);
  assert.equal(archive.transport.sha256, "b0a569272d49e1b89372c0700b2978ecb3d9849054595b71bc3465269dfaa4bb");
  assert.equal(archive.canonical.sha256, "b7da47f5a8d5109de784dde4aa31cd25d955ea29ab507c9aee6ad8d160ecec57");
  assert.equal(digest(Buffer.from(archive.canonical.payload)), archive.canonical.sha256);
  assert.notEqual(archive.transport.integrity, archive.canonical.integrity);
  const recompressed = Buffer.from(fixture);
  recompressed[4] ^= 1;
  const changed = inspectArchive(recompressed);
  assert.notEqual(changed.transport.sha256, archive.transport.sha256);
  assert.equal(changed.canonical.sha256, archive.canonical.sha256);
});

test("archive reader rejects unsafe names, links, duplicate paths and resource excess", () => {
  for (const member of [
    { name: "package/../escape" }, { name: "/absolute" }, { name: "package/a:b" },
    { name: "package/a?b" }, { name: "package/a|b" },
    { name: "package/link", kind: "2", link: "package/file" },
    { name: "package/huge", bytes: Buffer.alloc(16 * 1024 * 1024 + 1) }
  ]) {assert.throws(() => inspectArchive(tar([member])), /archive:/u); }
  assert.throws(() => inspectArchive(tar([{ name: "package/A" }, { name: "package/a" }])), /collision/u);
  assert.throws(() => inspectArchive(tar([{ name: "package/A/x" }, { name: "package/a/y" }])), /directory case collision/u);
  assert.throws(() => inspectArchive(tar([{ name: "package/a" }, { name: "package/a/b" }])), /collision/u);
  assert.throws(() => inspectArchive(fixture.subarray(0, fixture.length - 10)), /archive:|unexpected end|incorrect/u);
});

test("both ordered public branches and the native census remain incomplete without witnesses", () => {
  const source = inspectSource(repository, commit, tree);
  const files = inspectArchive(fixture).files;
  const surface = inspectSurface(source.sourceManifest, source.sourceManifest, files);
  assert.equal(surface.nativeClosure, "incomplete");
  assert.equal(surface.typedClosure, "incomplete");
  const changed = structuredClone(source.sourceManifest);
  changed.exports["./composition"] = { import: "./dist/composition.js", types: "./dist/composition.d.ts" };
  assert.throws(() => inspectSurface(source.sourceManifest, changed, files), /conditions changed/u);
  assert.throws(() => inspectSurface(source.sourceManifest, source.sourceManifest,
    new Map([...files].filter(([path]) => path !== "dist/rename-no-replace.node"))), /native member missing/u);
  assert.throws(() => inspectSurface(source.sourceManifest, source.sourceManifest,
    new Map([...files].filter(([path]) => path !== "dist/composition.d.ts"))), /target/u);
});

test("source and independently read installed tree are bound to complete identity", () => {
  const source = inspectSource(repository, commit, tree);
  assert.equal(source.package, "@agent-teams/filesystem-custody");
  assert.throws(() => inspectSource(repository, commit, "0".repeat(40)), /mismatch/u);
  assert.throws(() => inspectSource(repository, "4043cb68d8bfb389d952b28233ce9a992e00a832", tree), /mismatch/u);
  const archive = inspectArchive(fixture);
  const sandbox = mkdtempSync(join(tmpdir(), "ar-source-collector-test-"));
  try {
    const otherRepository = join(sandbox, "other-repository");
    mkdirSync(otherRepository);
    execFileSync("git", ["init", "-q", otherRepository]);
    execFileSync("git", ["-C", otherRepository, "remote", "add", "origin", "https://github.com/other/repo.git"]);
    assert.throws(() => inspectSource(otherRepository, commit, tree), /wrong repository identity/u);
    symlinkSync(repository, join(sandbox, "source-link"));
    assert.throws(() => assertExternalOutput(repository, join(sandbox, "source-link", "bundle")), /external absolute path/u);
    const archivePath = join(sandbox, "archive.tgz");
    const installedBase = join(sandbox, "installed");
    writeFileSync(archivePath, fixture);
    const identity = { packageName: source.package, version: source.version,
      requestedSourceCommit: commit, requestedSourceTree: tree, sourceBindingStatus: "unverified",
      archiveSha256: archive.canonical.sha256, archiveIntegrity: archive.canonical.integrity };
    const installed = join(installedBase, inventoryKey(identity));
    for (const [path, bytes] of archive.files) {
      mkdirSync(dirname(join(installed, path)), { recursive: true });
      writeFileSync(join(installed, path), bytes);
    }
    const args = { repository, commit, tree, archivePath, installedBase };
    const candidate = collect(args);
    assert.equal(candidate.releaseEligible, false);
    assert.equal(candidate.source.derivation.status, "incomplete");
    assert.equal(candidate.transport.sourceBindingStatus, "unverified");
    assert.equal(candidate.installed.identity.sourceBindingStatus, "unverified");
    assert.deepEqual(candidate.surface.exports.map(row => row.path), [".", "./composition"]);
    assert.ok(candidate.surface.census.native.includes("dist/rename-no-replace.node"));
    assert.ok(candidate.observation.reasons.some(reason => reason.includes("owner approval")));
    const oldUmask = process.umask(0);
    try {
      const output = join(sandbox, "output");
      run(["--repository", repository, "--commit", commit, "--tree", tree,
        "--archive", archivePath, "--installed-base", installedBase, "--output", output]);
      assert.equal(statSync(output).mode & 0o777, 0o700);
      for (const name of ["filesystem-custody.tgz", "canonical-archive.json", "candidate.json"]) {
        assert.equal(statSync(join(output, name)).mode & 0o777, 0o600);
      }
    } finally { process.umask(oldUmask); }
    const indexFile = join(installed, "dist/index.js");
    const outsideLink = join(sandbox, "outside-hardlink");
    linkSync(indexFile, outsideLink);
    assert.throws(() => collect(args), /linked or replaced member/u);
    rmSync(outsideLink);
    truncateSync(indexFile, 16 * 1024 * 1024 + 1);
    assert.throws(() => collect(args), /byte limit/u);
    writeFileSync(indexFile, archive.files.get("dist/index.js"));
    const replacement = join(sandbox, "replacement-dist");
    mkdirSync(replacement);
    assert.throws(() => installedFiles(installedBase, inventoryKey(identity), prefix => {
      if (prefix === "") {
        renameSync(join(installed, "dist"), join(sandbox, "original-dist"));
        renameSync(replacement, join(installed, "dist"));
      }
    }), /directory replaced/u);
    rmSync(join(installed, "dist"), { recursive: true });
    renameSync(join(sandbox, "original-dist"), join(installed, "dist"));
    const linkedArchive = join(sandbox, "linked.tgz");
    symlinkSync(archivePath, linkedArchive);
    assert.throws(() => collect({ ...args, archivePath: linkedArchive }), /ELOOP|symbolic/u);
    assert.throws(() => collect({ ...args, tree: "0".repeat(40) }), /mismatch/u);
    const forgedPath = join(sandbox, "forged.tgz");
    writeFileSync(forgedPath, tar([{ name: "package/package.json", bytes: Buffer.from(JSON.stringify({
      name: "@agent-teams/unrelated", version: "0.0.0", exports: source.sourceManifest.exports
    })) }]));
    assert.throws(() => collect({ ...args, archivePath: forgedPath }), /coordinates mismatch/u);
    writeFileSync(join(installed, "dist/index.js"), "changed");
    assert.throws(() => collect(args), /installed: mismatch/u);
    writeFileSync(join(installed, "dist/index.js"), archive.files.get("dist/index.js"));
    writeFileSync(join(installed, "extra"), "x");
    assert.throws(() => collect(args), /installed: mismatch/u);
    rmSync(join(installed, "extra"));
    rmSync(join(installed, "dist/index.js"));
    symlinkSync("composition.js", join(installed, "dist/index.js"));
    assert.throws(() => collect(args), /linked member/u);
  } finally { rmSync(sandbox, { recursive: true, force: true }); }
});

test("Git process errors fail even with a zero status and replace refs are disabled", () => {
  assert.throws(() => git(repository, ["--version"], (_command, _args, options) => {
    assert.equal(options.env.GIT_NO_REPLACE_OBJECTS, "1");
    return { status: 0, error: new Error("injected process failure"), stdout: Buffer.from("git version fake") };
  }), /injected process failure/u);
});

test("source origin accepts only the two exact HTTPS URLs", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "ar-source-origin-"));
  try {
    const checkout = join(sandbox, "checkout");
    execFileSync("git", ["init", "--quiet", checkout]);
    for (const path of ["package.json", "pnpm-workspace.yaml", "pnpm-lock.yaml", ".npmrc",
      "packages/platform/filesystem-custody/package.json",
      "packages/platform/filesystem-custody/native/rename-no-replace.c",
      "packages/platform/filesystem-custody/scripts/build-native-helper.mjs"]) {
      const target = join(checkout, path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, path.endsWith("package.json") && path.includes("filesystem-custody") ?
        JSON.stringify({ name: "@agent-teams/filesystem-custody", version: "0.0.0" }) : "fixture\n");
    }
    execFileSync("git", ["-C", checkout, "add", "-A"]);
    execFileSync("git", ["-C", checkout, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test",
      "commit", "--quiet", "-m", "fixture"]);
    const localCommit = execFileSync("git", ["-C", checkout, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const localTree = execFileSync("git", ["-C", checkout, "rev-parse", "HEAD^{tree}"], { encoding: "utf8" }).trim();
    execFileSync("git", ["-C", checkout, "remote", "add", "origin",
      "https://github.com/agent-teams-ai/agent-runtime.git"]);
    for (const remote of ["https://github.com/agent-teams-ai/agent-runtime",
      "https://github.com/agent-teams-ai/agent-runtime.git"]) {
      execFileSync("git", ["-C", checkout, "remote", "set-url", "origin", remote]);
      assert.equal(inspectSource(checkout, localCommit, localTree).commit, localCommit);
      for (const padded of [` ${remote}`, `${remote} `, `\t${remote}`, `${remote}\t`, `\r${remote}`, `${remote}\r`]) {
        execFileSync("git", ["-C", checkout, "remote", "set-url", "origin", padded]);
        assert.throws(() => inspectSource(checkout, localCommit, localTree), /wrong repository identity/u);
      }
    }
    execFileSync("git", ["-C", checkout, "remote", "set-url", "origin",
      "https://github.com/agent-teams-ai/agent-runtime.git.evil"]);
    assert.throws(() => inspectSource(checkout, localCommit, localTree), /wrong repository identity/u);
  } finally { rmSync(sandbox, { recursive: true, force: true }); }
});

test("installed inventory rejects aggregate size before content reads", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "ar-source-total-limit-"));
  try {
    const installed = join(sandbox, "key");
    mkdirSync(installed);
    for (let i = 0; i < 5; i++) {
      const path = join(installed, `part-${i}`);
      writeFileSync(path, "");
      truncateSync(path, 16 * 1024 * 1024);
    }
    assert.throws(() => installedFiles(sandbox, "key"), /byte limit/u);
  } finally { rmSync(sandbox, { recursive: true, force: true }); }
});

test("installed inventory rejects a concurrent root addition after enumeration", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "ar-source-addition-"));
  try {
    mkdirSync(join(sandbox, "key"));
    writeFileSync(join(sandbox, "key", "existing"), "x");
    assert.throws(() => installedFiles(sandbox, "key", prefix => {
      if (prefix === "") { writeFileSync(join(sandbox, "key", "added"), "y"); }
    }), /directory changed/u);
  } finally { rmSync(sandbox, { recursive: true, force: true }); }
});

test("installed inventory bounds each directory before reading every member", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "ar-source-count-"));
  try {
    mkdirSync(join(sandbox, "key"));
    for (let i = 0; i < 257; i++) { writeFileSync(join(sandbox, "key", String(i).padStart(3, "0")), ""); }
    assert.throws(() => installedFiles(sandbox, "key"), /member count limit/u);
  } finally { rmSync(sandbox, { recursive: true, force: true }); }
});

test("installed inventory rejects a hardlink added after its file was read", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "ar-source-late-link-"));
  try {
    const installed = join(sandbox, "key");
    mkdirSync(installed);
    const first = join(installed, "000-first");
    writeFileSync(first, "first");
    const old = new Date(Date.now() - 60_000);
    utimesSync(first, old, new Date());
    const initialAtime = statSync(first).atimeMs;
    const laterBytes = Buffer.alloc(256 * 1024);
    for (let i = 1; i < 256; i++) {
      writeFileSync(join(installed, String(i).padStart(3, "0")), laterBytes);
    }
    const outside = join(sandbox, "outside-hardlink");
    const watcher = spawn(process.execPath, ["-e", `
      const { statSync, linkSync } = require("node:fs");
      process.stdout.write("ready\\n");
      const deadline = Date.now() + 3000;
      while (statSync(process.argv[1]).atimeMs <= Number(process.argv[3])) {
        if (Date.now() >= deadline) { throw new Error("first file was not read"); }
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      linkSync(process.argv[1], process.argv[2]);
    `, first, outside, String(initialAtime)], { stdio: ["ignore", "pipe", "pipe"] });
    const ready = new Promise((resolve, reject) => {
      watcher.stdout.once("data", resolve);
      watcher.once("error", reject);
    });
    const done = new Promise((resolve, reject) => {
      watcher.once("exit", code => code === 0 ? resolve() : reject(new Error(`watcher exited ${code}`)));
      watcher.once("error", reject);
    });
    await ready;
    let failure;
    try { installedFiles(sandbox, "key"); } catch (error) { failure = error; }
    await done;
    assert.equal(statSync(outside).nlink, 2);
    assert.match(failure?.message ?? "", /installed: changed during read 000-first/u);
  } finally { rmSync(sandbox, { recursive: true, force: true }); }
});

test("archive reader stops concurrent compressed growth at the read limit", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "ar-source-growth-"));
  try {
    const path = join(sandbox, "archive.tgz");
    writeFileSync(path, fixture);
    let injected = false;
    let requested = 0;
    assert.throws(() => readBoundedArchive(path, (fd, bytes, offset, length, position) => {
      requested += length;
      if (!injected) {
        injected = true;
        appendFileSync(path, Buffer.alloc(16 * 1024 * 1024 + 1));
      }
      return readSync(fd, bytes, offset, length, position);
    }), /compressed size limit during read/u);
    assert.equal(injected, true);
    assert.ok(requested < 17 * 1024 * 1024);
  } finally { rmSync(sandbox, { recursive: true, force: true }); }
});

test("archive reader rejects an unwritten FIFO without blocking", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "ar-source-fifo-"));
  try {
    const fifo = join(sandbox, "archive.tgz");
    execFileSync("mkfifo", [fifo]);
    execFileSync(process.execPath, ["--input-type=module", "-e",
      'import assert from "node:assert/strict"; const { readBoundedArchive } = await import(process.argv[1]); assert.throws(() => readBoundedArchive(process.argv[2]), /regular compressed file/u);',
      new URL("./archive.mjs", import.meta.url).href, fifo], { timeout: 3000 });
  } finally { rmSync(sandbox, { recursive: true, force: true }); }
});

test("protected output rejects parent and output directory replacement before writes", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "ar-source-output-"));
  try {
    const checkout = join(sandbox, "checkout");
    mkdirSync(checkout);
    const parent = join(sandbox, "private");
    mkdirSync(parent, { mode: 0o700 });
    const output = join(parent, "result");
    const entries = [["candidate.json", "secret"]];
    assert.throws(() => writeProtectedOutput(checkout, output, entries, {
      afterParentOpen() {
        renameSync(parent, join(sandbox, "moved-private"));
        symlinkSync(checkout, parent);
      }
    }), /external absolute path|parent replaced/u);
    assert.deepEqual(readdirSync(checkout), []);
    assert.deepEqual(readdirSync(join(sandbox, "moved-private")), []);
    rmSync(parent);
    renameSync(join(sandbox, "moved-private"), parent);
    assert.throws(() => writeProtectedOutput(checkout, output, entries, {
      afterParentOpen() {
        renameSync(parent, join(sandbox, "original-private"));
        mkdirSync(parent, { mode: 0o700 });
      }
    }), /parent replaced/u);
    assert.deepEqual(readdirSync(parent), []);
    assert.throws(() => writeProtectedOutput(checkout, output, entries, {
      afterOutputOpen() {
        renameSync(output, join(sandbox, "moved-result"));
        symlinkSync(checkout, output);
      }
    }), /directory replaced/u);
    assert.deepEqual(readdirSync(checkout), []);
    assert.deepEqual(readdirSync(join(sandbox, "moved-result")), []);
  } finally { rmSync(sandbox, { recursive: true, force: true }); }
});

test("protected output rejects parent replacement between validation and open", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "ar-source-before-open-"));
  try {
    const checkout = join(sandbox, "checkout");
    mkdirSync(checkout);
    const parent = join(sandbox, "private");
    const entries = [["candidate.json", "secret"]];
    for (const mode of [0o700, 0o777]) {
      mkdirSync(parent, { mode: 0o700 });
      const original = join(sandbox, `original-${mode.toString(8)}`);
      assert.throws(() => writeProtectedOutput(checkout, join(parent, "result"), entries, {
        beforeParentOpen() {
          renameSync(parent, original);
          mkdirSync(parent, { mode });
          chmodSync(parent, mode);
        }
      }), /parent replaced/u);
      assert.deepEqual(readdirSync(parent), []);
      assert.deepEqual(readdirSync(original), []);
      rmSync(parent, { recursive: true });
      rmSync(original, { recursive: true });
    }
  } finally { rmSync(sandbox, { recursive: true, force: true }); }
});

test("focused check remains blocking in changed, fast and full routes", () => {
  const packageScripts = JSON.parse(readFileSync(join(repository, "package.json"), "utf8")).scripts;
  assert.equal(packageScripts["test:sdk-growth:source"], "node --test scripts/sdk-growth-source/collector.test.mjs");
  for (const gate of ["check:fast", "check"]) {
    assert.ok(packageScripts[gate].includes("pnpm test:sdk-growth:source &&"), `${gate} must block on source check`);
  }
  const workflow = readFileSync(join(repository, "architecture/foundation/repository-agent-workflow.yaml"), "utf8");
  assert.match(workflow, /- id: sdk-growth-source\n\s+script: test:sdk-growth:source\n\s+extensions: \[\.mjs, \.tgz\]\n\s+passPaths: false\n/u);
  assert.match(workflow, /- scripts\/sdk-growth-source\n/u);
  assert.match(workflow, /- architecture\/feature-module-standard\/sdk-growth-source\.json\n/u);
  const purePolicy = readFileSync(new URL("./surface.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(purePolicy, /from ["'](?:node:|@agent-teams\/engineering-foundation\/)/u);
});

test("scoped tooling feature has exact FMS ownership, census and blocking Foundation policy", () => {
  const profile = JSON.parse(readFileSync(join(repository, "architecture/feature-module-standard/sdk-growth-source.json"), "utf8"));
  const scripts = JSON.parse(readFileSync(join(repository, "package.json"), "utf8")).scripts;
  const actual = readdirSync(join(repository, "scripts/sdk-growth-source"))
    .filter(name => name.endsWith(".mjs")).map(name => `scripts/sdk-growth-source/${name}`).toSorted();
  const verify = (candidate, routes = scripts) => {
    assert.deepEqual(candidate.modules.policy, [
      "scripts/sdk-growth-source/candidate.mjs",
      "scripts/sdk-growth-source/surface.mjs"
    ]);
    assert.deepEqual(candidate.modules.adaptersAndComposition, [
      "scripts/sdk-growth-source/archive.mjs",
      "scripts/sdk-growth-source/collect.mjs",
      "scripts/sdk-growth-source/index.mjs"
    ]);
    assert.equal(candidate.modules.test, "scripts/sdk-growth-source/collector.test.mjs");
    assert.deepEqual([...candidate.modules.policy, ...candidate.modules.adaptersAndComposition, candidate.modules.test].toSorted(), actual);
    assert.equal(candidate.authority.sha256, "851653f96643cf0466b67ab22963661976b00de44840fa3144a48a8c054f95fa");
    assert.equal(candidate.scope, "development-tooling-only");
    assert.equal(candidate.consumerModuleStandard.sha256, "d5bb71e5a700014f9f0a09b17d1f33d24b30b66c49b273c9fb65584672c51e4f");
    assert.equal(candidate.consumerModuleStandard.compositionChange, false);
    assert.deepEqual(candidate.foundationBoundaries, ["tooling.sdk-growth-source.policy", "tooling.sdk-growth-source.adapters", "tooling.sdk-growth-source.tests"]);
    assert.equal(routes["foundation:check"], "agent-teams-foundation check && pnpm foundation:boundaries:negative && pnpm foundation:assert-dev-only && pnpm foundation:assert-registry && pnpm quality:adoption");
    assert.equal(routes["foundation:boundaries:negative"], "node --test scripts/architecture/source-dependency-adapter-boundaries.test.mjs scripts/docs/runtime-builtin-permissions.test.mjs scripts/ci/run-ordinary-postgres.test.mjs");
    assert.equal(routes["test:sdk-growth:source"], "node --test scripts/sdk-growth-source/collector.test.mjs");
    assert.equal(routes["check:changed"], "agent-teams-foundation agent-workflow changed --consumer .");
    for (const gate of ["check", "check:fast"]) {
      assert.ok(routes[gate].includes("pnpm test:sdk-growth:source &&"));
      assert.ok(routes[gate].includes("pnpm foundation:check &&"));
    }
  };
  verify(profile);
  const noOp = { ...scripts, "foundation:check": "true" };
  assert.throws(() => verify(profile, noOp));
  const removed = { ...scripts, "check:fast": scripts["check:fast"].replace("pnpm foundation:check && ", "") };
  assert.throws(() => verify(profile, removed));
  const removedFull = { ...scripts, check: scripts.check.replace("pnpm test:sdk-growth:source && ", "") };
  assert.throws(() => verify(profile, removedFull));
  const removedChanged = { ...scripts, "check:changed": "true" };
  assert.throws(() => verify(profile, removedChanged));
  const stale = structuredClone(profile);
  stale.authority.sha256 = "0".repeat(64);
  assert.throws(() => verify(stale));
  const unowned = structuredClone(profile);
  unowned.modules.policy.pop();
  assert.throws(() => verify(unowned));
});
