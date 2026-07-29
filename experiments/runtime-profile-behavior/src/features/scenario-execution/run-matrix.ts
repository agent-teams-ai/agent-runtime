import { join } from "node:path";

import {
  createEvidenceRun,
  writeJsonEvidence,
} from "../evidence/write-evidence.ts";
import { runScenario } from "./run-scenario.ts";
import type { ProbeScenario } from "./scenario.ts";

export const runMatrix = async (
  matrixName: string,
  scenarios: readonly ProbeScenario[],
): Promise<void> => {
  const run = await createEvidenceRun();
  const outcomes: Array<{
    scenarioId: string;
    provider: string;
    exitCode: number | null;
    timedOut: boolean;
    failedAssertions: readonly string[];
  }> = [];

  for (const scenario of scenarios) {
    const evidence = await runScenario(run, scenario);
    const relativePath = join(
      "evidence",
      "scenarios",
      `${scenario.id}.json`,
    );
    await writeJsonEvidence(join(run.root, relativePath), evidence);
    outcomes.push({
      scenarioId: scenario.id,
      provider: scenario.provider,
      exitCode: evidence.result.exitCode,
      timedOut: evidence.result.timedOut,
      failedAssertions: (evidence.assertions ?? [])
        .filter((assertion) => !assertion.passed)
        .map((assertion) => assertion.id),
    });
  }

  await writeJsonEvidence(join(run.root, "manifest.json"), {
    schemaVersion: 1,
    runId: run.id,
    matrix: matrixName,
    createdAt: new Date().toISOString(),
    evidence: outcomes.map(
      ({ scenarioId }) => `evidence/scenarios/${scenarioId}.json`,
    ),
    rawArtifacts: ["raw/strace/*"],
  });

  process.stdout.write(
    `${JSON.stringify(
      {
        runId: run.id,
        matrix: matrixName,
        outcomes,
      },
      null,
      2,
    )}\n`,
  );

  if (outcomes.some((outcome) => outcome.failedAssertions.length > 0)) {
    process.exitCode = 1;
  }
};
