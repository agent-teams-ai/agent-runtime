import { types } from "node:util";
import { addAbortListener } from "node:events";
import {
  HostCustodyFingerprintConflictError,
  type CustodiedSdkProcessLauncher,
} from "./custodied-provider-process.js";
import {
  assertDelegatedStartFingerprint, canonicalJson, createFingerprint, sha256,
} from "./host-custody-launch.js";
import { custodyDataRecord } from "./node-provider-process-custody-http-reservation.js";
import type { LiveCustody } from "./node-provider-process-custody-state.js";

type StartInput = Parameters<CustodiedSdkProcessLauncher["start"]>[1];
const signalPrototype = AbortSignal.prototype;
const nativeAborted = Object.getOwnPropertyDescriptor(signalPrototype, "aborted")!.get!;
const nativeSubscribe = addAbortListener;
const nativeRemove = EventTarget.prototype.removeEventListener;

const snapshotArguments = (value: readonly string[]): readonly string[] => {
  const record = custodyDataRecord(value);
  if (!Array.isArray(value) || Reflect.ownKeys(record).length !== record.length + 1) {
    throw new TypeError("Host Custody requires a dense arguments array");
  }
  const result: string[] = [];
  for (let index = 0; index < record.length; index += 1) {
    const item: unknown = record[index];
    if (typeof item !== "string") {throw new TypeError("Host Custody requires string arguments");}
    result.push(item);
  }
  return Object.freeze(result);
};

const snapshotEnvironment = (value: StartInput["environment"]): StartInput["environment"] => {
  const record = custodyDataRecord(value);
  for (const key of Reflect.ownKeys(record)) {
    if (typeof key !== "string" || (record[key] !== undefined && typeof record[key] !== "string")) {
      throw new TypeError("Host Custody requires string environment data");
    }
  }
  return record;
};

const retainAbortOperations = (signal: AbortSignal) => {
  if (signal === null || typeof signal !== "object" || types.isProxy(signal) ||
      Object.getPrototypeOf(signal) !== signalPrototype ||
      Reflect.ownKeys(signal).some(key => typeof key === "string" ||
        !("value" in Object.getOwnPropertyDescriptor(signal, key)!) ||
        Object.hasOwn(signalPrototype, key) || Object.hasOwn(EventTarget.prototype, key))) {
    throw new TypeError("Host Custody requires a native, unmodified abort signal");
  }
  nativeAborted.call(signal); // Brand validation is still before admission.
  // Subscription receives the genuine, validated signal before any launch
  // callback can mutate it. Later checks and cleanup use captured intrinsics.
  return Object.freeze({
    get aborted(): boolean {return nativeAborted.call(signal);},
    subscribe(listener: () => void): void {nativeSubscribe(signal, listener);},
    remove(listener: () => void): void {nativeRemove.call(signal, "abort", listener);},
  });
};

/** Pure preflight: no admission mutation, subscription, launch or containment. */
export const readCustodyStartAdmission = (input: StartInput, live: LiveCustody) => {
  const record = custodyDataRecord(input);
  if (Reflect.ownKeys(record).some(key =>
    !["arguments", "command", "cwd", "environment", "signal"].includes(key as string)) ||
    typeof record.command !== "string" || (record.cwd !== undefined && typeof record.cwd !== "string")) {
    throw new TypeError("Host Custody requires delegated start data");
  }
  const snapshot = Object.freeze({
    arguments: snapshotArguments(record.arguments), command: record.command, cwd: record.cwd,
    environment: snapshotEnvironment(record.environment),
  });
  const abort = retainAbortOperations(record.signal);
  const plan = live.plan!;
  const environment = assertDelegatedStartFingerprint(snapshot, plan, live.workspaceRef);
  const startIdentitySha256 = sha256(canonicalJson([
    live.fingerprint?.planSha256, sha256(snapshot.command),
    snapshot.cwd === undefined ? undefined : sha256(snapshot.cwd),
    snapshot.arguments, Object.keys(environment).toSorted(),
  ]));
  const fingerprint = createFingerprint({
    attemptId: live.attemptId, intentMode: plan.intentMode, operationId: live.operationId,
    providerBinding: live.providerBinding, workspaceRef: live.workspaceRef,
  }, plan, live.workspaceRef, snapshot.arguments);
  if (live.fingerprint?.fingerprintSha256 !== fingerprint.fingerprintSha256 ||
      (live.startIdentitySha256 !== undefined &&
        (live.startIdentitySha256 !== startIdentitySha256 || live.sdkProcess === undefined || live.exit === undefined))) {
    throw new HostCustodyFingerprintConflictError("Host Custody delegated start fingerprint conflict");
  }
  return Object.freeze({arguments: snapshot.arguments, environment, abort, startIdentitySha256,
    replay: live.startIdentitySha256 === undefined ? undefined : live.sdkProcess});
};
