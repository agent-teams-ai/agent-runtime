import type {
  EgressAuthorityReadOutcomeV1,
  TrustedEgressCompositionScopeV1,
  TrustedHostRequestProjectionV1,
} from "../../../contracts/provider-process-egress-authorization-v1.js";

export interface EgressAuthorityOwnerReadPort {
  resolvePolicy(input: Readonly<{
    scope: TrustedEgressCompositionScopeV1;
    authorizationRequestId: string;
    request: TrustedHostRequestProjectionV1;
  }>): Promise<EgressAuthorityReadOutcomeV1>;
  readCurrent(input: Readonly<{
    scope: TrustedEgressCompositionScopeV1;
    authorityRef: string;
  }>): Promise<EgressAuthorityReadOutcomeV1>;
}
