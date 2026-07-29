import type { ScenarioEvidence } from "../../model.ts";
import type { ProbeScenario } from "../scenario-execution/scenario.ts";

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};

const assertions = (
  requireResumeSuccess: boolean,
): NonNullable<ProbeScenario["assertions"]> =>
  (evidence: ScenarioEvidence) => {
    let output: Record<string, unknown> = {};
    try {
      output = record(JSON.parse(evidence.result.stdout));
    } catch {
      output = {};
    }
    const base = [
      {
        id: `${evidence.scenarioId}.probe-succeeded`,
        passed: evidence.result.exitCode === 0,
        expected: 0,
        actual: evidence.result.exitCode,
      },
      {
        id: `${evidence.scenarioId}.initial-session-succeeded`,
        passed: output.startedSuccessfully === true,
        expected: true,
        actual: output.startedSuccessfully,
      },
    ];
    if (!requireResumeSuccess) {
      return [
        ...base,
        {
          id: `${evidence.scenarioId}.rollback-outcome-recorded`,
          passed: typeof output.resumedSuccessfully === "boolean",
          expected: "boolean compatibility outcome",
          actual: output.resumedSuccessfully,
        },
      ];
    }
    return [
      ...base,
      {
        id: `${evidence.scenarioId}.cross-version-resume-succeeded`,
        passed:
          output.resumedSuccessfully === true &&
          output.sameSession === true,
        expected: true,
        actual: {
          resumedSuccessfully: output.resumedSuccessfully,
          sameSession: output.sameSession,
        },
      },
    ];
  };

export const binaryCompatibilityScenarios = (
  probeExecutable: string,
  previousOpenCode: string,
  currentOpenCode: string,
): readonly ProbeScenario[] => [
  {
    id: "opencode-upgrade-session-resume-1.17-to-1.18",
    provider: "opencode",
    invocation: (sandbox) => ({
      executable: process.execPath,
      args: [
        probeExecutable,
        previousOpenCode,
        currentOpenCode,
        sandbox.workspace,
      ],
      cwd: sandbox.workspace,
      timeoutMs: 130_000,
      trace: false,
    }),
    assertions: assertions(true),
  },
  {
    id: "opencode-rollback-session-resume-1.18-to-1.17",
    provider: "opencode",
    invocation: (sandbox) => ({
      executable: process.execPath,
      args: [
        probeExecutable,
        currentOpenCode,
        previousOpenCode,
        sandbox.workspace,
      ],
      cwd: sandbox.workspace,
      timeoutMs: 130_000,
      trace: false,
    }),
    assertions: assertions(false),
  },
];
