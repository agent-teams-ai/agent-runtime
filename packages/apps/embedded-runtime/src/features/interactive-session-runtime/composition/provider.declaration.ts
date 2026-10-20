import {declareModule} from "@get-modular/assembly";
import {Provider} from "./interactive-session-runtime.contracts.js";

export const providerDeclaration = declareModule({
  moduleId: "agent-runtime/interactive-host/provider", implementationId: "agent-runtime/interactive-host/provider/input",
  owner: {authority: "agent-runtime", path: ["interactive-session-runtime"]}, provides: [Provider.provide()], slots: [],
});
