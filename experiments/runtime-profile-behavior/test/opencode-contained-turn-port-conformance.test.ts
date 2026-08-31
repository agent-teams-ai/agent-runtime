import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { observeOpenCodeCapabilities } from "../src/features/acp-compatibility/opencode-acp-validation.ts";

type TerminalStopReason = "cancelled" | "end_turn" | "max_tokens" | "max_turn_requests" | "refusal";
type ProviderAcceptance = boolean | "unknown";
type OutputKind = "assistant" | "diagnostic" | "progress";

interface TerminalObservation {
  readonly kind: "terminal";
  readonly providerAccepted: true;
  readonly stopReason: TerminalStopReason;
}

interface RejectionObservation {
  readonly explicitNoStartProof: boolean;
  readonly kind: "request_rejected";
  readonly providerAccepted: ProviderAcceptance;
}

interface AmbiguousObservation {
  readonly kind:
    | "closure_timeout"
    | "late_request_rejected_after_timeout"
    | "request_timeout_ambiguity";
  readonly providerAccepted: ProviderAcceptance;
}

type SemanticObservation = AmbiguousObservation | RejectionObservation | TerminalObservation;

interface CapabilityCase {
  readonly capability: "close" | "fork" | "futureSessionOperation" | "list" | "prompt";
  readonly characterizationDisposition: "deferred" | "supported" | "unknown" | "unsupported";
  readonly observedStatus: "baseline" | "deferred" | "supported" | "unknown" | "unsupported";
}

interface OutcomeCase {
  readonly evidenceClassification:
    | "current_neutral_projection_kernel_exercised"
    | "proposed_acceptance_detail_contract_gap"
    | "proposed_deferred_distinct_terminal_reason"
    | "proposed_no_start_request_rejection_contract_gap";
  readonly id: string;
  readonly sdkSemanticObservation: SemanticObservation;
}

interface ConformanceFixture {
  readonly authoritySeparation: {
    readonly acpTerminalAuthority: string;
    readonly fixtureRole: "acp_semantic_observations_only_no_expected_kernel_outcomes";
    readonly kernelExpectationAuthority: readonly string[];
    readonly kernelHarnessProviderIdentity: "codex_contract_only_not_opencode_identity";
    readonly kernelImplementation: string;
  };
  readonly capabilityCases: readonly CapabilityCase[];
  readonly characterizationBoundary: {
    readonly anomalyDetail: {
      readonly currentNeutralOutcome: "indeterminate_with_opaque_bounded_evidence_id";
      readonly proposedContractGaps: readonly string[];
      readonly requiredSyntheticClasses: readonly string[];
    };
    readonly capabilityDisposition: {
      readonly currentManifestMembers: readonly string[];
      readonly required: readonly string[];
      readonly source: string;
    };
  };
  readonly conformanceStatus: "contract_gap";
  readonly contractPin: {
    readonly adapterIdentity: string;
    readonly provider: "opencode";
    readonly providerRevision: string;
    readonly supportedModes: readonly "analysis"[];
  };
  readonly evidencePolicy: {
    readonly indeterminateEvidenceId: "sha256_digest_only";
    readonly maxIdentifierCharacters: number;
    readonly maxRetainedTextBytes: number;
    readonly rawFieldsNeverRetained: readonly string[];
  };
  readonly evidenceKind: "synthetic_acp_characterization_with_current_kernel_contract_checks_not_opencode_conformance";
  readonly initializeResponse: Record<string, unknown>;
  readonly name: string;
  readonly neutralPortGap: {
    readonly acceptanceDetail: {
      readonly currentAmbiguousMembers: readonly string[];
      readonly lostFact: string;
      readonly observation: string;
      readonly required: string;
      readonly status: "proposed_contract_gap_not_kernel_exercised";
    };
    readonly requestRejection: {
      readonly currentProviderObservationKinds: readonly string[];
      readonly lostFacts: readonly string[];
      readonly observation: string;
      readonly required: string;
      readonly status: "proposed_contract_gap_not_kernel_exercised";
    };
    readonly forbiddenWorkarounds: readonly string[];
    readonly providerIdentity: {
      readonly currentClosedMembers: readonly string[];
      readonly required: "opencode";
      readonly source: string;
    };
    readonly status: "not_expressible_without_production_contract_widening";
  };
  readonly outcomeCases: readonly OutcomeCase[];
  readonly provenance: string;
  readonly scope: {
    readonly acpFramingAndCorrelationAuthority: "@agentclientprotocol/sdk@1.3.0";
    readonly liveProvider: false;
    readonly network: false;
    readonly productionAdapter: false;
    readonly providerProcess: false;
  };
}

type CurrentProviderEmit = (chunk: Readonly<{
  readonly cursor: number;
  readonly kind: OutputKind;
  readonly text: string;
}>) => Promise<void>;
type CurrentProviderObservation =
  | Readonly<{ readonly kind: "completed"; readonly outcome: "cancelled" | "failed" | "succeeded" }>
  | Readonly<{ readonly evidenceId: string; readonly kind: "indeterminate" }>;
type CurrentIndeterminateObservation = Extract<CurrentProviderObservation, { readonly kind: "indeterminate" }>;

type RawSemanticObservation = SemanticObservation & {
  readonly providerOutput: string;
  readonly sessionId: string;
  readonly toolCallId: string;
  readonly workspacePath: string;
};

const fixtureUrl = new URL(
  "../fixtures/acp-compatibility/opencode-contained-turn-port-conformance.json",
  import.meta.url,
);
const officialSdkSchemaUrl = new URL(
  "../../../node_modules/@agentclientprotocol/sdk/schema/schema.json",
  import.meta.url,
);
const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const providerContractPath = join(
  repositoryRoot,
  "packages/contexts/agent-execution/src/features/contained-agent-turn/contracts/contained-agent-turn.ts",
);
const fixtureDigest = "6ac1b5cd57e31684e8f3a83bfa5e0bf4072b976effc82006f6b15c4658ff4ef6";

const expectedCapabilityCases: readonly CapabilityCase[] = Object.freeze([
  { capability: "prompt", observedStatus: "baseline", characterizationDisposition: "supported" },
  { capability: "close", observedStatus: "supported", characterizationDisposition: "supported" },
  { capability: "fork", observedStatus: "deferred", characterizationDisposition: "deferred" },
  { capability: "futureSessionOperation", observedStatus: "unknown", characterizationDisposition: "unknown" },
  { capability: "list", observedStatus: "unsupported", characterizationDisposition: "unsupported" },
]);
const expectedCapabilityNames = expectedCapabilityCases.map(value => value.capability).toSorted();
const expectedCapabilityDispositions = ["deferred", "supported", "unknown", "unsupported"] as const;

const assertExactCapabilityContract = (actual: readonly unknown[]): void => {
  assert.deepEqual(actual, expectedCapabilityCases);
};

const loadFixture = async (): Promise<ConformanceFixture> =>
  JSON.parse(await readFile(fixtureUrl, "utf8")) as ConformanceFixture;

const digest = (value: string): string => createHash("sha256").update(value).digest("hex");

const evidenceId = (caseId: string): CurrentIndeterminateObservation["evidenceId"] =>
  `evidence:opencode-provider-indeterminate:${digest(caseId)}` as CurrentIndeterminateObservation["evidenceId"];

const MAX_PROJECTED_TEXT_BYTES = 256;
const forbiddenCredentialOrTokenMaterial =
  /credential|(?:^|[^a-z0-9_])(?:access[_-]?token|api[_-]?key|auth(?:entication|orization)?[_-]?token|bearer|password|secret|token)(?:[^a-z0-9_]|$)/iu;

const boundProjectedText = (text: string): string => {
  let projected = "";
  let projectedBytes = 0;
  for (const character of text) {
    const characterBytes = Buffer.byteLength(character);
    if (projectedBytes + characterBytes > MAX_PROJECTED_TEXT_BYTES) {break;}
    projected += character;
    projectedBytes += characterBytes;
  }
  return projected;
};

const assertNoCredentialOrTokenMaterial = (text: string): void => {
  assert.doesNotMatch(text, forbiddenCredentialOrTokenMaterial);
};

const completed = (
  outcome: "cancelled" | "failed" | "succeeded",
): CurrentProviderObservation => ({ kind: "completed", outcome });

const indeterminate = (caseId: string): CurrentProviderObservation => ({
  evidenceId: evidenceId(caseId),
  kind: "indeterminate",
});

const validateTerminalAgainstOfficialSdkSchema = async (
  stopReason: TerminalStopReason,
): Promise<TerminalStopReason> => {
  const schema = JSON.parse(await readFile(officialSdkSchemaUrl, "utf8")) as {
    readonly $defs?: {
      readonly StopReason?: {
        readonly oneOf?: readonly { readonly const?: unknown }[];
      };
    };
  };
  const officialReasons = schema.$defs?.StopReason?.oneOf
    ?.map(value => value.const)
    .filter((value): value is string => typeof value === "string") ?? [];
  assert.deepEqual(officialReasons.toSorted(), [
    "cancelled",
    "end_turn",
    "max_tokens",
    "max_turn_requests",
    "refusal",
  ]);
  assert.ok(officialReasons.includes(stopReason), stopReason);
  return stopReason;
};

class DeferredAcpTerminalReasonError extends Error {}
class ProposedAcceptanceDetailContractGapError extends Error {}
class ProposedNoStartRequestRejectionContractGapError extends Error {}

const assertRejectsWithExactMessage = async (
  promise: Promise<unknown>,
  expectedMessage: string,
): Promise<void> => {
  await assert.rejects(promise, error => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, expectedMessage);
    return true;
  });
};

class SyntheticAcpOutcomeProjection {
  readonly #caseId: string;
  readonly #observation: RawSemanticObservation;

  public constructor(caseId: string, observation: RawSemanticObservation) {
    this.#caseId = caseId;
    this.#observation = observation;
  }

  public async execute(
    emit: CurrentProviderEmit,
  ): Promise<CurrentProviderObservation> {
    const observation = this.#observation;
    if (observation.kind === "terminal") {
      const stopReason = await validateTerminalAgainstOfficialSdkSchema(observation.stopReason);
      if (stopReason === "end_turn") {
        const text = boundProjectedText(`synthetic OpenCode turn completed|${"x".repeat(300)}`);
        assertNoCredentialOrTokenMaterial(text);
        await emit({ cursor: 0, kind: "assistant", text });
        return completed("succeeded");
      }
      if (stopReason === "cancelled") {
        return completed("cancelled");
      }
      if (stopReason === "refusal") {
        const text = boundProjectedText("synthetic ACP refusal");
        assertNoCredentialOrTokenMaterial(text);
        await emit({ cursor: 0, kind: "diagnostic", text });
        return completed("failed");
      }
      if (stopReason === "max_tokens") {
        throw new DeferredAcpTerminalReasonError("max_tokens has no accepted distinct neutral mapping");
      }
      throw new DeferredAcpTerminalReasonError(
        "max_turn_requests has no accepted distinct neutral mapping",
      );
    }
    if (
      observation.kind === "request_rejected" &&
      observation.explicitNoStartProof &&
      observation.providerAccepted === false
    ) {
      throw new ProposedNoStartRequestRejectionContractGapError(
        "request_rejected accepted=false with proved no-start has no accepted neutral provider observation",
      );
    }
    if (observation.kind === "closure_timeout" && observation.providerAccepted === true) {
      throw new ProposedAcceptanceDetailContractGapError(
        "closure_timeout accepted=true cannot retain known acceptance in the neutral ambiguous outcome",
      );
    }
    return indeterminate(this.#caseId);
  }
}

const observedCapabilityStatus = (
  observation: ReturnType<typeof observeOpenCodeCapabilities>,
  capability: CapabilityCase["capability"],
): CapabilityCase["observedStatus"] => {
  switch (capability) {
    case "prompt":
      return observation.session.prompt;
    case "close":
      return observation.session.close;
    case "fork":
      return observation.session.fork;
    case "list":
      return observation.session.list;
    case "futureSessionOperation":
      return observation.unknown.includes("sessionCapabilities/futureSessionOperation")
        ? "unknown"
        : "unsupported";
  }
};

test("pins a fully synthetic, no-launch OpenCode semantic fixture", async () => {
  const bytes = await readFile(fixtureUrl);
  const fixture = JSON.parse(bytes.toString()) as ConformanceFixture;
  const sdkPackage = JSON.parse(
    await readFile(new URL("../../../node_modules/@agentclientprotocol/sdk/package.json", import.meta.url), "utf8"),
  ) as { readonly version?: unknown };
  assert.equal(createHash("sha256").update(bytes).digest("hex"), fixtureDigest);
  assert.equal(sdkPackage.version, "1.3.0");
  assert.match(fixture.provenance, /fully_synthetic/u);
  assert.equal(fixture.conformanceStatus, "contract_gap");
  assert.equal(
    fixture.evidenceKind,
    "synthetic_acp_characterization_with_current_kernel_contract_checks_not_opencode_conformance",
  );
  assert.deepEqual(fixture.authoritySeparation, {
    acpTerminalAuthority: "@agentclientprotocol/sdk@1.3.0/schema/schema.json#/$defs/StopReason",
    fixtureRole: "acp_semantic_observations_only_no_expected_kernel_outcomes",
    kernelExpectationAuthority: [
      "docs/decisions/0010-contained-agent-turn-v1-operation-authority.md",
      "packages/contexts/agent-execution/src/features/contained-agent-turn/application/ports/outbound/contained-turn-ports.ts",
      "packages/contexts/agent-execution/src/features/contained-agent-turn/domain/contained-turn-authority.ts",
      "packages/contexts/agent-execution/src/features/contained-agent-turn/domain/contained-turn-kernel-model.ts",
    ],
    kernelHarnessProviderIdentity: "codex_contract_only_not_opencode_identity",
    kernelImplementation: "packages/contexts/agent-execution/src/features/contained-agent-turn/composition/feature-module-factory.ts",
  });
  assert.ok(fixture.outcomeCases.every(value => !("expected" in value)));
  assert.deepEqual(fixture.contractPin, {
    adapterIdentity: "synthetic-opencode-acp-v1-projection",
    provider: "opencode",
    providerRevision:
      "opencode@1.18.5#78f75775f26bf92237b27748d3b07bbd84b861536cb4ebe437fab6cf36bcac21",
    supportedModes: ["analysis"],
  });
  assert.deepEqual(fixture.evidencePolicy, {
    indeterminateEvidenceId: "sha256_digest_only",
    maxIdentifierCharacters: 128,
    maxRetainedTextBytes: 256,
    rawFieldsNeverRetained: ["workspace", "session", "tool", "provider_output"],
  });
  assert.deepEqual(fixture.scope, {
    acpFramingAndCorrelationAuthority: "@agentclientprotocol/sdk@1.3.0",
    liveProvider: false,
    network: false,
    productionAdapter: false,
    providerProcess: false,
  });
  assert.doesNotMatch(bytes.toString(), /\/var\/|\/home\//u);
  assertNoCredentialOrTokenMaterial(bytes.toString());
  for (const sensitiveText of [
    "credential=[redacted]",
    "token=[redacted:token-field]",
    "access_token=[redacted]",
    "api-key=[redacted]",
    "Bearer [redacted]",
    "password=[redacted]",
    "secret=[redacted]",
  ]) {
    assert.throws(() => assertNoCredentialOrTokenMaterial(sensitiveText), sensitiveText);
  }
  assert.doesNotThrow(() => assertNoCredentialOrTokenMaterial("max_tokens is an ACP stop reason"));
});

test("preserves supported, deferred, unknown, and unsupported capability observations", async () => {
  const fixture = await loadFixture();
  const observation = observeOpenCodeCapabilities(fixture.initializeResponse);
  assert.deepEqual(fixture.capabilityCases.map(value => value.capability).toSorted(), expectedCapabilityNames);
  assertExactCapabilityContract(fixture.capabilityCases);
  assert.deepEqual(
    [...fixture.characterizationBoundary.capabilityDisposition.required].toSorted(),
    [...expectedCapabilityDispositions],
  );
  for (const capabilityCase of fixture.capabilityCases) {
    const status = observedCapabilityStatus(observation, capabilityCase.capability);
    assert.equal(status, capabilityCase.observedStatus, capabilityCase.capability);
    assert.equal(
      status === "baseline" ? "supported" : status,
      capabilityCase.characterizationDisposition,
      capabilityCase.capability,
    );
  }
  for (const disposition of expectedCapabilityDispositions) {
    assert.throws(
      () => assertExactCapabilityContract(
        fixture.capabilityCases.filter(value => value.characterizationDisposition !== disposition),
      ),
      `omitted disposition ${disposition}`,
    );
  }
  assert.throws(
    () => assertExactCapabilityContract([
      ...fixture.capabilityCases,
      { capability: "delete", observedStatus: "deferred", characterizationDisposition: "deferred" },
    ]),
    "invented capability",
  );
});

test("labels known acceptance lost by the ambiguous outcome as a proposed contract gap", async () => {
  const fixture = await loadFixture();
  const gapCase = fixture.outcomeCases.find(value => value.id === "sdk-closure-timeout");
  assert.ok(gapCase);
  assert.deepEqual(gapCase, {
    id: "sdk-closure-timeout",
    evidenceClassification: "proposed_acceptance_detail_contract_gap",
    sdkSemanticObservation: { kind: "closure_timeout", providerAccepted: true },
  });
  assert.deepEqual(fixture.neutralPortGap.acceptanceDetail, {
    currentAmbiguousMembers: ["evidenceId", "kind"],
    lostFact: "providerAccepted_true",
    observation: "closure_timeout_with_provider_accepted_true",
    required: "retain_known_provider_acceptance_independently_of_execution_ambiguity",
    status: "proposed_contract_gap_not_kernel_exercised",
  });
  assert.deepEqual(fixture.characterizationBoundary.anomalyDetail.proposedContractGaps, [
    "closure_timeout_with_provider_accepted_true_loses_acceptance",
    "request_rejected_with_proved_no_start_is_not_a_provider_access_prevention",
  ]);
  assert.deepEqual(Object.keys(indeterminate(gapCase.id)).toSorted(), ["evidenceId", "kind"]);
  const projection = new SyntheticAcpOutcomeProjection(gapCase.id, {
    ...gapCase.sdkSemanticObservation,
    providerOutput: "raw-provider-output-canary credential=raw-credential-canary token=raw-token-canary",
    sessionId: "raw-session-canary",
    toolCallId: "raw-tool-canary",
    workspacePath: "/synthetic/raw-workspace-canary",
  });
  await assert.rejects(
    projection.execute(async () => {}),
    ProposedAcceptanceDetailContractGapError,
  );
});

test("labels proved ACP request no-start as a proposed gap, never Provider Access prevention", async () => {
  const fixture = await loadFixture();
  const gapCase = fixture.outcomeCases.find(value => value.id === "explicit-pre-acceptance-rejection");
  assert.ok(gapCase);
  assert.deepEqual(gapCase, {
    evidenceClassification: "proposed_no_start_request_rejection_contract_gap",
    id: "explicit-pre-acceptance-rejection",
    sdkSemanticObservation: {
      explicitNoStartProof: true,
      kind: "request_rejected",
      providerAccepted: false,
    },
  });
  assert.deepEqual(fixture.neutralPortGap.requestRejection, {
    currentProviderObservationKinds: ["completed", "indeterminate"],
    lostFacts: ["providerAccepted_false", "proved_no_start"],
    observation: "request_rejected_with_provider_accepted_false_and_proved_no_start",
    required: "neutral_provider_observation_for_proved_request_no_start",
    status: "proposed_contract_gap_not_kernel_exercised",
  });
  const projection = new SyntheticAcpOutcomeProjection(gapCase.id, {
    ...gapCase.sdkSemanticObservation,
    providerOutput: "raw-provider-output-canary credential=raw-credential-canary token=raw-token-canary",
    sessionId: "raw-session-canary",
    toolCallId: "raw-tool-canary",
    workspacePath: "/synthetic/raw-workspace-canary",
  });
  await assertRejectsWithExactMessage(
    projection.execute(async () => {}),
    "request_rejected accepted=false with proved no-start has no accepted neutral provider observation",
  );
});

test("classifies every official ACP terminal reason without a refusal fallback", async () => {
  const fixture = await loadFixture();
  const terminalCases = fixture.outcomeCases.filter(
    (value): value is OutcomeCase & { readonly sdkSemanticObservation: TerminalObservation } =>
      value.sdkSemanticObservation.kind === "terminal",
  );
  assert.deepEqual(
    terminalCases.map(value => value.sdkSemanticObservation.stopReason).toSorted(),
    ["cancelled", "end_turn", "max_tokens", "max_turn_requests", "refusal"],
  );
  assert.deepEqual(
    Object.fromEntries(terminalCases.map(value => [
      value.sdkSemanticObservation.stopReason,
      value.evidenceClassification,
    ])),
    {
      cancelled: "current_neutral_projection_kernel_exercised",
      end_turn: "current_neutral_projection_kernel_exercised",
      max_tokens: "proposed_deferred_distinct_terminal_reason",
      max_turn_requests: "proposed_deferred_distinct_terminal_reason",
      refusal: "current_neutral_projection_kernel_exercised",
    },
  );
  for (const deferredReason of ["max_tokens", "max_turn_requests"] as const) {
    const outcomeCase = terminalCases.find(
      value => value.sdkSemanticObservation.stopReason === deferredReason,
    );
    assert.ok(outcomeCase);
    const projection = new SyntheticAcpOutcomeProjection(outcomeCase.id, {
      ...outcomeCase.sdkSemanticObservation,
      providerOutput: "raw-provider-output-canary credential=raw-credential-canary token=raw-token-canary",
      sessionId: "raw-session-canary",
      toolCallId: "raw-tool-canary",
      workspacePath: "/synthetic/raw-workspace-canary",
    });
    await assertRejectsWithExactMessage(
      projection.execute(async () => {}),
      `${deferredReason} has no accepted distinct neutral mapping`,
    );
  }
});

test("enforces the exact 256-byte projected text boundary without splitting code points", () => {
  const exact = boundProjectedText("x".repeat(MAX_PROJECTED_TEXT_BYTES + 1));
  assert.equal(Buffer.byteLength(exact), 256);
  assert.equal(exact, "x".repeat(256));
  const unicode = boundProjectedText(`${"x".repeat(255)}é`);
  assert.equal(Buffer.byteLength(unicode), 255);
  assert.equal(unicode, "x".repeat(255));
});

test("records the exact provider-identity gap and capability characterization boundary", async () => {
  const fixture = await loadFixture();
  const providerContract = await readFile(providerContractPath, "utf8");

  assert.match(providerContract, /export type ContainedTurnProvider = "claude" \| "codex";/u);
  assert.doesNotMatch(providerContract, /ContainedTurnProvider[^;]*"opencode"/u);
  assert.deepEqual(fixture.neutralPortGap.providerIdentity, {
    currentClosedMembers: ["claude", "codex"],
    required: "opencode",
    source: "packages/contexts/agent-execution/src/features/contained-agent-turn/contracts/contained-agent-turn.ts",
  });

  const manifestMembers = [
    "effectCardinality",
    "effectClass",
    "manifestRevision",
    "manifestVersion",
    "provider",
    "providerAttemptCardinality",
    "requiredProofKinds",
    "resourceScopeRevision",
    "supportedModes",
    "unknownCapabilityPolicy",
  ];
  assert.deepEqual(manifestMembers, [
    "effectCardinality",
    "effectClass",
    "manifestRevision",
    "manifestVersion",
    "provider",
    "providerAttemptCardinality",
    "requiredProofKinds",
    "resourceScopeRevision",
    "supportedModes",
    "unknownCapabilityPolicy",
  ]);
  assert.deepEqual(
    [...fixture.characterizationBoundary.capabilityDisposition.currentManifestMembers].toSorted(),
    manifestMembers,
  );
  assert.equal(fixture.neutralPortGap.status, "not_expressible_without_production_contract_widening");
  assert.deepEqual(fixture.neutralPortGap.forbiddenWorkarounds, [
    "cast_opencode_to_existing_provider",
    "mislabel_opencode_as_claude_or_codex",
    "widen_production_api_from_characterization",
  ]);
});
