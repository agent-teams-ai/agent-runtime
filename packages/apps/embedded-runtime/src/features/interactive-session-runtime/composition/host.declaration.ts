import {declareModule} from "@get-modular/assembly";
import {required} from "@get-modular/core";
import {Store, Provider, Authority, Custody, Context, Ownership, Host} from "./interactive-session-runtime.contracts.js";

export const hostDeclaration = declareModule({
  moduleId: "agent-runtime/interactive-host/host", implementationId: "agent-runtime/interactive-host/host/default",
  owner: {authority: "agent-runtime", path: ["interactive-session-runtime"]}, provides: [Host.provide()],
  slots: [Store.slot("store", required()), Provider.slot("provider", required()), Authority.slot("authority", required()),
    Custody.slot("custody", required()), Context.slot("context", required()), Ownership.slot("ownership", required())],
});
