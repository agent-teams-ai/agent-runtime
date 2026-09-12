import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {readFileSync} from "node:fs";
import {test} from "node:test";
import {brokerFixture} from "../../fixtures/codex-native-broker-0.153.4/fixture.ts";
import {rehashNativeLayers, type NativeConfigResult} from "../../fixtures/codex-native-config-0.153.4/fixture.ts";
import {validateCodexConfigEvidence, validateCodexInitializeEvidence,
  validateCodexPermissionProfileEvidence} from
  "../../../dist/features/contained-agent-turn/adapters/outbound/codex-app-server/codex-app-server-permission-boundary.js";
import {CODEX_APP_SERVER_LINUX_X64_TUPLE} from
  "../../../dist/features/contained-agent-turn/adapters/outbound/codex-app-server/codex-app-server-platform-tuple.js";

const root = new URL("../../fixtures/codex-native-config-0.153.4/linux-observation/", import.meta.url);
const read = (name: string) => JSON.parse(readFileSync(new URL(name, root), "utf8"));
const sha256 = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");

// Raw Linux captures are immutable evidence. Rebase only the private home for
// pure validation in a new disposable fixture, updating its layer fingerprints.
const rebaseHome = (value: unknown, originalHome: string, fixtureHome: string): unknown => {
  if (typeof value === "string") {return value.replaceAll(originalHome, fixtureHome);}
  if (Array.isArray(value)) {return value.map(item => rebaseHome(item, originalHome, fixtureHome));}
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, nested]) => [
      key.replaceAll(originalHome, fixtureHome), rebaseHome(nested, originalHome, fixtureHome)]));
  }
  return value;
};

test("Linux config observation links exact raw artifacts without granting live qualification", () => {
  const manifest = read("manifest.json"); const receipt = read("native-config-receipt.json");
  assert.equal(manifest.version, "0.153.4"); assert.equal(manifest.liveQualified, false);
  assert.equal(manifest.retainedDescriptorProof, false);
  assert.equal(receipt.executionBinding, manifest.executionBinding);
  assert.equal(receipt.platform, "linux-x64"); assert.equal(receipt.version, manifest.version);
  assert.equal(receipt.binarySha256, CODEX_APP_SERVER_LINUX_X64_TUPLE.binarySha256);
  assert.equal(receipt.isolatedNetwork, "unshare --net");
  assert.equal(receipt.authFilesSupplied, false); assert.equal(receipt.providerTurnRequested, false);
  assert.equal(receipt.profiles.length, 3);
  assert.equal(Object.keys(manifest.artifacts).length, 13);
  for (const [path, digest] of Object.entries(manifest.artifacts)) {
    assert.ok(!path.startsWith("/") && !path.split("/").includes(".."));
    assert.equal(sha256(readFileSync(new URL(path, root))), digest, path);
  }
  const input = read("input-receipt.json");
  assert.equal(input.captureScriptSha256, manifest.artifacts["capture-linux.mjs.txt"]);
  assert.equal(input.modelsSha256, manifest.modelsSha256);
  assert.equal(sha256(readFileSync(new URL(manifest.modelsCatalog, root))), manifest.modelsSha256);
  const stage = read("binary-stage-receipt.json");
  assert.equal(stage.binarySha256, receipt.binarySha256); assert.equal(stage.archiveSriVerified, true);
  assert.equal(stage.binaryBytes, 258_659_424);
  const cleanup = read("cleanup-receipt.json");
  assert.deepEqual(cleanup.runtimeReferences, []); assert.deepEqual(cleanup.mountReferences, []);
  assert.deepEqual(cleanup.removed, ["verified-codex.tgz", "codex-linux-0.153.4"]);
  for (const profile of receipt.profiles) {
    assert.equal(profile.resultSha256, manifest.artifacts[profile.resultPath]);
    assert.equal(profile.outerReturnCode, 0); assert.equal(profile.temporarySandboxRemoved, true);
    assert.equal(profile.configFields, 99); assert.equal(profile.layers, 3);
  }
});

for (const [recipe, mode] of [["permission", "analysis"], ["broker", "analysis"], ["broker", "workspace-write"]] as const) {
  test(`observed Linux ${recipe}/${mode} passes the current initialization and config validators`, t => {
    const f = brokerFixture(t, mode);
    const raw = read(`codex-native-linux-${recipe}-${mode}/result.json`);
    assert.equal(raw.stage, "complete"); assert.equal(raw.sawConfig, true);
    const originalHome = `${raw.project}/private-home`;
    const message = (id: string) => {
      const matches = raw.messages.filter((item: {id?: string}) => item.id === id);
      assert.equal(matches.length, 1); assert.ok(!("error" in matches[0])); return matches[0].result;
    };
    const initialize = message("init"); assert.equal(initialize.codexHome, originalHome);
    validateCodexInitializeEvidence({...initialize, codexHome: f.home}, f.boundary, CODEX_APP_SERVER_LINUX_X64_TUPLE);
    const config = rebaseHome(message("config"), originalHome, f.home) as NativeConfigResult;
    rehashNativeLayers(config);
    validateCodexConfigEvidence(config, f.boundary, recipe === "broker" ? f.recipe : undefined);
    validateCodexPermissionProfileEvidence(message("permission-list"), f.boundary);
    assert.equal(Object.keys(config.config).length, 99);
    assert.equal(Object.keys(config.origins).length, recipe === "broker" ? 36 : 14);
    // The opposite recipe must not become acceptable through path rebasing.
    assert.throws(() => validateCodexConfigEvidence(config, f.boundary, recipe === "broker" ? undefined : f.recipe));
  });
}
