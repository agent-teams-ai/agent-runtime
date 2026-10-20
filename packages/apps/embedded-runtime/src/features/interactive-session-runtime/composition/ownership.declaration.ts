import {declareModule} from "@get-modular/assembly";
import {Ownership} from "./interactive-session-runtime.contracts.js";

export const ownershipDeclaration = declareModule({
  moduleId: "agent-runtime/interactive-host/ownership", implementationId: "agent-runtime/interactive-host/ownership/input",
  owner: {authority: "agent-runtime", path: ["interactive-session-runtime"]}, provides: [Ownership.provide()], slots: [],
});
