import type { EgressDispatchObservation } from "../domain/dispatch-consumption.js";
import type { MonotonicClock } from "./ports/outbound/monotonic-clock.js";
import type { EgressAuthorizationSignerV1 } from "./ports/outbound/egress-authorization-signer.js";
import type { EgressPolicyTimeAuthorityV1 } from "./ports/outbound/egress-policy-time-authority.js";
import type { EgressTransportGatewayV1 } from "./ports/outbound/egress-exchange.js";
import type { ProviderRouteAuthorityV1 } from "./ports/outbound/provider-route-authority.js";

export interface ContainedTurnEgressDependencies {
  readonly routeAuthority: ProviderRouteAuthorityV1;
  readonly dispatchAuthority: {
    readonly observeDispatchConsumption: (input: EgressDispatchObservation) => Promise<unknown>;
  };
  readonly policyAuthority: EgressPolicyTimeAuthorityV1; readonly signer: EgressAuthorizationSignerV1;
  readonly transportGateway: EgressTransportGatewayV1;
}

/** Internal composition-root shape: adds the monotonic clock the write-authorization lease
 * timing check needs. Callers of the public gateway factory cannot supply this value; the
 * composition root always wires it from the Node adapter, the same way sibling
 * contained-turn-dispatch-authority keeps its own control clock out of caller-suppliable input. */
export interface ContainedTurnEgressRuntimeDependencies extends ContainedTurnEgressDependencies {
  readonly clock: MonotonicClock;
}
