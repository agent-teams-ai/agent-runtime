import type { ContainedTurnDispatchAuthorityV1 } from
  "../../contained-turn-dispatch-authority/contracts/contained-turn-dispatch-authority-v1.js";
import type { MonotonicClock } from "./ports/outbound/monotonic-clock.js";
import type { EgressAuthorizationSignerV1 } from "./ports/outbound/egress-authorization-signer.js";
import type { EgressPolicyTimeAuthorityV1 } from "./ports/outbound/egress-policy-time-authority.js";
import type { EgressTransportGatewayV1 } from "./ports/outbound/egress-exchange.js";
import type { ProviderRouteAuthorityV1 } from "./ports/outbound/provider-route-authority.js";

export interface ContainedTurnEgressDependencies {
  readonly routeAuthority: ProviderRouteAuthorityV1;
  readonly dispatchAuthority: Pick<ContainedTurnDispatchAuthorityV1, "observeDispatchConsumption">;
  readonly policyAuthority: EgressPolicyTimeAuthorityV1; readonly signer: EgressAuthorizationSignerV1;
  readonly transportGateway: EgressTransportGatewayV1; readonly clock: MonotonicClock;
}
