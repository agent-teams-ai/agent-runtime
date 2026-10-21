import {declareModule} from "@get-modular/assembly";
import {Store} from "./interactive-session-runtime.contracts.js";

export const storeDeclaration = declareModule({
  moduleId: "agent-runtime/interactive-host/store", implementationId: "agent-runtime/interactive-host/store/input",
  owner: {authority: "agent-runtime", path: ["interactive-session-runtime"]}, provides: [Store.provide()], slots: [],
});
