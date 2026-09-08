import { parse, stringify } from "yaml";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { projectFixtureLock } from "./fixture-lock.mjs";

const foundation = "@agent-teams/engineering-foundation";
const generated = Object.fromEntries([
  "agent-execution", "provider-access", "runtime-configuration", "runtime-security",
].map((id) => [`packages/contexts/${id}`, { name: `@agent-teams/${id}`, private: true }]));
const inputs = (version = "0.21.0") => {
  const manifest = { packageManager: "pnpm@11.18.0", devDependencies: {
    [foundation]: version, typescript: "catalog:", "@types/node": "catalog:", unrelated: "workspace:*",
  } };
  const versions = { [foundation]: `${version}(@types/node@24.13.3)`, typescript: "7.0.2", "@types/node": "24.13.3" };
  const entries = Object.fromEntries(Object.entries(versions).map(([name, value]) => [name, {
    specifier: manifest.devDependencies[name], version: value,
  }]));
  const workspace = { catalog: { typescript: "7.0.2", "@types/node": "24.13.3" } };
  const lock = {
    lockfileVersion: "9.0", settings: { autoInstallPeers: true },
    catalogs: { default: Object.fromEntries(Object.entries(workspace.catalog).map(([name, value]) => [name, { specifier: value, version: value }])) },
    importers: { ".": { devDependencies: entries, dependencies: { unrelated: {} } }, "old/workspace": {} },
    packages: Object.fromEntries(Object.entries(versions).map(([name, value]) => [`${name}@${value.split("(")[0]}`, { resolution: { integrity: "sha512-fixture" } }])),
    snapshots: Object.fromEntries(Object.entries(versions).map(([name, value]) => [`${name}@${value}`, { dependencies: { retained: "2.0.0" } }])),
    otherLockData: { preserved: true },
  };
  lock.snapshots["unreferenced@2.0.0"] = { optionalDependencies: { retained: "3.0.0" } };
  return [manifest, lock, workspace, structuredClone(generated)];
};

test("projects exact existing specs and peer resolutions; preserves all non-importer data without mutation", () => {
  for (const version of ["0.21.0", "0.22.7"]) {
    const args = inputs(version);
    const before = structuredClone(args);
    const { manifest, lock } = projectFixtureLock(...args);
    assert.deepEqual(args, before);
    assert.deepEqual(manifest, { name: "runtime-scaffold-fixture", private: true, packageManager: args[0].packageManager,
      devDependencies: { [foundation]: version, typescript: "catalog:", "@types/node": "catalog:" } });
    assert.deepEqual(lock, { ...args[1], importers: { ".": { devDependencies: args[1].importers["."].devDependencies },
      ...Object.fromEntries(Object.keys(generated).map((path) => [path, {}])) } });
    lock.snapshots["unreferenced@2.0.0"].optionalDependencies.retained = "changed";
    assert.deepEqual(args, before);
  }
});

const invalidCases = {
  "missing lock": (args) => { args[1] = null; },
  "unsupported lock": (args) => { args[1].lockfileVersion = "8.0"; },
  "missing pin": (args) => { delete args[0].packageManager; },
  "missing root": (args) => { delete args[1].importers["."]; },
  "missing manifest dependency": (args) => { delete args[0].devDependencies.typescript; },
  "missing locked dependency": (args) => { delete args[1].importers["."].devDependencies.typescript; },
  "mismatching specifier": (args) => { args[1].importers["."].devDependencies[foundation].specifier = "99.0.0"; },
  "malformed resolution version": (args) => { args[1].importers["."].devDependencies.typescript.version = {}; },
  "missing package resolution": (args) => { delete args[1].packages["typescript@7.0.2"].resolution; },
  "empty package resolution": (args) => { args[1].packages["typescript@7.0.2"].resolution = {}; },
  "missing snapshot": (args) => { delete args[1].snapshots["typescript@7.0.2"]; },
  "missing catalog": (args) => { delete args[1].catalogs.default.typescript; },
  "mismatching workspace catalog": (args) => { args[2].catalog.typescript = "99.0.0"; },
  "mismatching catalog resolution": (args) => { args[1].catalogs.default.typescript.version = "99.0.0"; },
  "missing generated package": (args) => { delete args[3][Object.keys(generated)[0]]; },
  "malformed generated manifest": (args) => { args[3][Object.keys(generated)[0]] = null; },
};
for (const [name, mutate] of Object.entries(invalidCases)) {
  test(`rejects ${name}`, () => {
    const args = inputs();
    mutate(args);
    assert.throws(() => projectFixtureLock(...args), /Invalid scaffold fixture input:/);
  });
}
for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies", "bundledDependencies", "bundleDependencies"]) {
  test(`rejects future generated ${field} and malformed declarations`, () => {
    for (const value of [{ future: "1.0.0" }, ["future"], null, false, ""]) {
      const args = inputs();
      args[3][Object.keys(generated)[0]][field] = value;
      assert.throws(() => projectFixtureLock(...args), /must have no/);
    }
  });
}

test("real source YAML projection round-trips with the declared yaml dependency", async () => {
  const root = new URL("../../", import.meta.url);
  const manifest = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
  const lock = parse(await readFile(new URL("pnpm-lock.yaml", root), "utf8"));
  const workspace = parse(await readFile(new URL("pnpm-workspace.yaml", root), "utf8"));
  const result = projectFixtureLock(manifest, lock, workspace, generated);
  assert.deepEqual(parse(stringify(result.lock)), result.lock);
  assert.equal(result.manifest.devDependencies[foundation], manifest.devDependencies[foundation]);
  assert.deepEqual({ ...result.lock, importers: lock.importers }, lock);
});
