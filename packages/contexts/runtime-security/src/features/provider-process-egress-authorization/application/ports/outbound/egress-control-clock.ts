import type { EgressControlTime } from "../../../domain/provider-process-egress-model.js";

export interface EgressControlClock {
  read(): EgressControlTime;
}
