import {declareModule} from "@get-modular/assembly";
import {Custody} from "./interactive-session-runtime.contracts.js";

export const custodyDeclaration = declareModule({
  moduleId: "agent-runtime/interactive-host/custody", implementationId: "agent-runtime/interactive-host/custody/input",
  owner: {authority: "agent-runtime", path: ["interactive-session-runtime"]}, provides: [Custody.provide()], slots: [],
});
