import { types as utilTypes } from "node:util";
import { boundedHttpOpaque } from "./http-ingress-validation.js";

export const snapshotHttpClosureDecision = (value: unknown): Readonly<{
  state: "closed" | "unknown"; receiptDigest: string;
}> | undefined => {
  if (typeof value !== "object" || value === null || utilTypes.isProxy(value)
    || Object.getPrototypeOf(value) !== Object.prototype) {return undefined;}
  const descriptors = Object.getOwnPropertyDescriptors(value); const keys = Reflect.ownKeys(descriptors);
  if (keys.length !== 2 || !keys.every(key => key === "state" || key === "receiptDigest")) {return undefined;}
  const state = descriptors.state; const receipt = descriptors.receiptDigest;
  if (state === undefined || receipt === undefined || !("value" in state) || !("value" in receipt)
    || (state.value !== "closed" && state.value !== "unknown") || !boundedHttpOpaque(receipt.value)) {return undefined;}
  return Object.freeze({state: state.value, receiptDigest: receipt.value});
};
