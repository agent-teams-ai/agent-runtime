import {addAbortListener} from "node:events";
import { types } from "node:util";
import { custodyDataRecord } from "./host-custody-inert-record.js";
import { validateCommittedDispatchProofV1, type CommittedDispatchProofV1 } from "../../../domain/committed-dispatch-proof-v1.js";
import type { ContainedTurnHostPostClaimPreparation } from "./contained-turn-kernel-custody-contracts.js";

export type HostCustodyHttpHandoff = Parameters<ContainedTurnHostPostClaimPreparation["prepareClaimed"]>[0];

/** Adapter-private HTTP identity/cutoff contract shared by the Node and Docker
 * resource owners. The session object is opaque to ingress, never a process,
 * dispatch authority, readiness assertion or physical closure observation. */
export interface HostCustodyHttpResourceLifetime {
  readonly executionSessionIdentity: object;
  readonly committedDispatchProof: CommittedDispatchProofV1;
  readonly underlyingCustodyRef: string;
  readonly hostLifecycleGenerationSha256: string;
  readonly signal: AbortSignal;
}

/** The resource slots can cut only their actual owner. */
export interface HostCustodyHttpResourceOwner {cutoff(): void;}

/** Inert validation only; COMMIT provenance belongs to the trusted caller. */
export const readHostCustodyHttpHandoff = (input: HostCustodyHttpHandoff): HostCustodyHttpHandoff => {
  const record = custodyDataRecord(input);
  if (Reflect.ownKeys(record).length !== 3 || typeof record.underlyingCustodyRef !== "string" ||
      record.underlyingCustodyRef.length === 0) {
    throw new TypeError("Host Custody HTTP preparation handoff is unavailable");
  }
  const proof = custodyDataRecord(record.committedDispatchProof);
  // Every proof field is scalar; reject nested executable values before validation.
  for (const key of Reflect.ownKeys(proof)) {
    const value: unknown = Object.getOwnPropertyDescriptor(proof, key)!.value;
    if (typeof value !== "string" && typeof value !== "number") {
      throw new TypeError("Host Custody HTTP preparation proof is unavailable");
    }
  }
  const signal = record.signal;
  if (signal === null || typeof signal !== "object" || types.isProxy(signal) ||
      Object.getPrototypeOf(signal) !== AbortSignal.prototype ||
      Reflect.ownKeys(signal).some(key => typeof key === "string" ||
        !("value" in Object.getOwnPropertyDescriptor(signal, key)!))) {
    throw new TypeError("Host Custody HTTP preparation signal is unavailable");
  }
  Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")!.get!.call(signal);
  return Object.freeze({ committedDispatchProof: validateCommittedDispatchProofV1({ ...proof }),
    signal, underlyingCustodyRef: record.underlyingCustodyRef });
};


const nativeAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")!.get!;
const nativeRemove = EventTarget.prototype.removeEventListener;
const nativeAbort = AbortController.prototype.abort;
/** Physical abort operations retained for the private resource composition. */
export const hostHttpAbortOperations = Object.freeze({
  aborted: (signal: AbortSignal): boolean => nativeAborted.call(signal),
  subscribe: addAbortListener,
  remove: (signal: AbortSignal, listener: () => void): void => nativeRemove.call(signal, "abort", listener),
  abort: (controller: AbortController): void => nativeAbort.call(controller),
});
