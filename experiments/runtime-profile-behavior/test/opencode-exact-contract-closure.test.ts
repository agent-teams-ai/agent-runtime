import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  OpenCodeExactContractError,
  parseOpenCodeExactContractFixture,
  replayOpenCodeExactContract,
} from "../src/features/acp-compatibility/opencode-exact-contract.ts";

const repositoryRoot = new URL("../../../", import.meta.url);
const fixtureUrl = new URL(
  "../fixtures/acp-compatibility/opencode-1-18-5-contract.json",
  import.meta.url,
);
const expectedFixtureDigest = "9c8c6c9ef0ec05235033f36b5691a3deb76b5a8356a97f83b79cfe7f6459ce68";

const sourcePaths = [
  "experiments/runtime-profile-behavior/fixtures/opencode-container-tls-gateway-summary.json",
  "experiments/runtime-profile-behavior/fixtures/provider-behavior-matrix.json",
  "experiments/runtime-profile-behavior/spec/runtime-operation-oracle/contained-turn-v1-contract.json",
  "experiments/runtime-profile-behavior/fixtures/acp-compatibility/opencode-contained-turn-port-conformance.json",
] as const;

const digest = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

const load = async (): Promise<{
  readonly parsed: Record<string, unknown>;
  readonly sourceDigests: Readonly<Record<string, string>>;
}> => {
  const parsed = JSON.parse(await readFile(fixtureUrl, "utf8")) as Record<string, unknown>;
  const sourceDigests = Object.fromEntries(
    await Promise.all(sourcePaths.map(async (path) => [path, digest(await readFile(new URL(path, repositoryRoot)))])),
  );
  return { parsed, sourceDigests };
};

const rejectionKind = (
  value: unknown,
  sourceDigests: Readonly<Record<string, string>>,
  kind: string,
): void => {
  assert.throws(
    () => parseOpenCodeExactContractFixture(value, sourceDigests),
    (error: unknown) => error instanceof OpenCodeExactContractError && error.kind === kind,
  );
};

test("closes the immutable exact-1.18.5 contract fixture without a provider launch", async () => {
  const bytes = await readFile(fixtureUrl);
  const { parsed, sourceDigests } = await load();
  assert.equal(digest(bytes), expectedFixtureDigest);

  const fixture = parseOpenCodeExactContractFixture(parsed, sourceDigests);
  assert.equal(fixture.claim, "contract_only_no_production_adapter");
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
  assert.deepEqual(fixture.deferredProductionWork, [
    "production_adapter",
    "process_custody",
    "credential_binding",
    "provider_access_route",
    "native_reconciliation",
  ]);
});

test("binds the normalized contract only to facts retained by exact checked-in evidence", async () => {
  const { parsed, sourceDigests } = await load();
  parseOpenCodeExactContractFixture(parsed, sourceDigests);

  const container = JSON.parse(
    await readFile(new URL(sourcePaths[0], repositoryRoot), "utf8"),
  ) as Record<string, any>;
  assert.deepEqual(container.runtimeClosure.openCode, {
    version: "1.18.5",
    sourceTag: "v1.18.5",
    sourceCommit: "e5cc278dec9294a627a7b05f47ce6a564408c1a2",
    binarySha256: "78f75775f26bf92237b27748d3b07bbd84b861536cb4ebe437fab6cf36bcac21",
  });
  assert.equal(container.accepted.directProxyOpenCodeE2E.acpProtocolVersion, 1);
  assert.equal(container.accepted.directProxyOpenCodeE2E.agentVersion, "1.18.5");
  assert.equal(container.accepted.directProxyOpenCodeE2E.stopReason, "end_turn");

  const matrix = JSON.parse(
    await readFile(new URL(sourcePaths[1], repositoryRoot), "utf8"),
  ) as Record<string, any>;
  const acp = matrix.observations.find(
    (entry: Record<string, unknown>) => entry.id === "opencode.acp-v1-negotiation",
  );
  assert.equal(acp.status, "confirmed");
  assert.match(acp.observation, /OpenCode 1\.18\.5 negotiated ACP v1/u);
  assert.match(acp.observation, /session new, list, resume, close, and an authenticated prompt/u);

  const oracle = JSON.parse(
    await readFile(new URL(sourcePaths[2], repositoryRoot), "utf8"),
  ) as Record<string, any>;
  const provider = oracle.providers.find((entry: Record<string, unknown>) => entry.provider === "opencode");
  const manifest = oracle.adapterCapabilityManifests.find(
    (entry: Record<string, unknown>) => entry.provider === "opencode",
  );
  assert.equal(provider.qualification, "contract_only_no_production_adapter");
  assert.equal(manifest.unknownCapabilityPolicy, "fail_closed");

  const neutralProjection = JSON.parse(
    await readFile(new URL(sourcePaths[3], repositoryRoot), "utf8"),
  ) as Record<string, any>;
  assert.deepEqual(neutralProjection.contractPin.supportedModes, ["analysis"]);
  assert.equal(neutralProjection.contractPin.providerRevision, provider.packageRevision);
});

test("replays through the provider-neutral contained-turn capability projection", async () => {
  const { parsed, sourceDigests } = await load();
  const replay = replayOpenCodeExactContract(
    parseOpenCodeExactContractFixture(parsed, sourceDigests),
  );
  assert.deepEqual(replay, {
    claim: "contract_only_no_production_adapter",
    provider: "opencode",
    providerRevision:
      "opencode@1.18.5#78f75775f26bf92237b27748d3b07bbd84b861536cb4ebe437fab6cf36bcac21",
    supportedModes: ["analysis"],
    terminal: "succeeded",
    unknownCapabilityPolicy: "fail_closed",
  });
  assert.deepEqual(Object.keys(replay).toSorted(), [
    "claim",
    "provider",
    "providerRevision",
    "supportedModes",
    "terminal",
    "unknownCapabilityPolicy",
  ]);
});

test("rejects wrong version, binary hash, and provenance", async () => {
  const { parsed, sourceDigests } = await load();
  for (const [path, replacement, kind] of [
    [["pin", "packageVersion"], "1.18.25", "package_version"],
    [["pin", "binaryVersion"], "1.18.25", "binary_version"],
    [["pin", "binarySha256"], "0".repeat(64), "binary_sha256"],
    [["provenance", "kind"], "captured_live_transcript", "provenance_kind"],
  ] as const) {
    const mutation = structuredClone(parsed) as Record<string, any>;
    mutation[path[0]][path[1]] = replacement;
    rejectionKind(mutation, sourceDigests, kind);
  }

  const driftedDigests = { ...sourceDigests, [sourcePaths[0]]: "0".repeat(64) };
  rejectionKind(parsed, driftedDigests, "source_digest_drift");
});

test("rejects malformed or extra fields and unsupported capability promotion", async () => {
  const { parsed, sourceDigests } = await load();
  const extra = structuredClone(parsed) as Record<string, unknown>;
  extra.extra = true;
  rejectionKind(extra, sourceDigests, "fixture_fields");

  const malformed = structuredClone(parsed) as Record<string, any>;
  malformed.normalizedInitializeResponse.protocolVersion = "1";
  assert.throws(
    () => parseOpenCodeExactContractFixture(malformed, sourceDigests),
    (error: unknown) => error instanceof Error,
  );

  const promoted = structuredClone(parsed) as Record<string, any>;
  promoted.capabilityDisposition[3].status = "supported";
  rejectionKind(promoted, sourceDigests, "capability_disposition");
});

test("rejects raw-data fields and drift from the neutral contract", async () => {
  const { parsed, sourceDigests } = await load();
  for (const [field, value] of [
    ["workspacePath", "/raw/workspace"],
    ["sessionText", "raw session text"],
    ["toolArguments", { command: "raw" }],
    ["credential", "raw-secret"],
    ["providerOutput", "raw provider output"],
    ["networkData", "raw packet"],
  ] as const) {
    const mutation = structuredClone(parsed) as Record<string, any>;
    mutation.boundedObservation[field] = value;
    rejectionKind(mutation, sourceDigests, "bounded_observation_fields");
  }

  for (const [field, value, kind] of [
    ["supportedModes", ["analysis", "workspace-write"], "neutral_supported_modes"],
    ["unknownCapabilityPolicy", "permit", "neutral_unknown_policy"],
    ["sourceSha256", "0".repeat(64), "neutral_contract_digest"],
  ] as const) {
    const mutation = structuredClone(parsed) as Record<string, any>;
    mutation.neutralContract[field] = value;
    rejectionKind(mutation, sourceDigests, kind);
  }
});

test("retains no ACP framing, identifiers, raw values, or second wire", async () => {
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
