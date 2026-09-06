import type { ContainedTurnHostPostClaimPreparation } from "../adapters/outbound/host-custody/contained-turn-kernel-custody-contracts.js";

const isProxy = process.getBuiltinModule("node:util").types.isProxy;
const apply = Reflect.apply;
export const capturePostClaimPreparation = (
  options: Readonly<{postClaimPreparation?: ContainedTurnHostPostClaimPreparation}>,
): "current-owner" | ContainedTurnHostPostClaimPreparation => {
  if (options === null || typeof options !== "object") {
    throw new TypeError("Host post-claim preparation options must be an object");
  }
  let owner: object | null = options;
  let option: PropertyDescriptor | undefined;
  while (owner !== null) {
    if (isProxy(owner)) {throw new TypeError("Host post-claim preparation options must not be a Proxy");}
    option = Object.getOwnPropertyDescriptor(owner, "postClaimPreparation");
    if (option !== undefined) {break;}
    owner = Object.getPrototypeOf(owner);
  }
  if (option === undefined) {return "current-owner";}
  if (!("value" in option)) {throw new TypeError("Host post-claim preparation must be a data property");}
  const capability: unknown = option.value;
  if (capability === undefined) {return "current-owner";}
  if (capability === null || typeof capability !== "object" || isProxy(capability)) {
    throw new TypeError("Host post-claim preparation capability is unavailable");
  }
  const method = Object.getOwnPropertyDescriptor(capability, "prepareClaimed");
  if (method === undefined || !("value" in method)
    || typeof method.value !== "function" || isProxy(method.value)) {
    throw new TypeError("Host post-claim preparation requires an own callable data property");
  }
  const prepareClaimed = method.value as ContainedTurnHostPostClaimPreparation["prepareClaimed"];
  return Object.freeze({
    prepareClaimed: (input: Parameters<typeof prepareClaimed>[0]) => apply(prepareClaimed, capability, [input]),
  });
};

