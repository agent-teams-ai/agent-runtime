import { join } from "node:path";

import { runAcpCompatibility } from "./features/acp-compatibility/run-acp.ts";
import { runBinaryCompatibility } from "./features/binary-compatibility/run-binary-compatibility.ts";
import { runPrecedence } from "./features/config-precedence/run-precedence.ts";
import { runStability } from "./features/config-precedence/run-stability.ts";
import { runCredentials } from "./features/credential-routes/run-credentials.ts";
import { createEvidenceRun, writeJsonEvidence } from "./features/evidence/write-evidence.ts";
import { captureHostInventory } from "./features/host-inventory/capture-host-inventory.ts";
import { runManagedPolicy } from "./features/managed-policy/run-managed-policy.ts";
import { runE2e } from "./features/provider-e2e/run-e2e.ts";
import { runLifecycle } from "./features/provider-lifecycle/run-lifecycle.ts";
import { runProfileDrift } from "./features/profile-drift/run-profile-drift.ts";
import { runProfileFilesystem } from "./features/profile-filesystem/run-profile-filesystem.ts";
import { runLegacyComparison } from "./features/legacy-comparison/run-legacy-comparison.ts";
import { runExtensionSafety } from "./features/extension-safety/run-extension-safety.ts";
import { runProfileLoss } from "./features/profile-loss/run-profile-loss.ts";
import { runBaseline } from "./features/scenario-execution/run-baseline.ts";
import { PROVIDERS } from "./providers.ts";

const usage = (): never => {
  throw new Error(
    "Usage: cli.ts <inventory|baseline|precedence|stability|credentials|e2e|lifecycle|acp|filesystem|drift|binary|legacy|extensions|profile-loss|managed-policy>",
  );
};

const runInventory = async (): Promise<void> => {
  const run = await createEvidenceRun();
  const inventory = await captureHostInventory(PROVIDERS);
  const evidencePath = join(run.evidenceRoot, "host-inventory.json");
  await writeJsonEvidence(evidencePath, inventory);
  await writeJsonEvidence(join(run.root, "manifest.json"), {
    schemaVersion: 1,
    runId: run.id,
    scenario: "host-inventory",
    createdAt: new Date().toISOString(),
    evidence: ["evidence/host-inventory.json"],
    rawArtifacts: [],
  });

  process.stdout.write(
    `${JSON.stringify(
      {
        runId: run.id,
        evidencePath,
        providers: inventory.providerExecutables.map((provider) => ({
          provider: provider.provider,
          available: provider.available,
          version: provider.version,
        })),
      },
      null,
      2,
    )}\n`,
  );
};

const command = process.argv[2];
switch (command) {
  case "inventory":
    await runInventory();
    break;
  case "baseline":
    await runBaseline();
    break;
  case "precedence":
    await runPrecedence();
    break;
  case "stability":
    await runStability();
    break;
  case "credentials":
    await runCredentials();
    break;
  case "e2e":
    await runE2e();
    break;
  case "lifecycle":
    await runLifecycle();
    break;
  case "acp":
    await runAcpCompatibility();
    break;
  case "filesystem":
    await runProfileFilesystem();
    break;
  case "drift":
    await runProfileDrift();
    break;
  case "binary":
    await runBinaryCompatibility();
    break;
  case "legacy":
    await runLegacyComparison();
    break;
  case "extensions":
    await runExtensionSafety();
    break;
  case "profile-loss":
    await runProfileLoss();
    break;
  case "managed-policy":
    await runManagedPolicy();
    break;
  default:
    usage();
}
