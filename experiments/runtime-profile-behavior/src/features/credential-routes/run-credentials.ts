import { join } from "node:path";

import { runMatrix } from "../scenario-execution/run-matrix.ts";
import { credentialScenarios } from "./scenarios.ts";

export const runCredentials = async (): Promise<void> => {
  const opencodeExecutable = join(
    process.cwd(),
    "node_modules",
    ".bin",
    "opencode",
  );
  await runMatrix(
    "credential-and-provider-routes",
    credentialScenarios(opencodeExecutable),
  );
};
