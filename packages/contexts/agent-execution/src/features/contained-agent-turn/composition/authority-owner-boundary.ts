import { cloneContainedTurnPortValue } from "./preparation-scope-anti-corruption.js";
import { detachAndFreezeContainedTurnValue } from "../domain/contained-turn-record.js";

const types = process.getBuiltinModule("node:util").types;
const prototype = Promise.prototype;
const then = Promise.prototype.then;
const constructor = Promise;
/** Check before any async adoption; never invoke an owner-supplied then/constructor. */
const ownerPromise = <T>(value: Promise<T>): Promise<T> => {
  if (types.isProxy(value) || !types.isPromise(value) || Object.getPrototypeOf(value) !== prototype ||
      Object.getOwnPropertyDescriptor(value, "then") !== undefined ||
      Object.getOwnPropertyDescriptor(value, "constructor") !== undefined ||
      Object.getOwnPropertyDescriptor(prototype, "then")?.value !== then ||
      Object.getOwnPropertyDescriptor(prototype, "constructor")?.value !== constructor) {
    throw new TypeError("authority owner must return an ordinary native Promise");
  }
  return value;
};
export const authorityValue = <T>(value: T): T => detachAndFreezeContainedTurnValue(cloneContainedTurnPortValue(value));
export const ownerValue = async <T>(value: Promise<T>): Promise<T> => authorityValue(await ownerPromise(value));
