import { createHash, createHmac, generateKeyPairSync, sign, timingSafeEqual, verify } from "node:crypto";

import type { EgressCanonicalDigest, EgressDecisionSigner, EgressDecisionVerifier } from
  "../../application/ports/outbound/egress-cryptography.js";
import type { EgressDecisionSignature, EgressSigningKeyMetadata } from
  "../../domain/provider-process-egress-model.js";
import { canonicalEgressValue } from "../../application/egress-canonical.js";

export const createNodeSha256EgressDigest = (): EgressCanonicalDigest => Object.freeze({
  digest(canonicalValue: string): string {
    return `sha256:${createHash("sha256").update(canonicalValue, "utf8").digest("hex")}`;
  },
});

export const createNodeHmacEgressDecisionSeal = (input: {
  readonly keyRef: string;
  readonly secret: string;
}): EgressDecisionSigner & EgressDecisionVerifier => {
  const keyRef = `${input.keyRef}`;
  const secret = `${input.secret}`;
  const calculate = (digest: string, generation: string): string =>
    createHmac("sha256", secret).update(`${generation}\0${digest}`, "utf8").digest("hex");
  return Object.freeze({
    sign(decisionDigest: string, signingKey: EgressSigningKeyMetadata) {
      if (signingKey.algorithm !== "hmac-sha256-synthetic" || signingKey.keyRef !== keyRef) {
        throw new TypeError("unsupported synthetic signing key");
      }
      return Object.freeze({ ...signingKey,
        value: calculate(decisionDigest, signingKey.keyGeneration) });
    },
    verify(decisionDigest: string, signature: EgressDecisionSignature) {
      if (signature.algorithm !== "hmac-sha256-synthetic" || signature.keyRef !== keyRef ||
        !/^[0-9a-f]{64}$/.test(signature.value)) {return false;}
      const expected = Buffer.from(calculate(decisionDigest, signature.keyGeneration), "hex");
      const actual = Buffer.from(signature.value, "hex");
      return expected.length === actual.length && timingSafeEqual(expected, actual);
    },
  });
};

export interface NodeEd25519EgressCandidateBinding {
  readonly keyRef: string;
  readonly keyGeneration: string;
  readonly signerRevision: string;
  readonly hostReservationId: string;
}

export const createNodeEd25519EgressCandidateSeal = (
  binding: NodeEd25519EgressCandidateBinding,
) => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const publicKeyDigest = `sha256:${createHash("sha256")
    .update(publicKey.export({ type: "spki", format: "der" })).digest("hex")}`;
  const signingKey = Object.freeze({ algorithm: "ed25519" as const,
    signatureEncoding: "hex-lower" as const, keyRef: binding.keyRef,
    publicKeyDigest, keyGeneration: binding.keyGeneration,
    signerRevision: binding.signerRevision, hostReservationId: binding.hostReservationId });
  const signingContext = canonicalEgressValue(signingKey);
  const document = (decisionDigest: string) => Buffer.from(
    `provider-process-egress-authorization/v2\0${signingContext}\0${decisionDigest}`, "utf8");
  let disposed = false;
  const verifier: EgressDecisionVerifier = Object.freeze({
    verify(decisionDigest: string, signature: EgressDecisionSignature): boolean {
      if (signature.algorithm !== "ed25519" ||
        canonicalEgressValue({ algorithm: signature.algorithm,
          signatureEncoding: signature.signatureEncoding, keyRef: signature.keyRef,
          publicKeyDigest: signature.publicKeyDigest, keyGeneration: signature.keyGeneration,
          signerRevision: signature.signerRevision,
          hostReservationId: signature.hostReservationId }) !== signingContext ||
        !/^[0-9a-f]{128}$/.test(signature.value)) {return false;}
      return verify(null, document(decisionDigest), publicKey, Buffer.from(signature.value, "hex"));
    },
  });
  const signer: EgressDecisionSigner = Object.freeze({
    sign(decisionDigest: string, requestedKey: EgressSigningKeyMetadata) {
      if (disposed || canonicalEgressValue(requestedKey) !== signingContext) {
        throw new TypeError("unavailable candidate signing key");
      }
      return Object.freeze({ ...signingKey,
        value: sign(null, document(decisionDigest), privateKey).toString("hex") });
    },
  });
  return Object.freeze({ signingKey, signer, verifier,
    dispose: () => { disposed = true; },
    isDisposed: () => disposed });
};
