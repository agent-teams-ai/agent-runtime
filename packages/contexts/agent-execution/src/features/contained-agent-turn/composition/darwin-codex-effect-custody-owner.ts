import {types} from "node:util";
import type {CommittedDispatchProofV1} from "../domain/committed-dispatch-proof-v1.js";
import type {CodexEffectCustodyAuthority, CodexEffectCustodyExecution, CodexEffectCustodyRequest}
  from "../adapters/outbound/codex-app-server/codex-app-server-effect-custody.js";
import {inspectDarwinNativeExecutionLease, inspectDarwinNativeLaunchObservation, assertDarwinNativeExecutionClaim, hostHttpAbortOperations,
  type DarwinNativeExecutionLease} from "../adapters/outbound/host-custody/contained-turn-kernel-custody-entrypoint.js";

const executionFields = ["attemptId", "custodyRef", "effectId", "operationId", "workspaceRef"] as const;
const issued = new WeakSet<object>();
const captureExecution = (execution: CodexEffectCustodyExecution): CodexEffectCustodyExecution => {
  if (!execution || typeof execution !== "object" || types.isProxy(execution) ||
      Object.getPrototypeOf(execution) !== Object.prototype) {
    throw new TypeError("Darwin execution must be an exact inert data record");
  }
  const fields = Object.getOwnPropertyDescriptors(execution);
  if (Reflect.ownKeys(fields).length !== executionFields.length || executionFields.some(key => {
    const field = fields[key];
    return !field || !("value" in field) || typeof field.value !== "string" || field.value.length === 0;
  })) {throw new TypeError("Darwin execution must contain only exact own data fields");}
  return Object.freeze({attemptId: fields.attemptId!.value!, custodyRef: fields.custodyRef!.value!,
    effectId: fields.effectId!.value!, operationId: fields.operationId!.value!, workspaceRef: fields.workspaceRef!.value!});
};

const directoriesJoined = (facts: ReturnType<typeof inspectDarwinNativeLaunchObservation>): boolean =>
  facts.privateRoot.path !== facts.workspace.path && facts.privateRoot.dev === facts.workspace.dev &&
  facts.privateRoot.ino !== facts.workspace.ino && facts.privateRoot.uid === facts.leasedUid &&
  facts.workspace.uid === facts.leasedUid && facts.privateRoot.mode === 0o700 && facts.workspace.mode === 0o700;

/** Native retained directory evidence covers the contained turn, never the
 * inode opened by an individual provider syscall. Endpoint paths are diagnostic.
 * Construction grants nothing until the actual retained PG claim is joined. */
export const createDarwinCodexEffectCustodyOwner = () => {
  const subscriptions: ReturnType<typeof hostHttpAbortOperations.subscribe>[] = [];
  let disposed = false;
  let consumed = false;
  let cut = false;
  let retained: Readonly<{lease: DarwinNativeExecutionLease; execution: CodexEffectCustodyExecution}> | undefined;
  const items = new Map<string, Readonly<{type: string; token: object}>>();
  const authority: CodexEffectCustodyAuthority = Object.freeze({admit(request: CodexEffectCustodyRequest) {
    const bound = retained;
    if (!bound || executionFields.some(field => request[field] !== bound.execution[field]) ||
        typeof request.itemId !== "string" || request.itemId.length === 0 || request.itemId.length > 1024 ||
        !["commandExecution", "fileChange"].includes(request.itemType) ||
        !["started", "updated", "completed", "terminal"].includes(request.phase)) {return;}
    const prior = items.get(request.itemId);
    if (prior !== undefined) {
      return prior.type === request.itemType && request.priorAdmission === prior.token ? prior.token : undefined;
    }
    if (cut || request.priorAdmission !== undefined || items.size >= 4096) {return;}
    try {inspectDarwinNativeExecutionLease(bound.lease);} catch {cut = true; return;}
    const token = Object.freeze({});
    items.set(request.itemId, Object.freeze({type: request.itemType, token}));
    return token;
  }});
  const owner = Object.freeze({authority,
    bind(lease: DarwinNativeExecutionLease, proof: CommittedDispatchProofV1, execution: CodexEffectCustodyExecution) {
      if (consumed || cut) {throw new TypeError("Darwin effect custody binding already consumed or cut off");}
      consumed = true;
      // The native owner compares detached proof bytes with its actual private
      // PG receiver's committed claim. Caller-shaped evidence cannot issue it.
      // Reject proxy traps before invoking the native proof comparator. Its
      // successful comparison establishes that every proof field is inert data.
      if (!proof || typeof proof !== "object" || types.isProxy(proof)) {
        throw new TypeError("Darwin committed proof must be inert data");
      }
      assertDarwinNativeExecutionClaim(lease, proof);
      const authenticated = Object.freeze({provider: proof.provider, operationId: proof.operationId,
        attemptId: proof.attemptId, custodyId: proof.custodyId, effectId: proof.effectId,
        workspaceId: proof.workspaceId, executionGenerationId: proof.executionGenerationId});
      const native = inspectDarwinNativeExecutionLease(lease);
      const facts = inspectDarwinNativeLaunchObservation(native.observation);
      const captured = captureExecution(execution);
      if (executionFields.some(field => typeof captured[field] !== "string" || captured[field].length === 0) ||
          authenticated.provider !== "codex" || captured.operationId !== authenticated.operationId ||
          captured.attemptId !== authenticated.attemptId || captured.custodyRef !== authenticated.custodyId ||
          captured.effectId !== authenticated.effectId || captured.workspaceRef !== facts.workspace.path ||
          facts.operationId !== authenticated.operationId || native.prepared.workspaceId !== authenticated.workspaceId ||
          native.prepared.executionGenerationId !== authenticated.executionGenerationId ||
          !/^[a-f0-9]{64}$/u.test(native.hostGenerationBinding) || !native.custodyRef ||
          !directoriesJoined(facts)) {
        throw new TypeError("Darwin effect custody execution/directory join unproven");
      }
      retained = Object.freeze({lease, execution: captured});
    },
    observeAbort(signal: AbortSignal) {
      if (disposed) {throw new TypeError("Darwin effect custody disposed");}
      subscriptions.push(hostHttpAbortOperations.subscribe(signal, () => {if (!disposed) {cut = true;}}));
      if (hostHttpAbortOperations.aborted(signal)) {cut = true;}
    },
    cutoff() {cut = true;},
    dispose() {
      disposed = true; cut = true;
      for (const subscription of subscriptions.splice(0)) {hostHttpAbortOperations.remove(subscription);}
      items.clear(); retained = undefined;
    },
  });
  issued.add(owner);
  return owner;
};
export type DarwinCodexEffectCustodyOwner = ReturnType<typeof createDarwinCodexEffectCustodyOwner>;
export const isDarwinCodexEffectCustodyOwner = (value: unknown): value is DarwinCodexEffectCustodyOwner =>
  typeof value === "object" && value !== null && issued.has(value);
