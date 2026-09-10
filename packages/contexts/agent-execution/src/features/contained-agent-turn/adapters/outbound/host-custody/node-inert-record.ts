import {types} from "node:util";

/** Node adapter check used before any caller-controlled property access. */
export const isNodeProxy = (value: object): boolean => types.isProxy(value);
