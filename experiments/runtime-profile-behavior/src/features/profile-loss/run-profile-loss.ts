import { join } from "node:path";

import { runMatrix } from "../scenario-execution/run-matrix.ts";
import { profileLossScenarios } from "./scenarios.ts";

export const runProfileLoss = async (): Promise<void> => {
  await runMatrix(
    "profile-loss",
    profileLossScenarios(
      join(process.cwd(), "node_modules", ".bin", "opencode"),
    ),
  );
};
