import { types } from "node:util";
import { canonicalDockerCustodyJson, dockerCustodyAuthoritySha256, validateDockerCustodyAttemptKey } from "./journal/docker-custody-journal-codec.js";
import { HostHttpEgressV4Journal } from "./journal/host-http-egress-v4-journal.js";
import { v4Digest, v4Exact, v4Hash, v4Subject } from "./journal/host-http-egress-v4-codec.js";
import type { DockerContainerAuthority } from "./engine/docker-engine-port.js";
import type { createDockerRemovalObservationOwner } from "./docker-removal-observation-owner.js";
import type { LinuxExclusiveRouteOwner } from "./linux-exclusive-route-owner.js";
import type { LinuxExclusiveRouteEndpoint } from "./linux-exclusive-route-policy.js";
import type { HostHttpEgressV4Intent, HostHttpEgressV4Observation,
  HostHttpEgressV4ObservationOwner, HostHttpEgressV4Observed, HostHttpEgressV4Subject } from "./journal/host-http-egress-v4-types.js";

const rejected = (): Error => new Error("Host HTTP egress V4 observation is unproven");
const {evidence, recordIntent, recordObservation, target} = HostHttpEgressV4Journal.prototype;

/**
 * Joins the retained physical observation owners of one subject into the single
 * owner the V4 journal accepts. It resolves nothing itself: every token is
 * offered to each member in turn, and a token that no member — or more than one
 * member — recognises resolves to nothing at all. Membership is fixed at
 * construction, so no later caller can add an issuer to a live ledger.
 */
export const joinHostHttpEgressV4Observers = (
  members: readonly HostHttpEgressV4ObservationOwner[],
): HostHttpEgressV4ObservationOwner => {
  if (!Array.isArray(members) || members.length < 1 || members.length > 8 ||
    new Set(members).size !== members.length) {throw rejected();}
  const readers = members.map(member => {
    if (member === null || typeof member !== "object" || types.isProxy(member) ||
      typeof member.readObservation !== "function") {throw rejected();}
    return member.readObservation.bind(member);
  });
  return Object.freeze({
    readObservation(token: object): HostHttpEgressV4Observation | undefined {
      let resolved: HostHttpEgressV4Observation | undefined;
      for (const read of readers) {
        const observation = read(token);
        if (observation === undefined) {continue;}
        // Two owners claiming the same token is a conflict, never a preference.
        if (resolved !== undefined) {return undefined;}
        resolved = observation;
      }
      return resolved;
    },
  });
};

/** Point-in-time readback of the retained Host listener recipe. This adapter may
 * not import Host custody, so the shape is restated and checked exactly here; the
 * observer calls the retained method itself and never accepts a readback value. */
export interface DockerHttpListenerReadback {
  observe(): unknown;
}
const READBACK_KEYS = ["scope", "openState", "listenerState", "admissionSealed", "nativeBindPending", "closeRequested",
  "serverCloseAcknowledged", "sockets", "consumerPending", "consumerWorkPending", "uncertainty"] as const;
const SOCKET_KEYS = ["observed", "closeEvents", "awaitingClose", "droppedWithoutSocket"] as const;
type Readback = Readonly<Record<typeof READBACK_KEYS[number], unknown>>;
const readback = (listener: DockerHttpListenerReadback): Readback => {
  if (listener === null || typeof listener !== "object" || types.isProxy(listener) ||
    typeof listener.observe !== "function") {throw rejected();}
  const observed: unknown = Reflect.apply(listener.observe, listener, []);
  v4Exact(observed, [...READBACK_KEYS]);
  v4Exact(observed.sockets, [...SOCKET_KEYS]);
  if (observed.scope !== "retained-node-server-and-delivered-sockets" || !Array.isArray(observed.uncertainty) ||
    typeof observed.admissionSealed !== "boolean" || typeof observed.nativeBindPending !== "boolean" ||
    typeof observed.serverCloseAcknowledged !== "boolean") {throw rejected();}
  return observed as Readback;
};
const listenerAddress = (input: unknown): Readonly<{address: string; port: number}> => {
  v4Exact(input, ["address", "family", "port"]);
  const address = input.address; const port = input.port;
  if (input.family !== "IPv4" || typeof address !== "string" || typeof port !== "number" ||
    !Number.isSafeInteger(port) || port < 1 || port > 65_535 ||
    !/^(?:10|127|172|192)\.\d{1,3}\.\d{1,3}\.\d{1,3}$/u.test(address)) {throw rejected();}
  return Object.freeze({address, port});
};

export type DockerHostHttpEgressObserverInput = Readonly<{
  subject: HostHttpEgressV4Subject;
  /** The lifecycle-owned container removal issuer; absence proof stays with it. */
  removal: Pick<ReturnType<typeof createDockerRemovalObservationOwner>, "readObservation">;
}>;

/**
 * The retained Host-side observation issuers that the network/Engine owner
 * explicitly cannot supply: the listener endpoint, the local admission cut, the
 * exact container absence and the installed kernel route. Each one calls its own
 * physical owner — a Node listener recipe, an AbortSignal, the lifecycle removal
 * owner, an installed route lease — and mints a private token only from what
 * that owner actually reports. No method accepts an observation body, a boolean
 * closure claim or a raw readback value. The V4 ledger stays borrowed: these
 * issuers never open, retire or close it and authorize no provider execution.
 */
export const createDockerHostHttpEgressObservers = (input: DockerHostHttpEgressObserverInput) => {
  v4Exact(input, ["subject", "removal"]);
  const subject = v4Subject(input.subject);
  const removal = input.removal;
  if (removal === null || typeof removal !== "object" || types.isProxy(removal) ||
    typeof removal.readObservation !== "function") {throw rejected();}
  const readRemoval = removal.readObservation.bind(removal);
  const tokens = new WeakMap<object, HostHttpEgressV4Observation>();
  let journal: HostHttpEgressV4Journal | undefined;
  let routeIntent = false;

  const open = (): HostHttpEgressV4Journal => {
    if (journal === undefined) {throw rejected();}
    return journal;
  };
  const publish = async (kind: HostHttpEgressV4Observed, actual: unknown, evidenceOf: unknown,
    container: DockerContainerAuthority | null = null): Promise<void> => {
    const ledger = open();
    const token = Object.freeze({});
    const observation: HostHttpEgressV4Observation = Object.freeze({kind, container, writeOutcome: null,
      subjectSha256: v4Hash(subject), observerSha256: subject.observerSha256,
      targetSha256: target.call(ledger, kind), actualSha256: v4Hash(actual), evidenceSha256: v4Digest(v4Hash(evidenceOf))});
    tokens.set(token, observation);
    const result = await recordObservation.call(ledger, `command:${v4Hash(observation)}`, token);
    if (result.kind !== "recorded") {throw rejected();}
  };
  const record = async (kind: HostHttpEgressV4Intent): Promise<void> => {
    const ledger = open();
    const result = await recordIntent.call(ledger, `command:${v4Hash({subject: v4Hash(subject), kind})}`,
      {kind, targetSha256: target.call(ledger, kind)});
    if (result.kind !== "recorded") {throw rejected();}
  };

  return Object.freeze({
    /** The single owner handed to the journal must already include this issuer. */
    observationOwner: Object.freeze<HostHttpEgressV4ObservationOwner>({
      readObservation: (token: object) => tokens.get(token),
    }),
    readObservation: (token: object): HostHttpEgressV4Observation | undefined => tokens.get(token),
    /** One-use binding of the already opened ledger for this exact subject. */
    bind(ledger: HostHttpEgressV4Journal): void {
      if (journal !== undefined || !(ledger instanceof HostHttpEgressV4Journal)) {throw rejected();}
      const facts = evidence.call(ledger);
      if (facts.subjectSha256 !== v4Hash(subject) || facts.admission !== "fresh_ledger") {throw rejected();}
      journal = ledger;
    },
    /** The endpoint the kernel actually bound, read back from the live recipe. */
    async observeListener(listener: DockerHttpListenerReadback, address: unknown): Promise<void> {
      const observed = readback(listener);
      const endpoint = listenerAddress(address);
      if (observed.openState !== "published" || observed.listenerState !== "open" ||
        observed.nativeBindPending !== false || observed.admissionSealed !== false ||
        observed.closeRequested !== false) {throw rejected();}
      await publish("listener_allocated", {listener: subject.listenerHandle, ...endpoint}, observed);
    },
    /** Local admission closure only: the retained cut signal and, when a listener
     * endpoint was actually handed out, its own sealed readback. `null` states
     * that this subject never obtained a listener recipe — a fact the trusted
     * composition owns, exactly as it owns the launched container authority it
     * hands to the network owner. It is never container, socket or kernel-route
     * closure, and never evidence about another Host's admission. */
    async observeCutoff(signal: AbortSignal, listener: DockerHttpListenerReadback | null): Promise<void> {
      const observed = listener === null ? undefined : readback(listener);
      if (!(signal instanceof AbortSignal) || types.isProxy(signal) || !signal.aborted ||
        (observed !== undefined && observed.admissionSealed !== true)) {throw rejected();}
      await record("cutoff");
      await publish("cutoff_observed", {cutoff: subject.routeHandle, listener: observed !== undefined},
        observed ?? {listener: "never-created"});
    },
    /** Exact historical absence of this container, proven by the lifecycle's own
     * removal owner. A token it does not recognise mints nothing. */
    async observeContainerAbsent(token: object): Promise<void> {
      const proof = readRemoval(token);
      if (proof === undefined ||
        canonicalDockerCustodyJson(validateDockerCustodyAttemptKey(proof.attemptKey)) !== canonicalDockerCustodyJson(subject.attempt) ||
        proof.authority.imageDigest !== subject.imageDigest) {throw rejected();}
      const authority: DockerContainerAuthority = Object.freeze({...proof.authority});
      await publish("container_absent", {container: dockerCustodyAuthoritySha256(authority),
        journalChecksumSha256: v4Digest(proof.journalChecksumSha256)}, proof, authority);
    },
    /** The listener endpoint after its owner acknowledged an exact close. */
    async observeListenerAbsent(listener: DockerHttpListenerReadback): Promise<void> {
      const observed = readback(listener);
      if (observed.listenerState !== "closed" || observed.serverCloseAcknowledged !== true ||
        (observed.uncertainty as readonly unknown[]).length !== 0) {throw rejected();}
      await publish("listener_absent", {listener: subject.listenerHandle, closed: true}, observed);
    },
    /** Fresh permission to attempt the kernel route; never the route itself. */
    async recordRouteIntent(): Promise<void> {
      if (routeIntent) {throw rejected();}
      await record("route_intent");
      routeIntent = true;
    },
    /** An installed exclusive route lease is the only accepted proof. Only the
     * Linux route owner returns one, and only after verifying its own kernel
     * readback; as with the Engine container authority, this issuer checks the
     * exact retained shape and the trusted composition that called
     * `openNodeLinuxExclusiveRoute` supplies the lease. A lease alone still mints
     * nothing: a fresh acknowledged `route_intent` must already be recorded. */
    async observeRouteInstalled(owner: LinuxExclusiveRouteOwner, endpoint: LinuxExclusiveRouteEndpoint): Promise<void> {
      if (!routeIntent || owner === null || typeof owner !== "object" || types.isProxy(owner) ||
        !Object.isFrozen(owner) || typeof owner.reserveFirstWrite !== "function" ||
        typeof owner.revoke !== "function" || typeof owner.releaseAfterContainerRemoval !== "function" ||
        !(owner.cutoff instanceof Promise)) {throw rejected();}
      const bound = Object.freeze({address: endpoint.address, port: endpoint.port});
      if (typeof bound.address !== "string" || !Number.isSafeInteger(bound.port) ||
        bound.port < 1 || bound.port > 65_535) {throw rejected();}
      await publish("route_installed", {route: subject.routeHandle, ...bound}, {route: bound, lease: "installed"});
    },
  });
};
