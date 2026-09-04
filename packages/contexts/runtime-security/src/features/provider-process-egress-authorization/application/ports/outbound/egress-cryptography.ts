import type { EgressDecisionSignature, EgressSigningKeyMetadata } from
  "../../../domain/provider-process-egress-model.js";

export interface EgressCanonicalDigest { digest(canonicalValue: string): string; }

export interface EgressDecisionSigner {
  sign(decisionDigest: string, signingKey: EgressSigningKeyMetadata):
    EgressDecisionSignature;
}

export interface EgressDecisionVerifier {
  verify(decisionDigest: string, signature: EgressDecisionSignature): boolean;
}
