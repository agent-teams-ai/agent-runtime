import assert from "node:assert/strict";
import test from "node:test";

import {
  codexConfigurationSemanticClassifierContract,
  createCodexConfigurationInspectionFeature,
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

const inspectWithRevision = async (revision: string) => {
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
    sourceIdentityKey: Buffer.alloc(32, 7),
    sourceReader: syntheticReader,
  });
  const result = await feature.inspectCodexConfiguration.execute({
    dialect: "codex-0.134",
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

test("rejects unsafe classifier output without exposing it", async () => {
  const secret = "sk-synthetic-classifier-secret-value";
  const feature = createCodexConfigurationInspectionFeature({
    parser: { parse: () => ({ document: { model: "safe" }, kind: "parsed" as const }) },
    semanticClassifier: {
      contract: codexConfigurationSemanticClassifierContract,
      revision: "synthetic-classifier/1",
      classify() {
        return {
          diagnostics: [],
          settings: [{ key: "model", unexpected: true, value: secret }],
        } as never;
      },
      supportsDialect: () => true,
    },
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

test("binds semantic digests to classifier revision and schema", async () => {
  const first = await inspectWithRevision("synthetic-classifier/1");
  const second = await inspectWithRevision("synthetic-classifier/2");
  const digestShape = /^codex-configuration-semantic-digest\/v1:sha256:[a-f0-9]{64}$/u;
  assert.match(first ?? "", digestShape);
  assert.match(second ?? "", digestShape);
  assert.notEqual(first, second);
});
