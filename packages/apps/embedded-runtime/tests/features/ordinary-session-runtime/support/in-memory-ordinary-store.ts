import {createHash, randomUUID} from "node:crypto";
import {containedTurnCommandFingerprint, type OrdinaryOperation, type OrdinaryOperationStore, type OrdinaryReceipt, type OrdinaryReceiptOf} from "@agent-teams/agent-execution/composition";
import {declareModule} from "@get-modular/assembly";
import {OrdinaryStore} from "../../../../dist/composition/ordinary-runtime-assembly.js";

type Ref = Parameters<OrdinaryOperationStore["read"]>[0];
const REQUIRED_RECEIPTS = ["dispatch_claim", "provider_terminal", "output_drain", "process_group_closed", "workspace_snapshot",
  "artifact_published", "credential_retired", "provider_grant_settled", "security_grant_settled"] as const;
const key = (...parts: readonly string[]): string => JSON.stringify(parts);
const operationKey = (ref: Ref): string => key(ref.scope.tenantId, ref.scope.projectId, ref.operationId);

/**
 * Owner fake of `agent-runtime/ordinary/store`, verified by the contract suite. It does not run the domain validator
 * and never reports `unknown`; use the PostgreSQL store for those.
 */
export function createInMemoryOrdinaryOperationStore(): OrdinaryOperationStore {
  const operations = new Map<string, OrdinaryOperation>();
  const commands = new Map<string, string>();
  // Every method checks and writes without an await in between, so concurrent callers are serialized by the event loop.
  const store = (operation: OrdinaryOperation): OrdinaryOperation => {
    operations.set(operationKey(operation), structuredClone(operation));
    return structuredClone(operation);
  };
  const current = (ref: Ref): OrdinaryOperation | undefined => {
    const found = operations.get(operationKey(ref));
    return found === undefined ? undefined : structuredClone(found);
  };
  const terminal = async (operation: OrdinaryOperation, receipts: readonly OrdinaryReceipt[], reconcile: boolean): Promise<OrdinaryOperation> => {
    const stored = current(operation);
    if (stored === undefined || stored.attemptId !== operation.attemptId) {throw new Error("ordinary terminal operation missing");}
    if (!["accepted", "running", "reconcile_required"].includes(stored.status)) {return stored;}
    const merged = [...stored.receipts];
    for (const receipt of structuredClone(receipts)) {
      const previous = merged.find(item => item.kind === receipt.kind);
      if (previous === undefined) {merged.push(receipt);}
      else if (JSON.stringify(previous) !== JSON.stringify(receipt)) {throw new Error("ordinary immutable receipt conflict");}
    }
    const claimed = merged.some(item => item.kind === "dispatch_claim");
    const providerTerminal = merged.find(item => item.kind === "provider_terminal");
    let status: OrdinaryOperation["status"] = "reconcile_required";
    if (!reconcile) {
      if (!claimed && stored.cancellationRequested) {status = "cancelled";}
      else if (providerTerminal !== undefined && REQUIRED_RECEIPTS.every(kind => merged.some(item => item.kind === kind))) {
        status = providerTerminal.terminalStatus === "completed" ? "succeeded" : providerTerminal.terminalStatus;
      }
    }
    return store({...stored, revision: stored.revision + 1, receipts: merged, status});
  };
  return {
    async accept(input) {
      const commandKey = key(input.scope.tenantId, input.scope.projectId, input.commandId);
      const fingerprint = containedTurnCommandFingerprint({scope: input.scope, intent: input.intent, provider: input.expectedProvider});
      const priorId = commands.get(commandKey);
      if (priorId !== undefined) {
        const prior = current({operationId: priorId, scope: input.scope});
        if (prior === undefined) {throw new Error("ordinary acceptance disappeared");}
        return prior.fingerprint === fingerprint ? {kind: "duplicate", operation: prior} : {kind: "conflict"};
      }
      const operation: OrdinaryOperation = {schemaVersion: 3, executionProfile: "user-session-v1", effectClass: "ordinary_user_session_effect",
        capabilityManifestRevision: "ordinary-codex-macos-arm64-0.153.4-v1", operationId: `ordinary:${randomUUID()}`, attemptId: `attempt:${randomUUID()}`,
        effectId: `effect:${randomUUID()}`, commandId: input.commandId, fingerprint, scope: {...input.scope}, input: structuredClone(input),
        preparation: null, revision: 0, status: "accepted", cancellationRequested: false, output: [], receipts: []};
      commands.set(commandKey, operation.operationId);
      return {kind: "accepted", operation: store(operation)};
    },
    async read(ref) {return current(ref);},
    async prepare(operation, preparation) {
      const now = Date.now();
      if ([preparation.providerAccess.expiresAt, preparation.security.expiresAt].some(expiry => expiry <= now + 10000 || expiry > now + 60000)) {
        throw new Error("ordinary preparation authority deadline rejected");
      }
      const stored = current(operation);
      if (stored === undefined || stored.revision !== operation.revision || stored.status !== "accepted" || stored.cancellationRequested || stored.preparation !== null) {
        throw new Error("ordinary preparation rejected");
      }
      return store({...stored, revision: stored.revision + 1, preparation: structuredClone(preparation)});
    },
    async claim(operation) {
      const stored = current(operation);
      if (stored === undefined || stored.revision !== operation.revision || stored.status !== "accepted" || stored.cancellationRequested || stored.preparation === null
        || Math.min(stored.preparation.security.expiresAt, stored.preparation.providerAccess.expiresAt) <= Date.now() + 10000) {
        return {kind: "not_claimed"};
      }
      const receipt: OrdinaryReceiptOf<"dispatch_claim"> = {operationId: stored.operationId, attemptId: stored.attemptId, executionProfile: stored.executionProfile,
        capabilityManifestRevision: stored.capabilityManifestRevision, kind: "dispatch_claim", claimId: `claim:${randomUUID()}`,
        reservationId: stored.preparation.reservationId, committedRevision: stored.revision + 1,
        // The fake keeps its own digest of the preparation; the contract only needs a stable digest-shaped value.
        preparationDigest: createHash("sha256").update(JSON.stringify(stored.preparation)).digest("hex")};
      return {kind: "claimed", operation: store({...stored, revision: stored.revision + 1, status: "running", receipts: [receipt]}), receipt: structuredClone(receipt)};
    },
    async cancel(ref) {
      const stored = current(ref);
      if (stored === undefined || !["accepted", "running"].includes(stored.status) || stored.cancellationRequested) {return stored;}
      return store({...stored, revision: stored.revision + 1, cancellationRequested: true});
    },
    async append(operation, output) {
      const stored = current(operation);
      if (stored === undefined || stored.status !== "running" || stored.attemptId !== operation.attemptId) {throw new Error("ordinary output rejected");}
      return store({...stored, revision: stored.revision + 1, output: [...stored.output, {cursor: stored.output.length + 1, kind: output.kind, text: output.text}]});
    },
    finish: (operation, receipts) => terminal(operation, receipts, false),
    reconcile: (operation, receipts) => terminal(operation, receipts, true),
  };
}

// Test-only id; never part of a production profile.
export const inMemoryOrdinaryStoreDeclaration = declareModule({moduleId: "agent-runtime/ordinary/store",
  implementationId: "agent-runtime/ordinary/store/in-memory", owner: {authority: "agent-runtime", path: ["ordinary-session-runtime", "tests"]},
  provides: [OrdinaryStore.provide()], slots: []});
