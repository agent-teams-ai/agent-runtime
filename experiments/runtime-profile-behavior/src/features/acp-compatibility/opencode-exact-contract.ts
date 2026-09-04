import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { parseTree, type Node, type ParseError } from "jsonc-parser";

export const OPENCODE_EXACT_PACKAGE_VERSION = "1.18.5";
export const OPENCODE_EXACT_BINARY_SHA256 =
  "78f75775f26bf92237b27748d3b07bbd84b861536cb4ebe437fab6cf36bcac21";
export const OPENCODE_EXACT_PROVIDER_REVISION =
  `opencode@${OPENCODE_EXACT_PACKAGE_VERSION}#${OPENCODE_EXACT_BINARY_SHA256}`;
export const OPENCODE_EXACT_MANIFEST_REVISION = "opencode-acp-contained-turn-v1@1";
export const OPENCODE_EXACT_MANIFEST_PROVIDER_REVISION =
  `opencode@${OPENCODE_EXACT_PACKAGE_VERSION}#sha256:${OPENCODE_EXACT_BINARY_SHA256}`;

export const OPENCODE_EXACT_CONTRACT_JSON_LIMITS = Object.freeze({
  maxArrayEntries: 32,
  maxBytes: 16_384,
  maxDepth: 8,
  maxNodes: 1_024,
  maxObjectProperties: 32,
  maxStringBytes: 512,
});

export type OpenCodeContractCapabilityDisposition =
  | "deferred"
  | "supported"
  | "unknown"
  | "unsupported";

interface SourcePointer {
  readonly field: string;
  readonly jsonPointer: string;
  readonly sourcePath: string;
}

export interface OpenCodeExactContractFixture {
  readonly schemaVersion: 2;
  readonly name: "opencode-1-18-5-contract-characterization";
  readonly claim: "contract_only_no_production_adapter";
  readonly pin: Readonly<{
    package: "opencode-ai";
    packageVersion: typeof OPENCODE_EXACT_PACKAGE_VERSION;
    binaryVersion: typeof OPENCODE_EXACT_PACKAGE_VERSION;
    binarySha256: typeof OPENCODE_EXACT_BINARY_SHA256;
    providerRevision: typeof OPENCODE_EXACT_PROVIDER_REVISION;
  }>;
  readonly provenance: Readonly<{
    fieldSources: readonly Readonly<SourcePointer>[];
    kind: "derived_from_checked_in_immutable_redacted_evidence";
    rawAcpTranscriptRetained: false;
    sources: readonly Readonly<{ readonly path: string; readonly role: string; readonly sha256: string }>[];
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
  readonly derivedCapabilityProjection: Readonly<{
    protocolVersion: 1;
    providerName: "OpenCode";
    providerVersion: typeof OPENCODE_EXACT_PACKAGE_VERSION;
    session: Readonly<{
      cancel: "deferred_timing_ambiguity";
      close: "observed";
      list: "observed";
      prompt: "observed";
      resume: "observed";
    }>;
  }>;
  readonly neutralContract: Readonly<{
    manifestProviderRevision: typeof OPENCODE_EXACT_MANIFEST_PROVIDER_REVISION;
    manifestRevision: typeof OPENCODE_EXACT_MANIFEST_REVISION;
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
    super("Invalid exact OpenCode contract characterization fixture");
    this.name = "OpenCodeExactContractError";
    this.kind = kind;
  }
}

const fail = (kind: string): never => {
  throw new OpenCodeExactContractError(kind);
};

const byteLength = (value: string): number => Buffer.byteLength(value, "utf8");
const digest = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

const record = (value: unknown, kind: string): Readonly<Record<string, unknown>> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {return fail(kind);}
  return value as Readonly<Record<string, unknown>>;
};

const exactKeys = (
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
  kind: string,
): void => {
  const actual = Object.keys(value).toSorted();
  const sortedExpected = [...expected].toSorted();
  if (actual.length !== sortedExpected.length || actual.some((key, index) => key !== sortedExpected[index])) {
    fail(kind);
  }
};

const exactString = (value: unknown, expected: string, kind: string): string =>
  value === expected ? value : fail(kind);

const exactFalse = (value: unknown, kind: string): false => value === false ? false : fail(kind);

const exactDigest = (value: unknown, expected: string, kind: string): string => {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value) || value !== expected) {return fail(kind);}
  return value;
};

const SOURCE = Object.freeze({
  container: Object.freeze({
    path: "experiments/runtime-profile-behavior/fixtures/opencode-container-tls-gateway-summary.json",
    sha256: "6dbc6ca165ca9ff26ac7bb56ff049a7af05b81521d5b82414725a0af904a2d60",
    role: "exact_binary_acp_v1_prompt_terminal_observation",
  }),
  hosting: Object.freeze({
    path: "experiments/runtime-profile-behavior/fixtures/opencode-hosting-e2e-summary.json",
    sha256: "efdb9caf86efae6dcb29529a84eb65a26b33ec42d837635afba71ac85579bf89",
    role: "exact_version_cancellation_timing_source",
  }),
  matrix: Object.freeze({
    path: "experiments/runtime-profile-behavior/fixtures/provider-behavior-matrix.json",
    sha256: "5acc1c00ddca29c81e83ab646ad57827cd349faf9cb6a0abb3e1c4a75075dba3",
    role: "exact_version_acp_operation_characterization",
  }),
  oracle: Object.freeze({
    path: "experiments/runtime-profile-behavior/spec/runtime-operation-oracle/contained-turn-v1-contract.json",
    sha256: "2e8c659bb57b866c0afce532e4ab94c2bb07501e5c97b3933718e6148fa279eb",
    role: "provider_neutral_manifest_pin_and_unknown_capability_policy",
  }),
  projection: Object.freeze({
    path: "experiments/runtime-profile-behavior/fixtures/acp-compatibility/opencode-contained-turn-port-conformance.json",
    sha256: "076f8830c29f10ebf9d40e0fb344f9f1a44a6b7291f3f29066080785beccf9fb",
    role: "synthetic_provider_neutral_kernel_projection_with_declared_identity_gap",
  }),
});

const EXPECTED_SOURCES = Object.freeze([
  SOURCE.container, SOURCE.hosting, SOURCE.matrix, SOURCE.oracle, SOURCE.projection,
]);

const EXPECTED_FIELD_SOURCES = Object.freeze([
  { field: "pin.packageVersion", sourcePath: SOURCE.container.path, jsonPointer: "/runtimeClosure/openCode/version" },
  { field: "pin.binaryVersion", sourcePath: SOURCE.container.path, jsonPointer: "/runtimeClosure/openCode/version" },
  { field: "pin.binarySha256", sourcePath: SOURCE.container.path, jsonPointer: "/runtimeClosure/openCode/binarySha256" },
  { field: "pin.providerRevision", sourcePath: SOURCE.oracle.path, jsonPointer: "/providers/2/packageRevision" },
  { field: "derivedCapabilityProjection.protocolVersion", sourcePath: SOURCE.container.path, jsonPointer: "/accepted/directProxyOpenCodeE2E/acpProtocolVersion" },
  { field: "derivedCapabilityProjection.providerName", sourcePath: SOURCE.container.path, jsonPointer: "/accepted/directProxyOpenCodeE2E/agentName" },
  { field: "derivedCapabilityProjection.providerVersion", sourcePath: SOURCE.container.path, jsonPointer: "/accepted/directProxyOpenCodeE2E/agentVersion" },
  { field: "derivedCapabilityProjection.session.prompt", sourcePath: SOURCE.container.path, jsonPointer: "/accepted/directProxyOpenCodeE2E/stopReason" },
  { field: "derivedCapabilityProjection.session.list", sourcePath: SOURCE.matrix.path, jsonPointer: "/observations/14/observation" },
  { field: "derivedCapabilityProjection.session.resume", sourcePath: SOURCE.matrix.path, jsonPointer: "/observations/14/observation" },
  { field: "derivedCapabilityProjection.session.close", sourcePath: SOURCE.matrix.path, jsonPointer: "/observations/14/observation" },
  { field: "derivedCapabilityProjection.session.cancel", sourcePath: SOURCE.hosting.path, jsonPointer: "/confirmedFacts/5/fact" },
  { field: "neutralContract.manifestRevision", sourcePath: SOURCE.oracle.path, jsonPointer: "/adapterCapabilityManifests/2/manifestRevision" },
  { field: "neutralContract.manifestProviderRevision", sourcePath: SOURCE.oracle.path, jsonPointer: "/adapterCapabilityManifests/2/providerRevision" },
  { field: "neutralContract.supportedModes", sourcePath: SOURCE.projection.path, jsonPointer: "/contractPin/supportedModes" },
  { field: "neutralContract.unknownCapabilityPolicy", sourcePath: SOURCE.oracle.path, jsonPointer: "/adapterCapabilityManifests/2/unknownCapabilityPolicy" },
  { field: "boundedObservation.stopReason", sourcePath: SOURCE.container.path, jsonPointer: "/accepted/directProxyOpenCodeE2E/stopReason" },
] satisfies readonly SourcePointer[]);

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
  "production_adapter", "process_custody", "credential_binding", "provider_access_route", "native_reconciliation",
]);

const inspectJsonNode = (node: Node, depth: number, state: { nodes: number }): void => {
  state.nodes += 1;
  if (state.nodes > OPENCODE_EXACT_CONTRACT_JSON_LIMITS.maxNodes) {fail("json_nodes");}
  if (depth > OPENCODE_EXACT_CONTRACT_JSON_LIMITS.maxDepth) {fail("json_depth");}
  if (node.type === "string" && byteLength(String(node.value)) > OPENCODE_EXACT_CONTRACT_JSON_LIMITS.maxStringBytes) {
    fail("json_string_size");
  }
  if (node.type === "array" && (node.children?.length ?? 0) > OPENCODE_EXACT_CONTRACT_JSON_LIMITS.maxArrayEntries) {
    fail("json_array_size");
  }
  if (node.type === "object") {
    const properties = node.children ?? [];
    if (properties.length > OPENCODE_EXACT_CONTRACT_JSON_LIMITS.maxObjectProperties) {fail("json_object_size");}
    const names = new Set<string>();
    for (const property of properties) {
      const name = String(property.children?.[0]?.value);
      if (names.has(name)) {fail("json_duplicate_key");}
      names.add(name);
    }
  }
  for (const child of node.children ?? []) {inspectJsonNode(child, depth + 1, state);}
};

const parseBoundedJson = (bytes: Uint8Array): unknown => {
  if (!(bytes instanceof Uint8Array)) {return fail("json_bytes");}
  if (bytes.byteLength === 0 || bytes.byteLength > OPENCODE_EXACT_CONTRACT_JSON_LIMITS.maxBytes) {
    return fail("json_size");
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return fail("json_utf8");
  }
  const errors: ParseError[] = [];
  const tree = parseTree(text, errors, { allowTrailingComma: false, disallowComments: true });
  if (tree === undefined || errors.length > 0) {return fail("json_syntax");}
  inspectJsonNode(tree, 0, { nodes: 0 });
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return fail("json_syntax");
  }
};

const repositoryRoot = new URL("../../../../../", import.meta.url);

const authenticateSources = async (): Promise<void> => {
  for (const source of EXPECTED_SOURCES) {
    let bytes: Uint8Array;
    try {
      bytes = await readFile(new URL(source.path, repositoryRoot));
    } catch {
      return fail("source_read");
    }
    if (digest(bytes) !== source.sha256) {fail("source_digest_drift");}
  }
};

const parseSourcePointer = (value: unknown): SourcePointer => {
  const pointer = record(value, "field_source");
  exactKeys(pointer, ["field", "jsonPointer", "sourcePath"], "field_source_fields");
  if (typeof pointer.field !== "string" || typeof pointer.jsonPointer !== "string" || typeof pointer.sourcePath !== "string") {
    return fail("field_source_value");
  }
  return Object.freeze({ field: pointer.field, jsonPointer: pointer.jsonPointer, sourcePath: pointer.sourcePath });
};

const parseFixture = (value: unknown): OpenCodeExactContractFixture => {
  const fixture = record(value, "fixture");
  exactKeys(fixture, [
    "authority", "boundedObservation", "capabilityDisposition", "claim", "deferredProductionWork",
    "derivedCapabilityProjection", "name", "neutralContract", "pin", "provenance", "schemaVersion", "scope",
  ], "fixture_fields");
  if (fixture.schemaVersion !== 2) {fail("schema_version");}
  exactString(fixture.name, "opencode-1-18-5-contract-characterization", "name");
  exactString(fixture.claim, "contract_only_no_production_adapter", "claim");

  const pin = record(fixture.pin, "pin");
  exactKeys(pin, ["binarySha256", "binaryVersion", "package", "packageVersion", "providerRevision"], "pin_fields");
  exactString(pin.package, "opencode-ai", "package");
  exactString(pin.packageVersion, OPENCODE_EXACT_PACKAGE_VERSION, "package_version");
  exactString(pin.binaryVersion, OPENCODE_EXACT_PACKAGE_VERSION, "binary_version");
  exactDigest(pin.binarySha256, OPENCODE_EXACT_BINARY_SHA256, "binary_sha256");
  exactString(pin.providerRevision, OPENCODE_EXACT_PROVIDER_REVISION, "provider_revision");

  const provenance = record(fixture.provenance, "provenance");
  exactKeys(provenance, ["fieldSources", "kind", "rawAcpTranscriptRetained", "sources"], "provenance_fields");
  exactString(provenance.kind, "derived_from_checked_in_immutable_redacted_evidence", "provenance_kind");
  exactFalse(provenance.rawAcpTranscriptRetained, "provenance_raw_transcript");
  if (!Array.isArray(provenance.sources) || provenance.sources.length !== EXPECTED_SOURCES.length) {
    return fail("provenance_sources");
  }
  const sources = provenance.sources.map((value, index) => {
    const source = record(value, "provenance_source");
    exactKeys(source, ["path", "role", "sha256"], "provenance_source_fields");
    const expected = EXPECTED_SOURCES[index] ?? fail("provenance_sources");
    return Object.freeze({
      path: exactString(source.path, expected.path, "provenance_path"),
      role: exactString(source.role, expected.role, "provenance_role"),
      sha256: exactDigest(source.sha256, expected.sha256, "provenance_digest"),
    });
  });
  if (!Array.isArray(provenance.fieldSources) || provenance.fieldSources.length !== EXPECTED_FIELD_SOURCES.length) {
    return fail("field_sources");
  }
  const fieldSources = provenance.fieldSources.map(parseSourcePointer);
  for (const [index, expected] of EXPECTED_FIELD_SOURCES.entries()) {
    const actual = fieldSources[index] ?? fail("field_sources");
    if (actual.field !== expected.field || actual.jsonPointer !== expected.jsonPointer || actual.sourcePath !== expected.sourcePath) {
      fail("field_sources");
    }
  }

  const authority = record(fixture.authority, "authority");
  exactKeys(authority, ["acpFramingAndCorrelationOwner", "customJsonRpcIds", "customNdjsonTransport", "secondAcpWire"], "authority_fields");
  exactString(authority.acpFramingAndCorrelationOwner, "@agentclientprotocol/sdk@1.3.0", "acp_owner");
  exactFalse(authority.customJsonRpcIds, "acp_authority");
  exactFalse(authority.customNdjsonTransport, "acp_authority");
  exactFalse(authority.secondAcpWire, "acp_authority");

  const scope = record(fixture.scope, "scope");
  exactKeys(scope, ["credentials", "liveProvider", "network", "productionAdapter"], "scope_fields");
  exactFalse(scope.credentials, "scope");
  exactFalse(scope.liveProvider, "scope");
  exactFalse(scope.network, "scope");
  exactFalse(scope.productionAdapter, "scope");

  const projection = record(fixture.derivedCapabilityProjection, "derived_capability_projection");
  exactKeys(projection, ["protocolVersion", "providerName", "providerVersion", "session"], "derived_capability_projection_fields");
  if (projection.protocolVersion !== 1) {fail("protocol_version");}
  exactString(projection.providerName, "OpenCode", "provider_name");
  exactString(projection.providerVersion, OPENCODE_EXACT_PACKAGE_VERSION, "provider_version");
  const session = record(projection.session, "derived_session_projection");
  exactKeys(session, ["cancel", "close", "list", "prompt", "resume"], "derived_session_projection_fields");
  exactString(session.cancel, "deferred_timing_ambiguity", "session_cancel");
  exactString(session.close, "observed", "session_close");
  exactString(session.list, "observed", "session_list");
  exactString(session.prompt, "observed", "session_prompt");
  exactString(session.resume, "observed", "session_resume");

  const neutral = record(fixture.neutralContract, "neutral_contract");
  exactKeys(neutral, ["manifestProviderRevision", "manifestRevision", "source", "sourceSha256", "supportedModes", "unknownCapabilityPolicy"], "neutral_contract_fields");
  exactString(neutral.source, SOURCE.projection.path, "neutral_contract_source");
  exactDigest(neutral.sourceSha256, SOURCE.projection.sha256, "neutral_contract_digest");
  exactString(neutral.manifestRevision, OPENCODE_EXACT_MANIFEST_REVISION, "manifest_revision");
  exactString(neutral.manifestProviderRevision, OPENCODE_EXACT_MANIFEST_PROVIDER_REVISION, "manifest_provider_revision");
  if (!Array.isArray(neutral.supportedModes) || neutral.supportedModes.length !== 1 || neutral.supportedModes[0] !== "analysis") {
    fail("neutral_supported_modes");
  }
  exactString(neutral.unknownCapabilityPolicy, "fail_closed", "neutral_unknown_policy");

  if (!Array.isArray(fixture.capabilityDisposition) || fixture.capabilityDisposition.length !== EXPECTED_CAPABILITIES.length) {
    return fail("capability_disposition");
  }
  const capabilityDisposition = fixture.capabilityDisposition.map((value, index) => {
    const capability = record(value, "capability_disposition_entry");
    exactKeys(capability, ["capability", "evidence", "status"], "capability_disposition_entry_fields");
    const expected = EXPECTED_CAPABILITIES[index] ?? fail("capability_disposition");
    return Object.freeze({
      capability: exactString(capability.capability, expected.capability, "capability_disposition"),
      evidence: exactString(capability.evidence, expected.evidence, "capability_disposition"),
      status: exactString(capability.status, expected.status, "capability_disposition") as OpenCodeContractCapabilityDisposition,
    });
  });

  if (!Array.isArray(fixture.deferredProductionWork) || fixture.deferredProductionWork.length !== EXPECTED_DEFERRED.length) {
    return fail("deferred_production_work");
  }
  const deferredProductionWork = fixture.deferredProductionWork.map((value, index) =>
    exactString(value, EXPECTED_DEFERRED[index] ?? fail("deferred_production_work"), "deferred_production_work"));

  const bounded = record(fixture.boundedObservation, "bounded_observation");
  exactKeys(bounded, ["retainedRawData", "stopReason", "terminal"], "bounded_observation_fields");
  exactString(bounded.terminal, "succeeded", "terminal");
  exactString(bounded.stopReason, "end_turn", "stop_reason");
  exactFalse(bounded.retainedRawData, "raw_data");

  return Object.freeze({
    authority: Object.freeze({
      acpFramingAndCorrelationOwner: "@agentclientprotocol/sdk@1.3.0",
      customJsonRpcIds: false, customNdjsonTransport: false, secondAcpWire: false,
    }),
    boundedObservation: Object.freeze({ retainedRawData: false, stopReason: "end_turn", terminal: "succeeded" }),
    capabilityDisposition: Object.freeze(capabilityDisposition),
    claim: "contract_only_no_production_adapter",
    deferredProductionWork: Object.freeze(deferredProductionWork),
    derivedCapabilityProjection: Object.freeze({
      protocolVersion: 1, providerName: "OpenCode", providerVersion: OPENCODE_EXACT_PACKAGE_VERSION,
      session: Object.freeze({ cancel: "deferred_timing_ambiguity", close: "observed", list: "observed", prompt: "observed", resume: "observed" }),
    }),
    name: "opencode-1-18-5-contract-characterization",
    neutralContract: Object.freeze({
      manifestProviderRevision: OPENCODE_EXACT_MANIFEST_PROVIDER_REVISION,
      manifestRevision: OPENCODE_EXACT_MANIFEST_REVISION,
      source: SOURCE.projection.path,
      sourceSha256: SOURCE.projection.sha256,
      supportedModes: Object.freeze(["analysis"] as const),
      unknownCapabilityPolicy: "fail_closed",
    }),
    pin: Object.freeze({
      binarySha256: OPENCODE_EXACT_BINARY_SHA256, binaryVersion: OPENCODE_EXACT_PACKAGE_VERSION,
      package: "opencode-ai", packageVersion: OPENCODE_EXACT_PACKAGE_VERSION,
      providerRevision: OPENCODE_EXACT_PROVIDER_REVISION,
    }),
    provenance: Object.freeze({
      fieldSources: Object.freeze(fieldSources), kind: "derived_from_checked_in_immutable_redacted_evidence",
      rawAcpTranscriptRetained: false, sources: Object.freeze(sources),
    }),
    schemaVersion: 2,
    scope: Object.freeze({ credentials: false, liveProvider: false, network: false, productionAdapter: false }),
  });
};

/**
 * Parses only bounded UTF-8 JSON bytes and authenticates every fixed source path in trusted code.
 * It is a contract-characterization loader, not an ACP wire parser or provider adapter.
 */
export const parseOpenCodeExactContractFixture = async (
  bytes: Uint8Array,
): Promise<OpenCodeExactContractFixture> => {
  const value = parseBoundedJson(bytes);
  await authenticateSources();
  return parseFixture(value);
};

export interface OpenCodeExactContractCharacterization {
  readonly claim: "contract_only_no_production_adapter";
  readonly kernelReplayClaimed: false;
  readonly provider: "opencode";
  readonly providerRevision: typeof OPENCODE_EXACT_PROVIDER_REVISION;
  readonly supportedModes: readonly ["analysis"];
  readonly terminalObservation: "succeeded";
  readonly unknownCapabilityPolicy: "fail_closed";
}

/** A detached summary only. The separate synthetic kernel test retains its declared OpenCode identity gap. */
export const characterizeOpenCodeExactContract = (
  fixture: OpenCodeExactContractFixture,
): OpenCodeExactContractCharacterization => Object.freeze({
  claim: fixture.claim,
  kernelReplayClaimed: false,
  provider: "opencode",
  providerRevision: fixture.pin.providerRevision,
  supportedModes: Object.freeze(["analysis"] as const),
  terminalObservation: fixture.boundedObservation.terminal,
  unknownCapabilityPolicy: fixture.neutralContract.unknownCapabilityPolicy,
});
