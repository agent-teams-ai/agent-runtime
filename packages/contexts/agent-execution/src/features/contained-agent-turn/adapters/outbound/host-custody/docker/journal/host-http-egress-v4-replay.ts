import type { DockerContainerAuthority } from "../engine/docker-engine-port.js";
import { dockerCustodyAuthoritySha256, dockerCustodyOwnerIdentitySha256 } from "./docker-custody-journal-codec.js";
import { v4Hash } from "./host-http-egress-v4-codec.js";
import {
  HOST_HTTP_EGRESS_V4_LIMITS as LIMITS, HostHttpEgressV4Error,
  type HostHttpEgressV4Event, type HostHttpEgressV4Observation, type HostHttpEgressV4Record,
  type HostHttpEgressV4Subject,
} from "./host-http-egress-v4-types.js";

interface Resource { phase: 0 | 1 | 2 | 3 | 4; actual: string | null; }
interface Exchange { number: number; inbound: Resource; upstream: Resource; closing: boolean; }
export interface HostHttpEgressV4Ledger {
  network: Resource; listener: Resource; route: Resource;
  container: DockerContainerAuthority | null; containerAbsent: boolean;
  exchange: Exchange | null; exchanges: number;
  cutoff: boolean; cutoffObserved: boolean; reconcileRequired: boolean; retired: boolean;
  actualIdentities: string[];
}
const resource = (): Resource => ({ phase: 0, actual: null });
export const v4EmptyLedger = (): HostHttpEgressV4Ledger => ({ network: resource(), listener: resource(), route: resource(),
  container: null, containerAbsent: false, exchange: null, exchanges: 0,
  cutoff: false, cutoffObserved: false, reconcileRequired: false, retired: false, actualIdentities: [] });
const ensure = (condition: boolean): void => { if (!condition) { throw new HostHttpEgressV4Error("conflict"); } };
const socketHandle = (subject: HostHttpEgressV4Subject, number: number, side: "inbound" | "upstream"): string =>
  `${side}:${v4Hash({ subjectSha256: v4Hash(subject), number, side })}`;
/** Private exact locator; neither a pathname nor evidence that an OS resource exists. */
export const v4Target = (s: HostHttpEgressV4Subject, state: HostHttpEgressV4Ledger, kind: HostHttpEgressV4Event["kind"]): string => {
  let target: unknown = null;
  if (kind.startsWith("network_")) { target = { handle: s.networkHandle, actual: state.network.actual }; }
  else if (kind.startsWith("listener_")) { target = { handle: s.listenerHandle, actual: state.listener.actual }; }
  else if (kind.startsWith("route_") || kind.startsWith("cutoff")) { target = { handle: s.routeHandle, actual: state.route.actual }; }
  else if (kind.startsWith("container_")) { target = state.container; }
  else if (kind.startsWith("inbound_") || kind.startsWith("upstream_")) {
    const side = kind.startsWith("inbound_") ? "inbound" : "upstream";
    target = { handle: socketHandle(s, state.exchange?.number ?? state.exchanges + 1, side) };
  } else if (kind.startsWith("sockets_")) {
    target = state.exchange === null ? null : { number: state.exchange.number,
      inbound: { handle: socketHandle(s, state.exchange.number, "inbound"), actual: state.exchange.inbound.actual },
      upstream: { handle: socketHandle(s, state.exchange.number, "upstream"), actual: state.exchange.upstream.actual } };
  }
  return v4Hash({ subjectSha256: v4Hash(s), target });
};
const checkContainer = (s: HostHttpEgressV4Subject, container: DockerContainerAuthority): void => {
  for (const key of ["daemonIdentitySha256", "daemonBootGenerationSha256", "hostIdentitySha256",
    "hostBootGenerationSha256", "launchFingerprintSha256", "operationNonceSha256"] as const) {
    ensure(container[key] === s.attempt[key]);
  }
  ensure(container.ownerIdentitySha256 === dockerCustodyOwnerIdentitySha256(s.attempt) && container.imageDigest === s.imageDigest);
};
const checkObservation = (s: HostHttpEgressV4Subject, state: HostHttpEgressV4Ledger, observation: HostHttpEgressV4Observation): void => {
  ensure(observation.subjectSha256 === v4Hash(s) && observation.observerSha256 === s.observerSha256 &&
    observation.targetSha256 === v4Target(s, state, observation.kind));
  if (!observation.kind.startsWith("container_")) { ensure(observation.container === null); return; }
  if (observation.container !== null) { checkContainer(s, observation.container); }
  if (observation.kind === "container_attached") { ensure(observation.container !== null); }
  if (state.container !== null) {
    ensure(observation.container !== null &&
      dockerCustodyAuthoritySha256(observation.container) === dockerCustodyAuthoritySha256(state.container));
  }
};
const allocate = (r: Resource, receipt?: HostHttpEgressV4Observation): void => {
  ensure(r.phase === (receipt === undefined ? 0 : 1));
  r.phase = receipt === undefined ? 1 : 2; r.actual = receipt?.actualSha256 ?? null;
};
const release = (r: Resource, receipt: boolean): void => {
  ensure(receipt ? r.phase === 3 : r.phase === 1 || r.phase === 2);
  r.phase = receipt ? 4 : 3;
};
const setup = (state: HostHttpEgressV4Ledger, event: HostHttpEgressV4Event): boolean => {
  const observation = "observation" in event ? event.observation : undefined;
  switch (event.kind) {
    case "network_intent": case "network_allocated":
      ensure(!state.cutoff); allocate(state.network, observation); return true;
    case "listener_intent": case "listener_allocated":
      ensure(!state.cutoff && state.network.phase === 2); allocate(state.listener, observation); return true;
    case "container_attached":
      ensure(!state.cutoff && state.listener.phase === 2 && state.container === null);
      state.container = event.observation.container; return true;
    case "route_intent": case "route_installed":
      ensure(!state.cutoff && state.container !== null); allocate(state.route, observation); return true;
    default: return false;
  }
};
const exchange = (state: HostHttpEgressV4Ledger, event: HostHttpEgressV4Event): boolean => {
  switch (event.kind) {
    case "inbound_intent":
      ensure(!state.cutoff && !state.reconcileRequired && state.route.phase === 2 && state.exchange === null && state.exchanges < LIMITS.maxExchanges);
      state.exchanges += 1;
      state.exchange = { number: state.exchanges, inbound: { phase: 1, actual: null }, upstream: resource(), closing: false }; return true;
    case "inbound_allocated": case "upstream_intent": case "upstream_allocated": {
      const active = state.exchange;
      ensure(!state.cutoff && active !== null && !active.closing);
      if (active === null) { throw new HostHttpEgressV4Error("conflict"); }
      if (event.kind === "inbound_allocated") { allocate(active.inbound, event.observation); }
      else { ensure(active.inbound.phase === 2); allocate(active.upstream, "observation" in event ? event.observation : undefined); }
      return true;
    }
    default: return false;
  }
};
const closeSockets = (state: HostHttpEgressV4Ledger, event: HostHttpEgressV4Event): boolean => {
  switch (event.kind) {
    case "sockets_close":
      ensure(state.exchange !== null && !state.exchange.closing);
      if (state.exchange !== null) { state.exchange.closing = true; } return true;
    case "sockets_closed": {
      const active = state.exchange; ensure(active !== null && active.closing);
      if (active?.inbound.phase === 1 || active?.upstream.phase === 1 || event.observation.writeOutcome === "unknown") { state.reconcileRequired = true; }
      state.exchange = null; return true;
    }
    default: return false;
  }
};
const cleanup = (state: HostHttpEgressV4Ledger, event: HostHttpEgressV4Event): void => {
  switch (event.kind) {
    case "cutoff":
      ensure(!state.cutoff); state.cutoff = true;
      if ([state.network, state.listener, state.route, state.exchange?.inbound, state.exchange?.upstream]
        .some(r => r?.phase === 1)) { state.reconcileRequired = true; } return;
    case "cutoff_observed": ensure(state.cutoff && !state.cutoffObserved); state.cutoffObserved = true; return;
    case "container_absent":
      ensure(state.cutoffObserved && state.exchange === null && !state.containerAbsent);
      state.containerAbsent = true; return;
    case "uncertain": ensure(!state.reconcileRequired); state.reconcileRequired = true; return;
    case "retired":
      ensure(state.cutoffObserved && state.containerAbsent && state.exchange === null &&
        [0, 4].includes(state.listener.phase) && [0, 4].includes(state.network.phase)); state.retired = true; return;
    default: releaseEndpoints(state, event);
  }
};
const releaseEndpoints = (state: HostHttpEgressV4Ledger, event: HostHttpEgressV4Event): void => {
  ensure(state.containerAbsent && state.cutoffObserved && state.exchange === null);
  switch (event.kind) {
    case "listener_release": case "listener_absent": release(state.listener, event.kind === "listener_absent"); return;
    case "network_release": case "network_absent":
      ensure([0, 4].includes(state.listener.phase)); release(state.network, event.kind === "network_absent"); return;
    default: throw new HostHttpEgressV4Error("conflict");
  }
};
/** Shared append/replay recipe; only resource axes live here. Kernel operation truth is elsewhere. */
export const v4Apply = (s: HostHttpEgressV4Subject, previous: HostHttpEgressV4Ledger, event: HostHttpEgressV4Event): HostHttpEgressV4Ledger => {
  ensure(!previous.retired && event.kind !== "opened");
  if ("observation" in event) { checkObservation(s, previous, event.observation); }
  else if ("targetSha256" in event) { ensure(event.targetSha256 === v4Target(s, previous, event.kind)); }
  const next = structuredClone(previous);
  if ("observation" in event && (event.kind.endsWith("_allocated") || event.kind === "route_installed")) {
    ensure(!next.actualIdentities.includes(event.observation.actualSha256)); next.actualIdentities.push(event.observation.actualSha256);
  }
  if (!setup(next, event) && !exchange(next, event) && !closeSockets(next, event)) { cleanup(next, event); }
  return next;
};
export const v4Replay = (records: readonly HostHttpEgressV4Record[], expected: HostHttpEgressV4Subject): HostHttpEgressV4Ledger => {
  let state = v4EmptyLedger(); const commands = new Set<string>();
  for (const record of records) {
    ensure(record.subjectSha256 === v4Hash(expected) && !commands.has(record.commandId)); commands.add(record.commandId);
    if (record.sequence === 0) { ensure(record.event.kind === "opened" && v4Hash(record.event.subject) === v4Hash(expected)); }
    else { state = v4Apply(expected, state, record.event); }
  }
  ensure(records.length > 0); return state;
};

/** Cleanup locators remain private and cannot be used for fresh allocation/dispatch. */
export const v4CleanupHandles = (s: HostHttpEgressV4Subject, state: HostHttpEgressV4Ledger) => Object.freeze({
  network: state.network.phase === 0 || state.network.phase === 4 ? null : Object.freeze({ handle: s.networkHandle, actualSha256: state.network.actual }),
  listener: state.listener.phase === 0 || state.listener.phase === 4 ? null : Object.freeze({ handle: s.listenerHandle, actualSha256: state.listener.actual }),
  route: state.route.phase === 0 ? null : Object.freeze({ handle: s.routeHandle, actualSha256: state.route.actual }),
  container: state.container === null ? null : Object.freeze({ ...state.container }), custodyAttempt: s.attempt,
  sockets: state.exchange === null ? null : Object.freeze({
    inbound: socketHandle(s, state.exchange.number, "inbound"), inboundActualSha256: state.exchange.inbound.actual,
    upstream: state.exchange.upstream.phase === 0 ? null : socketHandle(s, state.exchange.number, "upstream"),
    upstreamActualSha256: state.exchange.upstream.actual,
  }),
});
