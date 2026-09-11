import { createValidationTools, isEgressIdentifier, type EgressSecurityPrimitives } from "../domain/validation.js";
import type { TrustedEgressHostIdentityV1 } from "../domain/host-identity.js";
import type { ContainedTurnEgressDependencies } from "./contained-turn-egress-dependencies.js";
import type { EgressTransportV1 } from "./ports/outbound/egress-transport.js";

/** Validates the untrusted composition inputs a caller supplies (identity + every outbound port)
 * before the gateway trusts any of it. Fails closed on any missing/mistyped/extra member. */
export const captureComposition = (primitives: EgressSecurityPrimitives, identity: unknown, dependencies: unknown) => {
  const {exact, methods} = createValidationTools(primitives);
  const host = exact(identity, ["attemptId", "environmentId", "gatewayId", "hostInstanceId", "hostBootId", "transportMode"]);
  const deps = exact(dependencies, ["routeAuthority", "dispatchAuthority", "policyAuthority", "signer", "transportGateway", "clock"]);
  const routeAuthority = methods(deps?.routeAuthority, ["resolveExact", "revalidateExact"]);
  const dispatchAuthority = methods(deps?.dispatchAuthority, ["observeDispatchConsumption"]);
  const policyAuthority = methods(deps?.policyAuthority, ["resolve", "revalidateExact", "consumeFirstWrite"]);
  const signer = methods(deps?.signer, ["sign", "verify"]);
  const transportGateway = methods(deps?.transportGateway, ["openOneShotHttps"]);
  const clock = methods(deps?.clock, ["now"]);
  if (host === undefined || ![host.attemptId, host.environmentId, host.gatewayId, host.hostInstanceId, host.hostBootId].every(isEgressIdentifier) ||
      host.transportMode !== "one_shot_https" || routeAuthority === undefined || dispatchAuthority === undefined ||
      policyAuthority === undefined || signer === undefined || transportGateway === undefined || clock === undefined) {
    throw new TypeError("invalid contained turn egress composition");
  }
  return Object.freeze({identity: Object.freeze({...host}) as TrustedEgressHostIdentityV1,
    dependencies: Object.freeze({routeAuthority, dispatchAuthority, policyAuthority, signer,
      transportGateway, clock}) as unknown as ContainedTurnEgressDependencies});
};

/** Validates the untrusted session a transport gateway open call returns before the gateway
 * trusts either of its two callable surfaces. */
export const captureTransport = (primitives: EgressSecurityPrimitives, value: unknown) => {
  const {exact, methods} = createValidationTools(primitives);
  const session = exact(value, ["transport", "firstWrite"]); const transport = methods(session?.transport, ["execute", "close"]);
  const writer = methods(session?.firstWrite, ["writeExact"]); if (transport === undefined || writer === undefined) {return;}
  return Object.freeze({transport: transport as unknown as EgressTransportV1,
    writeExact: writer.writeExact as (input: unknown) => unknown});
};
