import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
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
    sourceIdentityKey: Buffer.alloc(32, 7),
    sourceReader: createNodeConfigurationSourceReader(maximumBytes),
  });

const fileIdentity = async (path: string): Promise<string> => {
  const observation = await stat(path);
  return `${observation.dev}:${observation.ino}`;
};

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
  const [userCanonical, workspaceCanonical, userIdentity, workspaceIdentity] = await Promise.all([
    realpath(user),
    realpath(workspace),
    fileIdentity(user),
    fileIdentity(workspace),
  ]);

  const input = {
    identityScope: "scope-1",
    nativeProfile: "work",
    observationEpoch: "epoch-1",
    sources: [
      { absolutePath: workspace, authorizedFileIdentity: workspaceIdentity, canonicalPath: workspaceCanonical, displayPath: "$WORKSPACE/.codex/config.toml", kind: "workspace" as const, observationEpoch: "epoch-1" },
      { absolutePath: user, authorizedFileIdentity: userIdentity, canonicalPath: userCanonical, displayPath: "$HOME/.codex/config.toml", kind: "user" as const, observationEpoch: "epoch-1" },
    ],
  };
  const first = await createFeature().inspectCodexConfiguration.execute(input);
  const second = await createFeature().inspectCodexConfiguration.execute(input);

  assert.deepEqual(first, second);
  const userSourceRef = first.sources.find(source => source.kind === "user")?.sourceRef;
  const workspaceSourceRef = first.sources.find(source => source.kind === "workspace")?.sourceRef;
  assert.ok(userSourceRef !== undefined);
  assert.ok(workspaceSourceRef !== undefined);
  assert.deepEqual(first.settings, [
    { key: "model", sourceRef: userSourceRef, value: "gpt-work" },
    { key: "model_reasoning_effort", sourceRef: userSourceRef, value: "high" },
    { key: "personality", sourceRef: workspaceSourceRef, value: "concise" },
  ]);
  assert.deepEqual(
    first.diagnostics.map(item => item.code).toSorted(),
    [
      "executable_setting_deferred",
      "provider_access_setting_deferred",
      "secret_setting_ignored",
      "security_setting_deferred",
      "unknown_setting_ignored",
    ],
  );
  assert.doesNotMatch(JSON.stringify(first), /must-not-leak/u);
});

test("reports a selected native profile missing only from the merged configuration", async t => {
  const root = await mkdtemp(join(tmpdir(), "ar-codex-profile-missing-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const user = join(root, "user.toml");
  const workspace = join(root, "workspace.toml");
  await writeFile(user, "model = 'gpt-base'\n");
  await writeFile(workspace, "personality = 'concise'\n");
  const [userCanonical, workspaceCanonical, userIdentity, workspaceIdentity] = await Promise.all([
    realpath(user),
    realpath(workspace),
    fileIdentity(user),
    fileIdentity(workspace),
  ]);

  const result = await createFeature().inspectCodexConfiguration.execute({
    identityScope: "scope-1",
    nativeProfile: "missing",
    observationEpoch: "epoch-1",
    sources: [
      { absolutePath: user, authorizedFileIdentity: userIdentity, canonicalPath: userCanonical, displayPath: "$HOME/config.toml", kind: "user", observationEpoch: "epoch-1" },
      { absolutePath: workspace, authorizedFileIdentity: workspaceIdentity, canonicalPath: workspaceCanonical, displayPath: "$WORKSPACE/config.toml", kind: "workspace", observationEpoch: "epoch-1" },
    ],
  });

  assert.deepEqual(result.diagnostics, [{ code: "profile_missing" }]);
});

test("rejects credential-shaped values even under portable setting keys", async t => {
  const root = await mkdtemp(join(tmpdir(), "ar-codex-secret-value-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const config = join(root, "config.toml");
  const secret = "sk-synthetic-credential-value";
  await writeFile(config, `model = '${secret}'\npersonality = 'concise'\n`);
  const canonicalPath = await realpath(config);
  const authorizedFileIdentity = await fileIdentity(config);

  const result = await createFeature().inspectCodexConfiguration.execute({
    identityScope: "scope-1",
    observationEpoch: "epoch-1",
    sources: [{
      absolutePath: config,
      authorizedFileIdentity,
      canonicalPath,
      displayPath: "$HOME/config.toml",
      kind: "user",
      observationEpoch: "epoch-1",
    }],
  });

  const observedSourceRef = result.sources[0]?.sourceRef;
  assert.ok(observedSourceRef !== undefined);
  assert.deepEqual(result.settings, [
    { key: "personality", sourceRef: observedSourceRef, value: "concise" },
  ]);
  assert.deepEqual(result.diagnostics, [
    { code: "secret_setting_ignored", sourceRef: observedSourceRef },
  ]);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(secret, "u"));
});

test("fails closed for encoded and unprefixed credential-like portable values", async t => {
  const root = await mkdtemp(join(tmpdir(), "ar-codex-secret-shapes-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const values = [
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzZWNyZXQifQ.signature",
    "abcdefghijklmnopqrstuvwxyzABCDEF1234567890",
    "custom-provider-secret-value",
  ];

  for (const [index, value] of values.entries()) {
    const config = join(root, `config-${index}.toml`);
    await writeFile(config, `model = '${value}'\n`);
    const canonicalPath = await realpath(config);
    const authorizedFileIdentity = await fileIdentity(config);
    const result = await createFeature().inspectCodexConfiguration.execute({
      identityScope: `scope-${index}`,
      observationEpoch: "epoch-1",
      sources: [{
        absolutePath: config,
        authorizedFileIdentity,
        canonicalPath,
        displayPath: `$HOME/config-${index}.toml`,
        kind: "user",
        observationEpoch: "epoch-1",
      }],
    });

    assert.equal(result.settings.length, 0);
    assert.ok(
      result.diagnostics.some(diagnostic =>
        diagnostic.code === "secret_setting_ignored" ||
        diagnostic.code === "setting_value_unsupported",
      ),
    );
    assert.doesNotMatch(JSON.stringify(result), new RegExp(value, "u"));
  }
});

test("rejects duplicate sources instead of accepting caller-defined precedence", async t => {
  const root = await mkdtemp(join(tmpdir(), "ar-codex-precedence-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const first = join(root, "first.toml");
  const second = join(root, "second.toml");
  await Promise.all([
    writeFile(first, "model = 'gpt-first'\n"),
    writeFile(second, "model = 'gpt-second'\n"),
  ]);
  const [firstCanonical, secondCanonical, firstIdentity, secondIdentity] = await Promise.all([
    realpath(first),
    realpath(second),
    fileIdentity(first),
    fileIdentity(second),
  ]);

  const result = await createFeature().inspectCodexConfiguration.execute({
    identityScope: "scope-1",
    observationEpoch: "epoch-1",
    sources: [
      { absolutePath: second, authorizedFileIdentity: secondIdentity, canonicalPath: secondCanonical, displayPath: "$HOME/second", kind: "user", observationEpoch: "epoch-1" },
      { absolutePath: first, authorizedFileIdentity: firstIdentity, canonicalPath: firstCanonical, displayPath: "$HOME/first", kind: "user", observationEpoch: "epoch-1" },
    ],
  });

  assert.deepEqual(result.settings, []);
  assert.deepEqual(result.diagnostics, [
    { code: "source_precedence_conflict", setting: "user" },
  ]);
  assert.ok(result.sources.every(source => source.status === "rejected"));
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
  const [duplicateCanonical, bomCanonical, invalidCanonical, largeCanonical, staleCanonical, duplicateIdentity, bomIdentity, invalidIdentity, largeIdentity, staleIdentity] = await Promise.all([
    realpath(duplicate),
    realpath(bom),
    realpath(invalidUtf8),
    realpath(oversized),
    realpath(stale),
    fileIdentity(duplicate),
    fileIdentity(bom),
    fileIdentity(invalidUtf8),
    fileIdentity(oversized),
    fileIdentity(stale),
  ]);

  const fixtures = [
    { absolutePath: duplicate, authorizedFileIdentity: duplicateIdentity, canonicalPath: duplicateCanonical, displayPath: "$HOME/duplicate", observationEpoch: "epoch-current" },
    { absolutePath: bom, authorizedFileIdentity: bomIdentity, canonicalPath: bomCanonical, displayPath: "$HOME/bom", observationEpoch: "epoch-current" },
    { absolutePath: invalidUtf8, authorizedFileIdentity: invalidIdentity, canonicalPath: invalidCanonical, displayPath: "$HOME/invalid", observationEpoch: "epoch-current" },
    { absolutePath: oversized, authorizedFileIdentity: largeIdentity, canonicalPath: largeCanonical, displayPath: "$HOME/large", observationEpoch: "epoch-current" },
    { absolutePath: stale, authorizedFileIdentity: staleIdentity, canonicalPath: staleCanonical, displayPath: "$HOME/stale", observationEpoch: "epoch-old" },
    { absolutePath: join(root, "missing.toml"), canonicalPath: join(root, "missing.toml"), displayPath: "$HOME/missing", observationEpoch: "epoch-current" },
  ] as const;
  const results = await Promise.all(fixtures.map((source, index) =>
    createFeature(32).inspectCodexConfiguration.execute({
      identityScope: `scope-${index}`,
      observationEpoch: "epoch-current",
      sources: [{ ...source, kind: "user" }],
    }),
  ));

  assert.deepEqual(
    results.flatMap(result => result.diagnostics.map(item => item.code)).toSorted(),
    [
      "config_bom_rejected",
      "config_invalid_utf8",
      "config_parse_failed",
      "config_too_large",
      "source_epoch_stale",
    ],
  );
  assert.ok(results.every(result => result.settings.length === 0));
  assert.equal(results.at(-1)?.sources[0]?.status, "missing");
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
  const authorizedFileIdentity = await fileIdentity(first);
  await rm(alias);
  await symlink(second, alias);

  const result = await createFeature().inspectCodexConfiguration.execute({
    identityScope: "scope-1",
    observationEpoch: "epoch-1",
    sources: [{
      absolutePath: alias,
      authorizedFileIdentity,
      canonicalPath: firstCanonical,
      displayPath: "$HOME/.codex/config.toml",
      kind: "user",
      observationEpoch: "epoch-1",
    }],
  });

  assert.equal(result.settings.length, 0);
  assert.equal(result.diagnostics[0]?.code, "config_unreadable");
});

test("does not read a different file installed at the authorized canonical path", async t => {
  const root = await mkdtemp(join(tmpdir(), "ar-codex-config-identity-race-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const config = join(root, "config.toml");
  await writeFile(config, "model = 'authorized'\n");
  const canonicalPath = await realpath(config);
  const authorizedFileIdentity = await fileIdentity(config);
  await rm(config);
  await writeFile(config, "model = 'replacement-must-not-be-read'\n");

  const result = await createFeature().inspectCodexConfiguration.execute({
    identityScope: "scope-1",
    observationEpoch: "epoch-1",
    sources: [{
      absolutePath: config,
      authorizedFileIdentity,
      canonicalPath,
      displayPath: "$HOME/.codex/config.toml",
      kind: "user",
      observationEpoch: "epoch-1",
    }],
  });

  assert.equal(result.settings.length, 0);
  assert.equal(result.diagnostics[0]?.code, "config_unreadable");
  assert.doesNotMatch(JSON.stringify(result), /replacement-must-not-be-read/u);
});
