import {declareModule} from "@get-modular/assembly";
import {Context} from "./interactive-session-runtime.contracts.js";

export const contextDeclaration = declareModule({
  moduleId: "agent-runtime/interactive-host/context", implementationId: "agent-runtime/interactive-host/context/input",
  owner: {authority: "agent-runtime", path: ["interactive-session-runtime"]}, provides: [Context.provide()], slots: [],
});
