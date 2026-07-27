import { join } from "node:path";

import { runMatrix } from "../scenario-execution/run-matrix.ts";
import { providerE2eScenarios } from "./scenarios.ts";

export const runE2e = async (): Promise<void> => {
  const opencodeExecutable = join(
    process.cwd(),
    "node_modules",
    ".bin",
    "opencode",
  );
  await runMatrix(
    "provider-authenticated-e2e",
    providerE2eScenarios(opencodeExecutable),
  );
};
