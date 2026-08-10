import { homedir } from "node:os";
import { join } from "node:path";

import type { ScenarioEvidence } from "../../model.ts";
import {
  captureFileSnapshot,
  diffFileSnapshots,
} from "../filesystem-observation/file-snapshot.ts";
import { summarizeStraceFiles } from "../filesystem-observation/strace-summary.ts";
import { redactText } from "../redaction/redact.ts";
import { runCommand } from "../process-execution/run-command.ts";
import {
  createSanitizedEnvironment,
  inheritedSensitiveKeys,
} from "./sanitized-environment.ts";
import type { EvidenceRun } from "../evidence/write-evidence.ts";
import { createScenarioSandbox } from "./create-sandbox.ts";
import type { ProbeScenario } from "./scenario.ts";
import { runTracedCommand } from "./run-traced-command.ts";

const redactResult = (
  result: ScenarioEvidence["result"],
  roots: Readonly<Record<string, string>>,
): ScenarioEvidence["result"] => ({
  ...result,
  command: redactText(result.command, { roots }),
  args: result.args.map((arg) => redactText(arg, { roots })),
  stdout: redactText(result.stdout, { roots }),
  stderr: redactText(result.stderr, { roots }),
});

const allowedWritePath = (path: string): boolean =>
  path.startsWith("<SANDBOX>") ||
  path === "/dev/null" ||
  path === "/dev/tty" ||
  path === "/sys/kernel/debug/tracing/trace_marker";

const safetyAssertions = (
  evidence: ScenarioEvidence,
  expectedTimeout: boolean,
): ScenarioEvidence["assertions"] => {
  const outsideWrites = evidence.trace.writePaths.filter(
    (path) => !allowedWritePath(path),
  );
  const assertions: NonNullable<ScenarioEvidence["assertions"]> = [
    {
      id: "safety.no-sensitive-environment-inheritance",
      passed:
        evidence.safety.inheritedSensitiveEnvironmentKeys.length === 0,
      expected: [],
      actual: evidence.safety.inheritedSensitiveEnvironmentKeys,
    },
    {
      id: "process.timeout-matched-expectation",
      passed: expectedTimeout
        ? evidence.result.timedOut
        : !evidence.result.timedOut,
      expected: expectedTimeout,
      actual: evidence.result.timedOut,
    },
  ];
  if (evidence.safety.syscallTrace) {
    return [
      ...assertions,
      {
        id: "safety.no-writes-outside-sandbox",
        passed: outsideWrites.length === 0,
        expected: [],
        actual: outsideWrites,
      },
    ];
  }
  return assertions;
};

export const runScenario = async (
  run: EvidenceRun,
  scenario: ProbeScenario,
): Promise<ScenarioEvidence> => {
  const sandbox = await createScenarioSandbox(run.sandboxRoot, scenario.id);
  await scenario.prepare?.(sandbox);
  const invocation = scenario.invocation(sandbox);
  const environment = createSanitizedEnvironment(
    sandbox,
    invocation.environment,
  );
  const inheritedSensitiveEnvironmentKeys =
    inheritedSensitiveKeys(environment);
  if (inheritedSensitiveEnvironmentKeys.length > 0) {
    throw new Error(
      `Sensitive environment reached scenario: ${inheritedSensitiveEnvironmentKeys.join(", ")}`,
    );
  }

  const roots = {
    SANDBOX: sandbox.root,
    HOST_HOME: homedir(),
    WORKTREE: process.cwd(),
  };
  const before = await captureFileSnapshot(sandbox.root);
  const tracePrefix = join(run.rawRoot, "strace", scenario.id);
  const syscallTrace = invocation.trace !== false;
  const commandOptions = {
    args: invocation.args,
    cwd: invocation.cwd ?? sandbox.workspace,
    env: environment,
    ...(invocation.timeoutMs === undefined
      ? {}
      : { timeoutMs: invocation.timeoutMs }),
  };
  const result = syscallTrace
    ? await runTracedCommand(
        {
          ...invocation,
          cwd: commandOptions.cwd,
        },
        environment,
        tracePrefix,
      )
    : await runCommand(invocation.executable, commandOptions);
  const normalizedResult = scenario.normalizeResult?.(result) ?? result;
  const after = await captureFileSnapshot(sandbox.root);
  const trace = syscallTrace
    ? await summarizeStraceFiles(tracePrefix, { roots })
    : { readPaths: [], writePaths: [], executePaths: [], traceFileCount: 0 };
  const verification = await scenario.verify?.(sandbox);

  const evidence: ScenarioEvidence = {
    schemaVersion: 1,
    scenarioId: scenario.id,
    provider: scenario.provider,
    capturedAt: new Date().toISOString(),
    command: {
      executable: redactText(invocation.executable, { roots }),
      args: invocation.args.map((arg) => redactText(arg, { roots })),
    },
    result: redactResult(normalizedResult, roots),
    filesystem: diffFileSnapshots(before, after),
    trace,
    safety: {
      syntheticHome: true,
      syntheticWorkspace: true,
      syscallTrace,
      inheritedSensitiveEnvironmentKeys,
    },
    ...(verification === undefined ? {} : { verification }),
  };
  const assertions = [
    ...(safetyAssertions(evidence, invocation.expectedTimeout ?? false) ?? []),
    ...(scenario.assertions?.(evidence) ?? []),
  ];
  return {
    ...evidence,
    assertions,
  };
};
