import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { runMatrix } from "../scenario-execution/run-matrix.ts";
import { binaryCompatibilityScenarios } from "./scenarios.ts";

export const runBinaryCompatibility = async (): Promise<void> => {
  const probeExecutable = fileURLToPath(
    new URL("./opencode-cross-version-resume-probe.ts", import.meta.url),
  );
  const previousOpenCode = join(
    process.cwd(),
    "node_modules",
    "opencode-previous",
    "bin",
    "opencode.exe",
  );
  const currentOpenCode = join(
    process.cwd(),
    "node_modules",
    ".bin",
    "opencode",
  );
  await runMatrix(
    "binary-compatibility",
    binaryCompatibilityScenarios(
      probeExecutable,
      previousOpenCode,
      currentOpenCode,
    ),
  );
};
