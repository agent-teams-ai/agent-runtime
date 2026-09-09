import assert from "node:assert/strict";
import {test, type TestContext} from "node:test";
import {mkdtempSync, mkdirSync, realpathSync, readFileSync, lstatSync, writeFileSync, renameSync, symlinkSync,
  unlinkSync, rmSync, chmodSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {DarwinCodexNativeFiles} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/darwin-codex-native-files.js";
import {createCodexAppServerPermissionBoundary} from "../../../dist/features/contained-agent-turn/adapters/outbound/codex-app-server/codex-app-server-permission-boundary.js";
import {darwinCodexInstallationMaterial, createDarwinCodexNativeBrokerRecipe, createCodexNativeBrokerRecipe, renderCodexNativeBrokerConfig,
  codexNativeBrokerUserOverrides} from "../../../dist/features/contained-agent-turn/adapters/outbound/codex-app-server/codex-native-broker-recipe.js";
import {prepareCodexNativeBrokerFiles, validateCodexNativeBrokerFiles} from "../../../dist/features/contained-agent-turn/adapters/outbound/codex-app-server/codex-native-broker-files.js";

const catalog = readFileSync(new URL("../../fixtures/codex-native-broker-0.153.4/models.json", import.meta.url));
const setup = (t: TestContext) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ar69-bootstrap-synthetic-")));
  const home = join(root, "home"); const workspace = join(root, "workspace"); const state = join(root, "tmp");
  for (const path of [home, workspace, state]) {mkdirSync(path, {mode: 0o700});}
  const boundary = createCodexAppServerPermissionBoundary({codexHome: home, workspaceRef: workspace, intentMode: "analysis"});
  const recipe = createDarwinCodexNativeBrokerRecipe({boundary, tmpDir: state, endpoint: "http://127.0.0.1:32123/backend-api/codex", profile: "codex-chatgpt"});
  const records: string[] = [];
  const files = new DarwinCodexNativeFiles(boundary, catalog, {record(kind: string) {records.push(kind);}} as never, () => {});
  t.after(async () => {await files.cleanup(); rmSync(root, {recursive: true, force: true});});
  return {home, state, recipe, files, records, boundary, path: join(home, "installation_id")};
};

test("production installer creates retained operation UUID under restrictive umask and erases only its three files", async t => {
  const f = setup(t); const mask = process.umask(0o077);
  try {f.files.install(f.recipe);} finally {process.umask(mask);}
  assert.match(readFileSync(f.path, "utf8"), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  assert.equal(lstatSync(f.path).mode & 0o777, 0o644);
  assert.equal(lstatSync(join(f.home, "config.toml")).mode & 0o777, 0o600);
  assert.equal(lstatSync(join(f.home, "models.json")).mode & 0o777, 0o600);
  assert.match(renderCodexNativeBrokerConfig(f.recipe), new RegExp(`^sqlite_home = ${JSON.stringify(f.state)}`));
  assert.equal(codexNativeBrokerUserOverrides(f.recipe).sqlite_home, f.state);
  assert.deepEqual(Object.keys(f.recipe).toSorted(), ["catalogPath", "catalogSha256", "endpoint", "kind", "profile"]);
  const prepared = await prepareCodexNativeBrokerFiles(f.recipe);
  validateCodexNativeBrokerFiles(prepared, f.recipe);
  assert.ok(darwinCodexInstallationMaterial(f.recipe));
  assert.throws(() => f.files.install(f.recipe));
  const other = setup(t); other.files.install(other.recipe);
  assert.notEqual(readFileSync(f.path, "utf8"), readFileSync(other.path, "utf8"));
  assert.equal(await f.files.cleanup(), true);
  assert.throws(() => lstatSync(f.path), {code: "ENOENT"});
  assert.throws(() => validateCodexNativeBrokerFiles(prepared, f.recipe));
  assert.equal(f.records.filter(kind => kind === "native_file_erased").length, 3);
});

test("existing file and symlink conflict are never opened, overwritten or disposed", async t => {
  for (const kind of ["file", "symlink"] as const) {
    const f = setup(t); const foreign = join(f.state, "foreign"); writeFileSync(foreign, "foreign");
    if (kind === "file") {writeFileSync(f.path, "foreign");} else {symlinkSync(foreign, f.path);}
    assert.throws(() => f.files.install(f.recipe));
    assert.equal(await f.files.cleanup(), false);
    assert.equal(readFileSync(f.path, "utf8"), "foreign");
    assert.equal(readFileSync(foreign, "utf8"), "foreign");
    assert.equal(lstatSync(f.path).isSymbolicLink(), kind === "symlink");
  }
});

test("retained identity rejects replacement/symlink, content and mode mutations before launch", async t => {
  for (const kind of ["replacement", "symlink", "contents", "mode"] as const) {
    const f = setup(t); f.files.install(f.recipe); const prepared = await prepareCodexNativeBrokerFiles(f.recipe);
    const retained = join(f.state, "retained");
    if (kind === "replacement" || kind === "symlink") {
      renameSync(f.path, retained);
      if (kind === "replacement") {writeFileSync(f.path, "foreign");} else {symlinkSync(retained, f.path);}
    } else if (kind === "contents") {writeFileSync(f.path, "00000000-0000-4000-8000-000000000000");}
    else {chmodSync(f.path, 0o600);}
    assert.throws(() => validateCodexNativeBrokerFiles(prepared, f.recipe));
    assert.throws(() => darwinCodexInstallationMaterial(f.recipe));
    if (kind === "replacement" || kind === "symlink") {
      assert.equal(await f.files.cleanup(), false);
      assert.ok(lstatSync(f.path)); // Cleanup preserved the foreign name.
      unlinkSync(f.path); renameSync(retained, f.path); // Test restores its own retained inode for teardown.
    }
  }
});

test("Darwin metadata cannot widen Linux recipe keys or its exact renderer", t => {
  const f = setup(t);
  const input = {boundary: f.boundary, endpoint: "http://10.1.2.3:32123/backend-api/codex", profile: "codex-chatgpt" as const};
  const linux = createCodexNativeBrokerRecipe(input);
  assert.equal(renderCodexNativeBrokerConfig(linux).startsWith('model_provider = "ar_broker"\n'), true);
  assert.equal(Object.hasOwn(codexNativeBrokerUserOverrides(linux), "sqlite_home"), false);
  assert.equal(darwinCodexInstallationMaterial(linux), undefined);
  assert.throws(() => createCodexNativeBrokerRecipe({...input, tmpDir: f.state} as never));
  for (const tmpDir of ["/", "relative", `${f.state}/..`, `${f.state}\nforeign`]) {
    assert.throws(() => createDarwinCodexNativeBrokerRecipe({...input, endpoint: f.recipe.endpoint, tmpDir}));
  }
});

// Config/read is synthetic here: the exact retained native capture is transformed
// only for the approved Darwin state leaf and endpoint, then rehashed as native.
test("Darwin config/read must retain sqlite_home in the user layer, origins and effective config", async t => {
  const f = setup(t);
  const {nativeBrokerConfig} = await import("../../fixtures/codex-native-broker-0.153.4/fixture.ts");
  const {rehashNativeLayers} = await import("../../fixtures/codex-native-config-0.153.4/fixture.ts");
  const {validateCodexConfigEvidence} = await import("../../../dist/features/contained-agent-turn/adapters/outbound/codex-app-server/codex-app-server-config-wire.js");
  const config = nativeBrokerConfig(f.home);
  const user = config.layers.find(layer => layer.name.type === "user")!;
  user.config.sqlite_home = f.state;
  (user.config.model_providers as {ar_broker: {base_url: string}}).ar_broker.base_url = f.recipe.endpoint;
  config.config.sqlite_home = f.state;
  (config.config.model_providers as {ar_broker: {base_url: string}}).ar_broker.base_url = f.recipe.endpoint;
  config.origins.sqlite_home = {name: user.name, version: user.version};
  rehashNativeLayers(config);
  validateCodexConfigEvidence(config, f.boundary, f.recipe);
  config.config.sqlite_home = f.home;
  assert.throws(() => validateCodexConfigEvidence(config, f.boundary, f.recipe));
  config.config.sqlite_home = f.state;
  delete config.origins.sqlite_home;
  assert.throws(() => validateCodexConfigEvidence(config, f.boundary, f.recipe));
});

test("production projection rejects broad root reads and any widened installation selector", async t => {
  const f = setup(t); f.files.install(f.recipe);
  const {createDarwinSeatbeltProjection} = await import("../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/darwin-seatbelt-launch-projection.js");
  const provider = join(f.state, "inert-provider"); writeFileSync(provider, "synthetic bytes; never executed");
  const pin = {path: provider, sha256: "a".repeat(64), dev: "1", ino: "2", uid: String(process.getuid!())};
  const input = {provider: pin, launcher: {...pin, path: "/usr/bin/sandbox-exec"}, observer: {...pin, path: "/synthetic/observer"},
    endpoint: {address: "127.0.0.1" as const, family: "IPv4" as const, port: 32123}, operationBinding: {},
    protectedRoot: f.state, readPaths: [f.home], writePaths: [], installationPath: f.path};
  const projected = createDarwinSeatbeltProjection(input);
  assert.ok(projected.profile.includes(`(allow file-write-data (literal "${f.path}"))`));
  for (const mutation of [{readPaths: ["/"]}, {readPaths: []}, {writePaths: [f.home]},
    {installationPath: join(f.home, "config.toml")}, {installationPath: f.home}]) {
    assert.throws(() => createDarwinSeatbeltProjection({...input, ...mutation}));
  }
  const retained = join(f.state, "retained-installation"); renameSync(f.path, retained); symlinkSync(retained, f.path);
  assert.throws(() => createDarwinSeatbeltProjection(input));
  unlinkSync(f.path); renameSync(retained, f.path);
});
