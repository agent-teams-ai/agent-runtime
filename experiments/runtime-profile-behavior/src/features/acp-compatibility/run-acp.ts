import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { runMatrix } from "../scenario-execution/run-matrix.ts";
import { acpCompatibilityScenarios } from "./scenarios.ts";

export const runAcpCompatibility = async (): Promise<void> => {
  const opencodeExecutable = join(
    process.cwd(),
    "node_modules",
    ".bin",
    "opencode",
  );
  const probeExecutable = fileURLToPath(
    new URL("./opencode-acp-handshake-probe.ts", import.meta.url),
  );
  await runMatrix(
    "acp-compatibility",
    acpCompatibilityScenarios(opencodeExecutable, probeExecutable),
  );
};
