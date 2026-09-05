import type { EgressAuthorizationEnvelopeV1 } from "./composition.js";
import type { FirstWriteInput } from "./first-write.js";
import { isDigest } from "./validation.js";
const freeze = Object.freeze;
export const signWrite = (canonicalBody: Uint8Array, input: FirstWriteInput) => {
  const {owners, policy, primitives, validation} = input;
  let envelope: EgressAuthorizationEnvelopeV1 | undefined;
  try {const signed = owners.signer.sign(canonicalBody.slice(), freeze({keyId: policy.keyId,
    keyGeneration: policy.keyGeneration, signerRevision: policy.signerRevision}));
    if (!primitives.thenable(signed)) {const raw = validation.exact(signed, ["keyId", "keyGeneration", "signerRevision", "digest", "signature"]);
      if (raw?.keyId === policy.keyId && raw.keyGeneration === policy.keyGeneration && raw.signerRevision === policy.signerRevision &&
          isDigest(raw.digest) && primitives.canonicalEd25519Signature(raw.signature)) {envelope = freeze({...raw}) as EgressAuthorizationEnvelopeV1;}}
  } catch {envelope = undefined;}
  let verified: unknown = false;
  try {verified = envelope === undefined ? false : owners.signer.verify(canonicalBody.slice(), envelope);} catch {verified = false;}
  return envelope !== undefined && envelope.digest === validation.hash(canonicalBody) &&
    !primitives.thenable(verified) && verified === true ? envelope : undefined;
};
