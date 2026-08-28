export const deepFreezeAuthorization = <Value>(value: Value): Value => {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const nested of Object.values(value)) {
    deepFreezeAuthorization(nested);
  }
  return Object.freeze(value);
};
