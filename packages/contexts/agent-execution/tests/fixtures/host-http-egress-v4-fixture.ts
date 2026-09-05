import { v4Decode, v4Hash } from "../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/journal/host-http-egress-v4-codec.js";
import { dockerCustodyOwnerIdentitySha256 } from "../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/journal/docker-custody-journal-codec.js";
import { HostHttpEgressV4Journal } from "../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/journal/host-http-egress-v4-journal.js";
import { v4Replay } from "../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/journal/host-http-egress-v4-replay.js";
import type { HostHttpEgressV4Capacity, HostHttpEgressV4Intent, HostHttpEgressV4Observation, HostHttpEgressV4ObservationOwner,
  HostHttpEgressV4Observed, HostHttpEgressV4Storage, HostHttpEgressV4Subject,
} from "../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/journal/host-http-egress-v4-types.js";

export const id = (prefix: string): string => `${prefix}:${v4Hash(prefix)}`;
export const subject: HostHttpEgressV4Subject = Object.freeze({
  attempt: Object.freeze({ tenantId: id("tenant"), projectId: id("project"), operationId: id("operation"), attemptId: id("attempt"),
    custodyId: id("custody"), hostInstanceId: id("host-instance"), hostBootId: id("host-boot"),
    daemonIdentitySha256: v4Hash("daemon"), daemonBootGenerationSha256: v4Hash("daemon-boot"), hostIdentitySha256: v4Hash("host"),
    hostBootGenerationSha256: v4Hash("host-boot-generation"), launchFingerprintSha256: v4Hash("launch"), operationNonceSha256: v4Hash("nonce") }),
  effectId: id("effect"), workspaceId: id("workspace"), executionGenerationId: id("execution-generation"),
  scopeSha256: v4Hash("scope"), acceptedAuthoritySha256: v4Hash("accepted"), committedClaimSha256: v4Hash("committed"),
  observerSha256: v4Hash("retained-owner"), imageDigest: id("sha256"), networkHandle: id("network"), listenerHandle: id("listener"), routeHandle: id("route"),
});
export const container = Object.freeze({ containerId: v4Hash("actual-container"),
  daemonIdentitySha256: subject.attempt.daemonIdentitySha256, daemonBootGenerationSha256: subject.attempt.daemonBootGenerationSha256,
  hostIdentitySha256: subject.attempt.hostIdentitySha256, hostBootGenerationSha256: subject.attempt.hostBootGenerationSha256,
  launchFingerprintSha256: subject.attempt.launchFingerprintSha256, operationNonceSha256: subject.attempt.operationNonceSha256,
  ownerIdentitySha256: dockerCustodyOwnerIdentitySha256(subject.attempt), imageDigest: subject.imageDigest, createSpecificationSha256: v4Hash("created-spec") });

/** Test-only synthetic observer: no production issuer, network or container effects. */
export class SyntheticV4Owner implements HostHttpEgressV4ObservationOwner {
  readonly #tokens = new WeakMap<object, HostHttpEgressV4Observation>();
  public reads = 0;
  public token(data: HostHttpEgressV4Observation): object {
    const token = Object.freeze({}); this.#tokens.set(token, Object.freeze(data)); return token;
  }
  public readObservation(token: object): HostHttpEgressV4Observation | undefined { this.reads += 1; return this.#tokens.get(token); }
}
export class MemoryV4Storage implements HostHttpEgressV4Storage {
  public journal: Uint8Array | null = null;
  public marker: Uint8Array | null = null;
  public owned = true;
  public calls = 0;
  public fault: "before" | "after" | "short" | "tombstone" | null = null;
  public async prepare() { this.calls += 1; return { journal: this.journal?.slice() ?? null, tombstone: this.marker?.slice() ?? null }; }
  public async assertOwned(): Promise<void> { if (!this.owned) { throw new Error("synthetic lock loss"); } }
  public async append(expected: number, bytes: Uint8Array): Promise<void> {
    this.calls += 1; const fault = this.fault; if (fault !== "tombstone") { this.fault = null; }
    if (expected !== (this.journal?.length ?? 0) || fault === "before") { throw new Error("synthetic append failure"); }
    this.journal = Buffer.concat([this.journal ?? Buffer.alloc(0), fault === "short" ? bytes.subarray(0, 10) : bytes]);
    if (fault === "after" || fault === "short") { throw new Error("synthetic acknowledgement loss"); }
  }
  public async tombstone(bytes: Uint8Array): Promise<void> {
    if (this.marker !== null) { throw new Error("exclusive marker exists"); }
    this.marker = bytes.slice(); if (this.fault === "tombstone") { this.fault = null; throw new Error("lost marker ack"); }
  }
  public async close(): Promise<void> {}
}
export class V4Fixture {
  public readonly owner = new SyntheticV4Owner();
  public readonly journal: HostHttpEgressV4Journal;
  public readonly storage: MemoryV4Storage;
  public serial = 0;
  public constructor(storage = new MemoryV4Storage(), capacity?: HostHttpEgressV4Capacity) {
    this.storage = storage;
    this.journal = new HostHttpEgressV4Journal(storage, subject, this.owner, capacity);
  }
  public command(): string { this.serial += 1; return `command:${v4Hash([this.serial, this.storage.journal?.length])}`; }
  public async open() { return this.journal.prepare(this.command()); }
  public async intent(kind: HostHttpEgressV4Intent) {
    return this.journal.recordIntent(this.command(), { kind, targetSha256: this.journal.target(kind) });
  }
  public state() { return v4Replay(v4Decode(this.storage.journal!), subject); }
  public data(kind: HostHttpEgressV4Observed, changes: Partial<HostHttpEgressV4Observation> = {}): HostHttpEgressV4Observation {
    return { kind, subjectSha256: v4Hash(subject), observerSha256: subject.observerSha256, targetSha256: this.journal.target(kind),
      actualSha256: v4Hash([kind, this.storage.journal?.length, this.serial]), evidenceSha256: v4Hash(["observed", this.serial]),
      container: kind === "container_attached" || kind === "container_absent" && this.state().container !== null ? container : null,
      writeOutcome: kind === "sockets_closed" ? "settled" : null, ...changes };
  }
  public async observe(kind: HostHttpEgressV4Observed, changes: Partial<HostHttpEgressV4Observation> = {}) {
    return this.journal.recordObservation(this.command(), this.owner.token(this.data(kind, changes)));
  }
  public async setup(): Promise<void> {
    await this.open(); await this.intent("network_intent"); await this.observe("network_allocated");
    await this.intent("listener_intent"); await this.observe("listener_allocated"); await this.observe("container_attached");
    await this.intent("route_intent"); await this.observe("route_installed");
  }
  public async exchange(): Promise<void> {
    await this.intent("inbound_intent"); await this.observe("inbound_allocated");
    await this.intent("upstream_intent"); await this.observe("upstream_allocated");
    await this.intent("sockets_close"); await this.observe("sockets_closed");
  }
  public async settle(): Promise<void> {
    let state = this.state(); if (state.retired) { return; }
    if (!state.cutoff) { await this.intent("cutoff"); }
    if (!state.cutoffObserved) { await this.observe("cutoff_observed"); }
    if (state.exchange !== null) {
      if (!state.exchange.closing) { await this.intent("sockets_close"); } await this.observe("sockets_closed");
    }
    if (!state.containerAbsent) { await this.observe("container_absent"); }
    state = this.state();
    if (state.listener.phase > 0 && state.listener.phase < 4) {
      if (state.listener.phase !== 3) { await this.intent("listener_release"); } await this.observe("listener_absent");
    }
    if (state.network.phase > 0 && state.network.phase < 4) {
      if (state.network.phase !== 3) { await this.intent("network_release"); } await this.observe("network_absent");
    }
    await this.intent("retired");
  }
}
