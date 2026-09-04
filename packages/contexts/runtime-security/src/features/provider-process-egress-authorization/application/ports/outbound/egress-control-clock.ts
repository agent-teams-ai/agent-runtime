import type { EgressControlTimeV1 } from
  "../../../contracts/provider-process-egress-authorization-v1.js";

export interface EgressControlClock {
  read(): EgressControlTimeV1;
}
