export const deepFreezeEgress = <Value>(value: Value): Value => {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {return value;}
  for (const nested of Object.values(value)) {deepFreezeEgress(nested);}
  return Object.freeze(value);
};
