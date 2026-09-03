import { containedTurnInvariant as invariant } from "./contained-turn-invariant.js";

const isPlainRecord = (value: object): boolean => Object.getPrototypeOf(value) === Object.prototype;

export const assertContainedTurnExactRecord = (
  name: string,
  value: object,
  expected: readonly string[],
): void => {
  invariant(isPlainRecord(value), `${name} must use the ordinary object prototype`);
  const keys = Reflect.ownKeys(value);
  invariant(keys.every(key => typeof key === "string"), `${name} must not contain symbol keys`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  invariant(
    Object.values(descriptors).every(descriptor => descriptor.enumerable && "value" in descriptor),
    `${name} must contain only enumerable data properties`,
  );
  const actual = (keys as string[]).toSorted();
  const wanted = [...expected].toSorted();
  invariant(
    actual.length === wanted.length && actual.every((key, index) => key === wanted[index]),
    `${name} must be an exact closed record`,
  );
};

export const hasContainedTurnLoneSurrogate = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff) {return true;}
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {return true;}
  }
  return false;
};

export const assertContainedTurnCanonicalArray = (value: readonly unknown[]): void => {
  const keys = Reflect.ownKeys(value);
  invariant(
    keys.length === value.length + 1 && keys.at(-1) === "length" &&
      Array.from({ length: value.length }, (_item, index) => index).every(index => Object.hasOwn(value, index)),
    "canonical arrays must be dense and contain no extra properties",
  );
  const descriptors = Object.getOwnPropertyDescriptors(value);
  invariant(
    Object.entries(descriptors).every(([key, descriptor]) =>
      key === "length" || (descriptor.enumerable && "value" in descriptor)),
    "canonical arrays must contain only data elements",
  );
};

export const detachAndFreezeContainedTurnValue = <Value>(value: Value): Value => {
  if (value === null || typeof value === "boolean" || typeof value === "number") {return value;}
  if (typeof value === "string") {
    invariant(!hasContainedTurnLoneSurrogate(value), "contained-turn text must not contain lone surrogates");
    return value;
  }
  invariant(typeof value === "object" && value !== undefined, "contained-turn values must be canonical data");
  if (Array.isArray(value)) {
    assertContainedTurnCanonicalArray(value);
    return Object.freeze(value.map(item => detachAndFreezeContainedTurnValue(item))) as Value;
  }
  assertContainedTurnExactRecord("contained-turn value", value, Object.keys(value));
  const detached = Object.fromEntries(
    Object.entries(value).map(([key, item]) => {
      invariant(item !== undefined, "contained-turn values must not contain undefined");
      return [key, detachAndFreezeContainedTurnValue(item)];
    }),
  );
  return Object.freeze(detached) as Value;
};
