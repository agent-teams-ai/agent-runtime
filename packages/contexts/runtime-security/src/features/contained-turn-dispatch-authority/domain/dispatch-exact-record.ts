/** A bounded, feature-local plain-own-data projection. */
export const snapshotExactDispatchRecord = <Name extends string>(
  value: unknown,
  names: readonly Name[],
): Readonly<Record<Name, unknown>> | undefined => {
  if (typeof value !== "object" || value === null) {return undefined;}
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {return undefined;}
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.length !== names.length ||
      keys.some(key => typeof key !== "string" || !names.includes(key as Name))) {
    return undefined;
  }
  const snapshot = Object.create(null) as Record<Name, unknown>;
  for (const name of names) {
    const descriptor = descriptors[name];
    if (descriptor === undefined || !("value" in descriptor)) {return undefined;}
    snapshot[name] = descriptor.value;
  }
  return snapshot;
};

/** Captures descriptors once and selects one exact variant without rereading the source. */
export const snapshotExactDispatchVariant = (
  value: unknown,
  variants: readonly (readonly string[])[],
): Readonly<Record<string, unknown>> | undefined => {
  if (typeof value !== "object" || value === null) {return undefined;}
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {return undefined;}
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  const names = variants.find(candidate => keys.length === candidate.length &&
    keys.every(key => typeof key === "string" && candidate.includes(key)));
  if (names === undefined) {return undefined;}
  const snapshot = Object.create(null) as Record<string, unknown>;
  for (const name of names) {
    const descriptor = descriptors[name];
    if (descriptor === undefined || !("value" in descriptor)) {return undefined;}
    snapshot[name] = descriptor.value;
  }
  return snapshot;
};
