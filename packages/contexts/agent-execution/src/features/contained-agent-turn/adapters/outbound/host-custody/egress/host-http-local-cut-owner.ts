import {types as utilTypes} from "node:util";
import {validateCommittedDispatchProofV1} from "../../../../domain/committed-dispatch-proof-v1.js";
import type {ContainedTurnHostPostClaimPreparation} from "../contained-turn-kernel-custody-contracts.js";
import type {createHostHttpEgressSession, HostHttpEgressSessionDependencies} from "./host-http-egress-session.js";
import {boundedHttpOpaque, snapshotHttpEgressOperation} from "./http-ingress-validation.js";
import type {HostHttpLocalAuthorityCut, HttpEgressBrokerPorts, HttpEgressClock} from "./http-egress-ports.js";
import type {HttpEgressOperation, HttpEgressReceipt} from "./http-egress-contracts.js";

type CutSnapshot = ReturnType<HostHttpLocalAuthorityCut["read"]>;
type ClockSample = Omit<CutSnapshot, "status">;
type ClaimedInput = Parameters<ContainedTurnHostPostClaimPreparation["prepareClaimed"]>[0];
type Session = ReturnType<typeof createHostHttpEgressSession>;
type SessionPorts = Omit<HostHttpEgressSessionDependencies, "identity" | "clock" | "localAuthorityCut">;

export type HostHttpLocalCutInput = Readonly<{
  /** Only the trusted, acknowledged prepareClaimed handoff; a digest is not COMMIT provenance. */
  claimed: ClaimedInput;
  /** Retain the actual Host-owned opaque live identity; never manufacture a replacement. */
  identity: HttpEgressBrokerPorts["identity"];
  expectedClock: Readonly<Pick<ClockSample, "authorityId" | "epoch">>;
  /** Borrow the SAME control clock/domain used by RS and all Host deadlines.
   * within must bound awaited work and honor its signal; closure uses a separate budget. */
  clock: Readonly<{read(): ClockSample; within: HttpEgressClock["within"]}>;
  operationDeadline: number;
  hostShutdownSignal?: AbortSignal;
}>;

const data = <T extends object>(value: T): T => {
  if (typeof value !== "object" || value === null || utilTypes.isProxy(value)
    || Object.getPrototypeOf(value) !== Object.prototype
    || Reflect.ownKeys(value).some(key => !("value" in Object.getOwnPropertyDescriptor(value, key)!))) {
    throw new TypeError("invalid Host HTTP local cut data");
  }
  return Object.freeze({...value});
};
const validTime = (value: number): boolean => Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0);
// Inspect only the immediate prototype of an ordinary native signal; instanceof
// would traverse an inherited Proxy and run caller code during construction.
const validSignal = (value: unknown): value is AbortSignal => typeof value === "object" && value !== null
  && !utilTypes.isProxy(value) && Object.getPrototypeOf(value) === AbortSignal.prototype;

const snapshotInput = (value: HostHttpLocalCutInput) => {
  const input = data(value); const claimed = data(input.claimed);
  const proof = validateCommittedDispatchProofV1(data(claimed.committedDispatchProof));
  const identity = data(input.identity); const expectedClock = data(input.expectedClock);
  const clock = data(input.clock);
  if (identity.operationId !== proof.operationId || identity.attemptId !== proof.attemptId
    || identity.custodyId !== proof.custodyId || identity.hostBootId !== proof.hostBootId
    || typeof identity.liveProcessSessionIdentity !== "object" || identity.liveProcessSessionIdentity === null
    || !boundedHttpOpaque(claimed.underlyingCustodyRef) || !validSignal(claimed.signal)
    || (input.hostShutdownSignal !== undefined && !validSignal(input.hostShutdownSignal))
    || !boundedHttpOpaque(expectedClock.authorityId) || !boundedHttpOpaque(expectedClock.epoch)
    || !validTime(input.operationDeadline) || input.operationDeadline === 0
    || typeof clock?.read !== "function" || typeof clock.within !== "function") {
    throw new TypeError("invalid Host HTTP local cut binding");
  }
  return Object.freeze({...input, claimed: Object.freeze({...claimed, committedDispatchProof: proof}),
    identity, expectedClock: Object.freeze({authorityId: expectedClock.authorityId, epoch: expectedClock.epoch}),
    readClock: clock.read.bind(input.clock), within: clock.within.bind(input.clock)});
};

/** Two listeners at most, detached even when broker execution rejects. Request abort
 * cannot abort the borrowed custody signal or reset the operation's irreversible cut. */
const linkRequest = (operationSignal: AbortSignal, requestSignal?: AbortSignal) => {
  const controller = new AbortController();
  const signals = requestSignal === undefined || requestSignal === operationSignal
    ? [operationSignal] : [operationSignal, requestSignal];
  const abort = (): void => {controller.abort();};
  const release = (): void => {for (const signal of signals) {signal.removeEventListener("abort", abort);}};
  for (const signal of signals) {signal.addEventListener("abort", abort, {once: true});}
  if (signals.some(signal => signal.aborted)) {abort();}
  return {signal: controller.signal, release};
};

/** Private operation owner. Construction only snapshots trusted data: no clock or
 * owner calls, subscriptions, timers or IO. bindSession is the explicit one-use
 * activation seam; retain close/dispose at Host, and publish only its session.
 * Reading the cut before activation fails permanently closed.
 * Clock drift and expiry are discovered by fresh reads, without a background poller.
 *
 * `current` means local execution permission only. The durable dispatch claim
 * remains the linearization point; later remote revocation needs containment and
 * reconciliation. This owner neither observes PA/RS databases nor proves closure.
 */
export const createHostHttpLocalCutOwner = (value: HostHttpLocalCutInput) => {
  const input = snapshotInput(value);
  const controller = new AbortController();
  const signals = [...new Set([input.claimed.signal,
    ...(input.hostShutdownSignal === undefined ? [] : [input.hostShutdownSignal])])];
  let status: CutSnapshot["status"] = "current";
  let latest = -1; let reading = false; let bound = false; let active = false; let clockUncertain = false;
  let session: Session | undefined;
  const detach = (): void => {for (const signal of signals) {signal.removeEventListener("abort", cancel);}};
  const seal = (reason: "revoked" | "unknown"): void => {
    if (reason === "unknown") {clockUncertain = true;}
    if (status === "current") {status = reason;}
    // Close admission before notifying any active transport's synchronous abort listeners.
    session?.close();
    controller.abort();
    detach();
  };
  const cancel = (): void => {seal("revoked");};
  const observeTime = (): number => {
    let controlTime = Number.NaN;
    if (!bound || reading) {seal("unknown");}
    if (!reading) {
      reading = true;
      try {
        const sample = data(input.readClock());
        if (sample.authorityId !== input.expectedClock.authorityId || sample.epoch !== input.expectedClock.epoch
          || !validTime(sample.controlTime) || sample.controlTime < latest) {seal("unknown");}
        else {
          controlTime = sample.controlTime; latest = controlTime;
        }
      } catch {seal("unknown");}
      finally {reading = false;}
    }
    return clockUncertain ? Number.NaN : controlTime;
  };
  const read = (): CutSnapshot => {
    if (signals.some(signal => signal.aborted)) {cancel();}
    const controlTime = observeTime();
    if (controlTime >= input.operationDeadline || signals.some(signal => signal.aborted)) {cancel();}
    return Object.freeze({status, ...input.expectedClock, controlTime});
  };
  // Every observation samples the borrowed authoritative clock. The V2 verifier
  // brackets its cut with fresh clock reads; no sample survives for another call.
  const cut: HostHttpLocalAuthorityCut = Object.freeze({read});
  // Closure acknowledgement keeps its own deadline and is never cancelled just
  // because local execution ended. Existing broker settlement owns its evidence.
  const clock: HttpEgressClock = Object.freeze({
    // Time remains readable after ordinary revocation/expiry for bounded cleanup.
    // Execution permission is checked separately at the V2 authority boundary;
    // clock-domain uncertainty still fails permanently closed.
    now: observeTime,
    within: <T>(deadline: number, action: () => Promise<T>, signal?: AbortSignal) => {
      return input.within(deadline, action, signal);
    },
  });
  // Composition explicitly selects the existing raw fixture or authenticated
  // session factory. Preserve its additional capabilities (e.g. native bearer).
  const bindSession = <Opened extends Session>(dependencies: SessionPorts,
    openSession: (ports: HostHttpEgressSessionDependencies) => Opened) => {
    if (bound) {throw new TypeError("Host HTTP local cut session is one-use");}
    bound = true;
    let retained: Opened;
    try {
      retained = openSession({...dependencies, identity: input.identity, clock, localAuthorityCut: cut});
      session = retained;
      for (const signal of signals) {signal.addEventListener("abort", cancel, {once: true});}
      read();
      if (status !== "current") {seal(status);}
    } catch (error) {seal("unknown"); throw error;}
    return Object.freeze({
      ...retained,
      close: cancel,
      async execute(request: HttpEgressOperation): Promise<HttpEgressReceipt> {
        let linked: ReturnType<typeof linkRequest> | undefined;
        try {
          const operation = snapshotHttpEgressOperation(request);
          if (operation.operationId !== input.identity.operationId || operation.attemptId !== input.identity.attemptId) {
            throw new TypeError("Host HTTP local cut operation mismatch");
          }
          read();
          // At most one active listener pair; concurrent admission permanently seals the session.
          if (active) {cancel(); return await retained.execute({...operation, signal: controller.signal});}
          active = true;
          linked = linkRequest(controller.signal, operation.signal);
          const receipt = await retained.execute({...operation, signal: linked.signal,
            limits: {...operation.limits, deadline: Math.min(operation.limits.deadline, input.operationDeadline)}});
          if (receipt.outcome !== "completed") {cancel();}
          return receipt;
        } catch (error) {seal("unknown"); throw error;}
        finally {if (linked !== undefined) {linked.release(); active = false;}}
      },
    });
  };
  return Object.freeze({cut, signal: controller.signal as AbortSignal, bindSession, close: cancel, dispose: cancel});
};
