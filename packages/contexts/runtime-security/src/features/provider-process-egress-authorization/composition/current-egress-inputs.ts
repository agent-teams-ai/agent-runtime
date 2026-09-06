import type { EgressBudgetsV2, EgressTlsOriginV2, TrustedEgressCompositionScopeV2,
  TrustedHostRequestProjectionV2 } from "../contracts/provider-process-egress-authorization-v2.js";

// Private composition DTOs only. The outer ACL projects the existing owners;
// neither this file nor the authorization application imports their private types.
export interface CurrentEgressOperation {
  readonly scope: TrustedEgressCompositionScopeV2;
  readonly providerId: string;
  readonly authorityGeneration: string;
  readonly claimBindingDigest: string;
}

// Full RS readAuthority projection, including the independent durable CAS version.
export interface CurrentEgressDispatchHead {
  readonly headVersion: string;
  readonly authority: null | {
    readonly operation: CurrentEgressOperation;
    readonly decision: "accepted";
    readonly purpose: "contained-turn.provider-dispatch/v1";
    readonly authorityRevision: string;
    readonly acceptedAuthorityDigest: string;
    readonly authorityHeadDigest: string;
    readonly constraintsDigest: string;
    readonly containmentPolicyDigest: string;
    readonly requestDigest: string;
    readonly providerBindingDigest: string;
    readonly claimBeforeControlTime: number;
    readonly revoked: boolean;
    readonly ownerEvidenceRef: string;
  };
}

// Exact HTTP permission shape. PA endorses the whole shape and the recipe
// association; RS separately approves it as part of its immutable rule.
export interface CurrentEgressRoute {
  readonly method: TrustedHostRequestProjectionV2["method"];
  readonly origin: EgressTlsOriginV2;
  readonly requestTarget: TrustedHostRequestProjectionV2["requestTarget"];
  readonly credentialSlots: readonly string[];
  readonly credentialRecipeRef: string;
  readonly framing: {
    readonly protocol: "http/1.1";
    readonly requestTarget: "origin-form";
    readonly authoritySource: "host";
    readonly contentLength: "body-byte-length";
    readonly transferEncoding: "absent";
    readonly connectionSpecificHeaders: "absent";
  };
}

export interface CurrentEgressRule {
  readonly policyRef: string;
  readonly revision: string;
  readonly expectedAcceptedConstraintsDigest: string;
  readonly route: CurrentEgressRoute;
  readonly tlsPolicyDigest: string;
  readonly limits: EgressBudgetsV2;
  readonly decisionTtlMilliseconds: number;
}

// PA owns these facts, including the ORIGINAL credential digest and an independent
// route digest. The ACL must preserve PA's selected full route, never infer it from
// provider name. Null means absence; unavailable/revoked remain explicit facts.
export interface CurrentEgressEndorsement {
  readonly operation: CurrentEgressOperation;
  readonly accessRef: string;
  readonly accountRef: string;
  readonly providerRouteRef: string;
  readonly bindingRevision: number;
  readonly credentialBindingDigest: string;
  readonly credentialGeneration: string;
  readonly routeAuthorityDigest: string;
  readonly available: boolean;
  readonly revoked: boolean;
  readonly route: CurrentEgressRoute;
}

export interface CurrentEgressOwnerInput {
  readonly operation: CurrentEgressOperation;
  readonly acceptedDispatch: CurrentEgressDispatchHead;
  readonly rule: CurrentEgressRule;
  // Trusted root approval is independent of the rule. Digest preimage is
  // { domain: "rs-current-egress-rule/v1", operation, acceptedDispatch, rule }.
  // Opaque dispatch constraints are compared, never treated as an HTTP policy.
  readonly approval: { readonly ruleRevision: string; readonly bindingDigest: string };
  // Trusted root supplies the running operation clock and deadline after claim
  // commitment. Claim-window checks remain at dispatch; signing time is separate.
  readonly timing: {
    readonly controlTimeAtAnchor: number;
    readonly monotonicAtAnchor: number;
    readonly operationDeadlineMonotonic: number;
    readonly readTimeoutMilliseconds: number;
  };
  readonly monotonicNow: () => number;
  // Trusted native async reader implementations with intact Promise intrinsics.
  // Their implementations must not create hostile promises/thenables or detached
  // rejections; the owner validates returned DATA, not arbitrary callback code.
  // Use explicit async wrappers for repository receivers, not bound functions.
  // Borrowed callbacks: no close/dispose/resource ownership is transferred.
  readonly readRsHead: (operation: CurrentEgressOperation) => Promise<CurrentEgressDispatchHead>;
  readonly readPaEndorsement: (operation: CurrentEgressOperation) =>
    Promise<CurrentEgressEndorsement | null>;
}
