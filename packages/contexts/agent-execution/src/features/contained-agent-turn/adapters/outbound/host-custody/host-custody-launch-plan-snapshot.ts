import { types } from "node:util";
import type { HostCustodyLaunchPlan } from "./custodied-provider-process.js";

const rejected = (): TypeError => new TypeError("Host Custody launch snapshot requires inert data");
const immutableLaunchPlans = new WeakSet<object>();

type LaunchScalar = null | undefined | string | number | boolean;
type ImmutableLaunchMetadata<Value> = Value extends LaunchScalar ? Value
  : Value extends readonly unknown[] | ((...args: never[]) => unknown) ? never
  : Value extends object ? {
    readonly [Key in keyof Value]: Key extends string | number
      ? Value[Key] extends LaunchScalar ? Value[Key] : never : never;
  } : never;

/** Exactly the frozen data shape this issuer supports, retaining named metadata. */
type ImmutableLaunchPlan<Plan extends HostCustodyLaunchPlan> = {
  readonly [Key in keyof Plan]: Key extends "arguments" | "privatePathEnvironmentKeys" ? readonly string[]
    : Key extends "environment" ? Readonly<Record<string, string>>
    : Key extends keyof HostCustodyLaunchPlan ? Plan[Key]
    : Key extends string ? ImmutableLaunchMetadata<Plan[Key]> : never;
};

/** Check descriptors before reading executable data, including its envelopes. */
export const assertInertHostLaunchData = (value: unknown): void => {
  if (typeof value !== "object" || value === null || types.isProxy(value)) {throw rejected();}
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== (Array.isArray(value) ? Array.prototype : Object.prototype) && prototype !== null) {
    throw rejected();
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).some(key => typeof key !== "string")
    || Object.values(descriptors).some(descriptor => !("value" in descriptor))) {throw rejected();}
};

const snapshotStrings = (value: readonly string[]): readonly string[] => {
  assertInertHostLaunchData(value);
  if (!Array.isArray(value)) {throw rejected();}
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.keys(descriptors).some(key => key !== "length" && !/^(0|[1-9]\d*)$/u.test(key))) {throw rejected();}
  const result: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const item = descriptors[String(index)]?.value;
    if (typeof item !== "string") {throw rejected();}
    result.push(item);
  }
  return Object.freeze(result);
};

const isLaunchScalar = (value: unknown): boolean => value === null || value === undefined
  || typeof value === "string" || typeof value === "number" || typeof value === "boolean";

/** Launch metadata contains scalars or flat scalar records (directory identities).
 * Reject deeper/executable structures instead of introducing a recursive copier.
 */
const snapshotLaunchMetadata = (value: unknown): unknown => {
  if (isLaunchScalar(value)) {return value;}
  assertInertHostLaunchData(value);
  if (Array.isArray(value)) {throw rejected();}
  const entries = Object.entries(Object.getOwnPropertyDescriptors(value));
  if (entries.some(([, descriptor]) => !isLaunchScalar(descriptor.value))) {throw rejected();}
  return Object.freeze(Object.fromEntries(entries.map(([key, descriptor]) => [key, descriptor.value])));
};

const copyImmutableLaunchPlan = <Plan extends HostCustodyLaunchPlan>(plan: Plan): ImmutableLaunchPlan<Plan> => {
  assertInertHostLaunchData(plan);
  if (Array.isArray(plan)) {throw rejected();}
  for (const key of ["binaryRevision", "containmentProfile", "executablePath", "executableSha256",
    "intentMode", "privateRootPath", "provider"] as const) {
    if (!Object.hasOwn(plan, key) || typeof plan[key] !== "string") {throw rejected();}
  }
  if (plan.spawnMode !== undefined && typeof plan.spawnMode !== "string") {throw rejected();}
  const launchArguments = snapshotStrings(plan.arguments);
  assertInertHostLaunchData(plan.environment);
  if (Array.isArray(plan.environment) || Object.values(plan.environment).some(value => typeof value !== "string")) {
    throw rejected();
  }
  const environment = Object.freeze({ ...plan.environment });
  const privatePathEnvironmentKeys = plan.privatePathEnvironmentKeys === undefined
    ? undefined : snapshotStrings(plan.privatePathEnvironmentKeys);
  const metadata = Object.fromEntries(Object.entries(Object.getOwnPropertyDescriptors(plan))
    .filter(([key]) => !["arguments", "environment", "privatePathEnvironmentKeys"].includes(key))
    .map(([key, descriptor]) => [key, snapshotLaunchMetadata(descriptor.value)]));
  return Object.freeze({ ...metadata, arguments: launchArguments, environment,
    ...(privatePathEnvironmentKeys === undefined ? {} : { privatePathEnvironmentKeys }),
  }) as ImmutableLaunchPlan<Plan>;
};

/** Always creates a new deeply immutable data object, even from an issued plan.
 * Only that new object receives Host retention identity, never provider authority.
 */
export const createImmutableHostCustodyLaunchPlan = <Plan extends HostCustodyLaunchPlan>(
  plan: Plan & ImmutableLaunchPlan<NoInfer<Plan>>,
): ImmutableLaunchPlan<Plan> => {
  const snapshot = copyImmutableLaunchPlan<Plan>(plan);
  immutableLaunchPlans.add(snapshot);
  return snapshot;
};

/** Host recognizes only its own immutable objects. Generic inputs are copied on
 * every boundary; no filesystem, binary, or delegated-start validation is replaced.
 */
export const snapshotHostCustodyLaunchPlan = (plan: HostCustodyLaunchPlan): HostCustodyLaunchPlan =>
  immutableLaunchPlans.has(plan) ? plan : copyImmutableLaunchPlan(plan);
