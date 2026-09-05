import type { ContainedTurnEgressResult } from "./composition.js";

const freeze = Object.freeze;
export const deny = (reason: Extract<ContainedTurnEgressResult, {status: "denied"}>["reason"]):
Extract<ContainedTurnEgressResult, {status: "denied"}> => freeze({status: "denied", reason, deniedApplicationBytes: 0});
export const uncertain = (reason: Extract<ContainedTurnEgressResult, {status: "indeterminate"}>["reason"]):
Extract<ContainedTurnEgressResult, {status: "indeterminate"}> => freeze({status: "indeterminate", reason});
export const sameBytes = (left: Uint8Array, right: Uint8Array) => {if (left.byteLength !== right.byteLength) {return false;}
  for (let index = 0; index < left.byteLength; index += 1) {if (left[index] !== right[index]) {return false;}} return true;};
