import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type {
  Case,
  Catalog,
  ContainedTurnV1Contract,
  ContainedTurnV1Disposition,
  NegativeGuardExample,
  V1Disposition,
} from "../../../fixtures/proof-artifacts/runtime-operation-oracle/runtime-operation-oracle-types.generated.ts";

import {
  generatedStateIsValid,
  stateAt,
  stateProductSize,
  type GeneratedState,
  type StateProductAxes,
} from "./runtime-operation-state-product.ts";

const fail = (message: string): never => {
  throw new Error(`contained-turn V1 authority: ${message}`);
};

const exact = (actual: unknown, expected: unknown, label: string): void => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`${label} differs: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
};

const dispositionCounts = (
  values: readonly V1Disposition[],
): { required: number; deferred: number; notApplicable: number } => ({
  required: values.filter((value) => value === "required").length,
  deferred: values.filter((value) => value === "deferred").length,
  notApplicable: values.filter((value) => value === "not_applicable").length,
});

const expectedRequirementDispositions: readonly V1Disposition[] = [
  "required", "required", "required", "required", "deferred", "required", "required",
  "required", "required", "deferred", "required", "required", "required", "not_applicable",
  "required", "required", "required", "required", "required", "required", "required",
  "required", "required", "deferred", "deferred", "required", "required", "deferred",
];

const exampleOverrides = new Map<string, V1Disposition>([
  ["operation-with-zero-effects", "not_applicable"],
  ["operation-with-multiple-mediated-effects", "not_applicable"],
  ["missing-child-satisfaction", "not_applicable"],
  ["missing-transcript-satisfaction", "not_applicable"],
  ["allow-dispatch-not-accepted-to-fresh-claim", "not_applicable"],
  ["allow-execution-reset-with-proof", "not_applicable"],
]);

const dispositionForState = (state: GeneratedState): V1Disposition => {
  if (state.effectResolution === "none") {
    return "not_applicable";
  }
  if (state.effectResolution === "indeterminate" || state.terminal === "outcome_indeterminate") {
    return "deferred";
  }
  return "required";
};

const stateDispositionCounts = (axes: StateProductAxes): ContainedTurnV1Disposition["expected"]["states"] => {
  const counts = {
    required: { total: 0, valid: 0, invalid: 0 },
    deferred: { total: 0, valid: 0, invalid: 0 },
    notApplicable: { total: 0, valid: 0, invalid: 0 },
  };
  for (let index = 0; index < stateProductSize(axes); index += 1) {
    const state = stateAt(axes, index);
    const disposition = dispositionForState(state);
    const bucket = disposition === "not_applicable" ? counts.notApplicable : counts[disposition];
    bucket.total += 1;
    if (generatedStateIsValid(state)) {
      bucket.valid += 1;
    } else {
      bucket.invalid += 1;
    }
  }
  return counts;
};

export const evaluatePreMaterializationGuard = (
  facts: readonly string[],
): NegativeGuardExample["expected"] => {
  const has = (fact: string): boolean => facts.includes(fact);
  if (has("guard_command_digest_mismatch") || has("guard_scope_mismatch")) {
    return "reject_guard_authority_mismatch";
  }
  if (has("matching_guard_persisted") && has("delayed_command_received") && !has("command_accepted")) {
    return "reject_before_operation";
  }
  if (has("dispatch_claim_committed") && has("matching_guard_persisted")) {
    return "post_dispatch_reconcile_required";
  }
  if (has("provider_not_found") || has("provider_history_absent")) {
    return "insufficient_negative_acceptance_evidence";
  }
  if (has("command_accepted") && has("matching_guard_persisted") && has("pre_dispatch_guard_checked")) {
    return "fence_before_dispatch";
  }
  return fail(`negative guard facts have no decision: ${facts.join(", ")}`);
};

const validateDisposition = (
  disposition: ContainedTurnV1Disposition,
  cases: readonly Case[],
  catalog: Catalog,
): void => {
  const requirements = cases.map(({ requirement, id }) => ({ requirement, caseId: id }));
  exact(
    disposition.requirements.map(({ requirement, caseId }) => ({ requirement, caseId })),
    requirements,
    "requirement disposition membership and order",
  );
  exact(
    disposition.requirements.map(({ disposition: value }) => value),
    expectedRequirementDispositions,
    "requirement V1 dispositions",
  );

  const examples = cases.flatMap((oracleCase) => oracleCase.examples.map(({ id }) => ({
    requirement: oracleCase.requirement,
    exampleId: id,
  })));
  exact(
    disposition.examples.map(({ requirement, exampleId }) => ({ requirement, exampleId })),
    examples,
    "example disposition membership and order",
  );
  const expectedExamples = cases.flatMap((oracleCase) => oracleCase.examples.map(({ id }) =>
    exampleOverrides.get(id) ?? expectedRequirementDispositions[oracleCase.requirement - 1] ??
      fail(`requirement ${oracleCase.requirement} has no V1 disposition`),
  ));
  exact(
    disposition.examples.map(({ disposition: value }) => value),
    expectedExamples,
    "example V1 dispositions",
  );
  exact(
    disposition.stateCategories.map(({ precedence, predicate, disposition: value }) => ({
      precedence,
      predicate,
      disposition: value,
    })),
    [
      { precedence: 1, predicate: "effect_resolution_none", disposition: "not_applicable" },
      {
        precedence: 2,
        predicate: "effect_resolution_indeterminate_or_terminal_outcome_indeterminate",
        disposition: "deferred",
      },
      { precedence: 3, predicate: "remaining_state_product", disposition: "required" },
    ],
    "state-category precedence",
  );
  exact(
    dispositionCounts(disposition.requirements.map(({ disposition: value }) => value)),
    disposition.expected.requirements,
    "requirement disposition counts",
  );
  exact(
    dispositionCounts(disposition.examples.map(({ disposition: value }) => value)),
    disposition.expected.examples,
    "example disposition counts",
  );
  const axes = catalog.stateProductAxes as StateProductAxes;
  exact(stateDispositionCounts(axes), disposition.expected.states, "48,000-state V1 disposition matrix");
  const totals = Object.values(disposition.expected.states)
    .reduce((sum, count) => sum + count.total, 0);
  exact(totals, disposition.expected.stateCount, "state disposition total");
};

const expectedReceipts = [
  "command_acceptance",
  "dispatch_claim_or_proved_no_dispatch",
  "provider_execution_closure_or_proved_no_start",
  "provider_terminal_observation_or_proved_no_start",
  "output_drain_and_fence_closure",
  "host_custody",
  "workspace_closure",
  "artifact_manifest_seal",
  "coarse_effect_resolution_or_reconciliation_debt",
  "containment_execution",
  "canonical_result_publication",
  "cutoff_enforcement_when_applicable",
] as const;

const expectedContainmentBindings = [
  "operation_id",
  "effect_id",
  "attempt_id_when_dispatched",
  "immutable_scope_digest",
  "provider_binary_revision",
  "adapter_capability_manifest_revision",
  "containment_policy_digest",
  "workspace_identity",
  "provider_access_route",
  "credential_binding_digest",
  "provider_host_instance_identity",
  "provider_host_boot_identity",
  "provider_terminal_observation",
  "output_drain_cursor",
  "artifact_manifest_seal",
  "cutoff_observation",
  "terminal_execution_observation",
] as const;

const expectedCompositionDependencies = [
  "operation_store",
  "security",
  "provider_access",
  "workspace",
  "artifacts",
  "custody",
  "provider",
] as const;

const validateContract = (contract: ContainedTurnV1Contract): void => {
  exact(contract.adrs, ["ADR-0009", "ADR-0010", "ADR-0012"],
    "contained-turn V1 authority decisions");
  exact(contract.correctionBaseCommit, "40ddaedd0da009a6611988e3a8e9eb00857b05be",
    "contained-turn V1 authority correction base");
  exact(contract.foundationInputs, [
    {
      pullRequest: 22,
      head: "a01ac2b02bcb8bf46efea8e78a13a255b3988ef2",
      authority: "non_authoritative_design_input",
      mappedGuardrails: [
        "no_go_static_authoring",
        "no_go_selection_graph",
        "no_go_lifecycle_coordinator",
        "no_go_process_host",
        "no_go_shared_foundation_api",
        "no_go_public_spi",
      ],
    },
    {
      pullRequest: 27,
      head: "ee976675ed48c35e92f868ede95cc68e3fb71c6f",
      authority: "non_authoritative_design_input",
      mappedGuardrails: [
        "future_dogfooding_boundary_only",
        "no_production_authority",
      ],
    },
  ], "Foundation design-input heads");
  exact(contract.providers.map(({ provider, packageRevision, qualification }) => ({
    provider,
    packageRevision,
    qualification,
  })), [
    {
      provider: "codex",
      packageRevision: "@openai/codex@0.150.1",
      qualification: "candidate_static_evidence_only",
    },
    {
      provider: "claude",
      packageRevision: "@anthropic-ai/claude-agent-sdk@0.3.251",
      qualification: "candidate_static_evidence_only",
    },
    {
      provider: "opencode",
      packageRevision: "opencode@1.18.5#78f75775f26bf92237b27748d3b07bbd84b861536cb4ebe437fab6cf36bcac21",
      qualification: "contract_only_no_production_adapter",
    },
  ], "exact provider candidate revisions");
  exact(contract.adapterCapabilityManifests.map((manifest) => ({
    provider: manifest.provider,
    manifestRevision: manifest.manifestRevision,
    providerRevision: manifest.providerRevision,
    resourceScopeRevision: manifest.resourceScopeRevision,
  })), [
    {
      provider: "codex",
      manifestRevision: "codex-contained-turn-v1@1",
      providerRevision: "codex-app-server@0.150.1#sha256:abf1bb1643a79f73aa78ee627e111e02d4f8c98f25813a0cf6ce277709664386",
      resourceScopeRevision: "contained-turn-v1-worst-case-scope@1",
    },
    {
      provider: "claude",
      manifestRevision: "claude-contained-turn-v1@1",
      providerRevision: "claude-agent-sdk@0.3.251#sha256:fd5f10ff0eb58daec04900466b143ea98aab50abf208a422bc008eaec13f61f7",
      resourceScopeRevision: "contained-turn-v1-worst-case-scope@1",
    },
    {
      provider: "opencode",
      manifestRevision: "opencode-acp-contained-turn-v1@1",
      providerRevision: "opencode@1.18.5#sha256:78f75775f26bf92237b27748d3b07bbd84b861536cb4ebe437fab6cf36bcac21",
      resourceScopeRevision: "contained-turn-v1-worst-case-scope@1",
    },
  ], "versioned adapter capability manifests");
  exact(contract.worstCaseResourceScope, {
    scopeRevision: "contained-turn-v1-worst-case-scope@1",
    filesystem: "disposable_operation_workspace_only_no_canonical_project",
    process: "fresh_provider_process_or_session_and_all_descendants",
    network: "exact_provider_access_route_through_enforced_boundary_no_ambient_route",
    credentials: "opaque_operation_scoped_binding_no_ambient_credential_directory",
    outputArtifactsCustody: "operation_scoped_only",
    providerSessionReuse: "forbidden",
  }, "worst-case contained resource scope");
  exact(contract.requiredReceiptSet.receipts, expectedReceipts, "immutable RequiredReceiptSet");
  exact(contract.containmentExecutionReceiptVersion, 1, "ContainmentExecutionReceipt version");
  exact(contract.containmentExecutionReceiptBindings, expectedContainmentBindings,
    "ContainmentExecutionReceipt bindings");
  exact(contract.compositionFixture.dependencies, expectedCompositionDependencies,
    "closed Pure DI dependency fixture");
  exact(contract.compositionFixture.operations, [
    "submit",
    "observe",
    "cancel",
  ], "ordinary caller operations");
  if (contract.compositionFixture.forbiddenExports.includes("host_disposal") === false ||
      contract.compositionFixture.forbiddenExports.includes("provider_adapter_or_session") === false ||
      contract.compositionFixture.forbiddenExports.includes("module_registry") === false) {
    fail("ordinary RuntimeAccessHandle forbidden exports are incomplete");
  }
  const identities = new Set(contract.identityMatrix.map(({ identity }) => identity));
  const namespaces = new Set(contract.identityMatrix.map(({ namespace }) => namespace));
  if (identities.size !== contract.identityMatrix.length || namespaces.size !== contract.identityMatrix.length) {
    fail("identity matrix identities and namespaces must be unique");
  }
  for (const entry of contract.identityMatrix) {
    if (entry.mustNotAlias.includes(entry.identity)) {
      fail(`identity ${entry.identity} aliases itself`);
    }
  }
  for (const identity of [
    "operation",
    "command",
    "effect",
    "attempt",
    "execution_generation",
    "provider_host_instance",
    "authority_revision",
    "execution_fence",
    "module",
    "module_generation",
    "plan_digest",
    "loaded_head",
  ]) {
    if (!identities.has(identity)) {
      fail(`identity matrix omits ${identity}`);
    }
  }
  const lifecycleIds = contract.lifecycleMatrix.map(({ lifecycle }) => lifecycle);
  exact(lifecycleIds, [
    "module_availability",
    "module_prepare_start_ready",
    "module_published",
    "module_drain",
    "module_stop_dispose",
    "module_failed_aborted_retired",
    "host_disposal",
    "caller_abort",
  ], "module and Host lifecycle matrix");
  for (const lifecycle of ["module_availability", "host_disposal", "caller_abort"]) {
    const row = contract.lifecycleMatrix.find(({ lifecycle: candidate }) => candidate === lifecycle) ??
      fail(`lifecycle matrix omits ${lifecycle}`);
    if (row.mustNotMean.includes("operation_terminal") === false) {
      fail(`${lifecycle} must not manufacture operation terminal truth`);
    }
  }
  exact(contract.truthBoundary, {
    durableCancellation: "accepted_exact_command_and_persisted_fence_or_cutoff",
    callerAbort: "never_manufactures_durable_truth",
    hostDisposal: "never_manufactures_durable_truth",
    ambiguousDispatch: "nonterminal_reconcile_required",
    blindRetry: "forbidden",
  }, "durable truth boundary");
  const guardIds = new Set<string>();
  for (const example of contract.negativeGuard) {
    if (guardIds.has(example.id)) {
      fail(`duplicate negative guard example ${example.id}`);
    }
    guardIds.add(example.id);
    exact(evaluatePreMaterializationGuard(example.facts), example.expected,
      `ADR-0004 negative guard ${example.id}`);
  }
  exact([...guardIds], [
    "guard-before-delayed-command",
    "guard-after-acceptance-before-claim",
    "claim-before-guard",
    "provider-not-found-is-not-prevention-proof",
    "guard-command-digest-mismatch",
    "guard-scope-mismatch",
  ], "ADR-0004 negative guard examples");
};

const sha256 = (bytes: Uint8Array): string =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

const validateProviderEvidence = async (
  repositoryRoot: string,
  contract: ContainedTurnV1Contract,
): Promise<void> => {
  for (const provider of contract.providers) {
    if (provider.evidenceFixture === undefined) {
      if (provider.provider !== "opencode" || provider.qualification !== "contract_only_no_production_adapter") {
        fail(`${provider.provider} omits immutable evidence without a contract-only disposition`);
      }
      continue;
    }
    if (!provider.evidenceFixture.startsWith("experiments/runtime-profile-behavior/fixtures/") ||
        provider.evidenceFixture.includes("..")) {
      fail(`${provider.provider} evidence path escapes the immutable fixture directory`);
    }
    const bytes = await readFile(join(repositoryRoot, provider.evidenceFixture));
    exact(sha256(bytes), provider.evidenceFixtureDigest, `${provider.provider} evidence digest`);
    const evidence = JSON.parse(bytes.toString("utf8")) as {
      runtimeClosure?: Record<string, unknown>;
      package?: Record<string, unknown>;
      assertions?: Record<string, unknown>;
      binaries?: { version?: string; sha256?: string }[];
    };
    if (provider.provider === "codex") {
      exact(evidence.runtimeClosure?.codexVersion, "0.150.1", "Codex evidence version");
      exact(evidence.runtimeClosure?.codexNpmIntegrity,
        "sha512-knrbhpJH3mEULAVStcZW4F5WEt9MQhBj6KFOonBSIUGTLcHlu9CE7FRmr95E33y94+sWNZSeVBBV/kYvlfgxkQ==",
        "Codex package integrity");
      exact(`sha256:${String(evidence.runtimeClosure?.nativeBinarySha256)}`,
        provider.binaryRevision, "Codex evidence binary revision");
      exact(`sha256:${String(evidence.runtimeClosure?.generatedV2SchemaSha256)}`,
        provider.schemaRevision, "Codex evidence schema revision");
      exact(`sha256:${String(evidence.runtimeClosure?.generatedV2TypesSha256)}`,
        provider.typescriptRevision, "Codex evidence TypeScript revision");
      exact(evidence.assertions?.behaviorQualified, false,
        "Codex static evidence must not imply behavior qualification");
    } else if (provider.provider === "claude") {
      exact(evidence.package?.version, "0.3.251", "Claude SDK evidence version");
      exact(evidence.package?.npmIntegrity, provider.packageIntegrity, "Claude SDK package integrity");
      exact(`claude-code@${String(evidence.package?.bundledCliExpectedVersion)}`,
        provider.bundledProviderRevision, "Claude bundled provider revision");
      exact(`sha256:${String(evidence.package?.nativeBinarySha256)}`,
        provider.binaryRevision, "Claude evidence binary revision");
      exact(evidence.assertions?.behaviorQualified, false,
        "Claude static evidence must not imply behavior qualification");
    } else if (provider.provider === "opencode") {
      const pinned = evidence.binaries?.find(({ version }) => version === "1.18.5") ??
        fail("OpenCode evidence omits version 1.18.5");
      exact(pinned.sha256,
        "78f75775f26bf92237b27748d3b07bbd84b861536cb4ebe437fab6cf36bcac21",
        "OpenCode evidence binary revision");
    }
  }
};

export type ContainedTurnV1Validation = {
  requirementDispositions: ContainedTurnV1Disposition["expected"]["requirements"];
  exampleDispositions: ContainedTurnV1Disposition["expected"]["examples"];
  stateDispositions: ContainedTurnV1Disposition["expected"]["states"];
  negativeGuardExamples: number;
};

export const validateContainedTurnV1Authority = async (input: {
  repositoryRoot: string;
  contract: ContainedTurnV1Contract;
  disposition: ContainedTurnV1Disposition;
  cases: readonly Case[];
  catalog: Catalog;
}): Promise<ContainedTurnV1Validation> => {
  validateDisposition(input.disposition, input.cases, input.catalog);
  validateContract(input.contract);
  await validateProviderEvidence(input.repositoryRoot, input.contract);
  return {
    requirementDispositions: input.disposition.expected.requirements,
    exampleDispositions: input.disposition.expected.examples,
    stateDispositions: input.disposition.expected.states,
    negativeGuardExamples: input.contract.negativeGuard.length,
  };
};
