import { join } from "node:path";

import { runMatrix } from "../scenario-execution/run-matrix.ts";
import { profileFilesystemScenarios } from "./scenarios.ts";

export const runProfileFilesystem = async (): Promise<void> => {
  const opencodeExecutable = join(
    process.cwd(),
    "node_modules",
    ".bin",
    "opencode",
  );
  await runMatrix(
    "profile-filesystem",
    profileFilesystemScenarios(opencodeExecutable),
  );
};
