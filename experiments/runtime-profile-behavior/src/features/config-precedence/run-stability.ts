import { join } from "node:path";

import { runMatrix } from "../scenario-execution/run-matrix.ts";
import { stabilityScenarios } from "./scenarios.ts";

export const runStability = async (): Promise<void> => {
  const opencodeExecutable = join(
    process.cwd(),
    "node_modules",
    ".bin",
    "opencode",
  );
  await runMatrix(
    "provider-stability",
    stabilityScenarios(opencodeExecutable),
  );
};
