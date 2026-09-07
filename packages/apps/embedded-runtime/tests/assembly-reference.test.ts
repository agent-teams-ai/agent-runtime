import { registerPassiveSetupScenarios, createDirectReferenceHost } from "./helpers/assembly-direct-reference.ts";

registerPassiveSetupScenarios("direct reference", async () => createDirectReferenceHost());
