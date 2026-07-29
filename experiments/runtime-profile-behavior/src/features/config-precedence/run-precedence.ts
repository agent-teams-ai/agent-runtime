import { join } from "node:path";

import { runMatrix } from "../scenario-execution/run-matrix.ts";
import { configurationScenarios } from "./scenarios.ts";

export const runPrecedence = async (): Promise<void> => {
  const opencodeExecutable = join(
    process.cwd(),
    "node_modules",
    ".bin",
    "opencode",
  );
  await runMatrix(
    "configuration-precedence",
    configurationScenarios(opencodeExecutable),
  );
};
