import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import type {
  ContainedTurnKernelDependencies,
  ContainedTurnKernelProviderObservation,
} from "../../../dist/features/contained-agent-turn/application/ports/outbound/contained-turn-ports.js";
import { createContainedTurnFeature } from "../../../dist/features/contained-agent-turn/composition/feature-module-factory.js";
import { createDependencies } from "./support/contained-agent-turn-fixture.ts";

type OutputKind = "assistant" | "diagnostic" | "progress";

interface KernelExpectation {
  readonly effect: "ambiguous" | "committed";
  readonly emittedKinds: readonly OutputKind[];
  readonly execution: "cancelled" | "failed" | "succeeded" | "unknown";
  readonly providerAcceptance: "accepted" | "unknown";
  readonly status: "cancelled" | "failed" | "reconcile_required" | "succeeded";
  readonly terminal: boolean;
}

interface ProjectedCase {
  readonly expectation: KernelExpectation;
  readonly id: string;
  readonly observation: ContainedTurnKernelProviderObservation;
  readonly output?: Readonly<{ readonly cursor: number; readonly kind: OutputKind; readonly text: string }>;
}

type IndeterminateObservation = Extract<ContainedTurnKernelProviderObservation, { readonly kind: "indeterminate" }>;

const evidenceId = (caseId: string): IndeterminateObservation["evidenceId"] =>
  `evidence:opencode-provider-indeterminate:${createHash("sha256").update(caseId).digest("hex")}` as
    IndeterminateObservation["evidenceId"];

const completed = (
  outcome: "cancelled" | "failed" | "succeeded",
): ContainedTurnKernelProviderObservation => ({ kind: "completed", outcome });

const indeterminate = (caseId: string): ContainedTurnKernelProviderObservation => ({
  evidenceId: evidenceId(caseId),
  kind: "indeterminate",
});

const projectedCases: readonly ProjectedCase[] = Object.freeze([
  {
    expectation: {
      effect: "committed",
      emittedKinds: [],
      execution: "cancelled",
      providerAcceptance: "accepted",
      status: "cancelled",
      terminal: true,
    },
    id: "completed-cancelled",
    observation: completed("cancelled"),
  },
  {
    expectation: {
      effect: "committed",
      emittedKinds: ["diagnostic"],
      execution: "failed",
      providerAcceptance: "accepted",
      status: "failed",
      terminal: true,
    },
    id: "completed-failed",
    observation: completed("failed"),
    output: { cursor: 0, kind: "diagnostic", text: "synthetic ACP refusal" },
  },
  {
    expectation: {
      effect: "committed",
      emittedKinds: ["assistant"],
      execution: "succeeded",
      providerAcceptance: "accepted",
      status: "succeeded",
      terminal: true,
    },
    id: "completed-succeeded",
    observation: completed("succeeded"),
    output: { cursor: 0, kind: "assistant", text: "x".repeat(256) },
  },
  ...[
    "late-rejection-after-timeout",
    "request-rejection-without-no-start-proof",
    "request-timeout-after-dispatch",
  ].map(id => ({
    expectation: {
      effect: "ambiguous" as const,
      emittedKinds: [],
      execution: "unknown" as const,
      providerAcceptance: "unknown" as const,
      status: "reconcile_required" as const,
      terminal: false,
    },
    id,
    observation: indeterminate(id),
  })),
]);

const createKernelHarness = (projectedCase: ProjectedCase) => {
  const projectedOutput: Array<{ readonly cursor: number; readonly kind: OutputKind; readonly text: string }> = [];
  const projectionCalls = { value: 0 };
  const providerObservations: ContainedTurnKernelProviderObservation[] = [];
  const fixture = createDependencies();
  const attestExecutionClosure = fixture.dependencies.custody.attestExecutionClosure;
  let projectedObservation: ContainedTurnKernelProviderObservation | undefined;
  const dependencies = {
    ...fixture.dependencies,
    custody: {
      ...fixture.dependencies.custody,
      async attestExecutionClosure(input) {
        const attestation = await attestExecutionClosure(input);
        if (
          projectedObservation?.kind !== "completed" ||
          projectedObservation.outcome === "succeeded" ||
          attestation.kind !== "proved"
        ) {
          return attestation;
        }
        return {
          ...attestation,
          executionClosureProof: {
            ...attestation.executionClosureProof,
            binding: { ...attestation.executionClosureProof.binding, outcome: projectedObservation.outcome },
          },
          terminalObservationProof: {
            ...attestation.terminalObservationProof,
            binding: { ...attestation.terminalObservationProof.binding, outcome: projectedObservation.outcome },
          },
        };
      },
    },
    provider: {
      ...fixture.dependencies.provider,
      async execute(input) {
        projectionCalls.value += 1;
        assert.equal(projectionCalls.value, 1, `${projectedCase.id} projected more than once`);
        input.start.createProcess(() => Object.freeze({}));
        if (projectedCase.output !== undefined) {
          projectedOutput.push(projectedCase.output);
          await input.emit(projectedCase.output);
        }
        projectedObservation = projectedCase.observation;
        providerObservations.push(projectedCase.observation);
        return projectedCase.observation;
      },
    },
  } satisfies ContainedTurnKernelDependencies;
  return {
    current: fixture.current,
    engine: createContainedTurnFeature(dependencies),
    projectedOutput,
    projectionCalls,
    providerObservations,
    workspaceQuarantines: fixture.workspaceQuarantines,
  };
};

test("projects the characterized OpenCode neutral outcomes through the real Contained Turn kernel", async () => {
  assert.deepEqual(projectedCases.map(value => value.id).toSorted(), [
    "completed-cancelled",
    "completed-failed",
    "completed-succeeded",
    "late-rejection-after-timeout",
    "request-rejection-without-no-start-proof",
    "request-timeout-after-dispatch",
  ]);

  for (const projectedCase of projectedCases) {
    const harness = createKernelHarness(projectedCase);
    const result = await harness.engine.submit.execute({
      commandId: `command:${projectedCase.id}`,
      expectedProvider: "codex",
      intent: { mode: "analysis", prompt: "synthetic kernel contract probe" },
      scope: { projectId: "project:one", tenantId: "tenant:one" },
    });
    assert.equal(result.status, "observed", projectedCase.id);
    if (result.status !== "observed") {continue;}
    const expectation = projectedCase.expectation;
    assert.equal(result.turn.status, expectation.status, projectedCase.id);
    assert.deepEqual(result.turn.output, harness.projectedOutput, projectedCase.id);
    assert.deepEqual(result.turn.output.map(chunk => chunk.kind), expectation.emittedKinds, projectedCase.id);
    const operation = harness.current();
    assert.ok(operation, projectedCase.id);
    assert.equal(operation.providerAcceptance.kind, expectation.providerAcceptance, projectedCase.id);
    assert.equal(operation.terminal.kind, expectation.terminal ? "final" : "open", projectedCase.id);
    if (expectation.execution === "unknown") {
      assert.equal(operation.providerExecution.kind, "unknown", projectedCase.id);
      assert.equal(operation.effect.kind, "ambiguous", projectedCase.id);
      assert.equal(operation.reconciliation.kind, "required", projectedCase.id);
      assert.equal(operation.physicalContainment.kind, "contained", projectedCase.id);
      assert.equal(operation.containment.kind, "uncertain", projectedCase.id);
    } else {
      assert.equal(operation.providerExecution.kind, "closed", projectedCase.id);
      if (operation.providerExecution.kind === "closed") {
        assert.equal(operation.providerExecution.outcome, expectation.execution, projectedCase.id);
      }
      assert.equal(operation.effect.kind, "resolved", projectedCase.id);
      if (operation.effect.kind === "resolved") {
        assert.equal(operation.effect.disposition, expectation.effect, projectedCase.id);
      }
      assert.equal(operation.containment.kind, "contained", projectedCase.id);
      assert.equal(operation.requiredReceiptSet.receipts.length, 12, projectedCase.id);
    }
    assert.equal(operation.output.fence.kind, "fenced", projectedCase.id);
    assert.equal(harness.workspaceQuarantines.length, 0, projectedCase.id);
    assert.equal(harness.projectionCalls.value, 1, projectedCase.id);
    assert.deepEqual(harness.providerObservations, [projectedCase.observation], projectedCase.id);
  }
});

test("keeps the current kernel capability-manifest shape in Agent Execution ownership", () => {
  assert.deepEqual(Object.keys(createDependencies().dependencies.provider.manifest).toSorted(), [
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
});
