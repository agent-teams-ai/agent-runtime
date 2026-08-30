import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { observeOpenCodeCapabilities } from "../src/features/acp-compatibility/opencode-acp-validation.ts";
import { createContainedTurnEngine } from "../../../packages/contexts/agent-execution/src/features/contained-agent-turn/application/contained-turn-engine.ts";
import type {
  AcceptContainedTurnCommandInput,
  ContainedTurnArtifactPort,
  ContainedTurnOperationStore,
  ContainedTurnProviderExecutionOutcome,
  ContainedTurnProviderPort,
  ContainedTurnSecurityPort,
  ContainedTurnWorkspacePort,
  ProviderProcessCustodyPort,
} from "../../../packages/contexts/agent-execution/src/features/contained-agent-turn/application/ports/outbound/contained-turn-ports.ts";
import {
  applyContainedTurnMutation,
  createAcceptedContainedTurnOperation,
  type ContainedTurnOperation,
} from "../../../packages/contexts/agent-execution/src/features/contained-agent-turn/domain/contained-turn-operation.ts";

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
    | "proposed_deferred_distinct_terminal_reason";
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
      readonly currentNeutralOutcome: "ambiguous_with_opaque_bounded_evidence_ref";
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
    readonly ambiguousEvidenceRef: "sha256_digest_only";
    readonly maxIdentifierCharacters: number;
    readonly maxRetainedTextBytes: number;
    readonly rawFieldsNeverRetained: readonly string[];
  };
  readonly evidenceKind: "synthetic_acp_characterization_with_independent_kernel_contract_checks_not_opencode_conformance";
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

type NeutralExecutionOutcome = ContainedTurnProviderExecutionOutcome;

type RawSemanticObservation = SemanticObservation & {
  readonly providerOutput: string;
  readonly sessionId: string;
  readonly toolCallId: string;
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
const portContractPath = join(
  repositoryRoot,
  "packages/contexts/agent-execution/src/features/contained-agent-turn/application/ports/outbound/contained-turn-ports.ts",
);
const providerContractPath = join(
  repositoryRoot,
  "packages/contexts/agent-execution/src/features/contained-agent-turn/contracts/contained-agent-turn.ts",
);
const fixtureDigest = "ae00b9b6dc96f5a2ee37b40b1f13968a8b847517973382f5756ebe1cf0fa7c6c";

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

const reference = (kind: string, caseId: string): string =>
  `urn:agent-runtime:${kind}:${digest(`${caseId}:${kind}`)}`;

const completed = (
  caseId: string,
  outcome: "cancelled" | "failed" | "succeeded",
): NeutralExecutionOutcome => ({
  acceptanceReceiptRef: reference("opencode-provider-accepted", caseId),
  effectDisposition: "committed",
  effectReceiptRef: reference("opencode-effect-resolved", caseId),
  executionReceiptRef: reference("opencode-execution-closed", caseId),
  kind: "completed",
  outcome,
  outputDrainReceiptRef: reference("opencode-output-drained", caseId),
});

const notAccepted = (caseId: string): NeutralExecutionOutcome => ({
  effectReceiptRef: reference("opencode-effect-not-committed", caseId),
  executionReceiptRef: reference("opencode-execution-not-started", caseId),
  kind: "not_accepted",
  outputDrainReceiptRef: reference("opencode-output-not-started", caseId),
  providerReceiptRef: reference("opencode-provider-not-accepted", caseId),
});

const ambiguous = (caseId: string): NeutralExecutionOutcome => ({
  evidenceRef: reference("opencode-provider-ambiguous", caseId),
  kind: "ambiguous",
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

class SyntheticAcpOutcomeProjection {
  readonly #caseId: string;
  readonly #observation: RawSemanticObservation;

  public constructor(caseId: string, observation: RawSemanticObservation) {
    this.#caseId = caseId;
    this.#observation = observation;
  }

  public async execute(
    input: Parameters<ContainedTurnProviderPort["execute"]>[0],
  ): Promise<NeutralExecutionOutcome> {
    const observation = this.#observation;
    if (observation.kind === "terminal") {
      const stopReason = await validateTerminalAgainstOfficialSdkSchema(observation.stopReason);
      if (stopReason === "end_turn") {
        await input.emit({ cursor: 0, kind: "assistant", text: "synthetic OpenCode turn completed" });
        return completed(this.#caseId, "succeeded");
      }
      if (stopReason === "cancelled") {
        return completed(this.#caseId, "cancelled");
      }
      if (stopReason === "refusal") {
        await input.emit({ cursor: 0, kind: "diagnostic", text: "synthetic ACP refusal" });
        return completed(this.#caseId, "failed");
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
      return notAccepted(this.#caseId);
    }
    if (observation.kind === "closure_timeout" && observation.providerAccepted === true) {
      throw new ProposedAcceptanceDetailContractGapError(
        "closure_timeout accepted=true cannot retain known acceptance in the neutral ambiguous outcome",
      );
    }
    return ambiguous(this.#caseId);
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

const kernelHarnessBinding = Object.freeze({
  adapterRevision: "kernel-contract-harness:test",
  binaryRevision: "synthetic-neutral-outcomes:test",
  capabilityManifestRevision: "contained-turn-v1:test",
  credentialBindingDigest: "credential:none",
  provider: "codex" as const,
  providerRouteRef: "route:none",
});

class MemoryOperationStore implements ContainedTurnOperationStore {
  readonly #byCommand = new Map<string, string>();
  readonly #operations = new Map<string, ContainedTurnOperation>();
  #sequence = 0;

  async accept(input: AcceptContainedTurnCommandInput) {
    const fingerprint = digest(JSON.stringify(input));
    const existingId = this.#byCommand.get(input.commandId);
    if (existingId !== undefined) {
      const operation = this.#operations.get(existingId);
      assert.ok(operation);
      return operation.commandFingerprint === fingerprint
        ? { kind: "replayed" as const, operation }
        : { kind: "conflict" as const };
    }
    const sequence = ++this.#sequence;
    const operation = createAcceptedContainedTurnOperation({
      acceptanceReceiptRef: `accept:${sequence}`,
      commandFingerprint: fingerprint,
      commandId: input.commandId,
      effectId: `effect:${sequence}`,
      intent: input.intent,
      operationId: `operation:${sequence}`,
      providerBinding: input.providerBinding,
      scope: input.scope,
      securityDecision: input.securityDecision,
    });
    this.#byCommand.set(input.commandId, operation.operationId);
    this.#operations.set(operation.operationId, operation);
    return { kind: "accepted" as const, operation };
  }

  async claimDispatch(input: {
    readonly cutoffReceiptRef: string;
    readonly expectedRevision: number;
    readonly operationId: string;
  }) {
    const current = this.#operations.get(input.operationId);
    if (current === undefined) {return { kind: "not_found" as const };}
    if (current.revision !== input.expectedRevision) {return { current, kind: "stale" as const };}
    const operation = applyContainedTurnMutation(current, {
      attemptId: `attempt:${current.operationId}`,
      claimRef: `claim:${current.operationId}`,
      cutoffReceiptRef: input.cutoffReceiptRef,
      kind: "dispatch_claimed",
    });
    this.#operations.set(operation.operationId, operation);
    return { kind: "claimed" as const, operation };
  }

  async compareAndSet(input: {
    readonly expectedRevision: number;
    readonly mutation: Parameters<typeof applyContainedTurnMutation>[1];
    readonly operationId: string;
  }) {
    const current = this.#operations.get(input.operationId);
    if (current === undefined) {return { kind: "not_found" as const };}
    if (current.revision !== input.expectedRevision) {return { current, kind: "stale" as const };}
    const operation = applyContainedTurnMutation(current, input.mutation);
    this.#operations.set(operation.operationId, operation);
    return { kind: "applied" as const, operation };
  }

  async preventDispatch(input: {
    readonly expectedRevision: number;
    readonly operationId: string;
    readonly proofRef: string;
  }) {
    return this.compareAndSet({
      expectedRevision: input.expectedRevision,
      mutation: { kind: "dispatch_prevented", receiptRef: input.proofRef },
      operationId: input.operationId,
    });
  }

  async read(operationId: string) {return this.#operations.get(operationId);}

  async requestCancellation(input: { readonly expectedRevision: number; readonly operationId: string }) {
    return this.compareAndSet({
      expectedRevision: input.expectedRevision,
      mutation: { kind: "cancellation_requested", requestRef: `cancel:${input.operationId}` },
      operationId: input.operationId,
    });
  }

  async terminalize(input: { readonly expectedRevision: number; readonly operationId: string }) {
    return this.compareAndSet({
      expectedRevision: input.expectedRevision,
      mutation: { kind: "terminalize", receiptRef: `terminal:${input.operationId}` },
      operationId: input.operationId,
    });
  }
}

const createKernelHarness = (outcomeCase: OutcomeCase) => {
  const store = new MemoryOperationStore();
  const providerOutcomes: ContainedTurnProviderExecutionOutcome[] = [];
  const projection = new SyntheticAcpOutcomeProjection(outcomeCase.id, {
    ...outcomeCase.sdkSemanticObservation,
    providerOutput: "raw-provider-output-canary",
    sessionId: "raw-session-canary",
    toolCallId: "raw-tool-canary",
  });
  const provider: ContainedTurnProviderPort = {
    manifest: Object.freeze({
      effectClass: "contained_unmediated_effect",
      providerBinding: kernelHarnessBinding,
      supportedModes: Object.freeze(["analysis"]),
    }),
    async execute(input) {
      const outcome = await projection.execute(input);
      providerOutcomes.push(outcome);
      return outcome;
    },
  };
  const security: ContainedTurnSecurityPort = {
    async authorize() {
      return { authorityRevision: "authority:1", decisionDigest: "decision:1", kind: "allowed" };
    },
    async revalidate() {return { kind: "allowed", proofRef: "cutoff-clear:1" };},
  };
  const workspace: ContainedTurnWorkspacePort = {
    async close(workspaceRef) {return { receiptRef: `workspace-closed:${workspaceRef}` };},
    async create(input) {return { workspaceRef: `workspace:${input.operationId}` };},
    async quarantine() {},
  };
  const artifacts: ContainedTurnArtifactPort = {
    async seal(input) {
      return {
        manifestReceiptRef: `manifest-receipt:${input.operationId}`,
        manifestRef: `manifest:${input.operationId}`,
        resultReceiptRef: `result-receipt:${input.operationId}`,
        resultRef: `result:${input.operationId}`,
      };
    },
  };
  const custody: ProviderProcessCustodyPort = {
    async open(input) {return { custodyRef: `custody:${input.attemptId}` };},
    async requestContainment(input) {
      return { kind: "contained", receiptRef: `contained:${input.attemptId}` };
    },
  };
  return {
    engine: createContainedTurnEngine({ artifacts, custody, operationStore: store, provider, security, workspace }),
    providerOutcomes,
    store,
  };
};

interface KernelExpectation {
  readonly effect: "ambiguous" | "committed" | "not_committed";
  readonly emittedKinds: readonly OutputKind[];
  readonly execution: "cancelled" | "failed" | "succeeded" | "unknown";
  readonly providerAcceptance: "accepted" | "not_accepted" | "unknown";
  readonly status: "cancelled" | "failed" | "reconcile_required" | "succeeded";
  readonly terminal: boolean;
}

const independentKernelExpectations: Readonly<Record<string, KernelExpectation>> = Object.freeze({
  "completed-cancelled": { effect: "committed", emittedKinds: [], execution: "cancelled", providerAcceptance: "accepted", status: "cancelled", terminal: true },
  "completed-failed": { effect: "committed", emittedKinds: ["diagnostic"], execution: "failed", providerAcceptance: "accepted", status: "failed", terminal: true },
  "completed-succeeded": { effect: "committed", emittedKinds: ["assistant"], execution: "succeeded", providerAcceptance: "accepted", status: "succeeded", terminal: true },
  "explicit-pre-acceptance-rejection": { effect: "not_committed", emittedKinds: [], execution: "failed", providerAcceptance: "not_accepted", status: "failed", terminal: true },
  "late-rejection-after-timeout": { effect: "ambiguous", emittedKinds: [], execution: "unknown", providerAcceptance: "unknown", status: "reconcile_required", terminal: false },
  "request-rejection-without-no-start-proof": { effect: "ambiguous", emittedKinds: [], execution: "unknown", providerAcceptance: "unknown", status: "reconcile_required", terminal: false },
  "request-timeout-after-dispatch": { effect: "ambiguous", emittedKinds: [], execution: "unknown", providerAcceptance: "unknown", status: "reconcile_required", terminal: false },
});

const expectedOutcomeKeys: Readonly<Record<NeutralExecutionOutcome["kind"], readonly string[]>> = {
  ambiguous: ["evidenceRef", "kind"],
  completed: [
    "acceptanceReceiptRef",
    "effectDisposition",
    "effectReceiptRef",
    "executionReceiptRef",
    "kind",
    "outcome",
    "outputDrainReceiptRef",
  ],
  not_accepted: [
    "effectReceiptRef",
    "executionReceiptRef",
    "kind",
    "outputDrainReceiptRef",
    "providerReceiptRef",
  ],
};

const assertBoundedReferences = (
  outcome: NeutralExecutionOutcome,
  maximumCharacters: number,
): void => {
  assert.deepEqual(Object.keys(outcome).toSorted(), [...expectedOutcomeKeys[outcome.kind]].toSorted());
  for (const [key, value] of Object.entries(outcome)) {
    if (!key.endsWith("Ref")) {continue;}
    assert.equal(typeof value, "string", key);
    assert.ok(value.length <= maximumCharacters, `${key}:${value.length}`);
    assert.match(value, /^urn:agent-runtime:[a-z-]+:[a-f0-9]{64}$/u, key);
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
    "synthetic_acp_characterization_with_independent_kernel_contract_checks_not_opencode_conformance",
  );
  assert.deepEqual(fixture.authoritySeparation, {
    acpTerminalAuthority: "@agentclientprotocol/sdk@1.3.0/schema/schema.json#/$defs/StopReason",
    fixtureRole: "acp_semantic_observations_only_no_expected_kernel_outcomes",
    kernelExpectationAuthority: [
      "docs/decisions/0010-contained-agent-turn-v1-operation-authority.md",
      "packages/contexts/agent-execution/src/features/contained-agent-turn/contracts/contained-agent-turn.ts",
      "packages/contexts/agent-execution/src/features/contained-agent-turn/domain/contained-turn-operation.ts",
    ],
    kernelHarnessProviderIdentity: "codex_contract_only_not_opencode_identity",
    kernelImplementation: "packages/contexts/agent-execution/src/features/contained-agent-turn/application/contained-turn-engine.ts",
  });
  assert.ok(fixture.outcomeCases.every(value => !("expected" in value)));
  assert.deepEqual(fixture.contractPin, {
    adapterIdentity: "opencode-acp-v1-adapter",
    provider: "opencode",
    providerRevision:
      "opencode@1.18.5#78f75775f26bf92237b27748d3b07bbd84b861536cb4ebe437fab6cf36bcac21",
    supportedModes: ["analysis"],
  });
  assert.deepEqual(fixture.evidencePolicy, {
    ambiguousEvidenceRef: "sha256_digest_only",
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
  assert.doesNotMatch(bytes.toString(), /\/var\/|\/home\/|credential|token/iu);
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
      undefined,
      `omitted disposition ${disposition}`,
    );
  }
  assert.throws(
    () => assertExactCapabilityContract([
      ...fixture.capabilityCases,
      { capability: "delete", observedStatus: "deferred", characterizationDisposition: "deferred" },
    ]),
    undefined,
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
    currentAmbiguousMembers: ["evidenceRef", "kind"],
    lostFact: "providerAccepted_true",
    observation: "closure_timeout_with_provider_accepted_true",
    required: "retain_known_provider_acceptance_independently_of_execution_ambiguity",
    status: "proposed_contract_gap_not_kernel_exercised",
  });
  assert.deepEqual(fixture.characterizationBoundary.anomalyDetail.proposedContractGaps, [
    "closure_timeout_with_provider_accepted_true_loses_acceptance",
  ]);
  assert.deepEqual(Object.keys(ambiguous(gapCase.id)).toSorted(), ["evidenceRef", "kind"]);
  const projection = new SyntheticAcpOutcomeProjection(gapCase.id, {
    ...gapCase.sdkSemanticObservation,
    providerOutput: "raw-provider-output-canary",
    sessionId: "raw-session-canary",
    toolCallId: "raw-tool-canary",
  });
  await assert.rejects(
    projection.execute({ attemptId: "attempt:gap", custody: { custodyRef: "custody:gap" },
      effectId: "effect:gap", async emit() {}, intent: { mode: "analysis", prompt: "synthetic" },
      async isCancellationRequested() {return false;}, operationId: "operation:gap",
      workspaceRef: "workspace:gap" }),
    ProposedAcceptanceDetailContractGapError,
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
      providerOutput: "raw-provider-output-canary",
      sessionId: "raw-session-canary",
      toolCallId: "raw-tool-canary",
    });
    await assert.rejects(
      projection.execute({
        attemptId: "attempt:deferred",
        custody: { custodyRef: "custody:deferred" },
        effectId: "effect:deferred",
        async emit() {},
        intent: { mode: "analysis", prompt: "synthetic" },
        async isCancellationRequested() {return false;},
        operationId: "operation:deferred",
        workspaceRef: "workspace:deferred",
      }),
      new RegExp(`^${deferredReason} has no accepted distinct neutral mapping$`, "u"),
    );
  }
});

test("drives projected neutral outcomes through the actual Contained Turn engine", async () => {
  const fixture = await loadFixture();
  const exercisedCases = fixture.outcomeCases.filter(
    value => value.evidenceClassification === "current_neutral_projection_kernel_exercised",
  );
  assert.deepEqual(
    exercisedCases.map(value => value.id).toSorted(),
    Object.keys(independentKernelExpectations).toSorted(),
  );
  const ambiguousClasses = exercisedCases
    .filter(value => independentKernelExpectations[value.id]?.status === "reconcile_required")
    .map(value => value.sdkSemanticObservation.kind === "request_rejected"
      ? "request_rejected_without_no_start_proof"
      : value.sdkSemanticObservation.kind)
    .toSorted();
  assert.deepEqual(
    ambiguousClasses,
    [...fixture.characterizationBoundary.anomalyDetail.requiredSyntheticClasses].toSorted(),
  );

  for (const outcomeCase of exercisedCases) {
    const expectation = independentKernelExpectations[outcomeCase.id];
    assert.ok(expectation, outcomeCase.id);
    const harness = createKernelHarness(outcomeCase);
    const result = await harness.engine.submit.execute({
      commandId: `command:${outcomeCase.id}`,
      expectedProvider: "codex",
      intent: { mode: "analysis", prompt: "synthetic kernel contract probe" },
      scope: { projectId: "project:synthetic", tenantId: "tenant:synthetic" },
    });
    assert.equal(result.status, "observed", outcomeCase.id);
    if (result.status !== "observed") {continue;}
    assert.equal(result.turn.status, expectation.status, outcomeCase.id);
    assert.deepEqual(result.turn.output.map(chunk => chunk.kind), expectation.emittedKinds, outcomeCase.id);
    const operation = await harness.store.read(result.turn.operationId);
    assert.ok(operation, outcomeCase.id);
    assert.equal(operation.providerAcceptance.kind, expectation.providerAcceptance, outcomeCase.id);
    assert.equal(operation.terminal.kind, expectation.terminal ? "terminal" : "nonterminal", outcomeCase.id);
    assert.equal(operation.containment.kind, "contained", outcomeCase.id);
    if (expectation.execution === "unknown") {
      assert.equal(operation.execution.kind, "unknown", outcomeCase.id);
      assert.equal(operation.effect.kind, "ambiguous", outcomeCase.id);
      assert.equal(operation.output.kind, "open", outcomeCase.id);
      assert.equal(operation.reconciliation.kind, "required", outcomeCase.id);
      assert.equal(operation.workspace.kind, "quarantined", outcomeCase.id);
    } else {
      assert.equal(operation.execution.kind, "closed", outcomeCase.id);
      if (operation.execution.kind === "closed") {
        assert.equal(operation.execution.outcome, expectation.execution, outcomeCase.id);
      }
      assert.equal(operation.effect.kind, "resolved", outcomeCase.id);
      if (operation.effect.kind === "resolved") {
        assert.equal(operation.effect.disposition, expectation.effect, outcomeCase.id);
      }
      assert.equal(operation.output.kind, "sealed", outcomeCase.id);
      assert.equal(operation.workspace.kind, "closed", outcomeCase.id);
      assert.equal(operation.receipts.length, 12, outcomeCase.id);
    }
    assert.equal(harness.providerOutcomes.length, 1, outcomeCase.id);
    const providerOutcome = harness.providerOutcomes[0];
    assert.ok(providerOutcome);
    assertBoundedReferences(providerOutcome, fixture.evidencePolicy.maxIdentifierCharacters);
    const retained = JSON.stringify({ operation, providerOutcome, turn: result.turn });
    for (const canary of ["raw-provider-output-canary", "raw-session-canary", "raw-tool-canary"]) {
      assert.ok(!retained.includes(canary), `${outcomeCase.id} retained ${canary}`);
    }
  }
});

test("records the exact provider-identity gap and capability characterization boundary", async () => {
  const fixture = await loadFixture();
  const providerContract = await readFile(providerContractPath, "utf8");
  const portContract = await readFile(portContractPath, "utf8");

  assert.match(providerContract, /export type ContainedTurnProvider = "claude" \| "codex";/u);
  assert.doesNotMatch(providerContract, /ContainedTurnProvider[^;]*"opencode"/u);
  assert.deepEqual(fixture.neutralPortGap.providerIdentity, {
    currentClosedMembers: ["claude", "codex"],
    required: "opencode",
    source: "packages/contexts/agent-execution/src/features/contained-agent-turn/contracts/contained-agent-turn.ts",
  });

  const manifestStart = portContract.indexOf("export interface ContainedTurnAdapterCapabilityManifest {");
  const manifestEnd = portContract.indexOf("\n}", manifestStart);
  assert.ok(manifestStart >= 0 && manifestEnd > manifestStart);
  const manifestBody = portContract.slice(manifestStart, manifestEnd);
  const manifestMembers = [...manifestBody.matchAll(/readonly ([A-Za-z]+):/gu)]
    .map(match => match[1])
    .toSorted();
  assert.deepEqual(manifestMembers, ["effectClass", "providerBinding", "supportedModes"]);
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
