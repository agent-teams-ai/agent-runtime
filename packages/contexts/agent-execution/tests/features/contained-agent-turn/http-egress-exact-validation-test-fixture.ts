import { createHash } from "node:crypto";
import type {
  HttpEgressFinalAuthorization,
  HttpEgressFinalAuthorizationDecision,
  HttpEgressRoute,
} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/egress/http-egress-ports.js";
import {
  canonicalFinalAuthorizationBindingParts,
} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/egress/http-final-authorization-binding.js";
import type {
  HttpEgressFinalAuthorizationFacts,
} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/egress/http-final-authorization-binding.js";

export const digestParts = (parts: readonly Uint8Array[]): string => {
  const hash = createHash("sha256");
  for (const part of parts) {hash.update(part);}
  return hash.digest("hex");
};

export const authorizationFacts = (
  input: HttpEgressFinalAuthorization,
): HttpEgressFinalAuthorizationFacts => {
  const { bindingDigest: _bindingDigest, ...facts } = input;
  return facts;
};

export const bindingDigestWith = (
  input: HttpEgressFinalAuthorization,
  changes: Partial<HttpEgressFinalAuthorizationFacts>,
): string => digestParts(canonicalFinalAuthorizationBindingParts(Object.freeze({
  ...authorizationFacts(input),
  ...changes,
})));

export const allowForBinding = (
  input: HttpEgressFinalAuthorization,
  bindingDigest: string,
): HttpEgressFinalAuthorizationDecision => Object.freeze({
  decision: "allow",
  receiptDigest: "final-receipt-digest",
  validUntil: 900,
  policyGeneration: input.policyGeneration,
  keyGeneration: input.keyGeneration,
  routeGeneration: input.routeGeneration,
  credentialGeneration: input.credentialGeneration,
  materializationReceiptDigest: input.materializationReceiptDigest,
  bindingDigest,
});

export const routeWith = (
  route: HttpEgressRoute,
  field: keyof HttpEgressRoute,
  value: unknown,
): HttpEgressRoute => {
  const changed = { ...route };
  Reflect.set(changed, field, value);
  return Object.freeze(changed);
};
