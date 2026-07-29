import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { ObservationAssertion, ProviderId } from "../../model.ts";
import {
  createEvidenceRun,
  writeJsonEvidence,
} from "../evidence/write-evidence.ts";
import { runCommand } from "../process-execution/run-command.ts";
import { managedPolicyAssertions } from "./managed-policy-assertions.ts";

interface ManagedPolicyEvidence {
  readonly schemaVersion: 1;
  readonly provider: ProviderId;
  readonly capturedAt: string;
  readonly safety: {
    readonly syntheticEtcOverlay: true;
    readonly syntheticHome: true;
    readonly syntheticWorkspace: true;
    readonly inheritedSensitiveEnvironmentKeys: readonly [];
  };
  readonly observation: Readonly<Record<string, unknown>>;
  readonly assertions: readonly ObservationAssertion[];
}

const script = (name: string): string =>
  fileURLToPath(new URL(`./${name}`, import.meta.url));

export const runManagedPolicy = async (): Promise<void> => {
  const run = await createEvidenceRun();
  const probes: readonly {
    readonly provider: ProviderId;
    readonly script: string;
    readonly timeoutMs: number;
    readonly extraArgs?: readonly string[];
  }[] = [
    {
      provider: "claude",
      script: script("claude-managed-policy-probe.ts"),
      timeoutMs: 90_000,
    },
    {
      provider: "codex",
      script: script("codex-managed-policy-probe.ts"),
      timeoutMs: 45_000,
    },
    {
      provider: "opencode",
      script: script("opencode-managed-policy-probe.ts"),
      timeoutMs: 45_000,
      extraArgs: [
        join(process.cwd(), "node_modules", ".bin", "opencode"),
        fileURLToPath(
          new URL(
            "../acp-compatibility/opencode-acp-handshake-probe.ts",
            import.meta.url,
          ),
        ),
      ],
    },
  ];
  const outcomes: Array<{
    readonly provider: ProviderId;
    readonly failedAssertions: readonly string[];
  }> = [];

  for (const probe of probes) {
    const root = join(run.sandboxRoot, `${probe.provider}-managed-policy`);
    const result = await runCommand("unshare", {
      args: [
        "-m",
        "--propagation",
        "private",
        process.execPath,
        probe.script,
        root,
        ...(probe.extraArgs ?? []),
      ],
      cwd: process.cwd(),
      env: {
        LANG: "C.UTF-8",
        PATH: process.env.PATH,
        TZ: "UTC",
      },
      timeoutMs: probe.timeoutMs,
    });
    if (result.exitCode !== 0) {
      throw new Error(
        `${probe.provider} managed-policy probe failed: ${result.stderr}`,
      );
    }
    const observation = JSON.parse(result.stdout) as Record<string, unknown>;
    const assertions = managedPolicyAssertions(probe.provider, observation);
    const evidence: ManagedPolicyEvidence = {
      schemaVersion: 1,
      provider: probe.provider,
      capturedAt: new Date().toISOString(),
      safety: {
        syntheticEtcOverlay: true,
        syntheticHome: true,
        syntheticWorkspace: true,
        inheritedSensitiveEnvironmentKeys: [],
      },
      observation,
      assertions,
    };
    await writeJsonEvidence(
      join(run.evidenceRoot, `managed-policy-${probe.provider}.json`),
      evidence,
    );
    outcomes.push({
      provider: probe.provider,
      failedAssertions: assertions
        .filter((assertion) => !assertion.passed)
        .map((assertion) => assertion.id),
    });
  }

  await writeJsonEvidence(join(run.root, "manifest.json"), {
    schemaVersion: 1,
    runId: run.id,
    matrix: "managed-policy",
    evidence: probes.map(
      ({ provider }) => `evidence/managed-policy-${provider}.json`,
    ),
    rawArtifacts: [],
  });
  process.stdout.write(
    `${JSON.stringify({ runId: run.id, matrix: "managed-policy", outcomes }, null, 2)}\n`,
  );
  if (outcomes.some((outcome) => outcome.failedAssertions.length > 0)) {
    process.exitCode = 1;
  }
};
