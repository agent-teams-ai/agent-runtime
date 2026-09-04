import {
  detachEgressAuthorityOutcome,
  detachEgressClockView,
  detachEgressDecisionSignature,
  detachEgressScope,
  detachFinalEgressInput,
  detachProvisionalEgressInput,
  isNodeProxy,
} from "../adapters/node-egress-boundary.js";
import { deepFreezeEgress } from "../application/immutable.js";
import { createProviderProcessEgressAuthorization } from
  "../application/provider-process-egress-authorization.js";
import type { EgressAuthorityOwnerReadPort } from
  "../application/ports/outbound/egress-authority-owner.js";
import type { EgressControlClock } from "../application/ports/outbound/egress-control-clock.js";
import type { EgressCanonicalDigest, EgressDecisionSigner, EgressDecisionVerifier } from
  "../application/ports/outbound/egress-cryptography.js";
import type {
  EgressAuthorityReadOutcomeV1,
  EgressControlTimeV1,
  EgressDecisionSignatureV1,
  EgressSigningKeyMetadataV1,
  RequestFinalEgressAuthorizationV1,
  RequestProvisionalEgressAuthorizationV1,
  TrustedEgressCompositionScopeV1,
} from "../contracts/provider-process-egress-authorization-v1.js";

export interface ProviderProcessEgressAuthorizationDependencies {
  readonly scope: TrustedEgressCompositionScopeV1;
  readonly authorityOwner: EgressAuthorityOwnerReadPort;
  readonly clock: EgressControlClock;
  readonly digest: EgressCanonicalDigest;
  readonly signer: EgressDecisionSigner;
  readonly verifier: EgressDecisionVerifier;
}

const snapshotFunction = (owner: unknown, name: string): ((...input: never[]) => unknown) => {
  if (owner === null || typeof owner !== "object" || isNodeProxy(owner)) {
    throw new TypeError("invalid dependency");
  }
  const descriptor = Object.getOwnPropertyDescriptor(owner, name);
  if (descriptor === undefined || !("value" in descriptor) || typeof descriptor.value !== "function") {
    throw new TypeError("invalid dependency operation");
  }
  return descriptor.value.bind(owner) as (...input: never[]) => unknown;
};

const detachOwner = (value: unknown): EgressAuthorityReadOutcomeV1 =>
  deepFreezeEgress(detachEgressAuthorityOutcome(value) as EgressAuthorityReadOutcomeV1);

const detachSignature = (value: unknown): EgressDecisionSignatureV1 =>
  deepFreezeEgress(detachEgressDecisionSignature(value) as EgressDecisionSignatureV1);

const snapshotDependencies = (input: ProviderProcessEgressAuthorizationDependencies) => {
  if (input === null || typeof input !== "object" || isNodeProxy(input) ||
    Object.getPrototypeOf(input) !== Object.prototype) {throw new TypeError("invalid dependencies");}
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const expected = ["authorityOwner", "clock", "digest", "scope", "signer", "verifier"].toSorted();
  const ownKeys = Reflect.ownKeys(descriptors);
  if (ownKeys.some(key => typeof key === "symbol")) {throw new TypeError("inexact dependencies");}
  const keys = (ownKeys as string[]).toSorted();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index]) ||
    keys.some(key => descriptors[key] === undefined || !("value" in descriptors[key]!))) {
    throw new TypeError("inexact dependencies");
  }
  const scope = deepFreezeEgress(detachEgressScope(input.scope) as TrustedEgressCompositionScopeV1);
  const resolvePolicy = snapshotFunction(input.authorityOwner, "resolvePolicy") as
    EgressAuthorityOwnerReadPort["resolvePolicy"];
  const readCurrent = snapshotFunction(input.authorityOwner, "readCurrent") as
    EgressAuthorityOwnerReadPort["readCurrent"];
  const clockRead = snapshotFunction(input.clock, "read") as () => EgressControlTimeV1;
  const digest = snapshotFunction(input.digest, "digest") as (value: string) => string;
  const sign = snapshotFunction(input.signer, "sign") as
    (value: string, key: EgressSigningKeyMetadataV1) => EgressDecisionSignatureV1;
  const verify = snapshotFunction(input.verifier, "verify") as
    (value: string, signature: EgressDecisionSignatureV1) => boolean;
  return Object.freeze({
    scope,
    authorityOwner: Object.freeze({
      async resolvePolicy(ownerInput: Parameters<EgressAuthorityOwnerReadPort["resolvePolicy"]>[0]) {
        try { return detachOwner(await resolvePolicy(ownerInput)); }
        catch { return deepFreezeEgress({ status: "indeterminate" as const,
          reason: "owner_malformed" as const }); }
      },
      async readCurrent(ownerInput: Parameters<EgressAuthorityOwnerReadPort["readCurrent"]>[0]) {
        try { return detachOwner(await readCurrent(ownerInput)); }
        catch { return deepFreezeEgress({ status: "indeterminate" as const,
          reason: "owner_malformed" as const }); }
      },
    }),
    clock: Object.freeze({ read: () => deepFreezeEgress(
      detachEgressClockView(clockRead()) as EgressControlTimeV1) }),
    digest: Object.freeze({ digest }),
    signer: Object.freeze({ sign: (value: string, key: EgressSigningKeyMetadataV1) =>
      detachSignature(sign(value, key)) }),
    verifier: Object.freeze({ verify: (value: string, signature: EgressDecisionSignatureV1) =>
      verify(value, signature) === true }),
  });
};

const invalid = (phase: "provisional" | "final") => deepFreezeEgress({ status: "denied" as const,
  evidence: { contractVersion: "provider-process-egress-denial-evidence/v1" as const,
    phase, issueCode: "invalid_input" as const, authorizationRef: "invalid" } });

export const createProviderProcessEgressAuthorizationFeature = (
  dependencies: ProviderProcessEgressAuthorizationDependencies,
) => {
  const authority = createProviderProcessEgressAuthorization(snapshotDependencies(dependencies));
  const hostEgressAuthorizationV1 = Object.freeze({
    async requestProvisional(input: RequestProvisionalEgressAuthorizationV1) {
      try { return await authority.requestProvisional(detachProvisionalEgressInput(input) as
        RequestProvisionalEgressAuthorizationV1); } catch { return invalid("provisional"); }
    },
    async authorizeFirstApplicationByte(input: RequestFinalEgressAuthorizationV1) {
      try { return await authority.authorizeFirstApplicationByte(detachFinalEgressInput(input) as
        RequestFinalEgressAuthorizationV1); } catch { return invalid("final"); }
    },
  });
  return Object.freeze({ hostEgressAuthorizationV1 });
};
