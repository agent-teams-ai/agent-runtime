import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  createNodeContainedTurnArtifacts,
  createNodeContainedTurnWorkspace,
} from "../../dist/composition.js";

interface CrashInput {
  readonly action: "close" | "create" | "rehydrate" | "seal";
  readonly artifactOptions: Parameters<typeof createNodeContainedTurnArtifacts>[0];
  readonly faultPoint: string;
  readonly operationId: string;
  readonly resultRef?: string;
  readonly scope: Readonly<{ projectId: string; tenantId: string }>;
  readonly workspaceOptions: Parameters<typeof createNodeContainedTurnWorkspace>[0];
  readonly workspaceRef?: string;
}

const encoded = process.argv[2];
if (encoded === undefined) {throw new Error("missing contained turn crash input");}
const input = JSON.parse(encoded) as CrashInput;
const faults = Object.freeze({
  checkpoint(point: string): void {
    if (point === input.faultPoint) {process.kill(process.pid, "SIGKILL");}
  },
});

const workspace = await createNodeContainedTurnWorkspace({
  ...input.workspaceOptions,
  testFaults: faults,
});
if (input.action === "create") {
  await workspace.create({ operationId: input.operationId, scope: input.scope });
} else {
  if (input.action === "rehydrate") {
    if (input.resultRef === undefined) {throw new Error("missing crash result reference");}
    const artifacts = await createNodeContainedTurnArtifacts({
      ...input.artifactOptions,
      testFaults: faults,
    });
    await artifacts.rehydrate({
      operationId: input.operationId,
      resultRef: input.resultRef,
      scope: input.scope,
    });
  } else {
    if (input.workspaceRef === undefined) {throw new Error("missing crash workspace reference");}
    if (input.action === "seal") {
      await writeFile(
        join(input.workspaceRef, "crash-result.txt"),
        "durable crash result",
        { mode: 0o600 },
      );
      const artifacts = await createNodeContainedTurnArtifacts({
        ...input.artifactOptions,
        testFaults: faults,
      });
      await artifacts.seal({
        operationId: input.operationId,
        output: [],
        scope: input.scope,
        workspaceRef: input.workspaceRef,
      });
    } else {
      await workspace.close({
        operationId: input.operationId,
        scope: input.scope,
        workspaceRef: input.workspaceRef,
      });
    }
  }
}

throw new Error(`fault checkpoint was not reached: ${input.faultPoint}`);
