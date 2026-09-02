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
const utilTypes = (process.getBuiltinModule("node:util") as {
  readonly types: {readonly isProxy: (value: unknown) => boolean};
}).types;
const utf8ByteLength = Buffer.byteLength.bind(Buffer);

interface ExpectedCredentialAuthority {
  readonly credentialBindingDigest: string;
  readonly credentialGeneration: number;
}

const isDataDescriptor = (
  descriptor: PropertyDescriptor | undefined,
): descriptor is PropertyDescriptor & {readonly value: unknown} =>
  descriptor !== undefined && "value" in descriptor;

const readInventory = (launch: object): Record<string, unknown> => {
  const descriptor = getOwnPropertyDescriptor(launch, "credentialOutputInventory");
  if (!isDataDescriptor(descriptor) || descriptor.value === null
    || typeof descriptor.value !== "object" || arrayIsArray(descriptor.value)
    || utilTypes.isProxy(descriptor.value)) {
    throw new TypeError("Codex credential output inventory is required");
  }
  return descriptor.value as Record<string, unknown>;
};

const assertExactInventoryShape = (inventory: Record<string, unknown>): void => {
  const inventoryKeys = ownKeys(inventory);
  if (inventoryKeys.length !== 3 || !hasOwn(inventory, "credentialBindingDigest")
    || !hasOwn(inventory, "credentialGeneration") || !hasOwn(inventory, "sensitiveOutputTokens")) {
    throw new TypeError("Codex credential output inventory must have an exact bounded shape");
  }
};

const readTokenArray = (
  inventory: Record<string, unknown>,
  expected: ExpectedCredentialAuthority,
): unknown[] => {
  const digest = getOwnPropertyDescriptor(inventory, "credentialBindingDigest");
  const generation = getOwnPropertyDescriptor(inventory, "credentialGeneration");
  const tokens = getOwnPropertyDescriptor(inventory, "sensitiveOutputTokens");
  if (!isDataDescriptor(digest) || !isDataDescriptor(generation) || !isDataDescriptor(tokens)
    || !arrayIsArray(tokens.value) || utilTypes.isProxy(tokens.value)
    || digest.value !== expected.credentialBindingDigest
    || generation.value !== expected.credentialGeneration) {
    throw new TypeError("Codex credential output inventory drifted from accepted credential authority");
  }
  return tokens.value as unknown[];
};

const readBoundedLength = (tokenArray: unknown[]): number => {
  if (getPrototypeOf(tokenArray) !== trustedArrayPrototype) {
    throw new TypeError("Codex credential output inventory must be a trusted plain array");
  }
  const descriptor = getOwnPropertyDescriptor(tokenArray, "length");
  if (!isDataDescriptor(descriptor) || !Number.isSafeInteger(descriptor.value)
    || Number(descriptor.value) < 0 || Number(descriptor.value) > MAX_TOKENS) {
    throw new TypeError("Codex credential output inventory exceeds its fixed bounds");
  }
  return Number(descriptor.value);
};

const assertDenseArray = (tokenArray: unknown[], length: number): void => {
  const tokenKeys = ownKeys(tokenArray);
  if (tokenKeys.length !== length + 1) {
    throw new TypeError("Codex credential output inventory must be a dense plain array");
  }
  for (let index = 0; index <= length; index += 1) {
    if (tokenKeys[index] !== (index === length ? "length" : String(index))) {
      throw new TypeError("Codex credential output inventory must be a dense plain array");
    }
  }
};

const snapshotTokens = (tokenArray: unknown[], length: number): readonly string[] => {
  const snapshot: string[] = [];
  let aggregateBytes = 0;
  for (let index = 0; index < length; index += 1) {
    const descriptor = getOwnPropertyDescriptor(tokenArray, String(index));
    if (!isDataDescriptor(descriptor) || typeof descriptor.value !== "string"
      || descriptor.value.length === 0) {
      throw new TypeError("Codex credential output inventory must contain own data strings");
    }
    const bytes = utf8ByteLength(descriptor.value, "utf8");
    aggregateBytes += bytes;
    if (bytes > MAX_TOKEN_BYTES || aggregateBytes > MAX_AGGREGATE_BYTES) {
      throw new TypeError("Codex credential output inventory exceeds its fixed bounds");
    }
    defineProperty(snapshot, String(index), {
      configurable: true, enumerable: true, value: descriptor.value, writable: true,
    });
  }
  return freeze(snapshot);
};

export const snapshotCodexCredentialOutputTokens = (
  launch: object,
  expected: ExpectedCredentialAuthority,
): readonly string[] => {
  const inventory = readInventory(launch);
  assertExactInventoryShape(inventory);
  const tokenArray = readTokenArray(inventory, expected);
  const length = readBoundedLength(tokenArray);
  assertDenseArray(tokenArray, length);
  return snapshotTokens(tokenArray, length);
};
