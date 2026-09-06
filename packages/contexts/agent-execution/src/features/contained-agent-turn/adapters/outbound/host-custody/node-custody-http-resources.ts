import { addAbortListener } from "node:events";
import type { HostCustodyHttpResourceLifetime, HostCustodyHttpResourceOwner } from "./host-custody-http-resource-lifetime.js";
import { custodyDataRecord } from "./host-custody-inert-record.js";
import type { createNodeHostHttpListener, NodeHostHttpAccept, NodeHostHttpListener } from "./egress/node-host-http-listener.js";
import type { createNodeHostHttpConsumptionJournal, PreparedHostHttpConsumptionJournal } from "./egress/node-host-http-consumption-journal.js";
import { prepareAuthenticatedHostHttpEgressSession, type HostHttpEgressSessionDependencies } from "./egress/host-http-egress-session.js";
import { createHostHttpLocalCutOwner, type HostHttpLocalCutInput } from "./egress/host-http-local-cut-owner.js";

type ListenerRecipe = ReturnType<typeof createNodeHostHttpListener>;
type ConsumptionRecipe = ReturnType<typeof createNodeHostHttpConsumptionJournal>;
type Ingress = ReturnType<typeof prepareAuthenticatedHostHttpEgressSession>;
type Session = ReturnType<Ingress["bind"]>;
/** Host-owned private consumer contract. An acknowledged intent permits a
 * listener effect; it is never physical closure or qualification evidence. */
export interface NodeCustodyHttpListenerLifecycle {
  bind(lifetime: HostCustodyHttpResourceLifetime): Readonly<{
    recordOpen(): Promise<Readonly<{kind: "recorded" | "duplicate"}>>;
    recordRelease(): Promise<Readonly<{kind: "recorded" | "duplicate"}>>;
  }>;
}
export type NodeCustodyHttpResourceInput = Readonly<{
  listener: ListenerRecipe;
  accept: NodeHostHttpAccept;
  consumption: ConsumptionRecipe;
  localCut: Omit<HostHttpLocalCutInput, "claimed" | "identity">;
  listenerLifecycle: NodeCustodyHttpListenerLifecycle;
}>;
export type NodeCustodyHttpResourcePreparation =
  | Readonly<{kind: "prepared"; address: NodeHostHttpListener["address"]; journal: PreparedHostHttpConsumptionJournal["journal"]}>
  | Readonly<{kind: "unsupported" | "unproven"}>;
const rejected = (): TypeError => new TypeError("Host HTTP resource custody unavailable or conflicts");
const identity = (lifetime: HostCustodyHttpResourceLifetime) => {
  const proof = lifetime.committedDispatchProof;
  return {operationId: proof.operationId, attemptId: proof.attemptId, custodyId: proof.custodyId,
    hostBootId: proof.hostBootId, liveProcessSessionIdentity: lifetime.executionSessionIdentity};
};

const capture = (input: NodeCustodyHttpResourceInput, lifetime: HostCustodyHttpResourceLifetime) => {
  const data = custodyDataRecord(input);
  const lifecycle = custodyDataRecord(data.listenerLifecycle);
  if (typeof lifecycle.bind !== "function") {throw rejected();}
  const bound = custodyDataRecord(lifecycle.bind.call(data.listenerLifecycle, lifetime));
  if (typeof bound.recordOpen !== "function" || typeof bound.recordRelease !== "function") {throw rejected();}
  const proof = lifetime.committedDispatchProof;
  const listener = custodyDataRecord(data.listener);
  const consumption = custodyDataRecord(data.consumption);
  if (typeof listener.open !== "function" || typeof listener.close !== "function" ||
    typeof listener.sealAdmission !== "function" || typeof consumption.prepare !== "function" ||
    typeof data.accept !== "function") {throw rejected();}
  return Object.freeze({listenerLifecycle: Object.freeze({recordOpen: bound.recordOpen.bind(bound),
    recordRelease: bound.recordRelease.bind(bound)}), accept: data.accept,
    listener: Object.freeze({open: listener.open.bind(data.listener), close: listener.close.bind(data.listener),
      sealAdmission: listener.sealAdmission.bind(data.listener)}),
    consumption: Object.freeze({prepare: consumption.prepare.bind(data.consumption)}),
    localCut: createHostHttpLocalCutOwner({...custodyDataRecord(data.localCut), identity: identity(lifetime),
      claimed: {committedDispatchProof: proof, underlyingCustodyRef: lifetime.underlyingCustodyRef, signal: lifetime.signal}}),
  });
};

/** Fixed slots on the actual reservation, never a registry. Construction has no
 * effects. Preparation is private trusted post-claim work, not HTTP readiness.
 * V4 is borrowed and never closed here; its actual observation owner remains
 * responsible for network/container/socket evidence and ledger reconciliation. */
export class NodeCustodyHttpResources {
  readonly #reservation: HostCustodyHttpResourceOwner;
  readonly #listenerCut: AbortController;
  #input: ReturnType<typeof capture> | undefined;
  #entered = false;
  #cut = false;
  #uncertain = false;
  #listenerOwned = false;
  #listener: NodeHostHttpListener | undefined;
  #journal: PreparedHostHttpConsumptionJournal | undefined;
  #ingress: Ingress | undefined;
  #session: Session | undefined;
  #binding = false;
  #preparation: Promise<void> | undefined;
  #listenerOpen: Promise<void> | undefined;
  #consumptionPrepare: Promise<void> | undefined;
  #retirement: Promise<void> | undefined;
  #journalRetired = false;
  #listenerCleanup: Promise<void> | undefined;
  #listenerClosed = false;
  #cleanup: Promise<boolean> | undefined;

  public constructor(reservation: HostCustodyHttpResourceOwner, controller: AbortController) {
    this.#reservation = reservation; this.#listenerCut = controller;
  }

  public get pending(): Promise<void> | undefined {return this.#preparation;}

  public openIngress(lifetime: HostCustodyHttpResourceLifetime): Ingress {
    if (this.#cut || this.#ingress !== undefined || this.#binding) {throw rejected();}
    // Reserve before entropy issuance, including a synchronous throw/reentrant cut.
    this.#binding = true;
    try {
      this.#ingress = prepareAuthenticatedHostHttpEgressSession(identity(lifetime));
      if (this.#cut) {this.#ingress.close(); throw rejected();}
      return this.#ingress;
    } catch {this.cutoff(); throw rejected();}
    finally {this.#binding = false;}
  }

  public bindSession(dependencies: HostHttpEgressSessionDependencies): Session {
    if (this.#cut || this.#ingress === undefined || this.#session !== undefined || this.#binding ||
      this.#entered && (this.#journal === undefined || this.#listener === undefined)) {throw rejected();}
    this.#binding = true;
    try {
      const ingress = this.#ingress;
      const fixed = this.#journal === undefined ? dependencies : {...dependencies, journal: this.#journal.journal};
      this.#session = this.#input === undefined ? ingress.bind(fixed) :
        this.#input.localCut.bindSession(fixed, ports => ingress.bind(ports));
      if (this.#cut) {this.#session.close(); throw rejected();}
      return this.#session;
    } catch {this.cutoff(); throw rejected();}
    finally {this.#binding = false;}
  }

  public prepare(lifetime: HostCustodyHttpResourceLifetime, input: NodeCustodyHttpResourceInput): Promise<NodeCustodyHttpResourcePreparation> {
    if (this.#entered || this.#cut || this.#session !== undefined || this.#binding) {throw rejected();}
    this.#entered = true;
    // Publish completion before reading recipes or invoking any async effect.
    const completion = Promise.withResolvers<void>();
    this.#preparation = completion.promise;
    try {
      this.#input = capture(input, lifetime);
      addAbortListener(this.#input.localCut.signal, () => this.cutoff());
    }
    catch {this.cutoff(); completion.resolve(); return Promise.resolve(Object.freeze({kind: "unsupported"}));}
    return this.#prepare().finally(() => completion.resolve());
  }

  async #prepare(): Promise<NodeCustodyHttpResourcePreparation> {
    const input = this.#input!;
    try {
      const intent = await input.listenerLifecycle.recordOpen();
      if (intent.kind !== "recorded") {throw rejected();}
      this.#listenerOwned = true;
      if (this.#cut) {return Object.freeze({kind: "unproven"});}
      // Both pending slots exist before either factory can throw or reenter.
      const opened = Promise.withResolvers<void>(); const prepared = Promise.withResolvers<void>();
      this.#listenerOpen = opened.promise; this.#consumptionPrepare = prepared.promise;
      void this.#openListener().finally(() => opened.resolve());
      void this.#prepareConsumption().finally(() => prepared.resolve());
      await Promise.all([this.#listenerOpen, this.#consumptionPrepare]);
      if (this.#cut || this.#listener === undefined || this.#journal === undefined) {return Object.freeze({kind: "unproven"});}
      return Object.freeze({kind: "prepared", address: this.#listener.address, journal: this.#journal.journal});
    } catch {
      // Missing actual V4 prerequisites cannot allocate listener or consumption.
      this.cutoff(); return Object.freeze({kind: "unsupported"});
    }
  }

  async #openListener(): Promise<void> {
    try {
      this.#listener = await this.#input!.listener.open(this.#input!.accept, this.#listenerCut);
      if (this.#cut) {this.#listener.sealAdmission();}
    } catch {this.cutoff();}
  }

  async #prepareConsumption(): Promise<void> {
    if (this.#cut) {return;}
    try {
      const prepared = await this.#input!.consumption.prepare();
      if (prepared.kind !== "ready") {this.#uncertain = true; this.cutoff(); return;}
      this.#journal = prepared;
      if (this.#cut) {this.#quarantineJournal();}
    } catch {this.#uncertain = true; this.cutoff();}
  }

  #quarantineJournal(): void {
    if (this.#journal === undefined || this.#retirement !== undefined) {return;}
    const completion = Promise.withResolvers<void>();
    this.#retirement = completion.promise;
    try {this.#journal.quarantine();} catch {this.#uncertain = true;}
    // Own retirement before calling it, including synchronous failures/reentrancy.
    try {
      void this.#journal.retire().then(result => {this.#journalRetired = result === "retired"; return this.#journalRetired;},
        () => {this.#uncertain = true;}).finally(() => completion.resolve());
    } catch {this.#uncertain = true; completion.resolve();}
  }

  public cutoff(): void {
    if (this.#cut) {return;}
    this.#cut = true;
    try {this.#ingress?.close();} catch {this.#uncertain = true;}
    try {this.#session?.close();} catch {this.#uncertain = true;}
    try {this.#input?.localCut.close();} catch {this.#uncertain = true;}
    try {this.#input?.listener.sealAdmission();} catch {this.#uncertain = true;}
    this.#quarantineJournal();
    this.#reservation.cutoff();
  }

  public cleanup(): Promise<boolean> {
    if (this.#cleanup !== undefined) {return this.#cleanup;}
    const completion = Promise.withResolvers<boolean>();
    this.#cleanup = completion.promise;
    this.cutoff();
    void this.#clean().then(completion.resolve, () => completion.resolve(false)).finally(() => {this.#cleanup = undefined;});
    return completion.promise;
  }

  async #clean(): Promise<boolean> {
    await this.#preparation;
    await this.#retirement;
    if (this.#listenerOwned && this.#listenerCleanup === undefined) {
      // Conflict/missing observations retain the endpoint. A later cleanup may
      // try again after the EXISTING observer records cutoff/socket/exact removal.
      const input = this.#input!;
      let recorded;
      try {
        recorded = await input.listenerLifecycle.recordRelease();
      } catch {return false;}
      if (recorded.kind !== "recorded") {this.#uncertain = true; return false;}
      const completion = Promise.withResolvers<void>();
      this.#listenerCleanup = completion.promise;
      try {
        void input.listener.close().then(result => {this.#listenerClosed = result.state === "closed"; return this.#listenerClosed;},
          () => {this.#uncertain = true;}).finally(() => completion.resolve());
      } catch {this.#uncertain = true; completion.resolve();}
    }
    await this.#listenerCleanup;
    return !this.#uncertain && !this.#binding && (!this.#listenerOwned || this.#listenerClosed) &&
      (this.#journal === undefined || this.#journalRetired);
  }
}
