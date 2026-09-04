import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import type { EgressCanonicalDigest, EgressDecisionSigner, EgressDecisionVerifier } from
  "../../application/ports/outbound/egress-cryptography.js";
import type { EgressDecisionSignatureV1, EgressSigningKeyMetadataV1 } from
  "../../contracts/provider-process-egress-authorization-v1.js";

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
    sign(decisionDigest: string, signingKey: EgressSigningKeyMetadataV1) {
      if (signingKey.algorithm !== "hmac-sha256-synthetic" || signingKey.keyRef !== keyRef) {
        throw new TypeError("unsupported synthetic signing key");
      }
      return Object.freeze({ ...signingKey,
        value: calculate(decisionDigest, signingKey.keyGeneration) });
    },
    verify(decisionDigest: string, signature: EgressDecisionSignatureV1) {
      if (signature.algorithm !== "hmac-sha256-synthetic" || signature.keyRef !== keyRef ||
        !/^[0-9a-f]{64}$/.test(signature.value)) {return false;}
      const expected = Buffer.from(calculate(decisionDigest, signature.keyGeneration), "hex");
      const actual = Buffer.from(signature.value, "hex");
      return expected.length === actual.length && timingSafeEqual(expected, actual);
    },
  });
};
