import type { DarwinRouteDurableStorage } from "../darwin-route-durable-storage.js";
import { captureConsumptionKey, consumptionFingerprint, type ConsumptionKey } from "./host-http-consumption-format.js";
import type { HostHttpConsumptionPreparation } from "./node-host-http-consumption-journal.js";

export interface DarwinConsumptionEnvelope {
  readonly tenantId: string; readonly projectId: string; readonly operationId: string;
  readonly attemptId: string; readonly custodyId: string; readonly hostBootId: string;
  readonly generation: string; readonly authorityVectorDigest: string; readonly listenerIdentity: string;
}
/** Separate Darwin schema, sharing only key/fingerprint validation. The actual
 * lifecycle owner holds the public native process lock through aggregate cleanup. */
export const createDarwinHostHttpConsumptionJournal = (storage: DarwinRouteDurableStorage,
  envelope: DarwinConsumptionEnvelope) => {
  const scope = Object.freeze({...envelope});
  for (const value of Object.values(scope)) {
    if (typeof value !== "string" || value.length < 1 || value.length > 256) {throw new TypeError("Darwin consumption scope rejected");}
  }
  let entered = false; let sealed = false; let uncertain = false; let retired = false;
  const uses = new Map<string, string>();
  const seal = (kind: "retired" | "quarantined"): void => {
    if (sealed) {return;}
    sealed = true;
    try {storage.append("consumption", kind, {acknowledgedUses: uses.size}); retired = kind === "retired";}
    catch {uncertain = true;}
  };
  return Object.freeze({prepare: async (): Promise<HostHttpConsumptionPreparation> => {
    if (entered) {return {kind: "reconciliation_required"};} entered = true;
    try {storage.create("consumption", scope);} catch {sealed = true; uncertain = true; return {kind: "unknown"};}
    return Object.freeze({kind: "ready", journal: Object.freeze({consume: (input: ConsumptionKey, fingerprint: string) => {
      if (sealed) {return "unknown" as const;}
      try {
        const key = captureConsumptionKey(input); const digest = consumptionFingerprint(fingerprint);
        storage.assertIntact();
        if (key.operationId !== scope.operationId || key.tenantId !== scope.tenantId || key.projectId !== scope.projectId) {
          uncertain = true; seal("quarantined"); return "mismatch" as const;
        }
        const index = JSON.stringify(key); const previous = uses.get(index);
        if (previous !== undefined) {
          if (previous === digest) {return "duplicate" as const;}
          uncertain = true; seal("quarantined"); return "mismatch" as const;
        }
        if (uses.size >= 256) {throw new Error("Darwin consumption capacity exhausted");}
        storage.append("consumption", "consume", {key, fingerprint: digest});
        uses.set(index, digest); return "consumed" as const;
      } catch {uncertain = true; seal("quarantined"); return "unknown" as const;}
    }}), quarantine() {uncertain = true; seal("quarantined");},
    retire() {seal("retired"); return Promise.resolve(retired && !uncertain ? "retired" as const : "unknown" as const);}});
  }});
};
