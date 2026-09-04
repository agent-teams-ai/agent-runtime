import type {
  EgressAuthorityReadOutcome,
  TrustedEgressCompositionScope,
  TrustedHostRequestProjection,
} from "../../../domain/provider-process-egress-model.js";

export interface EgressAuthorityOwnerReadPort {
  resolvePolicy(input: Readonly<{
    scope: TrustedEgressCompositionScope;
    authorizationRequestId: string;
    request: TrustedHostRequestProjection;
  }>): Promise<EgressAuthorityReadOutcome>;
  readCurrent(input: Readonly<{
    scope: TrustedEgressCompositionScope;
    authorityRef: string;
  }>): Promise<EgressAuthorityReadOutcome>;
}
