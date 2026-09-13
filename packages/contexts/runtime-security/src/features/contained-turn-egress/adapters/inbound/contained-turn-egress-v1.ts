import type {
  ContainedTurnEgress as ContainedTurnEgressV1,
  ContainedTurnEgressRequest as ContainedTurnEgressV1Request,
} from "../../contracts/contained-turn-egress-v1.js";
import type { ContainedTurnEgress } from "../../application/contained-turn-egress.js";
import type { ContainedTurnEgressRequest } from "../../domain/egress-request.js";

/** Perimeter check, not the owner of the rule. The gateway core already refuses
 * a malformed exchange before touching outbound ports; repeating the request
 * shape here keeps transport types off the application use-case interface. */
const request = (input: ContainedTurnEgressV1Request): ContainedTurnEgressRequest => input;

/** Projects the application gateway onto the published contract. The two shapes
 * coincide today, so this is a structural pass-through; its value is that either
 * declaration can move without the other, and that the use case never names a
 * transport type. */
export const createContainedTurnEgressV1 = (
  useCase: ContainedTurnEgress,
): ContainedTurnEgressV1 => Object.freeze({
  exchange(input: ContainedTurnEgressV1Request) {
    return useCase.exchange(request(input));
  },
  dispose: () => useCase.dispose(),
});
