import { types as utilTypes } from "node:util";

import { DockerEngineError } from "./docker-engine-error.js";
import type { DockerEngineFailureCode } from "./docker-engine-error.js";
import type {
  DockerContainerAuthority,
  DockerContainerCreate,
  DockerEngineCall,
  DockerEnginePolicy,
} from "./docker-engine-port.js";

const POLICY_KEYS = Object.freeze([
  "allowedEnvironmentKeys", "allowedNetworkName", "appArmorProfile", "cgroupParent", "cpuNanoCpus",
  "daemonPidFileMode", "daemonPidFileOwnerGid", "daemonPidFileOwnerUid", "daemonPidFilePath",
  "hostIdentitySha256", "memoryBytes", "pidsLimit", "privateRootSourceRoot", "seccompProfileJson",
  "seccompProfileSha256", "socketMode", "socketOwnerGid", "socketOwnerUid", "socketPath", "tmpfsBytes",
  "user", "workspaceSourceRoot", "writableLayerBytes",
]);

const AUTHORITY_KEYS = Object.freeze([
  "containerId", "createSpecificationSha256", "daemonBootGenerationSha256", "daemonIdentitySha256",
  "hostBootGenerationSha256", "hostIdentitySha256", "imageDigest", "launchFingerprintSha256",
  "operationNonceSha256",
]);

const CREATE_KEYS = Object.freeze([
  "arguments", "entrypoint", "environment", "imageDigest", "launchFingerprintSha256",
  "operationNonceSha256", "privateRootSource", "workspaceSource", "workspaceWritable",
]);
const POLICY_STRING_KEYS = Object.freeze([
  "allowedNetworkName", "appArmorProfile", "cgroupParent", "daemonPidFilePath", "hostIdentitySha256",
  "privateRootSourceRoot", "seccompProfileJson", "seccompProfileSha256", "socketPath", "user",
  "workspaceSourceRoot",
]);
const POLICY_NUMBER_KEYS = Object.freeze([
  "cpuNanoCpus", "daemonPidFileMode", "daemonPidFileOwnerGid", "daemonPidFileOwnerUid", "memoryBytes",
  "pidsLimit", "socketMode", "socketOwnerGid", "socketOwnerUid", "tmpfsBytes", "writableLayerBytes",
]);

const fail = (code: DockerEngineFailureCode): never => {throw new DockerEngineError(code);};

const dataValues = (
  value: unknown,
  expectedKeys: readonly string[] | undefined,
  code: DockerEngineFailureCode,
): Readonly<Record<string, unknown>> => {
  try {
    if (typeof value !== "object" || value === null || utilTypes.isProxy(value) ||
        Object.getPrototypeOf(value) !== Object.prototype) {
      return fail(code);
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.some(key => typeof key !== "string")) {return fail(code);}
    const stringKeys = keys as string[];
    if (expectedKeys !== undefined) {
      const observed = stringKeys.toSorted();
      const expected = [...expectedKeys].toSorted();
      if (observed.length !== expected.length || observed.some((key, index) => key !== expected[index])) {
        return fail(code);
      }
    }
    const values: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of stringKeys) {
      const descriptor = descriptors[key];
      if (descriptor === undefined || !("value" in descriptor)) {return fail(code);}
      values[key] = descriptor.value;
    }
    return values;
  } catch (error) {
    if (error instanceof DockerEngineError) {throw error;}
    return fail(code);
  }
};

const dataArray = (
  value: unknown,
  code: DockerEngineFailureCode,
): readonly unknown[] => {
  try {
    if (!Array.isArray(value) || utilTypes.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype) {
      return fail(code);
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.some(key => typeof key !== "string")) {return fail(code);}
    const lengthDescriptor = (descriptors as unknown as Record<string, PropertyDescriptor>)["length"];
    const lengthValue = lengthDescriptor?.value as unknown;
    if (lengthDescriptor === undefined || lengthDescriptor.get !== undefined || lengthDescriptor.set !== undefined ||
        typeof lengthValue !== "number" || !Number.isSafeInteger(lengthValue) || lengthValue < 0) {
      return fail(code);
    }
    const length = lengthValue;
    const expected = [...Array.from({ length }, (_, index) => String(index)), "length"].toSorted();
    const observed = (keys as string[]).toSorted();
    if (observed.length !== expected.length || observed.some((key, index) => key !== expected[index])) {
      return fail(code);
    }
    const result: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (descriptor === undefined || !("value" in descriptor)) {return fail(code);}
      result.push(descriptor.value);
    }
    return Object.freeze(result);
  } catch (error) {
    if (error instanceof DockerEngineError) {throw error;}
    return fail(code);
  }
};

const stringArray = (value: unknown, code: DockerEngineFailureCode): readonly string[] => {
  const values = dataArray(value, code);
  if (values.some(entry => typeof entry !== "string")) {return fail(code);}
  return values as readonly string[];
};

const stringRecord = (value: unknown, code: DockerEngineFailureCode): Readonly<Record<string, string>> => {
  const values = dataValues(value, undefined, code);
  if (Object.values(values).some(entry => typeof entry !== "string")) {return fail(code);}
  return Object.freeze({ ...values }) as Readonly<Record<string, string>>;
};

export const snapshotOwnDataObject = (
  value: unknown,
  allowedKeys: readonly string[],
  requiredKeys: readonly string[],
  code: DockerEngineFailureCode,
): Readonly<Record<string, unknown>> => {
  const values = dataValues(value, undefined, code);
  const keys = Object.keys(values);
  if (keys.some(key => !allowedKeys.includes(key)) || requiredKeys.some(key => !Object.hasOwn(values, key))) {
    return fail(code);
  }
  return Object.freeze({ ...values });
};

export const snapshotDockerEnginePolicy = (value: unknown): DockerEnginePolicy => {
  const policy = dataValues(value, POLICY_KEYS, "invalid-create-request");
  if (POLICY_STRING_KEYS.some(key => typeof policy[key] !== "string") ||
      POLICY_NUMBER_KEYS.some(key => typeof policy[key] !== "number")) {
    return fail("invalid-create-request");
  }
  const allowedEnvironmentKeys = stringArray(policy.allowedEnvironmentKeys, "invalid-create-request");
  return Object.freeze({ ...policy, allowedEnvironmentKeys }) as unknown as DockerEnginePolicy;
};

export const snapshotDockerContainerAuthority = (value: unknown): DockerContainerAuthority =>
  (() => {
    const authority = dataValues(value, AUTHORITY_KEYS, "invalid-authority");
    if (AUTHORITY_KEYS.some(key => typeof authority[key] !== "string")) {return fail("invalid-authority");}
    return Object.freeze({ ...authority }) as unknown as DockerContainerAuthority;
  })();

export const snapshotDockerContainerCreate = (value: unknown): DockerContainerCreate => {
  const input = dataValues(value, CREATE_KEYS, "invalid-create-request");
  if ([
    "entrypoint", "imageDigest", "launchFingerprintSha256", "operationNonceSha256", "privateRootSource",
    "workspaceSource",
  ].some(key => typeof input[key] !== "string") || typeof input.workspaceWritable !== "boolean") {
    return fail("invalid-create-request");
  }
  return Object.freeze({
    ...input,
    arguments: stringArray(input.arguments, "invalid-create-request"),
    environment: stringRecord(input.environment, "invalid-create-request"),
  }) as unknown as DockerContainerCreate;
};

export const snapshotDockerEngineCall = (value: unknown): DockerEngineCall => {
  const call = dataValues(value, ["deadlineEpochMs", "signal"], "deadline-exceeded");
  if (typeof call.deadlineEpochMs !== "number" || !Number.isSafeInteger(call.deadlineEpochMs)) {
    return fail("deadline-exceeded");
  }
  try {
    if (!(call.signal instanceof AbortSignal) || utilTypes.isProxy(call.signal) ||
        Object.getPrototypeOf(call.signal) !== AbortSignal.prototype) {return fail("aborted");}
    const aborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")?.get;
    if (aborted === undefined || typeof aborted.call(call.signal) !== "boolean") {return fail("aborted");}
  } catch {return fail("aborted");}
  return Object.freeze({ deadlineEpochMs: call.deadlineEpochMs, signal: call.signal }) as DockerEngineCall;
};
