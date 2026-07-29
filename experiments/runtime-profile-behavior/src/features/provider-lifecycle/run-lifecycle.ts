import { runMatrix } from "../scenario-execution/run-matrix.ts";
import { providerLifecycleScenarios } from "./scenarios.ts";

export const runLifecycle = async (): Promise<void> => {
  await runMatrix(
    "provider-lifecycle",
    providerLifecycleScenarios(),
  );
};
