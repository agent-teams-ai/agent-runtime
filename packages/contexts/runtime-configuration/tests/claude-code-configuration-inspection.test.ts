import assert from "node:assert/strict";
import test from "node:test";

import {
  CLAUDE_CODE_CONFIGURATION_BUDGETS, CLAUDE_CODE_EFFORT_VALUES,
  CLAUDE_CODE_MODEL_ALIASES, CLAUDE_CODE_MODEL_DEFAULT, CLAUDE_CODE_PROVIDER_ROUTE_KEYS,
  CLAUDE_CODE_PROVIDER_ROUTE_VOCABULARY_REVISION, CLAUDE_CODE_SETTINGS_DIALECT,
  type ClaudeCodeConfigurationSource, type ClaudeCodeConfigurationSourceReader,
  type TrustedClaudeCodeObservedSourcePlan,
} from "../dist/index.js";
import {
  claudeCodeConfigurationSemanticClassifierContract,
  createClaudeCodeConfigurationInspectionFeature,
  createClaudeCodeConfigurationSemanticClassifierV2, createStrictClaudeCodeJsonParser,
} from "../dist/composition.js";

const encoder = new TextEncoder();
const identityKey = encoder.encode("claude-code-v2-test-source-identity-key-material");

const source = (
  sourceId: string, role: "user" | "shared-project" | "project-local" = "user",
): ClaudeCodeConfigurationSource => ({
  access: "authorized", absolutePath: `/synthetic/${sourceId}.json`,
  authorizedFileIdentity: `identity:${sourceId}`, canonicalPath: `/synthetic/${sourceId}.json`,
  custodyRoot: { absolutePath: "/synthetic", canonicalPath: "/synthetic", rootId: "synthetic-root" },
  displayPath: `/private/${sourceId}.json`, observationEpoch: "epoch-1", role,
  selectionBasis: "caller-explicit", sourceId,
  trust: role === "user" ? "user" : "workspace-trusted",
});

const plan = (sources: readonly ClaudeCodeConfigurationSource[]): TrustedClaudeCodeObservedSourcePlan => ({
  claim: "observed-files-only",
  collector: {
    bundleId: "synthetic-bundle-v2", id: "synthetic-collector",
    observationEpoch: "epoch-1", platform: "darwin", version: "2",
  },
  contract: "claude-code-observed-source-plan/v1",
  roots: [{ absolutePath: "/synthetic", canonicalPath: "/synthetic", rootId: "synthetic-root" }],
  sources,
});

type Value = string | Uint8Array | "missing" | "stale" | "too-large" | "unreadable";
const readerFor = (values: Readonly<Record<string, Value>>): ClaudeCodeConfigurationSourceReader => ({
  async read(selected) {
    const value = values[selected.sourceId] ?? "missing";
    if (["missing", "stale", "too-large", "unreadable"].includes(value as string)) {
      return { status: value } as Awaited<ReturnType<ClaudeCodeConfigurationSourceReader["read"]>>;
    }
    return { bytes: typeof value === "string" ? encoder.encode(value) : value, status: "read" };
  },
});

const inspector = (reader: ClaudeCodeConfigurationSourceReader, overrides: Record<string, unknown> = {}) =>
  createClaudeCodeConfigurationInspectionFeature({
    parser: createStrictClaudeCodeJsonParser(),
    semanticClassifier: createClaudeCodeConfigurationSemanticClassifierV2(),
    sourceIdentityKey: identityKey, sourceReader: reader, ...overrides,
  } as Parameters<typeof createClaudeCodeConfigurationInspectionFeature>[0]);

const input = (sources: readonly ClaudeCodeConfigurationSource[]) => ({
  dialect: CLAUDE_CODE_SETTINGS_DIALECT, identityScope: "scope-a", sourcePlan: plan(sources),
});

test("strict parser rejects duplicate escape-equivalent keys and bounded JSON hazards", () => {
  const parser = createStrictClaudeCodeJsonParser();
  const cases: readonly [Uint8Array, string][] = [
    [encoder.encode('{"model":"sonnet","mo\\u0064el":"haiku"}'), "config_duplicate_key"],
    [Uint8Array.from([0xef, 0xbb, 0xbf, 0x7b, 0x7d]), "config_parse_failed"],
    [Uint8Array.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0xff, 0x7d]), "config_invalid_utf8"],
    [new Uint8Array(CLAUDE_CODE_CONFIGURATION_BUDGETS.bytesPerSource + 1), "config_too_large"],
    [encoder.encode(`{"x":${"[".repeat(17)}0${"]".repeat(17)}}`), "config_parse_failed"],
  ];
  for (const [bytes, diagnostic] of cases) {
    assert.deepEqual(parser.parse(bytes), { diagnostic, status: "rejected" });
  }
});

test("bounds and safely copies hostile source-reader byte output before parsing", async () => {
  let parses = 0;
  const oversized = await inspector({
    async read() {
      return { bytes: new Uint8Array(CLAUDE_CODE_CONFIGURATION_BUDGETS.bytesPerSource + 1), status: "read" };
    },
  }, { parser: { parse() { parses += 1; return { data: {}, status: "parsed" }; } } })
    .execute(input([source("oversized")]));
  assert.equal(oversized.diagnostics[0]?.code, "config_too_large");
  assert.equal(oversized.sources[0]?.status, "unreadable");
  assert.equal(parses, 0);

  const iterableBytes = encoder.encode('{"model":"sonnet"}');
  Object.defineProperty(iterableBytes, Symbol.iterator, {
    get() {throw new Error("byte iterator must not be read");},
  });
  const safelyCopied = await inspector({
    async read() {return { bytes: iterableBytes, status: "read" };},
  }).execute(input([source("hostile-iterator")]));
  assert.equal(safelyCopied.sources[0]?.status, "applied");
  assert.equal(safelyCopied.observedPortableIntent[0]?.key, "model");

  let proxyTraps = 0;
  const proxiedBytes = new Proxy(encoder.encode("{}"), {
    get() {proxyTraps += 1; throw new Error("proxy property access must not run");},
    getPrototypeOf() {proxyTraps += 1; throw new Error("proxy prototype access must not run");},
  });
  const rejectedProxy = await inspector({
    async read() {return { bytes: proxiedBytes, status: "read" };},
  }).execute(input([source("hostile-proxy")]));
  assert.equal(rejectedProxy.diagnostics[0]?.code, "config_unreadable");
  assert.equal(rejectedProxy.sources[0]?.status, "unreadable");
  assert.equal(proxyTraps, 0);
});

test("classifies default, every alias, exact dated names and 1m names without claiming compatibility", async () => {
  assert.equal(CLAUDE_CODE_MODEL_DEFAULT, "default");
  assert.equal(CLAUDE_CODE_MODEL_ALIASES.includes("default" as never), false);
  const cases = [CLAUDE_CODE_MODEL_DEFAULT, ...CLAUDE_CODE_MODEL_ALIASES,
    "claude-opus-4-1-20250805", "claude-opus-4-8[1m]"];
  for (const model of cases) {
    const result = await inspector(readerFor({ one: JSON.stringify({ model }) })).execute(input([source("one")]));
    const intent = result.observedPortableIntent[0];
    assert.equal(intent?.key, "model");
    assert.deepEqual(intent?.key === "model" ? intent.selection : undefined,
      model === "default" ? { kind: "provider-default" } :
        CLAUDE_CODE_MODEL_ALIASES.includes(model as never) ? { kind: "alias", value: model } :
          { kind: "exact-name", value: model });
    assert.equal(result.sourceModel.compatibility, "unqualified");
    assert.equal(result.sourceModel.precedence, "not-evaluated");
  }
  for (const effortLevel of CLAUDE_CODE_EFFORT_VALUES) {
    const result = await inspector(readerFor({ one: JSON.stringify({ effortLevel }) })).execute(input([source("one")]));
    assert.equal(result.observedPortableIntent[0]?.key === "effortLevel"
      ? result.observedPortableIntent[0].value : undefined, effortLevel);
  }
  const unsupportedEffort = await inspector(readerFor({ one: '{"effortLevel":"max"}' }))
    .execute(input([source("one")]));
  assert.equal(unsupportedEffort.diagnostics[0]?.code, "setting_value_unsupported");
});

test("returns value-free provider deployment and arbitrary selector deferrals with redaction equality", async () => {
  const inspect = async (model: string) => inspector(readerFor({ one: JSON.stringify({ model }) }))
    .execute(input([source("one")]));
  const first = await inspect("arn:aws:bedrock:us-east-1:111111111111:application-inference-profile/private-a");
  const second = await inspect("arn:aws:bedrock:eu-west-1:999999999999:application-inference-profile/a-different-length-private-b");
  assert.deepEqual(first.deferredObservations, [{
    form: "provider-deployment", key: "model", sourceRef: first.sources[0]?.sourceRef, status: "deferred",
  }]);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.doesNotMatch(JSON.stringify(first), /(?:111111|private|bedrock|length)/u);
  const arbitrary = await inspect("Sonnet-Corporate-Selector");
  const arbitraryVariant = await inspect("A-Completely-Different-Selector-Name");
  assert.equal(arbitrary.deferredObservations[0]?.form, "unclassified-selector");
  assert.deepEqual(arbitrary.diagnostics, []);
  assert.equal(JSON.stringify(arbitrary), JSON.stringify(arbitraryVariant));
});

test("observes declared sources independently without selecting a winner or cross-source taint", async () => {
  const sources = [source("legacy", "project-local"), source("root", "project-local"), source("bad", "shared-project")];
  const result = await inspector(readerFor({
    bad: "{", legacy: '{"model":"haiku"}', root: '{"model":"sonnet"}',
  })).execute(input(sources));
  assert.equal(result.observedPortableIntent.length, 2);
  assert.deepEqual(new Set(result.observedPortableIntent.map(item =>
    item.key === "model" && item.selection.kind === "alias" ? item.selection.value : "")),
  new Set(["haiku", "sonnet"]));
  assert.equal(result.sources.find(item => item.role === "shared-project")?.status, "malformed");
  assert.equal("portableIntent" in result, false);
  assert.equal("effectiveConfiguration" in result, false);
});

test("represents caller-declared repository, worktree, config-dir, ownership and cd topology without discovery", async () => {
  const bases = [
    "home-default", "claude-config-dir", "session-primary-working-directory", "repository-root",
    "main-worktree-root", "legacy-starting-directory", "caller-explicit", "static-preview",
  ] as const;
  const sources = bases.map((selectionBasis, index) => ({
    ...source(`declared-${index}`, index === 0 ? "user" : index === 2 ? "shared-project" : "project-local"),
    locationClaims: index === 4 ? ["main-checkout", "linked-worktree"] : undefined,
    selectionBasis,
  }));
  const values = Object.fromEntries(sources.map((item, index) => [
    item.sourceId, JSON.stringify({ model: index % 2 === 0 ? "sonnet" : "haiku" }),
  ]));
  const result = await inspector(readerFor(values)).execute(input(sources));
  assert.equal(result.sources.length, bases.length);
  assert.deepEqual(new Set(result.sources.map(item => item.selectionBasis)), new Set(bases));
  assert.equal(result.sourceModel.precedence, "not-evaluated");
  assert.equal(JSON.stringify(result).includes("/synthetic"), false);

  const duplicateRootPlan = input([]);
  duplicateRootPlan.sourcePlan = {
    ...duplicateRootPlan.sourcePlan,
    roots: [
      ...duplicateRootPlan.sourcePlan.roots,
      { absolutePath: "/synthetic", canonicalPath: "/synthetic", rootId: "home-repository-root" },
    ],
  };
  assert.deepEqual((await inspector(readerFor({})).execute(duplicateRootPlan)).diagnostics, []);

  const nextEpoch = input([{ ...source("one"), observationEpoch: "epoch-2" }]);
  nextEpoch.sourcePlan = {
    ...nextEpoch.sourcePlan,
    collector: { ...nextEpoch.sourcePlan.collector, observationEpoch: "epoch-2" },
    sources: [{ ...source("one"), observationEpoch: "epoch-2" }],
  };
  assert.notEqual((await inspector(readerFor({ one: "{}" })).execute(nextEpoch)).sourceModel.topologyRef,
    (await inspector(readerFor({ one: "{}" })).execute(input([source("one")]))).sourceModel.topologyRef);
});

test("rejects wrong type, empty, control-bearing, oversized and secret-shaped model values fail closed", async () => {
  const cases: readonly [unknown, string][] = [
    [42, "setting_type_unsupported"], ["", "setting_type_unsupported"],
    ["claude-sonnet\nroute", "setting_value_unsupported"],
    ["x".repeat(CLAUDE_CODE_CONFIGURATION_BUDGETS.classifierValueLength + 1), "setting_value_unsupported"],
    ["Bearer AR2_SECRET_VALUE_MUST_NEVER_APPEAR", "secret_setting_rejected"],
  ];
  for (const [model, code] of cases) {
    const result = await inspector(readerFor({ one: JSON.stringify({ model }) })).execute(input([source("one")]));
    assert.deepEqual(result.observedPortableIntent, []);
    assert.deepEqual(result.deferredObservations, []);
    assert.equal(result.diagnostics[0]?.code, code);
    assert.doesNotMatch(JSON.stringify(result), /AR2_SECRET_VALUE/u);
  }
  const credential = await inspector(readerFor({ one: JSON.stringify({ ANTHROPIC_API_KEY: "opaque" }) }))
    .execute(input([source("one")]));
  assert.equal(credential.diagnostics[0]?.code, "credential_material_rejected");
});

test("centralizes the v2 provider route vocabulary including Bedrock region, prefix, tier and Mantle", async () => {
  assert.equal(CLAUDE_CODE_PROVIDER_ROUTE_VOCABULARY_REVISION, "claude-code-provider-route-vocabulary/v2");
  assert.equal(Object.isFrozen(CLAUDE_CODE_PROVIDER_ROUTE_KEYS), true);
  assert.equal(Object.isFrozen(CLAUDE_CODE_PROVIDER_ROUTE_KEYS[0]), true);
  const keys = new Set(CLAUDE_CODE_PROVIDER_ROUTE_KEYS.map(entry => entry.key));
  for (const key of [
    "AWS_DEFAULT_REGION", "ANTHROPIC_BEDROCK_REGION_PREFIX", "ANTHROPIC_BEDROCK_SERVICE_TIER",
    "CLAUDE_CODE_USE_MANTLE", "CLAUDE_CODE_SKIP_MANTLE_AUTH", "ANTHROPIC_BEDROCK_MANTLE_BASE_URL",
  ]) {assert.equal(keys.has(key), true);}
  const inspect = async (suffix: string) => inspector(readerFor({ one: JSON.stringify({ env: {
    AWS_DEFAULT_REGION: `region-${suffix}`, ANTHROPIC_BEDROCK_REGION_PREFIX: `prefix-${suffix}`,
    ANTHROPIC_BEDROCK_SERVICE_TIER: `tier-${suffix}`, CLAUDE_CODE_USE_MANTLE: suffix,
    ANTHROPIC_BEDROCK_MANTLE_BASE_URL: `https://${suffix}.invalid`,
  } }) })).execute(input([source("one")]));
  assert.equal(JSON.stringify(await inspect("a")), JSON.stringify(await inspect("a-much-longer-b")));
});

test("rejects invalid topology and 17-source overflow before file I/O", async () => {
  let reads = 0;
  const configured = inspector({ async read() { reads += 1; return { status: "missing" }; } });
  const duplicate = input([source("one"), { ...source("two"), sourceId: "one" }]);
  assert.equal((await configured.execute(duplicate)).diagnostics[0]?.code, "source_plan_invalid");
  const duplicatePhysical = input([source("one"), { ...source("one"), sourceId: "two" }]);
  assert.equal((await configured.execute(duplicatePhysical)).diagnostics[0]?.code, "source_plan_invalid");
  const missingRoot = input([{ ...source("one"), custodyRoot: {
    absolutePath: "/synthetic", canonicalPath: "/synthetic", rootId: "missing-root",
  } } as ClaudeCodeConfigurationSource]);
  assert.equal((await configured.execute(missingRoot)).diagnostics[0]?.code, "source_plan_invalid");
  const unknownRole = input([{ ...source("one"), role: "managed" as never }]);
  assert.equal((await configured.execute(unknownRole)).diagnostics[0]?.code, "source_plan_unsupported");
  const unknownField = input([{ ...source("one"), callerRank: 1 } as ClaudeCodeConfigurationSource]);
  assert.equal((await configured.execute(unknownField)).diagnostics[0]?.code, "source_plan_invalid");
  const locationOverflow = input([{ ...source("one"), locationClaims: ["a", "b", "c", "d", "e"] }]);
  assert.equal((await configured.execute(locationOverflow)).diagnostics[0]?.code, "source_plan_invalid");
  const overflowSources = Array.from({ length: 17 }, (_, index) => source(`source-${index}`));
  assert.equal((await configured.execute(input(overflowSources))).diagnostics[0]?.code, "source_inventory_overflow");
  const overflowRoots = input([]);
  overflowRoots.sourcePlan = {
    ...overflowRoots.sourcePlan,
    roots: Array.from({ length: 17 }, (_, index) => ({
      absolutePath: `/synthetic-${index}`, canonicalPath: `/synthetic-${index}`, rootId: `root-${index}`,
    })),
  };
  assert.equal((await configured.execute(overflowRoots)).diagnostics[0]?.code, "source_inventory_overflow");
  const unsupported = input([]);
  unsupported.sourcePlan = { ...unsupported.sourcePlan, contract: "future" as never };
  assert.equal((await configured.execute(unsupported)).diagnostics[0]?.code, "source_plan_unsupported");
  assert.equal(reads, 0);
});

test("rejects aggregate existing-source overflow before reading configuration bytes", async () => {
  let reads = 0;
  const sources = Array.from({ length: 16 }, (_, index) => source(`source-${index}`));
  const result = await inspector({
    async measure() { return { bytes: 70_000, status: "measured" }; },
    async read() { reads += 1; return { status: "missing" }; },
  }).execute(input(sources));
  assert.deepEqual(result.diagnostics, [{ code: "source_total_too_large" }]);
  assert.equal(reads, 0);
});

test("rejects unsupported settings dialect before source I/O", async () => {
  let reads = 0;
  const selected = input([source("one")]);
  selected.dialect = "claude-code-settings@future" as typeof CLAUDE_CODE_SETTINGS_DIALECT;
  const result = await inspector({ async read() { reads += 1; return { status: "missing" }; } }).execute(selected);
  assert.deepEqual(result.diagnostics, [{ code: "configuration_dialect_unsupported" }]);
  assert.equal(reads, 0);
});

test("reports stale declared sources without suppressing unrelated observations", async () => {
  const stale: ClaudeCodeConfigurationSource = {
    access: "stale", custodyRootRef: "synthetic-root", displayPath: "/private/stale.json",
    observationEpoch: "epoch-1", role: "project-local", selectionBasis: "caller-explicit",
    sourceId: "stale", trust: "workspace-trusted",
  };
  const result = await inspector(readerFor({ one: '{"model":"sonnet"}' }))
    .execute(input([source("one"), stale]));
  assert.equal(result.diagnostics[0]?.code, "source_epoch_stale");
  assert.equal(result.observedPortableIntent.length, 1);
});

test("binds stable v2 digests and opaque provenance to topology, collector, dialect and classifier", async () => {
  const configured = inspector(readerFor({ one: '{"model":"sonnet"}' }));
  const first = await configured.execute(input([source("one")]));
  const second = await configured.execute(input([source("one")]));
  assert.deepEqual(first, second);
  assert.match(first.sources[0]?.semanticDigest ?? "", /^claude-code-configuration-semantic-digest\/v2:sha256:[a-f0-9]{64}$/u);
  assert.match(first.sourceModel.topologyRef, /^claude-code-topology\/v2:hmac-sha256:[a-f0-9]{64}$/u);
  assert.equal(first.sourceModel.classifierRevision, "claude-code-settings-2026-08-28-semantic-classifier/2");
  const changedPlan = input([source("one")]);
  changedPlan.sourcePlan = { ...changedPlan.sourcePlan, collector: { ...changedPlan.sourcePlan.collector, version: "3" } };
  assert.notEqual((await configured.execute(changedPlan)).sourceModel.topologyRef, first.sourceModel.topologyRef);
  const permutations = inspector(readerFor({ one: '{"model":"sonnet"}', two: '{"model":"haiku"}' }));
  const ordered = await permutations.execute(input([source("one"), source("two")]));
  const reversed = await permutations.execute(input([source("two"), source("one")]));
  assert.deepEqual(ordered, reversed);
});

test("contains hostile deferred classifier output and rejects value-bearing observations", async () => {
  const base = createClaudeCodeConfigurationSemanticClassifierV2();
  const result = await inspector(readerFor({ one: "{}" }), { semanticClassifier: {
    ...base, contract: claudeCodeConfigurationSemanticClassifierContract,
    classify: () => ({
      definitions: [], deferredObservations: [{
        form: "provider-deployment", key: "model", status: "deferred", value: "raw-secret",
      }], diagnostics: [], definedPortableKeys: ["model"], taintedPortableKeys: [],
    }),
  } }).execute(input([source("one")]));
  assert.equal(result.sources[0]?.status, "malformed");
  assert.doesNotMatch(JSON.stringify(result), /raw-secret/u);
});

test("rejects hostile classifier model definitions that cross the portable semantic boundary", async () => {
  const base = createClaudeCodeConfigurationSemanticClassifierV2();
  const classifyAsExactName = (value: string) => ({
    definitions: [{ key: "model" as const, selection: { kind: "exact-name" as const, value } }],
    deferredObservations: [], diagnostics: [], definedPortableKeys: ["model" as const],
    taintedPortableKeys: [],
  });
  const hostileValues = [
    "claude-credential-material", "claude-auth-token", "claude-bedrock-route",
    "claude-foundry-deployment", "claude-opus-4-1-20250805\u0007",
  ];
  for (const value of hostileValues) {
    const result = await inspector(readerFor({ one: "{}" }), { semanticClassifier: {
      ...base, contract: claudeCodeConfigurationSemanticClassifierContract,
      classify: () => classifyAsExactName(value),
    } }).execute(input([source("one")]));
    assert.equal(result.sources[0]?.status, "malformed");
    assert.deepEqual(result.observedPortableIntent, []);
    assert.doesNotMatch(JSON.stringify(result), new RegExp(value.replaceAll("\u0007", ""), "u"));
  }

  const documentedExactName = "claude-opus-4-1-20250805";
  const safe = await inspector(readerFor({ one: "{}" }), { semanticClassifier: {
    ...base, contract: claudeCodeConfigurationSemanticClassifierContract,
    classify: () => classifyAsExactName(documentedExactName),
  } }).execute(input([source("one")]));
  assert.equal(safe.sources[0]?.status, "applied");
  assert.deepEqual(safe.observedPortableIntent[0]?.key === "model"
    ? safe.observedPortableIntent[0].selection : undefined,
  { kind: "exact-name", value: documentedExactName });
});

test("returns detached deeply frozen results and honors cancellation without provider execution", async () => {
  const configured = inspector(readerFor({ one: '{"model":"claude-opus-4-8[1m]"}' }));
  const result = await configured.execute(input([source("one")]));
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.sourceModel), true);
  assert.equal(Object.isFrozen(result.observedPortableIntent), true);
  assert.equal(Object.isFrozen(result.observedPortableIntent[0]), true);
  const cancellation = new AbortController(); cancellation.abort(new Error("cancelled"));
  await assert.rejects(configured.execute(input([source("one")]), { signal: cancellation.signal }));
});
