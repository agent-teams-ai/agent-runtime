import { isNodeProxy, detachFinalEgressInput, detachProvisionalEgressInput } from
  "../adapters/node-egress-boundary.js";
import { createProviderProcessEgressAuthorization } from
  "../application/provider-process-egress-authorization.js";
import type { EgressControlClock } from "../application/ports/outbound/egress-control-clock.js";
import type { EgressCanonicalDigest, EgressDecisionSigner, EgressDecisionVerifier } from
  "../application/ports/outbound/egress-cryptography.js";
import type { RequestFinalEgressAuthorizationV1, RequestProvisionalEgressAuthorizationV1 } from
  "../contracts/provider-process-egress-authorization-v1.js";

export interface ProviderProcessEgressAuthorizationDependencies {
  readonly clock: EgressControlClock;
  readonly digest: EgressCanonicalDigest;
  readonly signer: EgressDecisionSigner;
  readonly verifier: EgressDecisionVerifier;
}

const snapshotFunction = (owner: unknown, name: string): ((...input: never[]) => unknown) => {
  if (owner === null || typeof owner !== "object" || isNodeProxy(owner)) {throw new TypeError("invalid dependency");}
  const descriptor = Object.getOwnPropertyDescriptor(owner, name);
  if (descriptor === undefined || !("value" in descriptor) || typeof descriptor.value !== "function") {
    throw new TypeError("invalid dependency operation");
  }
  return descriptor.value.bind(owner) as (...input: never[]) => unknown;
};

const snapshotDependencies = (input: ProviderProcessEgressAuthorizationDependencies) => {
  if (input === null || typeof input !== "object" || isNodeProxy(input) ||
    Object.getPrototypeOf(input) !== Object.prototype) {throw new TypeError("invalid dependencies");}
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const keys = Object.keys(descriptors).toSorted();
  if (keys.join("\0") !== ["clock", "digest", "signer", "verifier"].toSorted().join("\0") ||
    keys.some(key => descriptors[key] === undefined || !("value" in descriptors[key]!))) {
    throw new TypeError("inexact dependencies");
  }
  const clockNow = snapshotFunction(input.clock, "now") as () => number;
  const digest = snapshotFunction(input.digest, "digest") as (value: string) => string;
  const sign = snapshotFunction(input.signer, "sign") as
    (value: string, generation: string) => { keyRef: string; keyGeneration: string; value: string };
  const verify = snapshotFunction(input.verifier, "verify") as
    (value: string, signature: { keyRef: string; keyGeneration: string; value: string }) => boolean;
  return Object.freeze({ clock: Object.freeze({ now: clockNow }),
    digest: Object.freeze({ digest }), signer: Object.freeze({ sign }), verifier: Object.freeze({ verify }) });
};

const invalid = (phase: "provisional" | "final") => Object.freeze({ status: "denied" as const,
  evidence: Object.freeze({ contractVersion: "provider-process-egress-denial-evidence/v1" as const,
    phase, issueCode: "invalid_input" as const, authorizationRef: "invalid" }) });

export const createProviderProcessEgressAuthorizationFeature = (
  dependencies: ProviderProcessEgressAuthorizationDependencies,
) => {
  const authority = createProviderProcessEgressAuthorization(snapshotDependencies(dependencies));
  const hostEgressAuthorizationV1 = Object.freeze({
    requestProvisional(input: RequestProvisionalEgressAuthorizationV1) {
      try {
        return authority.requestProvisional(detachProvisionalEgressInput(input) as
          RequestProvisionalEgressAuthorizationV1);
      } catch { return invalid("provisional"); }
    },
    authorizeFirstApplicationByte(input: RequestFinalEgressAuthorizationV1) {
      try {
        return authority.authorizeFirstApplicationByte(detachFinalEgressInput(input) as
          RequestFinalEgressAuthorizationV1);
      } catch { return invalid("final"); }
    },
  });
  return Object.freeze({ hostEgressAuthorizationV1 });
};
