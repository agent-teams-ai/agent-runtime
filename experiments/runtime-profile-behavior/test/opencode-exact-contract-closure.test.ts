import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  characterizeOpenCodeExactContract,
  OpenCodeExactContractError,
  OPENCODE_EXACT_CONTRACT_JSON_LIMITS,
  parseOpenCodeExactContractFixture,
} from "../src/features/acp-compatibility/opencode-exact-contract.ts";

const repositoryRoot = new URL("../../../", import.meta.url);
const fixtureUrl = new URL(
  "../fixtures/acp-compatibility/opencode-1-18-5-contract.json",
  import.meta.url,
);
const expectedFixtureDigest = "c540dc43d931ec8355e3f13ac4feebebb42498703e79c360b18191df0eb29a84";
const hostingPath = "experiments/runtime-profile-behavior/fixtures/opencode-hosting-e2e-summary.json";
const hostingDigest = "efdb9caf86efae6dcb29529a84eb65a26b33ec42d837635afba71ac85579bf89";

const digest = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const encode = (value: unknown): Uint8Array => Buffer.from(JSON.stringify(value));
const loadBytes = (): Promise<Buffer> => readFile(fixtureUrl);
const loadObject = async (): Promise<Record<string, any>> =>
  JSON.parse(await readFile(fixtureUrl, "utf8")) as Record<string, any>;

const rejectionKind = async (bytes: Uint8Array, kind: string): Promise<void> => {
  await assert.rejects(
    parseOpenCodeExactContractFixture(bytes),
    (error: unknown) => error instanceof OpenCodeExactContractError && error.kind === kind,
  );
};

const isDeepFrozen = (value: unknown, seen = new Set<object>()): boolean => {
  if (typeof value !== "object" || value === null || seen.has(value)) {return true;}
  seen.add(value);
  return Object.isFrozen(value) && Object.values(value).every(entry => isDeepFrozen(entry, seen));
};

test("loads a bounded exact-1.18.5 characterization without a provider launch", async () => {
  const bytes = await loadBytes();
  assert.equal(digest(bytes), expectedFixtureDigest);
  const fixture = await parseOpenCodeExactContractFixture(bytes);
  assert.equal(fixture.claim, "contract_only_no_production_adapter");
  assert.equal(fixture.name, "opencode-1-18-5-contract-characterization");
  assert.equal(fixture.schemaVersion, 2);
  assert.deepEqual(
    fixture.capabilityDisposition.map(({ status }) => status).toSorted(),
    ["deferred", "supported", "unknown", "unsupported"],
  );
  assert.deepEqual(fixture.scope, {
    credentials: false,
    liveProvider: false,
    network: false,
    productionAdapter: false,
  });
  assert.ok(isDeepFrozen(fixture));
});

test("authenticates fixed sources internally and binds field-level provenance", async () => {
  const fixture = await parseOpenCodeExactContractFixture(await loadBytes());
  assert.equal(parseOpenCodeExactContractFixture.length, 1);
  assert.deepEqual(fixture.neutralContract, {
    manifestProviderRevision:
      "opencode@1.18.5#sha256:78f75775f26bf92237b27748d3b07bbd84b861536cb4ebe437fab6cf36bcac21",
    manifestRevision: "opencode-acp-contained-turn-v1@1",
    source: "experiments/runtime-profile-behavior/fixtures/acp-compatibility/opencode-contained-turn-port-conformance.json",
    sourceSha256: "076f8830c29f10ebf9d40e0fb344f9f1a44a6b7291f3f29066080785beccf9fb",
    supportedModes: ["analysis"],
    unknownCapabilityPolicy: "fail_closed",
  });
  assert.ok(fixture.provenance.fieldSources.every(pointer => pointer.jsonPointer.startsWith("/")));
  assert.ok(fixture.provenance.fieldSources.some(pointer =>
    pointer.field === "derivedCapabilityProjection.session.cancel" &&
    pointer.sourcePath === hostingPath && pointer.jsonPointer === "/confirmedFacts/5/fact"));

  const hostingBytes = await readFile(new URL(hostingPath, repositoryRoot));
  assert.equal(digest(hostingBytes), hostingDigest);
  const hosting = JSON.parse(hostingBytes.toString()) as Record<string, any>;
  assert.deepEqual(hosting.binaries[0], {
    version: "1.18.5",
    sha256: "78f75775f26bf92237b27748d3b07bbd84b861536cb4ebe437fab6cf36bcac21",
  });
  assert.equal(hosting.confirmedFacts[5].id, "cancel-version-ab");
  assert.match(hosting.confirmedFacts[5].fact, /1\.18\.5 failed 10\/10/u);
});

test("labels the invented initialize shape as a derived capability projection", async () => {
  const fixture = await parseOpenCodeExactContractFixture(await loadBytes());
  assert.deepEqual(fixture.derivedCapabilityProjection, {
    protocolVersion: 1,
    providerName: "OpenCode",
    providerVersion: "1.18.5",
    session: {
      cancel: "deferred_timing_ambiguity",
      close: "observed",
      list: "observed",
      prompt: "observed",
      resume: "observed",
    },
  });
  const bytes = await readFile(fixtureUrl, "utf8");
  assert.doesNotMatch(bytes, /normalizedInitializeResponse|initializeResponse/u);
});

test("withdraws kernel replay closure and returns only an immutable characterization", async () => {
  const characterization = characterizeOpenCodeExactContract(
    await parseOpenCodeExactContractFixture(await loadBytes()),
  );
  assert.deepEqual(characterization, {
    claim: "contract_only_no_production_adapter",
    kernelReplayClaimed: false,
    provider: "opencode",
    providerRevision:
      "opencode@1.18.5#78f75775f26bf92237b27748d3b07bbd84b861536cb4ebe437fab6cf36bcac21",
    supportedModes: ["analysis"],
    terminalObservation: "succeeded",
    unknownCapabilityPolicy: "fail_closed",
  });
  assert.ok(isDeepFrozen(characterization));
});

test("accepts bytes only and never touches an arbitrary getter graph", async () => {
  let getterCalls = 0;
  const hostile = Object.defineProperty({}, "schemaVersion", {
    enumerable: true,
    get: () => {
      getterCalls += 1;
      throw new Error("getter executed");
    },
  });
  await assert.rejects(
    parseOpenCodeExactContractFixture(hostile as Uint8Array),
    (error: unknown) => error instanceof OpenCodeExactContractError && error.kind === "json_bytes",
  );
  assert.equal(getterCalls, 0);
});

test("rejects extra own keys at every modeled object level", async () => {
  const mutations: readonly [readonly (string | number)[], string][] = [
    [[], "fixture_fields"],
    [["pin"], "pin_fields"],
    [["provenance"], "provenance_fields"],
    [["provenance", "sources", 0], "provenance_source_fields"],
    [["provenance", "fieldSources", 0], "field_source_fields"],
    [["authority"], "authority_fields"],
    [["scope"], "scope_fields"],
    [["derivedCapabilityProjection"], "derived_capability_projection_fields"],
    [["derivedCapabilityProjection", "session"], "derived_session_projection_fields"],
    [["neutralContract"], "neutral_contract_fields"],
    [["capabilityDisposition", 0], "capability_disposition_entry_fields"],
    [["boundedObservation"], "bounded_observation_fields"],
  ];
  for (const [path, kind] of mutations) {
    const mutation = await loadObject();
    let target: Record<string, unknown> = mutation;
    for (const segment of path) {target = target[segment] as Record<string, unknown>;}
    target.unmodelled = true;
    await rejectionKind(encode(mutation), kind);
  }
});

test("rejects raw ACP framing, _meta, and promoted or unmodelled capabilities", async () => {
  for (const [path, key, value, kind] of [
    [[], "jsonrpc", "2.0", "fixture_fields"],
    [[], "id", 1, "fixture_fields"],
    [[], "method", "initialize", "fixture_fields"],
    [[], "result", {}, "fixture_fields"],
    [["derivedCapabilityProjection"], "_meta", {}, "derived_capability_projection_fields"],
    [["derivedCapabilityProjection", "session"], "fork", "observed", "derived_session_projection_fields"],
    [["boundedObservation"], "providerOutput", "raw", "bounded_observation_fields"],
  ] as const) {
    const mutation = await loadObject();
    let target: Record<string, unknown> = mutation;
    for (const segment of path) {target = target[segment] as Record<string, unknown>;}
    target[key] = value;
    await rejectionKind(encode(mutation), kind);
  }
  const promoted = await loadObject();
  promoted.capabilityDisposition[3].status = "supported";
  await rejectionKind(encode(promoted), "capability_disposition");
});

test("rejects malformed primitives and arrays instead of returning unchecked content", async () => {
  for (const [path, value, kind] of [
    [["schemaVersion"], 1, "schema_version"],
    [["pin", "packageVersion"], "1.18.25", "package_version"],
    [["pin", "binarySha256"], "0".repeat(64), "binary_sha256"],
    [["provenance", "sources", 0, "sha256"], "0".repeat(64), "provenance_digest"],
    [["provenance", "fieldSources", 0, "jsonPointer"], "/wrong", "field_sources"],
    [["authority", "secondAcpWire"], true, "acp_authority"],
    [["scope", "network"], true, "scope"],
    [["derivedCapabilityProjection", "protocolVersion"], "1", "protocol_version"],
    [["derivedCapabilityProjection", "session", "cancel"], "supported", "session_cancel"],
    [["neutralContract", "manifestRevision"], "invented@2", "manifest_revision"],
    [["neutralContract", "manifestProviderRevision"], "wrong", "manifest_provider_revision"],
    [["neutralContract", "supportedModes"], ["analysis", "workspace-write"], "neutral_supported_modes"],
    [["boundedObservation", "retainedRawData"], true, "raw_data"],
    [["deferredProductionWork", 0], "production_adapter_complete", "deferred_production_work"],
  ] as const) {
    const mutation = await loadObject();
    let target: any = mutation;
    const final = path.at(-1);
    assert.ok(final !== undefined);
    for (const segment of path.slice(0, -1)) {target = target[segment];}
    target[final] = value;
    await rejectionKind(encode(mutation), kind);
  }
});

test("enforces bounded, unique-key strict JSON before model validation", async () => {
  await rejectionKind(new Uint8Array(), "json_size");
  await rejectionKind(Buffer.alloc(OPENCODE_EXACT_CONTRACT_JSON_LIMITS.maxBytes + 1, 0x20), "json_size");
  await rejectionKind(Uint8Array.of(0xff), "json_utf8");
  await rejectionKind(Buffer.from("{\"schemaVersion\":2,\"schemaVersion\":2}"), "json_duplicate_key");
  await rejectionKind(Buffer.from("{\"value\":/*comment*/1}"), "json_syntax");
  await rejectionKind(Buffer.from(`${"[".repeat(12)}0${"]".repeat(12)}`), "json_depth");
  await rejectionKind(encode({ value: "x".repeat(OPENCODE_EXACT_CONTRACT_JSON_LIMITS.maxStringBytes + 1) }), "json_string_size");
  await rejectionKind(encode({ value: Array.from({ length: OPENCODE_EXACT_CONTRACT_JSON_LIMITS.maxArrayEntries + 1 }, () => 0) }), "json_array_size");
});

test("retains no ACP frames, identifiers, raw values, or second wire", async () => {
  const bytes = await readFile(fixtureUrl, "utf8");
  const sdkPackage = JSON.parse(
    await readFile(new URL("../../../node_modules/@agentclientprotocol/sdk/package.json", import.meta.url), "utf8"),
  ) as { readonly version?: unknown };
  assert.equal(sdkPackage.version, "1.3.0");
  assert.doesNotMatch(bytes, /"(?:id|jsonrpc|method|params|result)"\s*:/u);
  assert.doesNotMatch(bytes, /\/var\/|\/home\/|session text|tool args|provider output|network data/iu);
  assert.match(bytes, /"customJsonRpcIds": false/u);
  assert.match(bytes, /"customNdjsonTransport": false/u);
  assert.match(bytes, /"secondAcpWire": false/u);
});
