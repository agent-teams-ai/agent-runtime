import { access, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { createNodeContainedTurnArtifacts } from "../../dist/composition.js";

interface ContenderInput {
  readonly artifactOptions: Parameters<typeof createNodeContainedTurnArtifacts>[0];
  readonly barrierRoot: string;
  readonly operationId: string;
  readonly pausePoint?: string;
  readonly resultRef: string;
  readonly role: "late" | "loser" | "owner";
  readonly scope: Readonly<{ projectId: string; tenantId: string }>;
}

const encoded = process.argv[2];
if (encoded === undefined) {throw new Error("missing rehydration contender input");}
const input = JSON.parse(encoded) as ContenderInput;
const waitForBarrier = async (name: string): Promise<void> => {
  const release = join(input.barrierRoot, `${input.role}-${name}`);
  for (;;) {
    try {await access(release); return;} catch {await delay(10);}
  }
};
const expectedPoint = input.role === "owner"
  ? input.pausePoint ?? "artifact.rehydrate.created"
  : input.role === "late"
    ? "artifact.rehydrate-startup.exclusion-waiting"
    : undefined;
let paused = false;
await writeFile(join(input.barrierRoot, `${input.role}-initializing`), "initializing", { flag: "wx" });
const artifacts = await createNodeContainedTurnArtifacts({
  ...input.artifactOptions,
  testFaults: {
    async checkpoint(point) {
      if (expectedPoint === undefined || point !== expectedPoint || paused) {return;}
      paused = true;
      await writeFile(join(input.barrierRoot, `${input.role}-ready`), point, { flag: "wx" });
      await waitForBarrier("release");
    },
  },
});
await writeFile(join(input.barrierRoot, `${input.role}-initialized`), "initialized", { flag: "wx" });
await waitForBarrier("start");
const path = await artifacts.rehydrate({
  operationId: input.operationId,
  resultRef: input.resultRef,
  scope: input.scope,
});
process.stdout.write(`${JSON.stringify(path)}\n`);
