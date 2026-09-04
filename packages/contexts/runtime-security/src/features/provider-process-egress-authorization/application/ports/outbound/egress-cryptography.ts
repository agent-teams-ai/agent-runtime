export interface EgressCanonicalDigest {
  digest(canonicalValue: string): string;
}

export interface EgressDecisionSignature {
  readonly keyRef: string;
  readonly keyGeneration: string;
  readonly value: string;
}

export interface EgressDecisionSigner {
  sign(decisionDigest: string, keyGeneration: string): EgressDecisionSignature;
}

export interface EgressDecisionVerifier {
  verify(decisionDigest: string, signature: EgressDecisionSignature): boolean;
}
