import { readFileSync } from "node:fs";

const header = readFileSync(new URL("./native/darwin-attempt-owner-protocol.h", import.meta.url), "utf8");
const definitions = new Map<string, number | string>();
for (const match of header.matchAll(/^#define (AE_[A-Z0-9_]+) (\d+|"[^"\n]+")$/gmu)) {
  const name = match[1];
  const literal = match[2];
  if (name === undefined || literal === undefined || definitions.has(name)) {
    throw new Error("duplicate native owner protocol definition");
  }
  definitions.set(name, literal.startsWith('"') ? literal.slice(1, -1) : Number(literal));
}

export const darwinAttemptOwnerNumeric = (name: string): number => {
  const value = definitions.get(`AE_${name}`);
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`missing native owner protocol definition: ${name}`);
  }
  return value;
};

export const darwinAttemptOwnerString = (name: string): string => {
  const value = definitions.get(`AE_${name}`);
  if (typeof value !== "string") {throw new Error(`missing native owner protocol definition: ${name}`);}
  return value;
};

const digestBytes = darwinAttemptOwnerNumeric("DIGEST_BYTES");
export const darwinAttemptOwnerDigest = new RegExp(`^[a-f0-9]{${digestBytes * 2}}$`, "u");
export {digestBytes as darwinAttemptOwnerDigestBytes};
