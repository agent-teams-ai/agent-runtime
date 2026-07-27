import { join } from "node:path";

import { runMatrix } from "./run-matrix.ts";
import { baselineScenarios } from "./scenario.ts";

export const runBaseline = async (): Promise<void> => {
  const opencodeExecutable = join(
    process.cwd(),
    "node_modules",
    ".bin",
    "opencode",
  );
  await runMatrix(
    "baseline",
    baselineScenarios(opencodeExecutable),
  );
};
