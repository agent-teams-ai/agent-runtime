import { sign as ed25519Sign, verify as ed25519Verify, type KeyObject } from "node:crypto";

import type { EgressAuthorizationEnvelopeV1, EgressAuthorizationSignerV1 } from "./composition.js";
import { exact, hash } from "./validation.js";

/** Node key identity is deliberately confined to this Node adapter. */
export interface NodeEd25519SignerIdentity {
  readonly keyId: string; readonly keyGeneration: string; readonly signerRevision: string;
  readonly privateKey: KeyObject; readonly publicKey: KeyObject;
}
export const createNodeEd25519EgressSigner = (identity: NodeEd25519SignerIdentity): EgressAuthorizationSignerV1 => {
  const captured = exact(identity, ["keyId", "keyGeneration", "signerRevision", "privateKey", "publicKey"]);
  const privateKey = captured?.privateKey as KeyObject | undefined; const publicKey = captured?.publicKey as KeyObject | undefined;
  if (captured === undefined || typeof captured.keyId !== "string" || typeof captured.keyGeneration !== "string" ||
      typeof captured.signerRevision !== "string" || privateKey?.type !== "private" || publicKey?.type !== "public" ||
      privateKey.asymmetricKeyType !== "ed25519" || publicKey.asymmetricKeyType !== "ed25519") {
    throw new TypeError("invalid Ed25519 signer identity");
  }
  const key = Object.freeze({...captured}) as unknown as NodeEd25519SignerIdentity;
  return Object.freeze({
    sign(body: Uint8Array, expected: Readonly<{keyId: string; keyGeneration: string; signerRevision: string}>) {
      if (expected.keyId !== key.keyId || expected.keyGeneration !== key.keyGeneration ||
          expected.signerRevision !== key.signerRevision) {throw new Error("signing authority mismatch");}
      return Object.freeze({keyId: key.keyId, keyGeneration: key.keyGeneration, signerRevision: key.signerRevision,
        digest: hash(body), signature: ed25519Sign(null, body, key.privateKey).toString("base64")});
    },
    verify(body: Uint8Array, envelope: EgressAuthorizationEnvelopeV1) {
      return envelope.keyId === key.keyId && envelope.keyGeneration === key.keyGeneration &&
        envelope.signerRevision === key.signerRevision && envelope.digest === hash(body) &&
        ed25519Verify(null, body, key.publicKey, Buffer.from(envelope.signature, "base64"));
    },
  });
};
