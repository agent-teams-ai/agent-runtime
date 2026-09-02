import { types as utilTypes } from "node:util";

const MAX_TOKENS = 256;
const MAX_TOKEN_BYTES = 4_096;
const MAX_AGGREGATE_BYTES = 65_536;
const trustedArrayPrototype = Array.prototype;
const arrayIsArray = Array.isArray;
const defineProperty = Object.defineProperty;
const freeze = Object.freeze;
const getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const getPrototypeOf = Object.getPrototypeOf;
const hasOwn = Object.hasOwn;
const ownKeys = Reflect.ownKeys;
const utf8ByteLength = Buffer.byteLength.bind(Buffer);

interface ExpectedCredentialAuthority {
  readonly credentialBindingDigest: string;
  readonly credentialGeneration: number;
}

export const snapshotCodexCredentialOutputTokens = (
  launch: object,
  expected: ExpectedCredentialAuthority,
): readonly string[] => {
  const descriptor = getOwnPropertyDescriptor(launch, "credentialOutputInventory");
  if (descriptor === undefined || !("value" in descriptor) || descriptor.value === null
    || typeof descriptor.value !== "object" || arrayIsArray(descriptor.value) || utilTypes.isProxy(descriptor.value)) {
    throw new TypeError("Codex credential output inventory is required");
  }
  const inventory = descriptor.value as Record<string, unknown>;
  const inventoryKeys = ownKeys(inventory);
  if (inventoryKeys.length !== 3 || !hasOwn(inventory, "credentialBindingDigest")
    || !hasOwn(inventory, "credentialGeneration") || !hasOwn(inventory, "sensitiveOutputTokens")) {
    throw new TypeError("Codex credential output inventory must have an exact bounded shape");
  }
  const digest = getOwnPropertyDescriptor(inventory, "credentialBindingDigest");
  const generation = getOwnPropertyDescriptor(inventory, "credentialGeneration");
  const tokens = getOwnPropertyDescriptor(inventory, "sensitiveOutputTokens");
  if (digest === undefined || !("value" in digest) || generation === undefined || !("value" in generation)
    || tokens === undefined || !("value" in tokens) || !arrayIsArray(tokens.value) || utilTypes.isProxy(tokens.value)
    || digest.value !== expected.credentialBindingDigest || generation.value !== expected.credentialGeneration) {
    throw new TypeError("Codex credential output inventory drifted from accepted credential authority");
  }
  const tokenArray = tokens.value as unknown[];
  if (getPrototypeOf(tokenArray) !== trustedArrayPrototype) {
    throw new TypeError("Codex credential output inventory must be a trusted plain array");
  }
  const lengthDescriptor = getOwnPropertyDescriptor(tokenArray, "length");
  if (lengthDescriptor === undefined || !("value" in lengthDescriptor)
    || !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0
    || lengthDescriptor.value > MAX_TOKENS) {
    throw new TypeError("Codex credential output inventory exceeds its fixed bounds");
  }
  const length = Number(lengthDescriptor.value);
  const tokenKeys = ownKeys(tokenArray);
  let exactDenseKeys = tokenKeys.length === length + 1;
  for (let index = 0; exactDenseKeys && index <= length; index += 1) {
    exactDenseKeys = tokenKeys[index] === (index === length ? "length" : String(index));
  }
  if (!exactDenseKeys) {
    throw new TypeError("Codex credential output inventory must be a dense plain array");
  }
  const snapshot: string[] = [];
  let aggregateBytes = 0;
  for (let index = 0; index < length; index += 1) {
    const tokenDescriptor = getOwnPropertyDescriptor(tokenArray, String(index));
    if (tokenDescriptor === undefined || !("value" in tokenDescriptor)
      || typeof tokenDescriptor.value !== "string" || tokenDescriptor.value.length === 0) {
      throw new TypeError("Codex credential output inventory must contain own data strings");
    }
    const bytes = utf8ByteLength(tokenDescriptor.value, "utf8");
    aggregateBytes += bytes;
    if (bytes > MAX_TOKEN_BYTES || aggregateBytes > MAX_AGGREGATE_BYTES) {
      throw new TypeError("Codex credential output inventory exceeds its fixed bounds");
    }
    defineProperty(snapshot, String(index), {
      configurable: true, enumerable: true, value: tokenDescriptor.value, writable: true,
    });
  }
  return freeze(snapshot);
};
