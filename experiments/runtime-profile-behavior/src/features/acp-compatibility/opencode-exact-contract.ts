import { observeOpenCodeCapabilities } from "./opencode-acp-validation.ts";

export const OPENCODE_EXACT_PACKAGE_VERSION = "1.18.5";
export const OPENCODE_EXACT_BINARY_SHA256 =
  "78f75775f26bf92237b27748d3b07bbd84b861536cb4ebe437fab6cf36bcac21";
export const OPENCODE_EXACT_PROVIDER_REVISION =
  `opencode@${OPENCODE_EXACT_PACKAGE_VERSION}#${OPENCODE_EXACT_BINARY_SHA256}`;

export type OpenCodeContractCapabilityDisposition =
  | "deferred"
  | "supported"
  | "unknown"
  | "unsupported";

export interface OpenCodeExactContractFixture {
  readonly schemaVersion: 1;
  readonly name: "opencode-1-18-5-contract";
  readonly claim: "contract_only_no_production_adapter";
  readonly pin: Readonly<{
    package: "opencode-ai";
    packageVersion: typeof OPENCODE_EXACT_PACKAGE_VERSION;
    binaryVersion: typeof OPENCODE_EXACT_PACKAGE_VERSION;
    binarySha256: typeof OPENCODE_EXACT_BINARY_SHA256;
    providerRevision: typeof OPENCODE_EXACT_PROVIDER_REVISION;
  }>;
  readonly provenance: Readonly<{
    kind: "normalized_from_checked_in_immutable_redacted_evidence";
    rawAcpTranscriptRetained: false;
    sources: readonly Readonly<{
      path: string;
      sha256: string;
      role: string;
    }>[];
  }>;
  readonly authority: Readonly<{
    acpFramingAndCorrelationOwner: "@agentclientprotocol/sdk@1.3.0";
    customJsonRpcIds: false;
    customNdjsonTransport: false;
    secondAcpWire: false;
  }>;
  readonly scope: Readonly<{
    liveProvider: false;
    network: false;
    credentials: false;
    productionAdapter: false;
  }>;
  readonly normalizedInitializeResponse: Readonly<Record<string, unknown>>;
  readonly neutralContract: Readonly<{
    source: string;
    sourceSha256: string;
    supportedModes: readonly ["analysis"];
    unknownCapabilityPolicy: "fail_closed";
  }>;
  readonly capabilityDisposition: readonly Readonly<{
    capability: string;
    status: OpenCodeContractCapabilityDisposition;
    evidence: string;
  }>[];
  readonly boundedObservation: Readonly<{
    terminal: "succeeded";
    stopReason: "end_turn";
    retainedRawData: false;
  }>;
  readonly deferredProductionWork: readonly string[];
}

export class OpenCodeExactContractError extends Error {
  public readonly kind: string;

  public constructor(kind: string) {
    super("Invalid exact OpenCode contract fixture");
    this.name = "OpenCodeExactContractError";
    this.kind = kind;
  }
}

const fail = (kind: string): never => {
  throw new OpenCodeExactContractError(kind);
};

const record = (value: unknown, kind: string): Readonly<Record<string, unknown>> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return fail(kind);
  }
  return value as Readonly<Record<string, unknown>>;
};

const exactKeys = (
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
  kind: string,
): void => {
  const actual = Object.keys(value).toSorted();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(kind);
  }
};

const exactString = (value: unknown, expected: string, kind: string): void => {
  if (value !== expected) {
    fail(kind);
  }
};

const sha256 = (value: unknown, kind: string): string => {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    return fail(kind);
  }
  return value;
};

const EXPECTED_SOURCES = Object.freeze([
  Object.freeze({
    path: "experiments/runtime-profile-behavior/fixtures/opencode-container-tls-gateway-summary.json",
    sha256: "6dbc6ca165ca9ff26ac7bb56ff049a7af05b81521d5b82414725a0af904a2d60",
    role: "exact_binary_acp_v1_prompt_terminal_observation",
  }),
  Object.freeze({
    path: "experiments/runtime-profile-behavior/fixtures/provider-behavior-matrix.json",
    sha256: "5acc1c00ddca29c81e83ab646ad57827cd349faf9cb6a0abb3e1c4a75075dba3",
    role: "exact_version_acp_operation_characterization",
  }),
  Object.freeze({
    path: "experiments/runtime-profile-behavior/spec/runtime-operation-oracle/contained-turn-v1-contract.json",
    sha256: "2e8c659bb57b866c0afce532e4ab94c2bb07501e5c97b3933718e6148fa279eb",
    role: "provider_neutral_contract_pin_and_unknown_capability_policy",
  }),
  Object.freeze({
    path: "experiments/runtime-profile-behavior/fixtures/acp-compatibility/opencode-contained-turn-port-conformance.json",
    sha256: "076f8830c29f10ebf9d40e0fb344f9f1a44a6b7291f3f29066080785beccf9fb",
    role: "provider_neutral_contained_turn_projection",
  }),
]);

const EXPECTED_CAPABILITIES = Object.freeze([
  Object.freeze({ capability: "contained_turn/analysis", status: "supported", evidence: "exact_prompt_end_turn" }),
  Object.freeze({ capability: "session/cancel", status: "deferred", evidence: "exact_version_timing_ambiguity" }),
  Object.freeze({ capability: "unobserved_acp_extensions", status: "unknown", evidence: "no_raw_transcript_retained" }),
  Object.freeze({ capability: "production_adapter", status: "unsupported", evidence: "contract_only_scope" }),
] satisfies readonly Readonly<{
  capability: string;
  status: OpenCodeContractCapabilityDisposition;
  evidence: string;
}>[]);

const EXPECTED_DEFERRED = Object.freeze([
  "production_adapter",
  "process_custody",
  "credential_binding",
  "provider_access_route",
  "native_reconciliation",
]);

export const parseOpenCodeExactContractFixture = (
  value: unknown,
  actualSourceDigests: Readonly<Record<string, string>>,
): OpenCodeExactContractFixture => {
  const fixture = record(value, "fixture");
  exactKeys(fixture, [
    "authority", "boundedObservation", "capabilityDisposition", "claim",
    "deferredProductionWork", "name", "neutralContract", "normalizedInitializeResponse",
    "pin", "provenance", "schemaVersion", "scope",
  ], "fixture_fields");
  if (fixture.schemaVersion !== 1) {
    fail("schema_version");
  }
  exactString(fixture.name, "opencode-1-18-5-contract", "name");
  exactString(fixture.claim, "contract_only_no_production_adapter", "claim");

  const pin = record(fixture.pin, "pin");
  exactKeys(pin, ["binarySha256", "binaryVersion", "package", "packageVersion", "providerRevision"], "pin_fields");
  exactString(pin.package, "opencode-ai", "package");
  exactString(pin.packageVersion, OPENCODE_EXACT_PACKAGE_VERSION, "package_version");
  exactString(pin.binaryVersion, OPENCODE_EXACT_PACKAGE_VERSION, "binary_version");
  exactString(pin.binarySha256, OPENCODE_EXACT_BINARY_SHA256, "binary_sha256");
  exactString(pin.providerRevision, OPENCODE_EXACT_PROVIDER_REVISION, "provider_revision");

  const provenance = record(fixture.provenance, "provenance");
  exactKeys(provenance, ["kind", "rawAcpTranscriptRetained", "sources"], "provenance_fields");
  exactString(provenance.kind, "normalized_from_checked_in_immutable_redacted_evidence", "provenance_kind");
  const sources = provenance.sources;
  if (provenance.rawAcpTranscriptRetained !== false) {
    fail("provenance");
  }
  const sourceEntries: readonly unknown[] = Array.isArray(sources)
    ? sources
    : fail("provenance");
  if (sourceEntries.length !== EXPECTED_SOURCES.length) {
    fail("provenance_sources");
  }
  for (const [index, expected] of EXPECTED_SOURCES.entries()) {
    const source = record(sourceEntries[index], "provenance_source");
    exactKeys(source, ["path", "role", "sha256"], "provenance_source_fields");
    exactString(source.path, expected.path, "provenance_path");
    exactString(source.role, expected.role, "provenance_role");
    exactString(sha256(source.sha256, "provenance_digest"), expected.sha256, "provenance_digest");
    exactString(actualSourceDigests[expected.path], expected.sha256, "source_digest_drift");
  }

  const authority = record(fixture.authority, "authority");
  exactKeys(authority, ["acpFramingAndCorrelationOwner", "customJsonRpcIds", "customNdjsonTransport", "secondAcpWire"], "authority_fields");
  exactString(authority.acpFramingAndCorrelationOwner, "@agentclientprotocol/sdk@1.3.0", "acp_owner");
  if (authority.customJsonRpcIds !== false || authority.customNdjsonTransport !== false || authority.secondAcpWire !== false) {
    fail("acp_authority");
  }

  const scope = record(fixture.scope, "scope");
  exactKeys(scope, ["credentials", "liveProvider", "network", "productionAdapter"], "scope_fields");
  if (Object.values(scope).some((entry) => entry !== false)) {
    fail("scope");
  }

  const initialized = observeOpenCodeCapabilities(fixture.normalizedInitializeResponse);
  if (
    initialized.providerName !== "OpenCode" ||
    initialized.providerVersion !== OPENCODE_EXACT_PACKAGE_VERSION ||
    initialized.protocolVersion !== 1 ||
    initialized.session.prompt !== "baseline" ||
    initialized.session.list !== "supported" ||
    initialized.session.resume !== "supported" ||
    initialized.session.close !== "supported" ||
    initialized.session.load !== "unsupported" ||
    initialized.session.fork !== "unsupported" ||
    initialized.unknown.length !== 0
  ) {
    fail("normalized_initialize_response");
  }

  const neutral = record(fixture.neutralContract, "neutral_contract");
  exactKeys(neutral, ["source", "sourceSha256", "supportedModes", "unknownCapabilityPolicy"], "neutral_contract_fields");
  const neutralSource = EXPECTED_SOURCES[3] ?? fail("neutral_contract_source");
  exactString(neutral.source, neutralSource.path, "neutral_contract_source");
  exactString(neutral.sourceSha256, neutralSource.sha256, "neutral_contract_digest");
  if (!Array.isArray(neutral.supportedModes) || neutral.supportedModes.length !== 1 || neutral.supportedModes[0] !== "analysis") {
    fail("neutral_supported_modes");
  }
  exactString(neutral.unknownCapabilityPolicy, "fail_closed", "neutral_unknown_policy");

  if (!Array.isArray(fixture.capabilityDisposition)) {
    fail("capability_disposition");
  }
  if (JSON.stringify(fixture.capabilityDisposition) !== JSON.stringify(EXPECTED_CAPABILITIES)) {
    fail("capability_disposition");
  }
  if (!Array.isArray(fixture.deferredProductionWork) || JSON.stringify(fixture.deferredProductionWork) !== JSON.stringify(EXPECTED_DEFERRED)) {
    fail("deferred_production_work");
  }

  const bounded = record(fixture.boundedObservation, "bounded_observation");
  exactKeys(bounded, ["retainedRawData", "stopReason", "terminal"], "bounded_observation_fields");
  exactString(bounded.terminal, "succeeded", "terminal");
  exactString(bounded.stopReason, "end_turn", "stop_reason");
  if (bounded.retainedRawData !== false) {
    fail("raw_data");
  }

  return structuredClone(fixture) as unknown as OpenCodeExactContractFixture;
};

export interface OpenCodeExactContractReplay {
  readonly claim: "contract_only_no_production_adapter";
  readonly provider: "opencode";
  readonly providerRevision: typeof OPENCODE_EXACT_PROVIDER_REVISION;
  readonly supportedModes: readonly ["analysis"];
  readonly terminal: "succeeded";
  readonly unknownCapabilityPolicy: "fail_closed";
}

export const replayOpenCodeExactContract = (
  fixture: OpenCodeExactContractFixture,
): OpenCodeExactContractReplay => Object.freeze({
  claim: fixture.claim,
  provider: "opencode",
  providerRevision: OPENCODE_EXACT_PROVIDER_REVISION,
  supportedModes: Object.freeze(["analysis"] as const),
  terminal: fixture.boundedObservation.terminal,
  unknownCapabilityPolicy: fixture.neutralContract.unknownCapabilityPolicy,
});
