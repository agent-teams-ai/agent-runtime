import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  createCodexConfigurationInspectionFeature,
  createNodeConfigurationSourceReader,
  createSmolTomlParser,
} from "../dist/composition.js";

const execFile = promisify(execFileCallback);

const createFeature = (maximumBytes = 128 * 1024) =>
  createCodexConfigurationInspectionFeature({
    parser: createSmolTomlParser(),
    sourceIdentityKey: Buffer.alloc(32, 7),
    sourceReader: createNodeConfigurationSourceReader(maximumBytes),
  });

const fileIdentity = async (path: string): Promise<string> => {
  const observation = await stat(path, { bigint: true });
  return `${observation.dev}:${observation.ino}:${observation.ctimeNs}:${observation.size}`;
};

test("applies user, selected external profile, and project precedence deterministically", async t => {
  const root = await mkdtemp(join(tmpdir(), "ar-codex-config-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const user = join(root, "user.toml");
  const workspace = join(root, "workspace.toml");
  const profile = join(root, "work.config.toml");
  await writeFile(
    user,
    [
      "model = 'gpt-5.5'",
      "personality = 'friendly'",
      "model_provider = 'openai'",
      "api_key = 'must-not-leak'",
      "approval_policy = 'never'",
      "unknown_future_key = 'future'",
    ].join("\n"),
  );
  await writeFile(
    profile,
    "model = 'gpt-5.6-codex'\nmodel_reasoning_effort = 'high'\npersonality = 'friendly'\n",
  );
  await writeFile(
    workspace,
    [
      "personality = 'pragmatic'",
      "model_reasoning_effort = 'medium'",
      "[mcp_servers.synthetic]",
      "command = 'ignored'",
    ].join("\n"),
  );
  const [userCanonical, profileCanonical, workspaceCanonical, userIdentity, profileIdentity, workspaceIdentity] = await Promise.all([
    realpath(user),
    realpath(profile),
    realpath(workspace),
    fileIdentity(user),
    fileIdentity(profile),
    fileIdentity(workspace),
  ]);

  const input = {
    dialect: "codex-0.134",
    identityScope: "scope-1",
    nativeProfile: "work",
    observationEpoch: "epoch-1",
    sources: [
      { absolutePath: workspace, authorizedFileIdentity: workspaceIdentity, canonicalPath: workspaceCanonical, displayPath: "$WORKSPACE/.codex/config.toml", kind: "workspace" as const, observationEpoch: "epoch-1" },
      { absolutePath: profile, authorizedFileIdentity: profileIdentity, canonicalPath: profileCanonical, displayPath: "$HOME/.codex/work.config.toml", kind: "external-profile" as const, observationEpoch: "epoch-1", profileName: "work" },
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
    { key: "model", sourceRef: first.sources.find(source => source.kind === "external-profile")?.sourceRef, value: "gpt-5.6-codex" },
    { key: "model_reasoning_effort", sourceRef: workspaceSourceRef, value: "medium" },
    { key: "personality", sourceRef: workspaceSourceRef, value: "pragmatic" },
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

test("does not apply obsolete nested profile tables as current Codex profiles", async t => {
  const root = await mkdtemp(join(tmpdir(), "ar-codex-legacy-profile-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const user = join(root, "config.toml");
  await writeFile(
    user,
    "[profiles.research]\nmodel = 'gpt-5.6-sol'\nmodel_reasoning_effort = 'max'\n",
  );
  const canonicalPath = await realpath(user);
  const authorizedFileIdentity = await fileIdentity(user);

  const result = await createFeature().inspectCodexConfiguration.execute({
    dialect: "codex-0.134",
    identityScope: "scope-legacy-profile",
    nativeProfile: "research",
    observationEpoch: "epoch-1",
    sources: [{
      absolutePath: user,
      authorizedFileIdentity,
      canonicalPath,
      displayPath: "$HOME/.codex/config.toml",
      kind: "user",
      observationEpoch: "epoch-1",
    }],
  });

  assert.deepEqual(result.settings, []);
  assert.deepEqual(result.diagnostics.map(item => item.code), [
    "profile_missing",
    "unknown_setting_ignored",
  ]);
});

test("reports a selected native profile missing only from the merged configuration", async t => {
  const root = await mkdtemp(join(tmpdir(), "ar-codex-profile-missing-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const user = join(root, "user.toml");
  const workspace = join(root, "workspace.toml");
  await writeFile(user, "model = 'gpt-5.5'\n");
  await writeFile(workspace, "personality = 'pragmatic'\n");
  const [userCanonical, workspaceCanonical, userIdentity, workspaceIdentity] = await Promise.all([
    realpath(user),
    realpath(workspace),
    fileIdentity(user),
    fileIdentity(workspace),
  ]);

  const result = await createFeature().inspectCodexConfiguration.execute({
    dialect: "codex-0.134",
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

test("reports a selected external profile that is missing or metadata-invalid", async t => {
  const root = await mkdtemp(join(tmpdir(), "ar-codex-external-profile-missing-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const existing = join(root, "work.config.toml");
  const missing = join(root, "missing.config.toml");
  await writeFile(existing, "model = 'gpt-5.6-sol'\n");
  const existingCanonical = await realpath(existing);
  const existingIdentity = await fileIdentity(existing);
  const feature = createFeature();

  const missingResult = await feature.inspectCodexConfiguration.execute({
    dialect: "codex-0.134",
    identityScope: "scope-missing-external-profile",
    nativeProfile: "missing",
    observationEpoch: "epoch-1",
    sources: [{
      absolutePath: missing,
      canonicalPath: missing,
      displayPath: "$HOME/.codex/missing.config.toml",
      kind: "external-profile",
      observationEpoch: "epoch-1",
      profileName: "missing",
    }],
  });
  assert.deepEqual(missingResult.diagnostics, [{ code: "profile_missing" }]);
  assert.equal(missingResult.sources[0]?.status, "missing");

  const invalidMetadata = await feature.inspectCodexConfiguration.execute({
    dialect: "codex-0.134",
    identityScope: "scope-invalid-external-profile",
    nativeProfile: "work",
    observationEpoch: "epoch-1",
    sources: [{
      absolutePath: existing,
      authorizedFileIdentity: existingIdentity,
      canonicalPath: existingCanonical,
      displayPath: "$HOME/.codex/work.config.toml",
      kind: "external-profile",
      observationEpoch: "epoch-1",
      profileName: "work",
      workspaceLayer: 0,
    }],
  });
  assert.deepEqual(invalidMetadata.diagnostics, [
    { code: "profile_missing" },
    { code: "source_precedence_conflict", setting: "external-profile" },
  ]);
  assert.equal(invalidMetadata.sources[0]?.status, "rejected");
});

test("applies Codex workspace layers returned closest-first and rejects ambiguous order", async t => {
  const root = await mkdtemp(join(tmpdir(), "ar-codex-workspace-layers-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const outer = join(root, "outer.toml");
  const closest = join(root, "closest.toml");
  await Promise.all([
    writeFile(outer, "personality = 'friendly'\n"),
    writeFile(closest, "personality = 'pragmatic'\n"),
  ]);
  const [outerCanonical, closestCanonical, outerIdentity, closestIdentity] =
    await Promise.all([
      realpath(outer),
      realpath(closest),
      fileIdentity(outer),
      fileIdentity(closest),
    ]);
  const sources = [
    { absolutePath: closest, authorizedFileIdentity: closestIdentity, canonicalPath: closestCanonical, displayPath: "$WORKSPACE/closest/.codex/config.toml", kind: "workspace" as const, observationEpoch: "epoch-1", workspaceLayer: 0 },
    { absolutePath: outer, authorizedFileIdentity: outerIdentity, canonicalPath: outerCanonical, displayPath: "$WORKSPACE/.codex/config.toml", kind: "workspace" as const, observationEpoch: "epoch-1", workspaceLayer: 1 },
  ];

  const feature = createFeature();
  const ordered = await feature.inspectCodexConfiguration.execute({
    dialect: "codex-0.134",
    identityScope: "scope-layers",
    observationEpoch: "epoch-1",
    sources,
  });
  assert.deepEqual(ordered.settings, [{
    key: "personality",
    sourceRef: ordered.sources.find(source => source.displayPath.includes("closest"))?.sourceRef,
    value: "pragmatic",
  }]);

  const ambiguous = await feature.inspectCodexConfiguration.execute({
    dialect: "codex-0.134",
    identityScope: "scope-layers",
    observationEpoch: "epoch-1",
    sources: sources.map(source => ({ ...source, workspaceLayer: 0 })),
  });
  assert.deepEqual(ambiguous.settings, []);
  assert.deepEqual(ambiguous.diagnostics, [
    { code: "source_precedence_conflict", setting: "workspace" },
  ]);
  assert.ok(ambiguous.sources.every(source => source.status === "rejected"));

  const duplicateIdentity = await feature.inspectCodexConfiguration.execute({
    dialect: "codex-0.134",
    identityScope: "scope-layers",
    observationEpoch: "epoch-1",
    sources: [sources[0]!, { ...sources[0]!, workspaceLayer: 1 }],
  });
  assert.deepEqual(duplicateIdentity.settings, []);
  assert.deepEqual(duplicateIdentity.diagnostics, [
    { code: "source_precedence_conflict", setting: "workspace" },
  ]);
  assert.ok(duplicateIdentity.sources.every(source => source.status === "rejected"));

  const duplicateAcrossKinds = await feature.inspectCodexConfiguration.execute({
    dialect: "codex-0.134",
    identityScope: "scope-cross-kind-duplicate",
    nativeProfile: "work",
    observationEpoch: "epoch-1",
    sources: [
      { ...sources[0]!, kind: "user", workspaceLayer: undefined },
      {
        ...sources[0]!,
        kind: "external-profile",
        profileName: "work",
        workspaceLayer: undefined,
      },
    ],
  });
  assert.deepEqual(duplicateAcrossKinds.settings, []);
  assert.deepEqual(duplicateAcrossKinds.diagnostics, [
    { code: "profile_missing" },
    { code: "source_precedence_conflict", setting: "source" },
  ]);
  assert.ok(duplicateAcrossKinds.sources.every(source => source.status === "rejected"));
});

test("rejects concise personality and fails closed for an unsupported dialect", async t => {
  const root = await mkdtemp(join(tmpdir(), "ar-codex-dialect-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const config = join(root, "config.toml");
  await writeFile(config, "personality = 'concise'\n");
  const canonicalPath = await realpath(config);
  const authorizedFileIdentity = await fileIdentity(config);
  const source = {
    absolutePath: config,
    authorizedFileIdentity,
    canonicalPath,
    displayPath: "$HOME/.codex/config.toml",
    kind: "user" as const,
    observationEpoch: "epoch-1",
  };
  const feature = createFeature();

  const invalidPersonality = await feature.inspectCodexConfiguration.execute({
    dialect: "codex-0.134",
    identityScope: "scope-personality",
    observationEpoch: "epoch-1",
    sources: [source],
  });
  assert.deepEqual(invalidPersonality.settings, []);
  assert.equal(invalidPersonality.diagnostics[0]?.code, "setting_value_unsupported");

  const unsupported = await feature.inspectCodexConfiguration.execute({
    dialect: "future-codex-dialect",
    identityScope: "scope-dialect",
    observationEpoch: "epoch-1",
    sources: [source],
  } as never);
  assert.deepEqual(unsupported.settings, []);
  assert.deepEqual(unsupported.diagnostics, [
    { code: "configuration_dialect_unsupported" },
  ]);
  assert.equal(unsupported.sources[0]?.status, "rejected");
});

test("accepts current Codex max and ultra reasoning efforts", async t => {
  const root = await mkdtemp(join(tmpdir(), "ar-codex-reasoning-effort-"));
  t.after(() => rm(root, { force: true, recursive: true }));

  for (const effort of ["max", "ultra"] as const) {
    const config = join(root, `${effort}.toml`);
    await writeFile(config, `model_reasoning_effort = '${effort}'\n`);
    const canonicalPath = await realpath(config);
    const authorizedFileIdentity = await fileIdentity(config);
    const result = await createFeature().inspectCodexConfiguration.execute({
      dialect: "codex-0.134",
      identityScope: `scope-${effort}`,
      observationEpoch: "epoch-1",
      sources: [{
        absolutePath: config,
        authorizedFileIdentity,
        canonicalPath,
        displayPath: `$HOME/.codex/${effort}.toml`,
        kind: "user",
        observationEpoch: "epoch-1",
      }],
    });

    assert.deepEqual(result.diagnostics, []);
    assert.deepEqual(result.settings, [{
      key: "model_reasoning_effort",
      sourceRef: result.sources[0]?.sourceRef,
      value: effort,
    }]);
  }
});

test("does not resolve inherited object properties as native profiles", async () => {
  const inheritedDocument = Object.assign(
    Object.create({ profiles: { inherited: { model: "gpt-inherited" } } }) as Record<
      string,
      unknown
    >,
    { profiles: {} },
  );
  const feature = createCodexConfigurationInspectionFeature({
    parser: {
      parse() {
        return { document: inheritedDocument, kind: "parsed" as const };
      },
    },
    sourceIdentityKey: Buffer.alloc(32, 7),
    sourceReader: {
      async read() {
        return { bytes: Buffer.from("synthetic"), kind: "read" as const };
      },
    },
  });
  const result = await feature.inspectCodexConfiguration.execute({
    dialect: "codex-0.134",
    identityScope: "scope-prototype",
    nativeProfile: "__proto__",
    observationEpoch: "epoch-1",
    sources: [{
      absolutePath: "/synthetic/config.toml",
      authorizedFileIdentity: "synthetic-file",
      canonicalPath: "/synthetic/config.toml",
      displayPath: "$HOME/config.toml",
      kind: "user",
      observationEpoch: "epoch-1",
    }],
  });

  assert.deepEqual(result.diagnostics.map(item => item.code), [
    "profile_missing",
    "unknown_setting_ignored",
  ]);

  delete inheritedDocument.profiles;
  const inheritedTopLevel = await feature.inspectCodexConfiguration.execute({
    dialect: "codex-0.134",
    identityScope: "scope-prototype",
    nativeProfile: "inherited",
    observationEpoch: "epoch-1",
    sources: [{
      absolutePath: "/synthetic/config.toml",
      authorizedFileIdentity: "synthetic-file",
      canonicalPath: "/synthetic/config.toml",
      displayPath: "$HOME/config.toml",
      kind: "user",
      observationEpoch: "epoch-1",
    }],
  });
  assert.deepEqual(inheritedTopLevel.diagnostics, [{ code: "profile_missing" }]);
});

test(
  "rejects a FIFO configuration source without blocking",
  { skip: process.platform === "win32" },
  async t => {
    const root = await mkdtemp(join(tmpdir(), "ar-codex-config-fifo-"));
    t.after(() => rm(root, { force: true, recursive: true }));
    const fifo = join(root, "config.toml");
    await execFile("mkfifo", [fifo]);
    const [canonicalPath, authorizedFileIdentity] = await Promise.all([
      realpath(fifo),
      fileIdentity(fifo),
    ]);

    const result = await createFeature().inspectCodexConfiguration.execute({
      dialect: "codex-0.134",
      identityScope: "scope-fifo",
      observationEpoch: "epoch-1",
      sources: [{
        absolutePath: fifo,
        authorizedFileIdentity,
        canonicalPath,
        displayPath: "$HOME/config.toml",
        kind: "user",
        observationEpoch: "epoch-1",
      }],
    });

    assert.deepEqual(result.settings, []);
    assert.equal(result.diagnostics[0]?.code, "config_unreadable");
  },
);

test("rejects credential-shaped values even under portable setting keys", async t => {
  const root = await mkdtemp(join(tmpdir(), "ar-codex-secret-value-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const config = join(root, "config.toml");
  const secret = "sk-synthetic-credential-value";
  await writeFile(config, `model = '${secret}'\npersonality = 'friendly'\n`);
  const canonicalPath = await realpath(config);
  const authorizedFileIdentity = await fileIdentity(config);

  const result = await createFeature().inspectCodexConfiguration.execute({
    dialect: "codex-0.134",
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
    { key: "personality", sourceRef: observedSourceRef, value: "friendly" },
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
    "gpt-AbCdEfGhIjKlMnOpQrStUv",
  ];

  for (const [index, value] of values.entries()) {
    const config = join(root, `config-${index}.toml`);
    await writeFile(config, `model = '${value}'\n`);
    const canonicalPath = await realpath(config);
    const authorizedFileIdentity = await fileIdentity(config);
    const result = await createFeature().inspectCodexConfiguration.execute({
      dialect: "codex-0.134",
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
    dialect: "codex-0.134",
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
      dialect: "codex-0.134",
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
    dialect: "codex-0.134",
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
    dialect: "codex-0.134",
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
