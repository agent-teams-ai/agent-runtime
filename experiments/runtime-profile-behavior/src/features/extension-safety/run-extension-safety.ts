import { join } from "node:path";

import { runMatrix } from "../scenario-execution/run-matrix.ts";
import { extensionSafetyScenarios } from "./scenarios.ts";

export const runExtensionSafety = async (): Promise<void> => {
  await runMatrix(
    "extension-safety",
    extensionSafetyScenarios(
      join(process.cwd(), "node_modules", ".bin", "opencode"),
    ),
  );
};
