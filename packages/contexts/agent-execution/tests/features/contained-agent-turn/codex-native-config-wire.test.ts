import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createCodexAppServerPermissionBoundary, validateCodexConfigEvidence } from "../../../dist/features/contained-agent-turn/adapters/outbound/codex-app-server/codex-app-server-permission-boundary.js";
import { BoundedCodexJsonLineReader } from "../../../dist/features/contained-agent-turn/adapters/outbound/codex-app-server/codex-app-server-jsonl.js";
import { boundary, createProvider, executeInput, exactConfigResult, FakeCodexProcess, standardHandshake } from "../../codex-app-server-contained-turn-provider-fixture.ts";
import { nativeConfigResult, nativeFixtureHome, nativeFixtureUrl, rehashNativeLayers, type NativeConfigResult, type NativeRecord } from "../../fixtures/codex-native-config-0.153.4/fixture.ts";

const profileId = "agent-runtime-contained-v1";
const exact = () => nativeConfigResult(boundary.codexHome);
const rejectMutation = (change: (result: NativeConfigResult) => void): void => {
  const result = exact();
  change(result);
  assert.throws(() => validateCodexConfigEvidence(result, boundary), /Codex permission evidence rejected/u);
};

test("retains the complete native capture with digest-bound provenance and no reduced alternative", () => {
  const bytes = readFileSync(nativeFixtureUrl);
  const provenance = JSON.parse(readFileSync(new URL("../../fixtures/codex-native-config-0.153.4/provenance.json", import.meta.url), "utf8"));
  assert.equal(createHash("sha256").update(bytes).digest("hex"), provenance.normalization.sha256);
  assert.equal(provenance.capture.rawArtifactSha256, "778b394b1ebd80645e1a543da28e5580c703ef230ce8cc3d8b107fcf39d0919a");
  assert.equal(provenance.source.commit, "3d2ee51ca2d5db578f328aa75e20aa22c0197c9a");
  assert.equal(provenance.capture.binarySha256, "b973d440acac501fd2594a43e7ca9ce41e0a65b9dfb28d0d7a7837c99e1261e3");
  const result = exact();
  assert.equal(Object.keys(result.config).length, 99);
  assert.equal(Object.keys(result.origins).length, 14);
  assert.equal(result.layers.length, 3);
  validateCodexConfigEvidence(result, boundary);
  assert.deepEqual(exactConfigResult(), result);
  rejectMutation(changed => {changed.config = { default_permissions: profileId, permissions: changed.config.permissions };});
  rejectMutation(changed => {changed.origins = { permissions: changed.origins[`permissions.${profileId}.extends`]! };});
});

test("supports deterministic intent inheritance and opaque dotted/Unicode private paths", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ar69-config-modes-")));
  try {
    const home = join(root, "private.home.é-😀"); const workspace = join(root, "workspace");
    mkdirSync(home, { mode: 0o700 }); mkdirSync(workspace, { mode: 0o700 });
    for (const mode of ["analysis", "workspace-write"] as const) {
      const selected = createCodexAppServerPermissionBoundary({ codexHome: home, intentMode: mode, workspaceRef: workspace });
      const response = nativeConfigResult(home, mode);
      validateCodexConfigEvidence(response, selected);
      assert.throws(() => validateCodexConfigEvidence(nativeConfigResult(home, mode === "analysis" ? "workspace-write" : "analysis"), selected), /rejected/u);
      assert.throws(() => validateCodexConfigEvidence(nativeConfigResult(`${home}/other`, mode), selected), /rejected/u);
    }
    // Identity transformation preserves retained byte-level semantic content and hashes.
    assert.deepEqual(nativeConfigResult(nativeFixtureHome), JSON.parse(readFileSync(nativeFixtureUrl, "utf8")));
  } finally {rmSync(root, { recursive: true, force: true });}
});

test("rejects omission and nondefault values for every one of the 99 effective fields", () => {
  for (const [key, value] of Object.entries(exact().config)) {
    rejectMutation(result => {delete result.config[key];});
    for (const replacement of [value === null ? "nondefault" : null, [], { enabled: true }]) {
      if (JSON.stringify(replacement) === JSON.stringify(value)) {continue;}
      rejectMutation(result => {result.config[key] = replacement;});
    }
  }
  for (const value of [true, false, {}, [], 0, "", "https://unqualified.invalid", ["run-hook"]]) {
    for (const key of ["model", "model_provider", "model_catalog_json", "instructions", "hooks", "projects", "openai_base_url"]) {
      rejectMutation(result => {result.config[key] = value;});
    }
  }
  rejectMutation(result => {result.config.unknown = null;});
  rejectMutation(result => {Object.assign(result, { extra: null });});
});

test("rejects every nested default shape or value change, including empty maps", () => {
  const defaults = exact().config;
  for (const [key, value] of Object.entries(defaults)) {
    if (value === null || typeof value !== "object" || key === "permissions") {continue;}
    if (Array.isArray(value)) {
      rejectMutation(result => {(result.config[key] as unknown[]).push("extra");});
      continue;
    }
    rejectMutation(result => {(result.config[key] as NativeRecord).extra = null;});
    for (const [nestedKey, nested] of Object.entries(value)) {
      rejectMutation(result => {delete (result.config[key] as NativeRecord)[nestedKey];});
      rejectMutation(result => {(result.config[key] as NativeRecord)[nestedKey] = nested === null ? true : null;});
      if (typeof nested === "boolean") {
        rejectMutation(result => {(result.config[key] as NativeRecord)[nestedKey] = !nested;});
      }
    }
  }
});

test("requires all eight disabled flags in effective values, raw session config and leaf origins", () => {
  const disabled = ["apps", "browser_use", "computer_use", "image_generation", "multi_agent", "multi_agent_v2", "plugins", "remote_plugin"];
  for (const feature of disabled) {
    const leaf = feature === "multi_agent_v2" ? `features.${feature}.enabled` : `features.${feature}`;
    for (const value of [true, null, { enabled: false }, 0, "false"]) {
      rejectMutation(result => {(result.config.features as NativeRecord)[feature] = value;});
      rejectMutation(result => {
        (result.layers[0]!.config.features as NativeRecord)[feature] = value;
        rehashNativeLayers(result); // Even consistent forged versions cannot admit a changed launch.
      });
    }
    rejectMutation(result => {delete (result.layers[0]!.config.features as NativeRecord)[feature]; rehashNativeLayers(result);});
    rejectMutation(result => {delete result.origins[leaf];});
  }
  rejectMutation(result => {delete result.layers[0]!.config.features; rehashNativeLayers(result);});
  rejectMutation(result => {(result.layers[0]!.config.features as NativeRecord).auth_elicitation = true; rehashNativeLayers(result);});
});

test("requires every exact leaf origin and its unique layer name/version without parsing path segments", () => {
  for (const key of Object.keys(exact().origins)) {
    rejectMutation(result => {delete result.origins[key];});
    for (const version of ["1", "", `sha256:${"0".repeat(64)}`]) {
      rejectMutation(result => {result.origins[key]!.version = version;});
    }
    for (const name of [{ type: "sessionFlags", extra: true }, { type: "system", file: "/etc/codex/config.toml" },
      { type: "user", file: `${boundary.codexHome}/other.toml`, profile: null },
      { type: "user", file: `${boundary.codexHome}/config.toml`, profile: "other" }]) {
      rejectMutation(result => {result.origins[key]!.name = name;});
    }
    for (const malformed of [`${key}.`, `.${key}`, `${key}\0`, `${key}.enabled`, key.replaceAll(".", "\\.")]) {
      rejectMutation(result => {result.origins[malformed] = result.origins[key]!; delete result.origins[key];});
    }
    rejectMutation(result => {Object.assign(result.origins[key]!, { extra: null });});
  }
  rejectMutation(result => {
    result.origins["features.multi_agent_v2"] = result.origins["features.multi_agent_v2.enabled"]!;
    delete result.origins["features.multi_agent_v2.enabled"];
  });
  rejectMutation(result => {result.origins.permissions = result.origins[`permissions.${profileId}.extends`]!;});
  rejectMutation(result => {
    const user = result.origins[`permissions.${profileId}.extends`]!;
    result.origins["features.apps"] = { name: user.name, version: user.version };
  });
});

test("rejects added, disabled, duplicate, reordered, overridden or content-unbound layers", () => {
  for (let index = 0; index < 3; index += 1) {
    rejectMutation(result => {result.layers.splice(index, 1);});
    rejectMutation(result => {result.layers.push(structuredClone(result.layers[index]!));});
    rejectMutation(result => {
      result.layers[index]!.version = `sha256:${"0".repeat(64)}`;
      for (const origin of Object.values(result.origins)) {
        if (origin.name.type === result.layers[index]!.name.type) {origin.version = result.layers[index]!.version;}
      }
    });
    for (const key of ["instructions", "model", "features", "permissions", "projects"]) {
      rejectMutation(result => {result.layers[index]!.config[key] = {}; rehashNativeLayers(result);});
    }
    for (const value of ["ignored", undefined, false, {}]) {
      rejectMutation(result => {result.layers[index]!.disabledReason = value;});
    }
  }
  rejectMutation(result => {result.layers.reverse();});
  for (const type of ["project", "mdm", "enterpriseManaged", "legacyManagedConfigTomlFromFile", "legacyManagedConfigTomlFromMdm", "packagedDefaults", "unknown"]) {
    for (const disabledReason of [undefined, "untrusted project"]) {
      rejectMutation(result => {result.layers.push({ config: {}, name: { type }, version: "1", ...(disabledReason ? { disabledReason } : {}) });});
    }
  }
});

test("rejects getters, proxies and shape tricks before invoking attacker-controlled code", () => {
  let touched = 0;
  const traps = {
    get: () => {touched += 1; throw new Error("get invoked");},
    ownKeys: () => {touched += 1; throw new Error("ownKeys invoked");},
    getPrototypeOf: () => {touched += 1; throw new Error("getPrototypeOf invoked");},
  };
  const select: ((result: NativeConfigResult) => object)[] = [
    result => result, result => result.config, result => result.origins, result => result.layers,
    result => result.layers[0]!, result => result.layers[0]!.name, result => result.layers[0]!.config,
    result => result.origins["features.apps"]!, result => result.origins["features.apps"]!.name,
    result => result.config.shell_environment_policy as object,
  ];
  for (const target of select) {
    rejectMutation(result => {Object.defineProperty(target(result), "extra", { enumerable: true, get: () => {touched += 1; return null;} });});
    rejectMutation(result => {Object.defineProperty(target(result), "hidden", { value: null });});
    rejectMutation(result => {Object.defineProperty(target(result), Symbol("extra"), { value: null });});
    rejectMutation(result => {Object.setPrototypeOf(target(result), { inherited: true });});
  }
  for (const mutate of [
    (r: NativeConfigResult) => {r.config = new Proxy(r.config, traps);},
    (r: NativeConfigResult) => {r.layers = new Proxy(r.layers, traps);},
    (r: NativeConfigResult) => {r.layers[0]!.name = new Proxy(r.layers[0]!.name, traps);},
    (r: NativeConfigResult) => {r.origins["features.apps"]!.name = new Proxy({}, traps);},
    (r: NativeConfigResult) => {Object.defineProperty(r.layers, "0", { get: () => {touched += 1; return {};}, enumerable: true });},
    (r: NativeConfigResult) => {Object.defineProperty(r.config, "model", { get: () => {touched += 1; return null;}, enumerable: true });},
    (r: NativeConfigResult) => {r.config.features = new Proxy({}, traps);},
  ]) {rejectMutation(mutate);}
  assert.throws(() => validateCodexConfigEvidence(new Proxy(exact(), traps), boundary), /rejected/u);
  const revoked = Proxy.revocable({}, traps); revoked.revoke();
  rejectMutation(result => {result.config = revoked.proxy;});
  rejectMutation(result => {delete result.layers[1];});
  rejectMutation(result => {result.config.cycle = result.config;});
  rejectMutation(result => {result.config.model = Number.NaN;});
  rejectMutation(result => {result.config.model = () => null;});
  rejectMutation(result => {result.config.model = 1n;});
  assert.equal(touched, 0);
});

test("wire decoder rejects duplicate native leaf keys including Unicode-escaped aliases", async () => {
  const source = JSON.stringify({ id: "config", result: exact() });
  const token = '"features.apps":';
  for (const duplicate of ['"features.apps":null,', '"features.\\u0061pps":null,']) {
    const wire = source.replace(token, `${duplicate}${token}`);
    const reader = new BoundedCodexJsonLineReader((async function* () {yield Buffer.from(`${wire}\n`);})(), 100_000);
    await assert.rejects(reader.read(performance.now() + 1000), /malformed JSON/u);
  }
});

test("native config drift refuses synthetic execution before thread/start or turn/start", async () => {
  const mutations: ((result: NativeConfigResult) => void)[] = [
    result => {
      const user = result.layers.find(layer => layer.name.type === "user")!;
      const project = { dotCodexFolder: boundary.workspaceRef + "/.codex", type: "project" };
      user.name = project;
      for (const origin of Object.values(result.origins)) {
        if (origin.name.type === "user") {origin.name = project;}
      }
    },
    result => {result.config.openai_base_url = "https://unqualified.invalid";},
    result => {(result.config.features as NativeRecord).plugins = true;},
    result => {delete result.origins["features.multi_agent_v2.enabled"];},
    result => {result.layers[1]!.disabledReason = "ignored";},
    result => {result.layers[2]!.config.instructions = "unsafe";},
  ];
  for (const mutate of mutations) {
    const process = new FakeCodexProcess((message, target) => {
      if (message.method === "config/read") {
        const result = exact(); mutate(result); target.emit({ id: message.id, result });
      } else {standardHandshake(message, target);}
    });
    const outcome = await createProvider(process).execute(executeInput(process));
    assert.equal(outcome.kind, "not_accepted");
    assert.equal(process.requests.some(request => request.method === "thread/start" || request.method === "turn/start"), false);
  }
});
