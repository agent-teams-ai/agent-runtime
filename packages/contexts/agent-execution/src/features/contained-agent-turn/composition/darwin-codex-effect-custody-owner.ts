import type {CommittedDispatchProofV1} from "../domain/committed-dispatch-proof-v1.js";
import type {CodexEffectCustodyAuthority, CodexEffectCustodyExecution, CodexEffectCustodyRequest}
  from "../adapters/outbound/codex-app-server/codex-app-server-effect-custody.js";
import {inspectDarwinNativeExecutionLease, inspectDarwinNativeLaunchObservation, assertDarwinNativeExecutionClaim,
  type DarwinNativeExecutionLease} from "../adapters/outbound/host-custody/contained-turn-kernel-custody-entrypoint.js";

const executionFields = ["attemptId", "custodyRef", "effectId", "operationId", "workspaceRef"] as const;
const issued = new WeakSet<object>();

/** Native retained directory evidence covers the contained turn, never the
 * inode opened by an individual provider syscall. Endpoint paths are diagnostic.
 * Construction grants nothing until the actual retained PG claim is joined. */
export const createDarwinCodexEffectCustodyOwner = () => {
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
      assertDarwinNativeExecutionClaim(lease, proof);
      const native = inspectDarwinNativeExecutionLease(lease);
      const facts = inspectDarwinNativeLaunchObservation(native.observation);
      const captured = Object.freeze({...execution});
      if (executionFields.some(field => typeof captured[field] !== "string" || captured[field].length === 0) ||
          proof.provider !== "codex" || captured.operationId !== proof.operationId ||
          captured.attemptId !== proof.attemptId || captured.custodyRef !== proof.custodyId ||
          captured.effectId !== proof.effectId || captured.workspaceRef !== facts.workspace.path ||
          facts.operationId !== proof.operationId || native.prepared.workspaceId !== proof.workspaceId ||
          native.prepared.executionGenerationId !== proof.executionGenerationId ||
          !/^[a-f0-9]{64}$/u.test(native.hostGenerationBinding) || !native.custodyRef ||
          facts.privateRoot.path === facts.workspace.path || facts.privateRoot.dev !== facts.workspace.dev ||
          facts.privateRoot.ino === facts.workspace.ino || facts.privateRoot.uid !== facts.leasedUid ||
          facts.workspace.uid !== facts.leasedUid || facts.privateRoot.mode !== 0o700 || facts.workspace.mode !== 0o700) {
        throw new TypeError("Darwin effect custody execution/directory join unproven");
      }
      retained = Object.freeze({lease, execution: captured});
    },
    cutoff() {cut = true;},
  });
  issued.add(owner);
  return owner;
};
export type DarwinCodexEffectCustodyOwner = ReturnType<typeof createDarwinCodexEffectCustodyOwner>;
export const isDarwinCodexEffectCustodyOwner = (value: unknown): value is DarwinCodexEffectCustodyOwner =>
  typeof value === "object" && value !== null && issued.has(value);
