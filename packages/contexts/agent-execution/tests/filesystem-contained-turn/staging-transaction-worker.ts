import { access, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import {
  createNodeContainedTurnArtifacts,
  createNodeContainedTurnWorkspace,
} from "../../dist/composition.js";

type StagingTransactionInput = Readonly<{
  action: "seal" | "workspace-create";
  artifactOptions?: Parameters<typeof createNodeContainedTurnArtifacts>[0];
  barrierRoot: string;
  operationId: string;
  pausePoint: string;
  scope: Readonly<{ projectId: string; tenantId: string }>;
  workspaceOptions?: Parameters<typeof createNodeContainedTurnWorkspace>[0];
  workspaceRef?: string;
}>;

const encoded = process.argv[2];
if (encoded === undefined) {throw new Error("missing staging transaction input");}
const input = JSON.parse(encoded) as StagingTransactionInput;

const waitForBarrier = async (name: string): Promise<void> => {
  const path = join(input.barrierRoot, name);
  for (;;) {
    try {await access(path); return;} catch {await delay(10);}
  }
};

let paused = false;
const testFaults = Object.freeze({
  async checkpoint(point: string): Promise<void> {
    if (point !== input.pausePoint || paused) {return;}
    paused = true;
    await writeFile(join(input.barrierRoot, "transaction-ready"), point, { flag: "wx" });
    await waitForBarrier("transaction-release");
  },
});

let result: string;
if (input.action === "seal") {
  if (input.artifactOptions === undefined || input.workspaceRef === undefined) {
    throw new Error("seal staging transaction input is incomplete");
  }
  const artifacts = await createNodeContainedTurnArtifacts({
    ...input.artifactOptions,
    testFaults,
  });
  await writeFile(join(input.barrierRoot, "transaction-initialized"), "initialized", { flag: "wx" });
  await waitForBarrier("transaction-start");
  result = (await artifacts.seal({
    operationId: input.operationId,
    output: [],
    scope: input.scope,
    workspaceRef: input.workspaceRef,
  })).resultRef;
} else {
  if (input.workspaceOptions === undefined) {
    throw new Error("workspace staging transaction input is incomplete");
  }
  const workspace = await createNodeContainedTurnWorkspace({
    ...input.workspaceOptions,
    testFaults,
  });
  await writeFile(join(input.barrierRoot, "transaction-initialized"), "initialized", { flag: "wx" });
  await waitForBarrier("transaction-start");
  result = (await workspace.create({
    operationId: input.operationId,
    scope: input.scope,
  })).workspaceRef;
}

process.stdout.write(`${JSON.stringify(result)}\n`);
