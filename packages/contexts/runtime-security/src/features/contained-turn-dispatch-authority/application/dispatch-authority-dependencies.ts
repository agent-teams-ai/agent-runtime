import type { DispatchControlClock } from "./ports/outbound/control-clock.js";
import type { DispatchConsumptionRepository } from "./ports/outbound/dispatch-consumption-repository.js";
import type { DispatchDigest } from "./ports/outbound/dispatch-digest.js";

export interface DispatchAuthorityOperations {
  readonly consumeAtomically: DispatchConsumptionRepository["consumeAtomically"];
  readonly observe: DispatchConsumptionRepository["observe"];
  readonly settleAtomically: DispatchConsumptionRepository["settleAtomically"];
  readonly now: DispatchControlClock["now"];
  readonly digestCanonical: DispatchDigest["digestCanonical"];
}
