import {
  v4Decode, v4DecodeTombstone, v4Encode, v4Event, v4Hash, v4Locator,
  v4Observation, v4Record, v4Subject, v4Tombstone,
} from "./host-http-egress-v4-codec.js";
import { v4Apply, v4CleanupHandles, v4EmptyLedger, v4Replay, v4Target, type HostHttpEgressV4Ledger } from "./host-http-egress-v4-replay.js";
import {
  HOST_HTTP_EGRESS_V4_LIMITS as LIMITS, HostHttpEgressV4Error,
  type HostHttpEgressV4Capacity, type HostHttpEgressV4Event, type HostHttpEgressV4Intent,
  type HostHttpEgressV4ObservationOwner, type HostHttpEgressV4Record, type HostHttpEgressV4Storage,
  type HostHttpEgressV4Subject,
} from "./host-http-egress-v4-types.js";

const cleanupKinds = new Set<HostHttpEgressV4Event["kind"]>(["cutoff", "cutoff_observed", "sockets_close", "sockets_closed",
  "container_absent", "listener_release", "listener_absent", "network_release", "network_absent", "retired", "uncertain"]);
const allocationKinds = new Set<HostHttpEgressV4Event["kind"]>(["network_intent", "listener_intent", "route_intent", "inbound_intent", "upstream_intent"]);
const releaseSlots = (phase: number): number => phase === 0 || phase === 4 ? 0 : phase === 3 ? 1 : 2;
const remainingCleanup = (s: HostHttpEgressV4Ledger): number => {
  return (s.cutoff ? s.cutoffObserved ? 0 : 1 : 2) + (s.exchange === null ? 0 : s.exchange.closing ? 1 : 2) +
    (s.containerAbsent ? 0 : 1) + releaseSlots(s.listener.phase) + releaseSlots(s.network.phase) +
    (s.retired ? 0 : 1) + 2; // retained tombstone + uncertainty evidence
};

/**
 * Dormant Host-private ledger. Constructors perform no I/O. Only explicit prepare
 * opens storage; a fresh acknowledged intent is the sole permission to attempt
 * its named resource effect. Duplicate/recovered intents never authorize repeats.
 * No real observer is implemented here: durable bytes do not independently prove
 * kernel route denial, socket absence/drain, container removal or zero upstream
 * effects. The retained authority adapter must supply those observations later.
 * retired closes this resource ledger only. The kernel owns operation/output truth.
 */
export class HostHttpEgressV4Journal {
  readonly #storage: HostHttpEgressV4Storage;
  readonly #subject: HostHttpEgressV4Subject;
  readonly #readObservation: HostHttpEgressV4ObservationOwner["readObservation"];
  readonly #limits: HostHttpEgressV4Capacity;
  readonly #commands = new Map<string, HostHttpEgressV4Record>();
  #state = v4EmptyLedger();
  #tail: HostHttpEgressV4Record | undefined;
  #bytes = 0;
  #started = false;
  #prepared = false;
  #recovery = false;
  #unknown = false;
  #busy = false;
  #tombstoned = false;
  #uncertainAppend: string | null = null;

  public constructor(storage: HostHttpEgressV4Storage, subject: HostHttpEgressV4Subject,
    owner: HostHttpEgressV4ObservationOwner, capacity: HostHttpEgressV4Capacity = LIMITS) {
    this.#storage = storage; this.#subject = v4Subject(subject);
    this.#readObservation = owner.readObservation.bind(owner);
    if (!Number.isSafeInteger(capacity.maxRecords) || capacity.maxRecords < 1 || capacity.maxRecords > LIMITS.maxRecords ||
      !Number.isSafeInteger(capacity.maxBytes) || capacity.maxBytes < 1 || capacity.maxBytes > LIMITS.maxBytes) {
      throw new HostHttpEgressV4Error("capacity");
    }
    this.#limits = Object.freeze({ maxRecords: capacity.maxRecords, maxBytes: capacity.maxBytes });
  }
  public evidence() {
    return Object.freeze({ subjectSha256: v4Hash(this.#subject), tailSha256: this.#tail?.checksumSha256 ?? null,
      resourceLedger: this.#unknown ? "quarantined" : this.#state.retired ? "retired" : "open",
      admission: this.#unknown || this.#recovery || this.#state.cutoff || this.#state.reconcileRequired || !this.#prepared ? "closed" : "fresh_ledger",
      reconcileRequired: this.#unknown || this.#state.reconcileRequired });
  }
  async #tombstone(disposition: "retired" | "quarantined"): Promise<void> {
    if (this.#tombstoned) { return; }
    const tombstone = v4Tombstone({ subjectSha256: v4Hash(this.#subject), tailSha256: this.#tail?.checksumSha256 ?? v4Hash(null),
      uncertainAppendSha256: this.#uncertainAppend,
      disposition, reconcileRequired: disposition === "quarantined" || this.#state.reconcileRequired });
    await this.#storage.tombstone(v4Encode(tombstone)); this.#tombstoned = true;
  }
  async #quarantine(): Promise<never> {
    this.#unknown = true; this.#state.reconcileRequired = true;
    await this.#tombstone("quarantined").catch(() => {});
    throw new HostHttpEgressV4Error("quarantined");
  }
  #capacity(record: HostHttpEgressV4Record, bytes: Uint8Array, next: HostHttpEgressV4Ledger): void {
    const reserve = record.event.kind === "opened" ? 24 : record.event.kind === "inbound_intent" ? 18 :
      cleanupKinds.has(record.event.kind) ? remainingCleanup(next) : 12;
    if (record.sequence + 1 + reserve > this.#limits.maxRecords ||
      this.#bytes + bytes.length + reserve * LIMITS.maxRecordBytes > this.#limits.maxBytes) { throw new HostHttpEgressV4Error("capacity"); }
  }
  async #persist(commandId: string, input: HostHttpEgressV4Event) {
    const event = v4Event(input);
    const record = v4Record({ sequence: (this.#tail?.sequence ?? -1) + 1, subjectSha256: v4Hash(this.#subject),
      commandId, event, previousSha256: this.#tail?.checksumSha256 ?? null });
    const previous = this.#commands.get(commandId);
    if (previous) {
      if (previous.commandSha256 !== record.commandSha256) { throw new HostHttpEgressV4Error("conflict"); }
      return Object.freeze({ kind: "duplicate" as const, checksumSha256: previous.checksumSha256 });
    }
    if (this.#recovery && !cleanupKinds.has(event.kind) || this.#state.reconcileRequired && allocationKinds.has(event.kind)) {
      throw new HostHttpEgressV4Error("conflict");
    }
    const next = event.kind === "opened" ? this.#state : v4Apply(this.#subject, this.#state, event);
    const bytes = v4Encode(record); this.#capacity(record, bytes, next);
    try {
      this.#uncertainAppend = record.checksumSha256;
      await this.#storage.append(this.#bytes, bytes); await this.#storage.assertOwned();
      this.#bytes += bytes.length; this.#tail = record; this.#state = next; this.#commands.set(commandId, record);
      this.#uncertainAppend = null;
      if (next.retired) { await this.#tombstone("retired"); }
      return Object.freeze({ kind: "recorded" as const, checksumSha256: record.checksumSha256 });
    } catch { return this.#quarantine(); }
  }
  #recoverTombstone(bytes: Uint8Array, records: readonly HostHttpEgressV4Record[]): void {
    const tomb = v4DecodeTombstone(bytes);
    const tombIndex = records.findIndex(record => record.checksumSha256 === tomb.tailSha256);
    if (tomb.subjectSha256 !== v4Hash(this.#subject) ||
      (tombIndex < 0 && (tomb.disposition !== "quarantined" || tomb.tailSha256 !== v4Hash(null))) ||
      tomb.disposition === "quarantined" && (!tomb.reconcileRequired || records.slice(tombIndex + 1)
        .some((record, index) => !cleanupKinds.has(record.event.kind) &&
          !(index === 0 && record.checksumSha256 === tomb.uncertainAppendSha256))) ||
      tomb.disposition === "retired" && (!this.#state.retired || tomb.tailSha256 !== this.#tail?.checksumSha256)) {
      throw new HostHttpEgressV4Error("quarantined");
    }
    this.#tombstoned = true; this.#state.reconcileRequired ||= tomb.reconcileRequired;
  }
  public async prepare(commandId: string) {
    if (this.#started) { throw new HostHttpEgressV4Error("conflict"); } this.#started = true; this.#busy = true;
    try {
      const files = await this.#storage.prepare(v4Locator(this.#subject));
      if (files.journal === null) {
        if (files.tombstone !== null) { throw new HostHttpEgressV4Error("quarantined"); }
        await this.#persist(commandId, { kind: "opened", subject: this.#subject }); this.#prepared = true;
        return Object.freeze({ kind: "fresh" as const, evidence: this.evidence() });
      }
      this.#recovery = true;
      if (files.journal.length > this.#limits.maxBytes) { throw new HostHttpEgressV4Error("quarantined"); }
      const records = v4Decode(files.journal);
      if (records.length > this.#limits.maxRecords) { throw new HostHttpEgressV4Error("quarantined"); }
      this.#state = v4Replay(records, this.#subject); this.#tail = records.at(-1); this.#bytes = files.journal.length;
      for (const record of records) { this.#commands.set(record.commandId, record); }
      if (files.tombstone !== null) { this.#recoverTombstone(files.tombstone, records); }
      // A surviving prefix cannot prove its last acknowledgement was delivered.
      if (!this.#state.retired || !this.#tombstoned) {
        this.#state.reconcileRequired = true; await this.#tombstone("quarantined");
      }
      await this.#storage.assertOwned(); this.#prepared = true;
      return Object.freeze({ kind: "cleanup_only" as const, evidence: this.evidence() });
    } catch (error) {
      if (error instanceof HostHttpEgressV4Error && error.code === "capacity" && this.#tail === undefined) { throw error; }
      return this.#quarantine();
    } finally { this.#busy = false; }
  }
  #admit(): void {
    if (this.#busy) { throw new HostHttpEgressV4Error("busy"); }
    if (!this.#prepared || this.#unknown) { throw new HostHttpEgressV4Error("quarantined"); }
  }
  public target(kind: Exclude<HostHttpEgressV4Event["kind"], "opened">): string {
    this.#admit(); return v4Target(this.#subject, this.#state, kind);
  }
  public async recordIntent(commandId: string, input: Readonly<{ kind: HostHttpEgressV4Intent; targetSha256: string }>) {
    this.#admit(); this.#busy = true;
    try { await this.#storage.assertOwned(); return await this.#persist(commandId, input); }
    catch (error) {
      if (error instanceof HostHttpEgressV4Error && ["conflict", "capacity"].includes(error.code)) { throw error; }
      return this.#quarantine();
    } finally { this.#busy = false; }
  }
  public async recordObservation(commandId: string, token: object) {
    this.#admit(); this.#busy = true;
    try {
      const observation = v4Observation(this.#readObservation(token));
      await this.#storage.assertOwned();
      return await this.#persist(commandId, { kind: observation.kind, observation });
    } catch (error) {
      if (error instanceof HostHttpEgressV4Error && ["conflict", "capacity"].includes(error.code)) { throw error; }
      return this.#quarantine();
    } finally { this.#busy = false; }
  }
  public async cleanupHandles() {
    this.#admit(); this.#busy = true;
    try {
      await this.#storage.assertOwned();
      return Object.freeze({ kind: "cleanup_only" as const, handles: v4CleanupHandles(this.#subject, this.#state) });
    }
    catch { return this.#quarantine(); }
    finally { this.#busy = false; }
  }
  public async close(): Promise<void> {
    if (this.#busy) { throw new HostHttpEgressV4Error("busy"); }
    this.#prepared = false; this.#recovery = true;
    try { await this.#storage.close(); } catch { this.#unknown = true; throw new HostHttpEgressV4Error("quarantined"); }
  }
}
