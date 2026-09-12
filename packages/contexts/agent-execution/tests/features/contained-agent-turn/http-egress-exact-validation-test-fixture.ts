import type {HttpEgressRoute} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/egress/http-egress-ports.js";

export const routeWith = (
  route: HttpEgressRoute,
  field: keyof HttpEgressRoute,
  value: unknown,
): HttpEgressRoute => {
  const changed = {...route};
  Reflect.set(changed, field, value);
  return Object.freeze(changed);
};
