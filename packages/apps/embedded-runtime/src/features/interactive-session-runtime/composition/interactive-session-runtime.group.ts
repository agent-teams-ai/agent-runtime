import {group} from "@get-modular/assembly";
import {hostModule} from "./host.module.js";

export const interactiveSessionRuntimeGroup = group("interactive-session-runtime", [
  hostModule,
]);
