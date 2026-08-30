export const immutable = <Value>(value: Value): Value => {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {return value;}
  for (const nested of Object.values(value)) {immutable(nested);}
  return Object.freeze(value);
};
