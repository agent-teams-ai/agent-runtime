import {declareModule} from "@get-modular/assembly";
import {Authority} from "./interactive-session-runtime.contracts.js";

export const authorityDeclaration = declareModule({
  moduleId: "agent-runtime/interactive-host/authority", implementationId: "agent-runtime/interactive-host/authority/input",
  owner: {authority: "agent-runtime", path: ["interactive-session-runtime"]}, provides: [Authority.provide()], slots: [],
});
