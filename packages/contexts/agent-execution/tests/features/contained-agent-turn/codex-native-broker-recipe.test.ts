import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync, chmodSync, unlinkSync, linkSync, symlinkSync, renameSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  createCodexNativeBrokerRecipe, renderCodexNativeBrokerConfig,
  CODEX_NATIVE_CATALOG_SHA256, CODEX_NATIVE_CATALOG_BYTES,
  codexNativeBrokerUserOverrides, codexNativeBrokerEffectiveOverrides,
} from "../../../dist/features/contained-agent-turn/adapters/outbound/codex-app-server/codex-native-broker-recipe.js";
import { prepareCodexNativeBrokerFiles, validateCodexNativeBrokerFiles } from "../../../dist/features/contained-agent-turn/adapters/outbound/codex-app-server/codex-native-broker-files.js";
import { createCodexAppServerPermissionBoundary, validateCodexConfigEvidence, validateCodexPermissionProfileEvidence } from "../../../dist/features/contained-agent-turn/adapters/outbound/codex-app-server/codex-app-server-permission-boundary.js";
import { brokerFixture, nativeBrokerConfig, capture, captureUrl, catalogUrl, fixtureEndpoint, fixtureCapability } from "../../fixtures/codex-native-broker-0.150.1/fixture.ts";
import { nativeConfigResult, rehashNativeLayers, type NativeConfigResult } from "../../fixtures/codex-native-config-0.150.1/fixture.ts";

const hash = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");

test("both native captures retain exact binary, source, safety facts and normalized digest provenance", t => {
  const provenance = JSON.parse(readFileSync(new URL("../../fixtures/codex-native-broker-0.150.1/provenance.json", import.meta.url), "utf8"));
  assert.equal(provenance.source.officialSourceCommit, "90854393966b21e9ebfd21b122334eb09a20c93d");
  assert.equal(provenance.source.archiveSha256, "c107d525a8eaf2df6e21b0e76ada96fab4077ff38471c20c69ec2f4ca4b623cb");
  for (const [file, digest] of Object.entries(provenance.files)) {
    assert.equal(hash(readFileSync(new URL(`../../fixtures/codex-native-broker-0.150.1/${file}`, import.meta.url))), digest);
  }
  assert.equal(readFileSync(catalogUrl).length, CODEX_NATIVE_CATALOG_BYTES);
  assert.equal(hash(readFileSync(catalogUrl)), CODEX_NATIVE_CATALOG_SHA256);
  for (const mode of ["analysis", "workspace-write"] as const) {
    const f = brokerFixture(t, mode); const raw = capture(mode);
    assert.equal(raw.intent, mode);
    assert.equal(raw.binarySha256, "abf1bb1643a79f73aa78ee627e111e02d4f8c98f25813a0cf6ce277709664386");
    assert.equal(raw.isolatedNetwork, true); assert.equal(raw.authFilesSupplied, false);
    assert.equal(raw.providerTurnRequested, false); assert.equal(raw.stage, "complete");
    assert.equal(raw.closeResult.signal, "SIGTERM");
    const retained = raw.messages.find((message: { id?: string }) => message.id === "config").result;
    assert.deepEqual(nativeBrokerConfig(`${raw.project}/private-home`, mode), retained);
    assert.equal(hash(readFileSync(captureUrl(mode))), provenance.files[`capture.linux-${mode}.json`]);
    const normalized = nativeBrokerConfig(`${provenance.captures[mode].syntheticRoot}/private-home`, mode);
    assert.equal(hash(`${JSON.stringify(normalized, null, 2)}\n`), provenance.captures[mode].normalizedSha256);
    assert.equal(Object.keys(normalized.config).length, 98);
    assert.equal(Object.keys(normalized.origins).length, 36);
    assert.equal(normalized.layers.length, 3);
    validateCodexConfigEvidence(nativeBrokerConfig(f.home, mode), f.boundary, f.recipe);
    validateCodexPermissionProfileEvidence(raw.messages.find((message: { id?: string }) => message.id === "permission-list").result, f.boundary);
    // Explicit second mode: legacy permission-only is still 98 / 14 / 3.
    const legacy = nativeConfigResult(f.home, mode);
    assert.equal(Object.keys(legacy.config).length, 98); assert.equal(Object.keys(legacy.origins).length, 14);
    assert.equal(legacy.layers.length, 3); validateCodexConfigEvidence(legacy, f.boundary);
    assert.throws(() => validateCodexConfigEvidence(legacy, f.boundary, f.recipe));
    assert.throws(() => validateCodexConfigEvidence(nativeBrokerConfig(f.home, mode), f.boundary));
  }
});

test("pure renderer matches supplied TOML and keeps local capability out of metadata and tool environment", t => {
  const f = brokerFixture(t);
  assert.deepEqual(readdirSync(f.home), []);
  const raw = capture("analysis");
  const input = readFileSync(new URL("../../fixtures/codex-native-broker-0.150.1/input-config.analysis.toml", import.meta.url), "utf8");
  const text = renderCodexNativeBrokerConfig(f.recipe);
  assert.equal(text, input.replaceAll(`${raw.project}/private-home`, f.home));
  const effective = nativeBrokerConfig(f.home).config;
  assert.deepEqual(codexNativeBrokerUserOverrides(f.recipe), Object.fromEntries(
    Object.entries(nativeBrokerConfig(f.home).layers[1]!.config).filter(([key]) => key !== "permissions")));
  const overrides = codexNativeBrokerEffectiveOverrides(f.recipe);
  for (const [key, value] of Object.entries(overrides)) {assert.deepEqual(effective[key], value);}
  assert.deepEqual(effective.shell_environment_policy, {
    inherit: null, ignore_default_excludes: null, exclude: ["AR_PRIVATE_BROKER_CAPABILITY"],
    set: null, include_only: null, filters: null, experimental_use_profile: null,
  });
  assert.equal(effective.allow_login_shell, false);
  assert.equal(text.includes('enabled = true'), false);
  assert.equal(f.boundary.permissionProfile.network.enabled, false);
  assert.equal(f.boundary.permissionProfile.file_system.entries[0]?.path, f.home);
  for (const output of [text, JSON.stringify(f.recipe), JSON.stringify(overrides), JSON.stringify(effective), f.boundary.effectivePolicyDigest]) {
    assert.equal(output.includes(fixtureCapability), false);
  }
  assert.deepEqual(readdirSync(f.home), []); // renderer never creates files or allocates a home
});

test("only canonical RFC1918 IPv4 plus exact observed profile path can be selected", t => {
  const { boundary } = brokerFixture(t);
  const create = (endpoint: unknown, profile: unknown = "codex-chatgpt") =>
    createCodexNativeBrokerRecipe({ boundary, endpoint, profile } as never);
  for (const address of ["10.1.2.3", "172.16.0.1", "172.31.255.1", "192.168.1.1"]) {
    for (const port of [1, 80, 65535]) {assert.equal(create(`http://${address}:${port}/backend-api/codex`).endpoint, `http://${address}:${port}/backend-api/codex`);}
  }
  for (const address of ["0.0.0.0", "127.0.0.1", "8.8.8.8", "172.15.0.1", "172.32.0.1", "192.169.1.1", "169.254.1.1", "100.64.0.1", "224.0.0.1", "255.255.255.255", "localhost", "[::1]", "010.1.2.3", "10.1.2.256", "167837953", "10.1.2"]) {
    assert.throws(() => create(`http://${address}:43129/backend-api/codex`));
  }
  for (const suffix of ["", "/", "/responses", "?x=1", "#x", "/../codex", "/%2e%2e/codex", "\r\n", "\n", "\r", " ", "\\responses"]) {
    if (suffix !== "") {assert.throws(() => create(`${fixtureEndpoint}${suffix}`));}
  }
  for (const port of ["0", "00", "080", "65536", "-1", "1.5", "1e3", ""]) {assert.throws(() => create(`http://10.1.2.3:${port}/backend-api/codex`));}
  for (const url of [fixtureEndpoint.replace("http:", "https:"), fixtureEndpoint.replace("//", "//user:pass@"), fixtureEndpoint.replace("backend-api/codex", "v1"), fixtureEndpoint.replace("http://", "http://\r\n")]) {assert.throws(() => create(url));}
  for (const profile of ["codex-api", "CodexChatGPT", {}, null]) {assert.throws(() => create(fixtureEndpoint, profile));}
});

test("recipe identity rejects forged records, Proxies, accessors and mutation without running traps", t => {
  const f = brokerFixture(t); let touched = 0;
  const trap = () => {touched += 1; throw new Error("must not run");};
  const proxy = <T extends object>(value: T) => new Proxy(value, { get: trap, ownKeys: trap, getPrototypeOf: trap });
  const input = { boundary: f.boundary, endpoint: fixtureEndpoint, profile: "codex-chatgpt" as const };
  for (const bad of [proxy(input), { ...input, extra: true }, Object.defineProperty({ ...input }, "endpoint", { get: trap }),
    { ...input, boundary: proxy(f.boundary) }, { ...input, boundary: { ...f.boundary } }, { ...input, endpoint: { toString: trap } }]) {
    assert.throws(() => createCodexNativeBrokerRecipe(bad as never));
  }
  for (const bad of [{ ...f.recipe }, Object.freeze({ ...f.recipe }), proxy(f.recipe), Object.create(f.recipe)]) {
    assert.throws(() => renderCodexNativeBrokerConfig(bad));
    assert.throws(() => validateCodexConfigEvidence(nativeBrokerConfig(f.home), f.boundary, bad));
  }
  assert.equal(Object.isFrozen(f.recipe), true);
  assert.throws(() => Object.assign(f.recipe, { endpoint: "http://10.0.0.2:5/backend-api/codex" }));
  const snapshotted = createCodexNativeBrokerRecipe(input);
  input.endpoint = "http://10.0.0.2:5/backend-api/codex";
  assert.equal(snapshotted.endpoint, fixtureEndpoint);
  const similarBoundary = createCodexAppServerPermissionBoundary({ codexHome: f.home, workspaceRef: f.workspace, intentMode: "analysis" });
  assert.throws(() => validateCodexConfigEvidence(nativeBrokerConfig(f.home), similarBoundary, f.recipe));
  assert.equal(touched, 0);
});

test("native attestation rejects every field/origin/layer mutation, even with recomputed layer digests", t => {
  for (const mode of ["analysis", "workspace-write"] as const) {
    const f = brokerFixture(t, mode);
    const reject = (mutate: (result: NativeConfigResult) => void) => {
      const r = nativeBrokerConfig(f.home, mode); mutate(r);
      assert.throws(() => validateCodexConfigEvidence(r, f.boundary, f.recipe));
    };
    for (const key of Object.keys(nativeBrokerConfig(f.home, mode).config)) {
      reject(r => {delete r.config[key];}); reject(r => {r.config[key] = "drift";});
    }
    for (const key of Object.keys(nativeBrokerConfig(f.home, mode).origins)) {
      reject(r => {delete r.origins[key];});
      reject(r => {r.origins[key]!.version = `sha256:${"0".repeat(64)}`;});
      reject(r => {r.origins[key]!.name = { type: "sessionFlags", extra: true };});
    }
    for (let index = 0; index < 3; index += 1) {
      reject(r => {r.layers.splice(index, 1);}); reject(r => {r.layers.push(r.layers[index]!);});
      reject(r => {r.layers[index]!.config.extra = false; rehashNativeLayers(r);});
      reject(r => {r.layers[index]!.disabledReason = "ignored";});
      reject(r => {r.layers[index]!.name.type = "project";});
    }
    reject(r => {r.config.unknown = null;}); reject(r => {r.origins.unknown = r.origins.model!;});
    reject(r => {r.layers.reverse();}); reject(r => {Object.assign(r, { extra: null });});
    // Mutate every nested native broker default/leaf independently.
    const walk = (value: unknown, path: string[]) => {
      if (value === null || typeof value !== "object") {return;}
      for (const [key, child] of Object.entries(value)) {
        const visit = (r: NativeConfigResult) => [...path].reduce((v, part) => (v as Record<string, unknown>)[part], r.config as unknown) as Record<string, unknown>;
        reject(r => {visit(r)[key] = "drift";});
        reject(r => {delete visit(r)[key];});
        walk(child, [...path, key]);
      }
    };
    walk(nativeBrokerConfig(f.home, mode).config, []);
    const allowedNull = nativeBrokerConfig(f.home, mode);
    allowedNull.layers.forEach(layer => {layer.disabledReason = null;});
    validateCodexConfigEvidence(allowedNull, f.boundary, f.recipe);
  }
});

test("rebased captures reject endpoint substitution and native wire Proxy/accessor attacks without serialization", t => {
  const f = brokerFixture(t); let touched = 0;
  const trap = () => {touched += 1; throw new Error(fixtureCapability);};
  for (const mutate of [
    (r: NativeConfigResult) => {r.config.model_providers = new Proxy({}, { ownKeys: trap, get: trap });},
    (r: NativeConfigResult) => {Object.defineProperty(r.layers[1]!.config, "model", { get: trap, enumerable: true });},
    (r: NativeConfigResult) => {r.origins = new Proxy(r.origins, { getPrototypeOf: trap });},
    (r: NativeConfigResult) => {r.layers = new Proxy(r.layers, { get: trap });},
    (r: NativeConfigResult) => {
      for (const config of [r.config, r.layers[1]!.config]) {
        (config.model_providers as { ar_broker: Record<string, unknown> }).ar_broker.base_url = "http://10.203.0.2:43129/backend-api/codex";
      }
      rehashNativeLayers(r);
    },
  ]) {
    const r = nativeBrokerConfig(f.home); mutate(r);
    assert.throws(() => validateCodexConfigEvidence(r, f.boundary, f.recipe), error => {
      assert.equal(String(error).includes(fixtureCapability), false); return true;
    });
  }
  assert.equal(touched, 0);
});

test("explicit preparation verifies pinned bytes and produces only a private same-recipe file observation", async t => {
  const f = brokerFixture(t);
  await assert.rejects(prepareCodexNativeBrokerFiles(f.recipe));
  const files = await f.prepare(); validateCodexNativeBrokerFiles(files, f.recipe);
  assert.equal(Object.isFrozen(files), true); assert.equal(JSON.stringify(files).includes(fixtureCapability), false);
  for (const forged of [{ ...files }, new Proxy(files, {})]) {assert.throws(() => validateCodexNativeBrokerFiles(forged, f.recipe));}
  const recipe2 = createCodexNativeBrokerRecipe({ boundary: f.boundary, endpoint: fixtureEndpoint, profile: "codex-chatgpt" });
  assert.throws(() => validateCodexNativeBrokerFiles(files, recipe2));
  writeFileSync(join(f.home, "models.json"), "{}");
  assert.throws(() => validateCodexNativeBrokerFiles(files, f.recipe));
  await assert.rejects(prepareCodexNativeBrokerFiles(f.recipe));
});

test("preparation rejects stale home, config/catalog replacement, mode widening, symlinks and hardlinks", async t => {
  for (const name of ["models.json", "config.toml"]) {
    for (const attack of ["bytes", "mode", "symlink", "hardlink", "replacement"] as const) {
      const f = brokerFixture(t); const files = await f.prepare(); const path = join(f.home, name);
      if (attack === "bytes") {const b = readFileSync(path); b[0] = b[0] === 32 ? 33 : 32; writeFileSync(path, b);}
      if (attack === "mode") {chmodSync(path, 0o644);}
      if (attack === "symlink" || attack === "hardlink") {
        const other = join(f.root, "substitute"); writeFileSync(other, readFileSync(path), { mode: 0o600 }); unlinkSync(path);
        if (attack === "symlink") {symlinkSync(other, path);} else {linkSync(other, path);}
      }
      if (attack === "replacement") {const b = readFileSync(path); renameSync(path, `${path}.old`); writeFileSync(path, b, { mode: 0o600 });}
      assert.throws(() => validateCodexNativeBrokerFiles(files, f.recipe));
      if (attack !== "replacement") {await assert.rejects(prepareCodexNativeBrokerFiles(f.recipe));}
    }
  }
  const f = brokerFixture(t); const files = await f.prepare();
  renameSync(f.home, `${f.home}.old`); mkdirSync(f.home, { mode: 0o700 });
  assert.throws(() => validateCodexNativeBrokerFiles(files, f.recipe));
  await assert.rejects(prepareCodexNativeBrokerFiles(f.recipe));
});

test("preparation and launch revalidation reject every unexpected private-home entry without reading auth", async t => {
  for (const name of ["auth.json", "models_cache.json", "sessions", "other-config.toml"]) {
    const f = brokerFixture(t); const files = await f.prepare();
    // Synthetic unreadable bytes: only a directory entry may be observed.
    writeFileSync(join(f.home, name), "synthetic state that must not be opened", { mode: 0o000 });
    assert.throws(() => validateCodexNativeBrokerFiles(files, f.recipe));
    await assert.rejects(prepareCodexNativeBrokerFiles(f.recipe));
  }
});
