import type { EgressDecisionSignatureV1, EgressSigningKeyMetadataV1 } from
  "../../../contracts/provider-process-egress-authorization-v1.js";

export interface EgressCanonicalDigest { digest(canonicalValue: string): string; }

export interface EgressDecisionSigner {
  sign(decisionDigest: string, signingKey: EgressSigningKeyMetadataV1):
    EgressDecisionSignatureV1;
}

export interface EgressDecisionVerifier {
  verify(decisionDigest: string, signature: EgressDecisionSignatureV1): boolean;
}
