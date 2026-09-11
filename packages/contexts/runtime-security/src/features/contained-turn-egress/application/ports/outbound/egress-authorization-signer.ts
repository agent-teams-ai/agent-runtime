import type { EgressAuthorizationEnvelopeV1 } from "../../../domain/egress-authorization.js";

export interface EgressAuthorizationSignerV1 {
  sign(canonicalBody: Uint8Array, key: Readonly<{keyId: string; keyGeneration: string;
    signerRevision: string}>): unknown;
  verify(canonicalBody: Uint8Array, envelope: EgressAuthorizationEnvelopeV1): unknown;
}
