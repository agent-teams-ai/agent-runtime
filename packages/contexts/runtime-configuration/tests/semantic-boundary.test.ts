import { createNodeConfigurationDigest } from "../dist/features/codex-configuration-inspection/adapters/outbound/node-configuration-digest.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  codexConfigurationSemanticClassifierContract,
  createCodexConfigurationInspectionFeature,
  createCodexConfigurationSemanticClassifierV1,
  createSmolTomlParser,
} from "../dist/composition.js";

const syntheticSource = {
  absolutePath: "/synthetic/config.toml",
  authorizedFileIdentity: "synthetic-file",
  canonicalPath: "/synthetic/config.toml",
  custodyRoot: { absolutePath: "/synthetic", canonicalPath: "/synthetic" },
  displayPath: "$HOME/.codex/config.toml",
  kind: "user" as const,
  observationEpoch: "epoch-1",
};

const syntheticReader = {
  async read() {
    return { bytes: Buffer.from("synthetic"), kind: "read" as const };
  },
};

const inspectWithRevision = async (
  revision: string,
  dialect = "codex-0.134",
) => {
  const feature = createCodexConfigurationInspectionFeature({
    parser: {
      parse() {
        return { document: { model: "safe" }, kind: "parsed" as const };
      },
    },
    semanticClassifier: {
      contract: codexConfigurationSemanticClassifierContract,
      revision,
      classify() {
        return { diagnostics: [], settings: [{ key: "model" as const, value: "safe" }] };
      },
      supportsDialect: () => true,
    },
    digest: createNodeConfigurationDigest(),
    sourceIdentityKey: Buffer.alloc(32, 7),
    sourceReader: syntheticReader,
  });
  const result = await feature.inspectCodexConfiguration.execute({
    dialect,
    identityScope: "scope-semantic-digest",
    observationEpoch: "epoch-1",
    sources: [syntheticSource],
  });
  return result.sources[0]?.semanticDigest;
};

test("rejects parser accessors without invoking them", async () => {
  let getterReads = 0;
  const document = Object.create(null) as Record<string, unknown>;
  Object.defineProperty(document, "model", {
    enumerable: true,
    get() {
      getterReads += 1;
      return "must-not-be-observed";
    },
  });
  let classifierCalls = 0;
  const feature = createCodexConfigurationInspectionFeature({
    parser: { parse: () => ({ document, kind: "parsed" as const }) },
    semanticClassifier: {
      contract: codexConfigurationSemanticClassifierContract,
      revision: "synthetic-classifier/1",
      classify() {
        classifierCalls += 1;
        return { diagnostics: [], settings: [] };
      },
      supportsDialect: () => true,
    },
    digest: createNodeConfigurationDigest(),
    sourceIdentityKey: Buffer.alloc(32, 7),
    sourceReader: syntheticReader,
  });

  const result = await feature.inspectCodexConfiguration.execute({
    dialect: "codex-0.134",
    identityScope: "scope-parser-accessor",
    observationEpoch: "epoch-1",
    sources: [syntheticSource],
  });

  assert.equal(getterReads, 0);
  assert.equal(classifierCalls, 0);
  assert.deepEqual(result.settings, []);
  assert.deepEqual(result.diagnostics.map(item => item.code), ["config_parse_failed"]);
  assert.equal(result.sources[0]?.status, "malformed");
});

test("rejects secret-shaped classifier output without exposing it", async () => {
  const secret = "sk-synthetic-classifier-secret-value";
  const feature = createCodexConfigurationInspectionFeature({
    parser: { parse: () => ({ document: { model: "safe" }, kind: "parsed" as const }) },
    semanticClassifier: {
      contract: codexConfigurationSemanticClassifierContract,
      revision: "synthetic-classifier/1",
      classify() {
        return {
          diagnostics: [],
          settings: [{ key: "model", value: secret }],
        };
      },
      supportsDialect: () => true,
    },
    digest: createNodeConfigurationDigest(),
    sourceIdentityKey: Buffer.alloc(32, 7),
    sourceReader: syntheticReader,
  });

  await assert.rejects(
    feature.inspectCodexConfiguration.execute({
      dialect: "codex-0.134",
      identityScope: "scope-classifier-boundary",
      observationEpoch: "epoch-1",
      sources: [syntheticSource],
    }),
    error => {
      assert.ok(error instanceof TypeError);
      assert.equal(error.message, "semantic classifier returned an invalid result");
      assert.doesNotMatch(error.message, new RegExp(secret, "u"));
      return true;
    },
  );
});

test("rejects non-record parser roots while keeping nested opaque scalars inert", async () => {
  const throwingProxy = new Proxy(Object.create(null) as object, {
    getPrototypeOf() {
      throw new Error("synthetic parser trap must stay contained");
    },
  });
  for (const rootDocument of [
    new Date("1979-05-27T07:32:00Z"),
    Number.POSITIVE_INFINITY,
    throwingProxy,
  ]) {
    let classifierCalls = 0;
    const feature = createCodexConfigurationInspectionFeature({
      parser: { parse: () => ({ document: rootDocument, kind: "parsed" as const }) },
      semanticClassifier: {
        contract: codexConfigurationSemanticClassifierContract,
        revision: "synthetic-classifier/1",
        classify() {
          classifierCalls += 1;
          return { diagnostics: [], settings: [] };
        },
        supportsDialect: () => true,
      },
      digest: createNodeConfigurationDigest(),
      sourceIdentityKey: Buffer.alloc(32, 7),
      sourceReader: syntheticReader,
    });

    const result = await feature.inspectCodexConfiguration.execute({
      dialect: "codex-0.134",
      identityScope: "scope-invalid-parser-root",
      observationEpoch: "epoch-1",
      sources: [syntheticSource],
    });

    assert.equal(classifierCalls, 0);
    assert.equal(result.sources[0]?.status, "malformed");
  }

  const feature = createCodexConfigurationInspectionFeature({
    parser: {
      parse: () => ({
        document: { model: "safe-model", opaqueInteger: 9_223_372_036_854_775_807n },
        kind: "parsed" as const,
      }),
    },
    semanticClassifier: createCodexConfigurationSemanticClassifierV1(),
    digest: createNodeConfigurationDigest(),
    sourceIdentityKey: Buffer.alloc(32, 7),
    sourceReader: syntheticReader,
  });
  const result = await feature.inspectCodexConfiguration.execute({
    dialect: "codex-0.134",
    identityScope: "scope-nested-bigint",
    observationEpoch: "epoch-1",
    sources: [syntheticSource],
  });
  assert.equal(result.sources[0]?.status, "applied");
  assert.equal(result.settings[0]?.value, "safe-model");
  assert.equal(result.diagnostics[0]?.code, "unknown_setting_ignored");
});

test("keeps valid TOML opaque scalars and repeated diagnostics observable", async () => {
  const feature = createCodexConfigurationInspectionFeature({
    parser: createSmolTomlParser(),
    semanticClassifier: createCodexConfigurationSemanticClassifierV1(),
    digest: createNodeConfigurationDigest(),
    sourceIdentityKey: Buffer.alloc(32, 7),
    sourceReader: {
      async read() {
        return {
          bytes: Buffer.from([
            "model = 'safe-model'",
            "updated = 1979-05-27T07:32:00Z",
            "limit = inf",
          ].join("\n")),
          kind: "read" as const,
        };
      },
    },
  });

  const result = await feature.inspectCodexConfiguration.execute({
    dialect: "codex-0.134",
    identityScope: "scope-valid-toml-scalars",
    observationEpoch: "epoch-1",
    sources: [syntheticSource],
  });

  assert.deepEqual(result.settings, [{
    key: "model",
    sourceRef: result.sources[0]?.sourceRef,
    value: "safe-model",
  }]);
  assert.deepEqual(
    result.diagnostics.map(diagnostic => diagnostic.code),
    ["unknown_setting_ignored", "unknown_setting_ignored"],
  );
  assert.equal(result.sources[0]?.status, "applied");
});

test("keeps the parser and classifier diagnostic budgets aligned", async () => {
  const document = Object.fromEntries(
    Array.from({ length: 257 }, (_, index) => [`unknown_${index}`, index]),
  );
  const feature = createCodexConfigurationInspectionFeature({
    parser: { parse: () => ({ document, kind: "parsed" as const }) },
    semanticClassifier: createCodexConfigurationSemanticClassifierV1(),
    digest: createNodeConfigurationDigest(),
    sourceIdentityKey: Buffer.alloc(32, 7),
    sourceReader: syntheticReader,
  });
  const result = await feature.inspectCodexConfiguration.execute({
    dialect: "codex-0.134",
    identityScope: "scope-diagnostic-budget",
    observationEpoch: "epoch-1",
    sources: [syntheticSource],
  });

  assert.equal(result.sources[0]?.status, "applied");
  assert.equal(result.diagnostics.length, 257);
  assert.ok(result.diagnostics.every(item => item.code === "unknown_setting_ignored"));
});

test("binds semantic digests to schema, contract, revision, dialect, and settings", async () => {
  const first = await inspectWithRevision("synthetic-classifier/1");
  const second = await inspectWithRevision("synthetic-classifier/2");
  const otherDialect = await inspectWithRevision("synthetic-classifier/1", "codex-next");
  const digestShape = /^codex-configuration-semantic-digest\/v1:sha256:[a-f0-9]{64}$/u;
  assert.match(first ?? "", digestShape);
  assert.match(second ?? "", digestShape);
  assert.notEqual(first, second);
  assert.notEqual(first, otherDialect);

  const expectedPreimage = {
    classifierContract: codexConfigurationSemanticClassifierContract,
    classifierRevision: "synthetic-classifier/1",
    dialect: "codex-0.134",
    digestSchema: "codex-configuration-semantic-digest/v1",
    settings: [["model", "safe"]],
  };
  const expected = `codex-configuration-semantic-digest/v1:sha256:${
    createHash("sha256").update(JSON.stringify(expectedPreimage)).digest("hex")
  }`;
  assert.equal(first, expected);
});

test("the digest port is the only identifier source, and a substituted implementation is observed", async () => {
  const calls: { key: string; preimage: string }[] = [];
  const recording = Object.freeze({
    hmacSha256Hex: (key: Uint8Array, preimage: string) => {
      calls.push({ key: Buffer.from(key).toString("hex"), preimage });
      return "0".repeat(64);
    },
    sha256Hex: (preimage: string) => {
      calls.push({ key: "", preimage });
      return "1".repeat(64);
    },
  });
  const feature = createCodexConfigurationInspectionFeature({
    digest: recording,
    parser: { parse: () => ({ document: { model: "safe" }, kind: "parsed" as const }) },
    semanticClassifier: {
      contract: codexConfigurationSemanticClassifierContract,
      revision: "v1",
      classify: () => ({ diagnostics: [], settings: [{ key: "model" as const, value: "safe" }] }),
      supportsDialect: () => true,
    },
    sourceIdentityKey: Buffer.alloc(32, 7),
    sourceReader: syntheticReader,
  });
  const result = await feature.inspectCodexConfiguration.execute({
    dialect: "codex-0.134",
    identityScope: "scope-substituted-digest",
    observationEpoch: "epoch-1",
    sources: [syntheticSource],
  });
  const observed = result.sources[0];
  // Every identifier the use case publishes comes from the injected port, so the
  // feature states its dependency on an algorithm instead of reaching for one.
  assert.equal(observed?.sourceRef, `codex-config-source:${"0".repeat(64)}`);
  assert.equal(observed?.semanticDigest, `codex-configuration-semantic-digest/v1:sha256:${"1".repeat(64)}`);
  assert.deepEqual(calls.map(call => call.key), ["07".repeat(32), ""]);
  assert.equal(calls[0]?.preimage, ["scope-substituted-digest", "user", "/synthetic/config.toml"].join("\u0000"));
});
