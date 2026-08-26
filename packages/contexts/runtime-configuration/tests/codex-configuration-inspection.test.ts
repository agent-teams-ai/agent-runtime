import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createCodexConfigurationInspectionFeature,
  createNodeConfigurationSourceReader,
  createSmolTomlParser,
} from "../dist/composition.js";

const createFeature = (maximumBytes = 128 * 1024) =>
  createCodexConfigurationInspectionFeature({
    parser: createSmolTomlParser(),
    sourceReader: createNodeConfigurationSourceReader(maximumBytes),
  });

test("applies deterministic precedence and selected native profile", async t => {
  const root = await mkdtemp(join(tmpdir(), "ar-codex-config-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const user = join(root, "user.toml");
  const workspace = join(root, "workspace.toml");
  await writeFile(
    user,
    [
      "model = 'gpt-base'",
      "personality = 'friendly'",
      "model_provider = 'openai'",
      "api_key = 'must-not-leak'",
      "approval_policy = 'never'",
      "unknown_future_key = 'future'",
      "[profiles.work]",
      "model = 'gpt-work'",
      "model_reasoning_effort = 'high'",
    ].join("\n"),
  );
  await writeFile(
    workspace,
    [
      "personality = 'concise'",
      "model_reasoning_effort = 'medium'",
      "[mcp_servers.synthetic]",
      "command = 'ignored'",
    ].join("\n"),
  );
  const [userCanonical, workspaceCanonical] = await Promise.all([
    realpath(user),
    realpath(workspace),
  ]);

  const input = {
    nativeProfile: "work",
    observationEpoch: "epoch-1",
    sources: [
      { absolutePath: workspace, canonicalPath: workspaceCanonical, displayPath: "$WORKSPACE/.codex/config.toml", kind: "workspace" as const, observationEpoch: "epoch-1", precedence: 20, sourceRef: "source:workspace" },
      { absolutePath: user, canonicalPath: userCanonical, displayPath: "$HOME/.codex/config.toml", kind: "user" as const, observationEpoch: "epoch-1", precedence: 10, sourceRef: "source:user" },
    ],
  };
  const first = await createFeature().inspectCodexConfiguration.execute(input);
  const second = await createFeature().inspectCodexConfiguration.execute(input);

  assert.deepEqual(first, second);
  assert.deepEqual(first.settings, [
    { key: "model", sourceRef: "source:user", value: "gpt-work" },
    { key: "model_reasoning_effort", sourceRef: "source:workspace", value: "medium" },
    { key: "personality", sourceRef: "source:workspace", value: "concise" },
  ]);
  assert.deepEqual(
    first.diagnostics.map(item => item.code).toSorted(),
    [
      "executable_setting_deferred",
      "profile_missing",
      "provider_access_setting_deferred",
      "secret_setting_ignored",
      "security_setting_deferred",
      "unknown_setting_ignored",
    ],
  );
  assert.doesNotMatch(JSON.stringify(first), /must-not-leak/u);
});

test("rejects duplicate keys, BOM, invalid UTF-8, oversized and stale sources", async t => {
  const root = await mkdtemp(join(tmpdir(), "ar-codex-invalid-config-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  await mkdir(root, { recursive: true });
  const duplicate = join(root, "duplicate.toml");
  const bom = join(root, "bom.toml");
  const invalidUtf8 = join(root, "invalid.toml");
  const oversized = join(root, "large.toml");
  const stale = join(root, "stale.toml");
  await writeFile(duplicate, "model = 'a'\nmodel = 'b'\n");
  await writeFile(bom, Buffer.from([0xef, 0xbb, 0xbf, ...Buffer.from("model='a'")]));
  await writeFile(invalidUtf8, Buffer.from([0xc3, 0x28]));
  await writeFile(oversized, "model = 'this is deliberately too large'\n");
  await writeFile(stale, "model = 'stale'\n");
  const [duplicateCanonical, bomCanonical, invalidCanonical, largeCanonical, staleCanonical] = await Promise.all([
    realpath(duplicate),
    realpath(bom),
    realpath(invalidUtf8),
    realpath(oversized),
    realpath(stale),
  ]);

  const result = await createFeature(32).inspectCodexConfiguration.execute({
    observationEpoch: "epoch-current",
    sources: [
      { absolutePath: duplicate, canonicalPath: duplicateCanonical, displayPath: "$HOME/duplicate", kind: "user", observationEpoch: "epoch-current", precedence: 1, sourceRef: "duplicate" },
      { absolutePath: bom, canonicalPath: bomCanonical, displayPath: "$HOME/bom", kind: "user", observationEpoch: "epoch-current", precedence: 2, sourceRef: "bom" },
      { absolutePath: invalidUtf8, canonicalPath: invalidCanonical, displayPath: "$HOME/invalid", kind: "user", observationEpoch: "epoch-current", precedence: 3, sourceRef: "invalid" },
      { absolutePath: oversized, canonicalPath: largeCanonical, displayPath: "$HOME/large", kind: "user", observationEpoch: "epoch-current", precedence: 4, sourceRef: "large" },
      { absolutePath: stale, canonicalPath: staleCanonical, displayPath: "$HOME/stale", kind: "user", observationEpoch: "epoch-old", precedence: 5, sourceRef: "stale" },
      { absolutePath: join(root, "missing.toml"), canonicalPath: join(root, "missing.toml"), displayPath: "$HOME/missing", kind: "user", observationEpoch: "epoch-current", precedence: 6, sourceRef: "missing" },
    ],
  });

  assert.deepEqual(
    result.diagnostics.map(item => item.code).toSorted(),
    [
      "config_bom_rejected",
      "config_invalid_utf8",
      "config_parse_failed",
      "config_too_large",
      "source_epoch_stale",
    ],
  );
  assert.equal(result.settings.length, 0);
  assert.equal(result.sources.find(item => item.sourceRef === "missing")?.status, "missing");
});

test("does not read a configuration alias retargeted after authorization", async t => {
  const root = await mkdtemp(join(tmpdir(), "ar-codex-config-race-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const first = join(root, "first.toml");
  const second = join(root, "second.toml");
  const alias = join(root, "config.toml");
  await writeFile(first, "model = 'authorized'\n");
  await writeFile(second, "model = 'retargeted'\n");
  await symlink(first, alias);
  const firstCanonical = await realpath(first);
  await rm(alias);
  await symlink(second, alias);

  const result = await createFeature().inspectCodexConfiguration.execute({
    observationEpoch: "epoch-1",
    sources: [{
      absolutePath: alias,
      canonicalPath: firstCanonical,
      displayPath: "$HOME/.codex/config.toml",
      kind: "user",
      observationEpoch: "epoch-1",
      precedence: 1,
      sourceRef: "source:user",
    }],
  });

  assert.equal(result.settings.length, 0);
  assert.equal(result.diagnostics[0]?.code, "config_unreadable");
});
