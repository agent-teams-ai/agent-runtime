import assert from "node:assert/strict";
import test from "node:test";

import {
  CLAUDE_CODE_CONFIGURATION_BUDGETS,
  CLAUDE_CODE_EFFORT_VALUES,
  CLAUDE_CODE_MODEL_ALIASES,
  CLAUDE_CODE_SETTINGS_DIALECT,
  type ClaudeCodeConfigurationSource,
  type ClaudeCodeConfigurationSourceKind,
  type ClaudeCodeConfigurationSourceReader,
} from "../dist/index.js";
import {
  claudeCodeConfigurationSemanticClassifierContract,
  createClaudeCodeConfigurationInspectionFeature,
  createClaudeCodeConfigurationSemanticClassifierV1,
  createStrictClaudeCodeJsonParser,
} from "../dist/composition.js";

const encoder = new TextEncoder();
const identityKey = encoder.encode("claude-code-test-source-identity-key-material");

const source = (
  kind: ClaudeCodeConfigurationSourceKind,
  observationEpoch = "epoch-1",
): ClaudeCodeConfigurationSource => ({
  access: "authorized",
  absolutePath: `/synthetic/${kind}.json`,
  authorizedFileIdentity: `identity:${kind}`,
  canonicalPath: `/synthetic/${kind}.json`,
  custodyRoot: { absolutePath: "/synthetic", canonicalPath: "/synthetic" },
  displayPath: `$SAFE/${kind}.json`,
  kind,
  observationEpoch,
});

type SourceValue = string | Uint8Array | "missing" | "stale" | "too-large" | "unreadable";

const readerFor = (
  values: Partial<Record<ClaudeCodeConfigurationSourceKind, SourceValue>>,
): ClaudeCodeConfigurationSourceReader => ({
  async read(selected) {
    const value = values[selected.kind] ?? "missing";
    if (value === "missing" || value === "stale" || value === "too-large" || value === "unreadable") {
      return { status: value };
    }
    return { bytes: typeof value === "string" ? encoder.encode(value) : value, status: "read" };
  },
});

const inspector = (reader: ClaudeCodeConfigurationSourceReader, overrides: Record<string, unknown> = {}) =>
  createClaudeCodeConfigurationInspectionFeature({
    parser: createStrictClaudeCodeJsonParser(),
    semanticClassifier: createClaudeCodeConfigurationSemanticClassifierV1(),
    sourceIdentityKey: identityKey,
    sourceReader: reader,
    ...overrides,
  } as Parameters<typeof createClaudeCodeConfigurationInspectionFeature>[0]);

const input = (sources: readonly ClaudeCodeConfigurationSource[]) => ({
  dialect: CLAUDE_CODE_SETTINGS_DIALECT,
  identityScope: "scope-a",
  observationEpoch: "epoch-1",
  sources,
});

const permutations = <T>(values: readonly T[]): readonly (readonly T[])[] =>
  values.length === 0 ? [[]] : values.flatMap((value, index) =>
    permutations(values.filter((_, candidate) => candidate !== index)).map(rest => [value, ...rest]));

test("resolves every source slot and all caller-order permutations with independent key winners", async () => {
  for (const kind of ["user", "shared-project", "project-local"] as const) {
    const result = await inspector(readerFor({ [kind]: '{"model":"sonnet","effortLevel":"high"}' }))
      .execute(input([source(kind)]));
    assert.deepEqual(result.portableIntent.map(item => [item.key, item.value]), [
      ["effortLevel", "high"], ["model", "sonnet"],
    ]);
  }

  const sources = [source("user"), source("shared-project"), source("project-local")];
  const configured = inspector(readerFor({
    user: '{"model":"haiku","effortLevel":"low"}',
    "shared-project": '{"model":"sonnet"}',
    "project-local": '{"effortLevel":"xhigh"}',
  }));
  const results = await Promise.all(permutations(sources).map(order => configured.execute(input(order))));
  assert.equal(new Set(results.map(result => JSON.stringify(result))).size, 1);
  assert.deepEqual(results[0]?.portableIntent.map(item => [item.key, item.value]), [
    ["effortLevel", "xhigh"], ["model", "sonnet"],
  ]);
});

test("taints lower values per key when a higher source is malformed, unreadable, stale, untrusted or invalid", async () => {
  const base = [source("user"), source("project-local")];
  for (const high of ["{", "unreadable", "stale", "too-large"] as const) {
    const result = await inspector(readerFor({
      user: '{"model":"haiku","effortLevel":"low"}', "project-local": high,
    })).execute(input(base));
    assert.deepEqual(result.portableIntent, []);
  }

  const invalid = await inspector(readerFor({
    user: '{"model":"haiku","effortLevel":"low"}',
    "project-local": '{"model":"claude-sonnet-4-20250514","effortLevel":"high"}',
  })).execute(input(base));
  assert.deepEqual(invalid.portableIntent.map(item => [item.key, item.value]), [["effortLevel", "high"]]);

  const duplicated = await inspector(readerFor({ user: '{"model":"haiku"}' })).execute(input([
    source("user"), { ...source("user"), absolutePath: "/synthetic/other.json", canonicalPath: "/synthetic/other.json" },
  ]));
  assert.deepEqual(duplicated.portableIntent, []);
  assert.ok(duplicated.diagnostics.every(item => item.code === "source_untrusted"));
});

test("preserves rejected higher slots as non-readable precedence evidence", async () => {
  for (const access of ["untrusted", "stale", "rejected"] as const) {
    const reads: ClaudeCodeConfigurationSourceKind[] = [];
    const configured = inspector({
      async read(selected) {
        reads.push(selected.kind);
        return {
          bytes: encoder.encode('{"model":"haiku","effortLevel":"low"}'),
          status: "read",
        };
      },
    });
    const higher: ClaudeCodeConfigurationSource = {
      access,
      displayPath: "$WORKSPACE/.claude/settings.local.json",
      kind: "project-local",
      observationEpoch: "epoch-1",
    };

    const result = await configured.execute(input([source("user"), higher]));

    assert.deepEqual(reads, ["user"]);
    assert.deepEqual(result.portableIntent, []);
    assert.equal(result.sources.find(item => item.kind === "project-local")?.status,
      access === "stale" ? "stale" : "rejected");
    assert.ok(result.diagnostics.some(diagnostic =>
      diagnostic.code === (access === "untrusted" ? "source_untrusted" : "source_epoch_stale")
    ));
  }
});

test("strict parser rejects duplicate escape-equivalent keys at depth and all frozen JSON hazards", () => {
  const parser = createStrictClaudeCodeJsonParser();
  const cases: readonly [Uint8Array, string][] = [
    [encoder.encode('{"nested":{"model":"sonnet","mo\\u0064el":"haiku"}}'), "config_duplicate_key"],
    [Uint8Array.from([0xef, 0xbb, 0xbf, 0x7b, 0x7d]), "config_parse_failed"],
    [Uint8Array.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0xff, 0x7d]), "config_invalid_utf8"],
    [encoder.encode("[]"), "config_parse_failed"],
    [encoder.encode('{"x":1,}'), "config_parse_failed"],
    [encoder.encode('{/* no */"x":1}'), "config_parse_failed"],
    [encoder.encode('{"x":1e400}'), "config_parse_failed"],
    [encoder.encode(`{"x":${"[".repeat(17)}0${"]".repeat(17)}}`), "config_parse_failed"],
    [new Uint8Array(CLAUDE_CODE_CONFIGURATION_BUDGETS.bytesPerSource + 1), "config_too_large"],
  ];
  for (const [bytes, diagnostic] of cases) {
    assert.deepEqual(parser.parse(bytes), { diagnostic, status: "rejected" });
  }
  assert.equal(parser.parse(encoder.encode('{"x":-0,"y":1.5e2}')).status, "parsed");
});

test("enforces key, string, array, object-key and node budgets deterministically", () => {
  const parser = createStrictClaudeCodeJsonParser();
  const tooLongKey = `{"${"k".repeat(CLAUDE_CODE_CONFIGURATION_BUDGETS.keyLength + 1)}":1}`;
  const tooLongString = `{"x":"${"v".repeat(CLAUDE_CODE_CONFIGURATION_BUDGETS.stringLength + 1)}"}`;
  const tooManyArrayItems = `{"x":[${Array.from({ length: 1_025 }, () => "0").join(",")}]}`;
  const tooManyKeys = `{${Array.from({ length: 1_025 }, (_, index) => `"k${index}":0`).join(",")}}`;
  for (const text of [tooLongKey, tooLongString, tooManyArrayItems, tooManyKeys]) {
    assert.deepEqual(parser.parse(encoder.encode(text)), {
      diagnostic: "config_parse_failed", status: "rejected",
    });
  }
});

test("accepts only the frozen model and effort allowlists and rejects max", async () => {
  for (const model of CLAUDE_CODE_MODEL_ALIASES) {
    const result = await inspector(readerFor({ user: JSON.stringify({ model }) })).execute(input([source("user")]));
    assert.equal(result.portableIntent[0]?.value, model);
  }
  for (const effortLevel of CLAUDE_CODE_EFFORT_VALUES) {
    const result = await inspector(readerFor({ user: JSON.stringify({ effortLevel }) })).execute(input([source("user")]));
    assert.equal(result.portableIntent[0]?.value, effortLevel);
  }
  const result = await inspector(readerFor({ user: '{"effortLevel":"max"}' })).execute(input([source("user")]));
  assert.deepEqual(result.portableIntent, []);
  assert.equal(result.diagnostics[0]?.code, "setting_value_unsupported");
});

test("defers full IDs and routes and rejects secrets without affecting safe sibling intent or leaking sentinels", async () => {
  const raw = JSON.stringify({
    ANTHROPIC_API_KEY: "AR2_SECRET_VALUE_MUST_NEVER_APPEAR",
    env: { ANTHROPIC_BASE_URL: "https://AR2_ROUTE_ID_MUST_NEVER_APPEAR.invalid" },
    effortLevel: "xhigh",
    hooks: { BeforeTool: "AR2_EXECUTABLE_MUST_NEVER_APPEAR" },
    model: "sonnet",
    mystery: "AR2_UNKNOWN_MUST_NEVER_APPEAR",
    permissions: { allow: ["AR2_SECURITY_MUST_NEVER_APPEAR"] },
  });
  const result = await inspector(readerFor({ user: raw })).execute(input([source("user")]));
  assert.deepEqual(result.portableIntent.map(item => [item.key, item.value]), [
    ["effortLevel", "xhigh"], ["model", "sonnet"],
  ]);
  const codes = result.diagnostics.map(item => item.code);
  for (const code of [
    "credential_material_rejected", "provider_route_deferred", "setting_value_unsupported",
  ]) assert.ok(codes.includes(code as never));
  const serialized = JSON.stringify(result);
  for (const sentinel of ["SECRET_VALUE", "ROUTE_ID", "EXECUTABLE", "UNKNOWN", "SECURITY", "ANTHROPIC_API_KEY"]) {
    assert.doesNotMatch(serialized, new RegExp(sentinel, "u"));
  }

  for (const model of ["claude-opus-4-1-20250805", "us.anthropic.claude-sonnet", "https://gateway.invalid/model"]) {
    const deferred = await inspector(readerFor({ user: JSON.stringify({ model }) })).execute(input([source("user")]));
    assert.deepEqual(deferred.portableIntent, []);
    assert.equal(deferred.diagnostics[0]?.code, "provider_route_deferred");
  }
});

test("makes secret and route value bytes non-interfering across every exported field", async () => {
  const inspectSecretVariant = async (secret: string, route: string) => inspector(readerFor({
    user: JSON.stringify({
      ANTHROPIC_API_KEY: secret,
      env: {
        ANTHROPIC_BASE_URL: route,
        nestedPassword: secret,
      },
      effortLevel: "high",
      model: "sonnet",
    }),
  })).execute(input([source("user")]));

  const first = await inspectSecretVariant(
    "AR2_SECRET_VALUE_MUST_NEVER_APPEAR_A",
    "https://AR2_ROUTE_ID_MUST_NEVER_APPEAR_A.invalid",
  );
  const second = await inspectSecretVariant(
    "a-completely-different-secret-with-a-different-length-000000000000000000000000000000000000",
    "arn:aws:bedrock:region:account:route-b",
  );
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.deepEqual(first.diagnostics.map(item => item.code), [
    "credential_material_rejected", "provider_route_deferred",
  ]);
});

test("semantic digest covers only the sorted safe projection and classifier authority", async () => {
  const first = await inspector(readerFor({ user: '{"model":"sonnet","unknownA":1}' })).execute(input([source("user")]));
  const second = await inspector(readerFor({ user: '{"unknownB":2,"model":"sonnet"}' })).execute(input([source("user")]));
  assert.equal(first.sources[0]?.semanticDigest, second.sources[0]?.semanticDigest);
  assert.match(first.sources[0]?.semanticDigest ?? "", /^claude-code-configuration-semantic-digest\/v1:sha256:[a-f0-9]{64}$/u);
  const baseClassifier = createClaudeCodeConfigurationSemanticClassifierV1();
  const revised = await inspector(readerFor({ user: '{"model":"sonnet"}' }), {
    semanticClassifier: { ...baseClassifier, revision: "synthetic-revision/2" },
  }).execute(input([source("user")]));
  assert.notEqual(first.sources[0]?.semanticDigest, revised.sources[0]?.semanticDigest);
});

test("bounds excess source slots independently of caller order", async () => {
  const excess = [
    source("user"), source("shared-project"), source("project-local"),
    { ...source("user"), canonicalPath: "/synthetic/extra.json", absolutePath: "/synthetic/extra.json" },
  ];
  const configured = inspector(readerFor({ user: '{"model":"sonnet"}' }));
  const results = await Promise.all([excess, excess.toReversed()].map(sources =>
    configured.execute(input(sources))));
  assert.equal(new Set(results.map(result => JSON.stringify(result))).size, 1);
  assert.equal(results[0]?.sources.length, CLAUDE_CODE_CONFIGURATION_BUDGETS.sourceSlots);
  assert.equal(results[0]?.diagnostics.length, CLAUDE_CODE_CONFIGURATION_BUDGETS.sourceSlots);
  assert.ok(results[0]?.diagnostics.every(diagnostic => diagnostic.code === "source_untrusted"));
});

test("contains hostile parser and classifier doubles without invoking accessors", async () => {
  let invoked = false;
  const hostileData = Object.create(null) as Record<string, unknown>;
  Object.defineProperty(hostileData, "model", { enumerable: true, get() { invoked = true; throw new Error("sentinel"); } });
  const parserResult = await inspector(readerFor({ user: "{}" }), {
    parser: { parse: () => ({ data: hostileData, status: "parsed" }) },
  }).execute(input([source("user")]));
  assert.equal(invoked, false);
  assert.equal(parserResult.diagnostics[0]?.code, "config_parse_failed");

  const hostileParseResult = Object.create(null) as Record<string, unknown>;
  Object.defineProperty(hostileParseResult, "status", {
    enumerable: true, get() { invoked = true; throw new Error("raw parser sentinel"); },
  });
  const parserEnvelope = await inspector(readerFor({ user: "{}" }), {
    parser: { parse: () => hostileParseResult },
  }).execute(input([source("user")]));
  assert.equal(invoked, false);
  assert.equal(parserEnvelope.diagnostics[0]?.code, "config_parse_failed");

  const classifierResult = await inspector(readerFor({ user: "{}" }), {
    semanticClassifier: {
      contract: claudeCodeConfigurationSemanticClassifierContract,
      revision: "hostile/1",
      supportsDialect: () => true,
      classify: () => {
        const result = Object.create(null) as Record<string, unknown>;
        Object.defineProperty(result, "definitions", { enumerable: true, get() { invoked = true; throw new Error("sentinel"); } });
        return result;
      },
    },
  }).execute(input([source("user")]));
  assert.equal(invoked, false);
  assert.equal(classifierResult.diagnostics[0]?.code, "config_parse_failed");
});

test("rejects any non-frozen dialect without reading sources", async () => {
  let reads = 0;
  const result = await inspector({
    async read() { reads += 1; return { status: "missing" }; },
  }).execute({
    ...input([source("user")]),
    dialect: "claude-code-settings@future" as typeof CLAUDE_CODE_SETTINGS_DIALECT,
  });
  assert.equal(reads, 0);
  assert.deepEqual(result.diagnostics, [{ code: "configuration_dialect_unsupported" }]);
  assert.equal(result.sources[0]?.status, "rejected");
});

test("reports stale epochs and stale reader identities without reading lower intent through them", async () => {
  const epoch = await inspector(readerFor({ user: '{"model":"haiku"}' }))
    .execute(input([source("user", "old-epoch")]));
  assert.equal(epoch.sources[0]?.status, "stale");
  assert.equal(epoch.diagnostics[0]?.code, "source_epoch_stale");

  const identity = await inspector(readerFor({ user: "stale" })).execute(input([source("user")]));
  assert.equal(identity.sources[0]?.status, "stale");
  assert.equal(identity.diagnostics[0]?.code, "source_epoch_stale");
});

test("returns detached deeply frozen deterministic results", async () => {
  const configured = inspector(readerFor({ user: '{"model":"sonnet"}' }));
  const first = await configured.execute(input([source("user")]));
  const second = await configured.execute(input([source("user")]));
  assert.deepEqual(first, second);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.sources), true);
  assert.equal(Object.isFrozen(first.sources[0]), true);
  assert.equal(Object.isFrozen(first.diagnostics), true);
  assert.equal(Object.isFrozen(first.portableIntent[0]), true);
  assert.notEqual(first, second);
});

test("replaces caller paths with frozen symbolic paths and contains reader errors", async () => {
  const rawPath = "/Users/private/AR2_RAW_PATH_MUST_NEVER_APPEAR/settings.json";
  const selected = { ...source("user"), displayPath: rawPath };
  const observed = await inspector(readerFor({ user: "{}" })).execute(input([selected]));
  assert.equal(observed.sources[0]?.displayPath, "$HOME/.claude/settings.json");
  assert.doesNotMatch(JSON.stringify(observed), /AR2_RAW_PATH_MUST_NEVER_APPEAR/u);

  const failed = await inspector({
    async read() { throw new Error(`${rawPath}: AR2_SECRET_VALUE_MUST_NEVER_APPEAR`); },
  }).execute(input([selected]));
  assert.deepEqual(failed.diagnostics.map(item => item.code), ["config_unreadable"]);
  assert.equal(failed.sources[0]?.status, "unreadable");
  assert.doesNotMatch(JSON.stringify(failed), /AR2_(?:RAW_PATH|SECRET_VALUE)_MUST_NEVER_APPEAR/u);
});

test("contains malformed reader envelopes without observing accessors", async () => {
  let invoked = false;
  const result = await inspector({
    async read() {
      const hostile = Object.create(null) as Record<string, unknown>;
      Object.defineProperty(hostile, "status", {
        enumerable: true,
        get() { invoked = true; throw new Error("raw-reader-secret"); },
      });
      return hostile as never;
    },
  }).execute(input([source("user")]));
  assert.equal(invoked, false);
  assert.deepEqual(result.diagnostics.map(item => item.code), ["config_unreadable"]);
});

test("honors cancellation before and during reads, parsing, and classification", async () => {
  const before = new AbortController();
  before.abort(new Error("before"));
  await assert.rejects(inspector(readerFor({})).execute(input([source("user")]), { signal: before.signal }));

  const duringRead = new AbortController();
  await assert.rejects(inspector({
    async read() {
      duringRead.abort(new Error("read"));
      return { bytes: encoder.encode("{}"), status: "read" };
    },
  }).execute(input([source("user")]), { signal: duringRead.signal }));

  const duringParsing = new AbortController();
  let parserReceivedSignal = false;
  await assert.rejects(inspector(readerFor({ user: "{}" }), {
    parser: {
      parse(_bytes: Uint8Array, options?: { readonly signal?: AbortSignal }) {
        parserReceivedSignal = options?.signal === duringParsing.signal;
        duringParsing.abort(new Error("parsing"));
        return { data: {}, status: "parsed" as const };
      },
    },
  }).execute(input([source("user")]), { signal: duringParsing.signal }));
  assert.equal(parserReceivedSignal, true);

  const duringClassification = new AbortController();
  const baseClassifier = createClaudeCodeConfigurationSemanticClassifierV1();
  await assert.rejects(inspector(readerFor({ user: "{}" }), {
    semanticClassifier: {
      ...baseClassifier,
      classify(dialect, data, options) {
        duringClassification.abort(new Error("classification"));
        return baseClassifier.classify(dialect, data, options);
      },
    },
  }).execute(input([source("user")]), { signal: duringClassification.signal }));

  const direct = new AbortController();
  direct.abort(new Error("direct parser cancellation"));
  assert.throws(() => createStrictClaudeCodeJsonParser().parse(
    encoder.encode("{}"), { signal: direct.signal },
  ));
});
