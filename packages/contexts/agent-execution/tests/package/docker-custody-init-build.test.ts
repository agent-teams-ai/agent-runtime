import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../../scripts/docker-custody-init/build.mjs", import.meta.url));
function invoke(args: string[], cwd: string, path = process.env.PATH) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd, env: { PATH: path }, encoding: "utf8", timeout: 90_000,
  });
}
function scratch(t: test.TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "docker-custody-init-build-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test("CLI rejects unsafe arguments and preserves existing paths before invoking tools", (t) => {
  const directory = scratch(t);
  for (const args of [[], ["--output"], ["--output", "relative"], ["--output", "/tmp/a\nb"],
    ["--unknown", join(directory, "new")], ["--output", join(directory, "new"), "extra"]]) {
    const result = invoke(args, directory, "");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Expected --output/u);
  }
  const existing = join(directory, "existing");
  mkdirSync(existing);
  writeFileSync(join(existing, "sentinel"), "keep");
  writeFileSync(join(directory, "file"), "keep");
  symlinkSync(existing, join(directory, "link"));
  symlinkSync(join(directory, "absent"), join(directory, "dangling"));
  for (const name of ["existing", "file", "link", "dangling"]) {
    const result = invoke(["--output", join(directory, name)], directory, "");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /EEXIST/u);
  }
  assert.equal(readFileSync(join(existing, "sentinel"), "utf8"), "keep");
  assert.equal(readFileSync(join(directory, "file"), "utf8"), "keep");
  assert.equal(existsSync(join(directory, "new")), false);
  const help = invoke(["--help"], directory, "");
  assert.equal(help.status, 0);
  assert.match(help.stdout, /NOT native\/Host\/provider qualification/u);
});

test("missing/wrong Bun and failed bundler never publish a success manifest", (t) => {
  const directory = scratch(t);
  const missing = invoke(["--output", join(directory, "missing")], directory, "");
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /ENOENT/u);
  const bin = join(directory, "bin");
  mkdirSync(bin);
  for (const [name, version] of [["wrong", "1.3.14"], ["failed", "1.3.11"]]) {
    writeFileSync(join(bin, "bun"), `#!${process.execPath}\nif (process.argv[2] === '--version') console.log('${version}'); else { console.error('synthetic bundler failure'); process.exitCode = 23; }\n`, { mode: 0o700 });
    const output = join(directory, name);
    const result = invoke(["--output", output], directory, `${bin}:${process.env.PATH}`);
    assert.equal(result.status, 1);
    assert.match(result.stderr, name === "wrong" ? /Expected installed Bun 1\.3\.11/u : /synthetic bundler failure/u);
    assert.equal(existsSync(join(output, "manifest.json")), false);
    assert.equal(existsSync(join(output, "Dockerfile")), false);
  }
});

test("installed pinned Bun builds identical real init bytes in fresh contexts and refuses missing config", (t) => {
  const version = spawnSync("bun", ["--version"], { encoding: "utf8", timeout: 5000 });
  if (version.status !== 0 || version.stdout.trim() !== "1.3.11") {
    t.skip("Requires already installed Bun 1.3.11; no dependency installation permitted");
    return;
  }
  const directory = scratch(t);
  const outputs = [join(directory, "first context"), join(directory, "second-$context")];
  const bundles = outputs.map((output, index) => {
    const cwd = join(directory, `cwd-${index}`);
    mkdirSync(cwd);
    const result = invoke(["--output", output], cwd);
    assert.equal(result.status, 0, result.stderr);
    const bundle = readFileSync(join(output, "ar-custody-init.mjs"));
    const manifest = JSON.parse(readFileSync(join(output, "manifest.json"), "utf8"));
    assert.equal(manifest.bundle.bytes, bundle.length);
    assert.equal(manifest.bundle.sha256, createHash("sha256").update(bundle).digest("hex"));
    assert.equal(manifest.tool.version, "1.3.11");
    assert.match(manifest.source.revision, /^[0-9a-f]{40}$/u);
    assert.equal(manifest.image.platform, "linux/amd64");
    assert.equal(manifest.image.base, "node@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d");
    assert.deepEqual(readFileSync(join(output, "Dockerfile")), readFileSync(new URL("../../scripts/docker-custody-init/Dockerfile", import.meta.url)));
    const refusal = spawnSync(process.execPath, ["--no-addons", "--no-global-search-paths", join(output, "ar-custody-init.mjs")], {
      cwd, env: {}, encoding: "utf8", timeout: 5000, maxBuffer: 4096,
    });
    assert.equal(refusal.error, undefined);
    assert.equal(refusal.signal, null);
    assert.equal(refusal.status, 1);
    assert.equal(refusal.stdout, "");
    assert.equal(refusal.stderr, "custody init startup failed\n");
    return bundle;
  });
  assert.deepEqual(bundles[0], bundles[1]);
});
