import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";
import {auditNodeEngineCompatibility, packageManifests, satisfiesNodeRange} from "./audit-node-engine-compatibility.mjs";

test("qualified Node versions accept production 24 and Node 26 while skipping 25", () => {
  const range = ">=24.18.0 <25 || >=26.10.0 <27";
  for (const target of ["24.18.0", "24.21.0", "26.10.0", "26.14.2"]) {
    assert.equal(satisfiesNodeRange(range, target), true, target);
  }
  for (const target of ["24.17.9", "25.0.0", "26.9.9", "27.0.0"]) {
    assert.equal(satisfiesNodeRange(range, target), false, target);
  }
});

test("published engine ranges catch a dependency that rejects Node 26", () => {
  const lockfile = `packages:\n\n  'example@1.0.0':\n    engines: {node: '>=24.18.0 <25'}\n`;
  const result = auditNodeEngineCompatibility([], lockfile);
  assert.deepEqual(result.find(({target}) => target === "24.18.0"), {target: "24.18.0", blockers: []});
  assert.deepEqual(result.find(({target}) => target === "26.10.0"), {
    target: "26.10.0",
    blockers: [{name: "example@1.0.0", range: ">=24.18.0 <25"}],
  });
});

test("common transitive engine forms remain portable across both qualified majors", () => {
  for (const range of ["18 || 20 || >=22", "^20.19.0 || >=22.12.0", "^22.22.2 || ^24.15.0 || >=26.0.0"]) {
    assert.equal(satisfiesNodeRange(range, "24.18.0"), true, range);
    assert.equal(satisfiesNodeRange(range, "26.10.0"), true, range);
  }
});

test("engine audit reads each owned package root but skips dependency trees and external symlinks", t => {
  const fixture = mkdtempSync(join(tmpdir(), "node-engine-scope-"));
  t.after(() => rmSync(fixture, {recursive: true, force: true}));
  const outside = join(fixture, "outside");
  const workspace = join(fixture, "workspace");
  mkdirSync(outside);
  mkdirSync(workspace);
  writeFileSync(join(workspace, "package.json"), JSON.stringify({name: "root", engines: {node: ">=24.18.0 <25 || >=26.10.0 <27"}}));
  writeFileSync(join(workspace, "pnpm-workspace.yaml"), 'packages:\n  - "experiments/*"\n  - "packages/apps/*"\n  - "packages/contexts/*"\n  - "packages/platform/*"\n');
  writeFileSync(join(outside, "package.json"), JSON.stringify({name: "external", engines: {node: "<1"}}));
  mkdirSync(join(workspace, "packages", "apps", "owned"), {recursive: true});
  writeFileSync(join(workspace, "packages", "apps", "owned", "package.json"), JSON.stringify({name: "owned", engines: {node: ">=24.18.0 <25 || >=26.10.0 <27"}}));
  mkdirSync(join(workspace, "packages", "contexts"), {recursive: true});
  symlinkSync(outside, join(workspace, "packages", "contexts", "external"), "dir");
  symlinkSync(outside, join(workspace, "experiments"), "dir");
  mkdirSync(join(workspace, "packages", "platform", "linked"), {recursive: true});
  symlinkSync(join(outside, "package.json"), join(workspace, "packages", "platform", "linked", "package.json"));
  mkdirSync(join(workspace, "packages", "apps", "owned", "node_modules", "bad"), {recursive: true});
  writeFileSync(join(workspace, "packages", "apps", "owned", "node_modules", "bad", "package.json"), readFileSync(join(outside, "package.json")));
  mkdirSync(join(workspace, "node_modules", "bad"), {recursive: true});
  writeFileSync(join(workspace, "node_modules", "bad", "package.json"), readFileSync(join(outside, "package.json")));

  const manifests = packageManifests(workspace);
  assert.deepEqual(manifests, [join(workspace, "package.json"), join(workspace, "packages", "apps", "owned", "package.json")]);
  assert.deepEqual(auditNodeEngineCompatibility(manifests, "packages:\n").map(({blockers}) => blockers), [[], []]);

  mkdirSync(join(workspace, "packages", "platform", "new-owned"));
  writeFileSync(join(workspace, "packages", "platform", "new-owned", "package.json"), JSON.stringify({name: "new-owned", engines: {node: "<1"}}));
  assert.deepEqual(auditNodeEngineCompatibility(packageManifests(workspace), "packages:\n").map(({blockers}) => blockers), [
    [{name: "new-owned", range: "<1"}], [{name: "new-owned", range: "<1"}],
  ]);
});

test("Node 26 lane explicitly rejects incompatible engine and peer fixtures with pnpm 11", t => {
  const workflow = readFileSync(new URL("../../.github/workflows/node-26-compatibility.yml", import.meta.url), "utf8");
  assert.match(workflow, /pnpm install --frozen-lockfile --engine-strict --strict-peer-dependencies/u);
  const fixture = mkdtempSync(join(tmpdir(), "node-engine-pnpm-strict-"));
  t.after(() => rmSync(fixture, {recursive: true, force: true}));
  const install = directory => spawnSync("pnpm", ["--dir", directory, "install", "--offline", "--ignore-scripts", "--engine-strict", "--strict-peer-dependencies", "--store-dir", join(fixture, "store")], {
    encoding: "utf8", env: {...process.env, CI: "true"},
  });

  const engine = join(fixture, "engine");
  mkdirSync(join(engine, "incompatible"), {recursive: true});
  writeFileSync(join(engine, "package.json"), JSON.stringify({name: "engine-fixture", version: "1.0.0", dependencies: {incompatible: "file:./incompatible"}}));
  writeFileSync(join(engine, "incompatible", "package.json"), JSON.stringify({name: "incompatible", version: "1.0.0", engines: {node: "<1"}}));
  const engineResult = install(engine);
  assert.equal(engineResult.status, 1, engineResult.stderr || engineResult.error?.message);
  assert.match(engineResult.stdout + engineResult.stderr, /ERR_PNPM_UNSUPPORTED_ENGINE/u);

  const peer = join(fixture, "peer");
  mkdirSync(join(peer, "plugin"), {recursive: true});
  mkdirSync(join(peer, "host"));
  writeFileSync(join(peer, "package.json"), JSON.stringify({name: "peer-fixture", version: "1.0.0", dependencies: {plugin: "file:./plugin", host: "file:./host"}}));
  writeFileSync(join(peer, "plugin", "package.json"), JSON.stringify({name: "plugin", version: "1.0.0", peerDependencies: {host: "^2.0.0"}}));
  writeFileSync(join(peer, "host", "package.json"), JSON.stringify({name: "host", version: "1.0.0"}));
  const peerResult = install(peer);
  assert.equal(peerResult.status, 1, peerResult.stderr || peerResult.error?.message);
  assert.match(peerResult.stdout + peerResult.stderr, /ERR_PNPM_PEER_DEP_ISSUES/u);
});

test("pnpm workspace strict settings reject fresh and locked invalid engine and peer graphs", t => {
  assert.equal(spawnSync("pnpm", ["--version"], {encoding: "utf8"}).stdout.trim(), "11.18.0");
  const fixture = mkdtempSync(join(tmpdir(), "capture-pnpm-strict-"));
  t.after(() => rmSync(fixture, {recursive: true, force: true}));
  const workspace = readFileSync(new URL("../../pnpm-workspace.yaml", import.meta.url));
  const run = (directory, args) => spawnSync("pnpm", ["--dir", directory, "install", "--offline", "--ignore-scripts",
    "--store-dir", join(fixture, "store"), ...args], {encoding: "utf8", env: {...process.env, CI: "true"}});
  const cases = [
    {name: "engine", packages: {incompatible: {name: "incompatible", version: "1.0.0", engines: {node: "<1"}}},
      error: /ERR_PNPM_UNSUPPORTED_ENGINE/u, relax: ["--no-engine-strict"]},
    {name: "peer", packages: {plugin: {name: "plugin", version: "1.0.0", peerDependencies: {host: "^2.0.0"}},
      host: {name: "host", version: "1.0.0"}}, error: /ERR_PNPM_PEER_DEP_ISSUES/u,
      relax: ["--no-strict-peer-dependencies"]},
  ];
  for (const {name, packages, error, relax} of cases) {
    const directory = join(fixture, name);
    mkdirSync(directory);
    writeFileSync(join(directory, "pnpm-workspace.yaml"), workspace);
    writeFileSync(join(directory, "package.json"), JSON.stringify({name: `${name}-fixture`, version: "1.0.0",
      dependencies: Object.fromEntries(Object.keys(packages).map(key => [key, `file:./${key}`]))}));
    for (const [key, manifest] of Object.entries(packages)) {
      mkdirSync(join(directory, key));
      writeFileSync(join(directory, key, "package.json"), JSON.stringify(manifest));
    }
    const fresh = run(directory, []);
    assert.equal(fresh.status, 1, `${name} fresh: ${fresh.stdout}${fresh.stderr}`);
    assert.match(fresh.stdout + fresh.stderr, error);
    const lock = run(directory, ["--lockfile-only", ...relax]);
    assert.equal(lock.status, 0, `${name} lock fixture: ${lock.stdout}${lock.stderr}`);
    const check = run(directory, name === "engine" ? ["--frozen-lockfile", "--engine-strict", "--strict-peer-dependencies"] :
      ["--resolution-only", "--lockfile-only", "--no-frozen-lockfile", "--engine-strict", "--strict-peer-dependencies"]);
    assert.equal(check.status, 1, `${name} locked: ${check.stdout}${check.stderr}`);
    assert.match(check.stdout + check.stderr, error);
  }
});
