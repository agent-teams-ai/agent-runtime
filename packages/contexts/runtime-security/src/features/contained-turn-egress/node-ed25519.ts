import { createHash, sign as ed25519Sign, verify as ed25519Verify, type KeyObject } from "node:crypto";
import { types as nodeTypes } from "node:util";

import type { EgressAuthorizationEnvelopeV1, EgressAuthorizationSignerV1 } from "./composition.js";
const hash = (body: Uint8Array) => `sha256:${createHash("sha256").update(body).digest("hex")}`;
const exact = (value: unknown, names: readonly string[]) => {
  if (typeof value !== "object" || value === null || nodeTypes.isProxy(value)) {return;}
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== names.length) {return;}
  const result: Record<string, unknown> = {};
  for (const name of names) {const descriptor = descriptors[name]; if (descriptor === undefined || !("value" in descriptor)) {return;}
    result[name] = descriptor.value;} return result;
};

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
      if (!/^[A-Za-z0-9+/]{86}==$/u.test(envelope.signature)) {return false;}
      const signature = Buffer.from(envelope.signature, "base64");
      if (signature.byteLength !== 64 || signature.toString("base64") !== envelope.signature) {return false;}
      return envelope.keyId === key.keyId && envelope.keyGeneration === key.keyGeneration &&
        envelope.signerRevision === key.signerRevision && envelope.digest === hash(body) &&
        ed25519Verify(null, body, key.publicKey, signature);
    },
  });
};
