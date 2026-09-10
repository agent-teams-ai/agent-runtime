import { withStableDirectoryProcessLock } from "@agent-teams/filesystem-custody/composition";

import type { HostHttpConsumptionJournal } from "./http-egress-ports.js";
import {
  MAX_CONSUMPTION_BYTES, captureConsumptionEnvelope, captureConsumptionKey, captureConsumptionLimits,
  consumptionDigest, consumptionFingerprint, consumptionHeader, consumptionRecord, consumptionTombstone,
  sameConsumptionScope, type ConsumptionKey, type HostHttpConsumptionEnvelope, type HostHttpConsumptionLimits,
} from "./host-http-consumption-format.js";
import {
  HostHttpConsumptionStorage, captureConsumptionDirectory, type HostHttpConsumptionDirectory,
} from "./host-http-consumption-storage.js";

export interface PreparedHostHttpConsumptionJournal {
  readonly kind: "ready";
  readonly journal: HostHttpConsumptionJournal;
  /** Irreversible local seal; retains the process lock until retire. */
  quarantine(): void;
  /** Resource disposal only, never TCP drain, provider containment, or terminal
   * operation truth. Leaves all generation/tombstone bytes for reconciliation.
   * MUST seal admission synchronously before returning the cleanup promise. */
  retire(): Promise<"retired" | "unknown">;
  /** Owner-issued physical evidence only. Absence never proves disposal.
   * Quarantine remains uncertainty even when its seal and closure acknowledge. */
  disposalEvidence?(): Readonly<{persistedSeal: "retired" | "quarantined" | "unknown"; closed: boolean}>;
}

export type HostHttpConsumptionPreparation = PreparedHostHttpConsumptionJournal |
  Readonly<{ kind: "busy" | "reconciliation_required" | "unknown" | "unsupported" }>;

class ConsumptionTail implements HostHttpConsumptionJournal {
  private readonly acknowledged = new Map<string, string>();
  private sealed = false;
  private retired = false;
  private persistedSeal: "retired" | "quarantined" | "unknown" = "unknown";
  private tailDigest: string;
  private readonly envelopeDigest: string;

  public constructor(
    private readonly storage: HostHttpConsumptionStorage,
    private readonly envelope: HostHttpConsumptionEnvelope,
    private readonly limits: HostHttpConsumptionLimits,
    header: Buffer,
  ) {
    this.envelopeDigest = consumptionDigest(JSON.stringify(envelope));
    this.tailDigest = consumptionDigest(header);
  }

  public consume(input: ConsumptionKey, requestFingerprint: string): ReturnType<HostHttpConsumptionJournal["consume"]> {
    if (this.sealed) { return "unknown"; }
    try {
      const key = captureConsumptionKey(input);
      const fingerprint = consumptionFingerprint(requestFingerprint);
      this.storage.assertIntact();
      if (!sameConsumptionScope(key, this.envelope)) { this.seal("quarantined"); return "mismatch"; }
      const indexKey = JSON.stringify(key);
      const previous = this.acknowledged.get(indexKey);
      if (previous !== undefined) {
        if (previous === fingerprint) { return "duplicate"; }
        this.seal("quarantined");
        return "mismatch";
      }
      // Reserve worst-case record/index capacity BEFORE allocating a frame or
      // adding an index entry. Unknown burns this entire generation, including
      // keys that may have reached storage without an acknowledgement.
      if (this.acknowledged.size >= this.limits.maxBoundaryUses || this.storage.remainingBytes < MAX_CONSUMPTION_BYTES) {
        this.seal("quarantined");
        return "unknown";
      }
      const bytes = consumptionRecord({ sequence: this.acknowledged.size + 1,
        envelopeDigest: this.envelopeDigest, previousDigest: this.tailDigest, key, requestFingerprint: fingerprint });
      this.storage.append(bytes);
      this.acknowledged.set(indexKey, fingerprint);
      this.tailDigest = consumptionDigest(bytes);
      return "consumed";
    } catch {
      this.seal("quarantined");
      return "unknown";
    }
  }

  public seal(disposition: "retired" | "quarantined"): boolean {
    if (this.sealed) { return this.retired; }
    this.sealed = true;
    // Mark before I/O, including before the tombstone allocation. No failure
    // can reopen admission; ENOSPC may leave only the exclusive generation file.
    try {
      const persisted = this.storage.persistTombstone(consumptionTombstone({ disposition,
        envelopeDigest: this.envelopeDigest, acknowledgedUses: this.acknowledged.size, tailDigest: this.tailDigest }));
      if (persisted) { this.persistedSeal = disposition; }
      this.retired = disposition === "retired" && persisted;
    } catch { this.retired = false; }
    return this.retired;
  }

  public sealEvidence(): "retired" | "quarantined" | "unknown" { return this.persistedSeal; }

  public retire(): boolean {
    if (!this.sealed) {
      try { this.storage.assertIntact(); }
      catch { return this.seal("quarantined"); }
    }
    return this.seal("retired");
  }
}

const unsupported = (error: unknown): boolean => error instanceof Error && [
  "consumption platform unsupported",
  "the qualified stable directory process lock binding is unavailable",
  "the qualified stable directory process lock binding is invalid",
  "stable directory process locks are qualified only on Linux",
].includes(error.message);

/** Dormant concrete Host adapter. Construction only snapshots bounded identity
 * and settings. The later real post-claim binder must supply the private root
 * pin, exact owner envelope, and manage retirement. Obtaining this object or
 * preparing its storage proves no claim provenance, policy, current authority,
 * route enforcement, or qualification. Production/canary admission stays closed.
 * No descriptor, process lock, timer, or background task exists before prepare.
 */
export const createNodeHostHttpConsumptionJournal = (input: Readonly<{
  directory: HostHttpConsumptionDirectory;
  envelope: HostHttpConsumptionEnvelope;
  limits?: HostHttpConsumptionLimits;
}>): Readonly<{ prepare(): Promise<HostHttpConsumptionPreparation> }> => {
  const directory = captureConsumptionDirectory(input.directory);
  const envelope = captureConsumptionEnvelope(input.envelope);
  const limits = captureConsumptionLimits(input.limits);
  let attempted = false;
  return Object.freeze({ prepare: async (): Promise<HostHttpConsumptionPreparation> => {
    // flock is reentrant per descriptor; reserve this instance before any await.
    // A losing/failed prepare is not retryable through the same factory.
    if (attempted) { return { kind: "unknown" }; }
    attempted = true;
    const ready = Promise.withResolvers<HostHttpConsumptionPreparation>();
    const release = Promise.withResolvers<void>();
    let storage: HostHttpConsumptionStorage | undefined;
    let tail: ConsumptionTail | undefined;
    let contended = false;
    let cleanupSucceeded = true;
    let cleanupComplete = false;
    let retirement: Promise<"retired" | "unknown"> | undefined;
    const running = (async (): Promise<void> => {
      try {
        storage = await HostHttpConsumptionStorage.open(directory, limits.maxJournalBytes);
        const held = storage;
        await withStableDirectoryProcessLock(held.directory, async () => {
          const header = consumptionHeader(envelope, limits);
          tail = new ConsumptionTail(held, envelope, limits, header);
          try {
            if (held.hasResidue()) {
              tail.seal("quarantined"); ready.resolve({ kind: "reconciliation_required" }); return;
            }
          } catch {
            tail.seal("quarantined"); ready.resolve({ kind: "reconciliation_required" }); return;
          }
          held.create(header);
          const live = tail;
          ready.resolve(Object.freeze({ kind: "ready", journal: Object.freeze({
            consume: (key: ConsumptionKey, fingerprint: string) => live.consume(key, fingerprint),
          }), disposalEvidence: () => Object.freeze({persistedSeal: live.sealEvidence(),
            closed: cleanupComplete && cleanupSucceeded}), quarantine: () => { live.seal("quarantined"); }, retire: () => {
            retirement ??= (async (): Promise<"retired" | "unknown"> => {
              const retired = live.retire();
              release.resolve();
              await running;
              return retired && cleanupSucceeded ? "retired" : "unknown";
            })();
            return retirement;
          } }));
          await release.promise;
        }, { onContention: () => { contended = true; throw new Error("consumption lock busy"); } });
      } catch (error) {
        tail?.seal("quarantined");
        cleanupSucceeded = false;
        ready.resolve({ kind: contended ? "busy" : unsupported(error) ? "unsupported" : "unknown" });
      } finally {
        try { await storage?.close(); } catch { cleanupSucceeded = false; }
        cleanupComplete = true;
      }
    })();
    const result = await ready.promise;
    // Failed preparation returns only after descriptors and locks are released.
    if (result.kind !== "ready") { await running; }
    return result;
  } });
};
