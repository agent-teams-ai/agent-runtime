import { join } from "node:path";

import { runMatrix } from "../scenario-execution/run-matrix.ts";
import { profileDriftScenarios } from "./scenarios.ts";

export const runProfileDrift = async (): Promise<void> => {
  const opencodeExecutable = join(
    process.cwd(),
    "node_modules",
    ".bin",
    "opencode",
  );
  await runMatrix(
    "profile-drift",
    profileDriftScenarios(opencodeExecutable),
  );
};
