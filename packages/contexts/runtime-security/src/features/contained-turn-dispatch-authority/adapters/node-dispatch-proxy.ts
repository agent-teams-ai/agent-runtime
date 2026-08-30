import { types as nodeUtilTypes } from "node:util";

/** Runtime-only proxy detection; application and domain remain provider-neutral. */
export const isNodeDispatchProxy = (value: unknown): boolean =>
  nodeUtilTypes.isProxy(value);
