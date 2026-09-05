import type { ContainedTurnEgressResult, EgressTransportV1 } from "./composition.js";

type State = "open" | "active" | "closing" | "used" | "closed" | "quarantined";

export class EgressOneShotLifecycle {
  #state: State = "open";
  #transport: EgressTransportV1 | undefined;
  #writeExact: ((input: unknown) => unknown) | undefined;
  #close: (() => PromiseLike<void>) | undefined;
  #closure: Promise<boolean> | undefined;
  #closing = false;
  #acquired = false;
  #acquiring = false;
  #flight: Promise<ContainedTurnEgressResult> | undefined;
  #cancel!: () => void;
  #cancelled = new Promise<void>(resolve => {this.#cancel = resolve;});
  #owners = new Set<Promise<unknown>>();

  public activate(): boolean {
    if (this.#state !== "open") {return false;}
    this.#state = "active"; return true;
  }
  public get active(): boolean {return this.#state === "active";}
  public get quarantined(): boolean {return this.#state === "quarantined";}
  public get transport(): EgressTransportV1 | undefined {return this.#transport;}
  public get writeExact(): ((input: unknown) => unknown) | undefined {return this.#writeExact;}

  public retainClose(close: (() => PromiseLike<void>) | undefined): void {
    this.#acquired = true; this.#close = close;
  }
  public attach(session: Readonly<{transport: EgressTransportV1; writeExact: (input: unknown) => unknown}>): void {
    this.#transport = session.transport; this.#writeExact = session.writeExact;
  }
  public markUsed(): void {if (this.#state === "active") {this.#state = "used";}}
  public quarantine(): void {this.#state = "quarantined"; this.#cancel();}
  public track(flight: Promise<ContainedTurnEgressResult>): void {this.#flight = flight;}

  public async owner<Value>(operation: () => PromiseLike<Value>, acquisition = false): Promise<Value | undefined> {
    if (!this.active) {return;}
    // Retain acquisition state through native thenable assimilation and async settlement.
    this.#acquiring ||= acquisition;
    const pending = (async () => await operation())();
    this.#owners.add(pending);
    const settled = () => {this.#owners.delete(pending); if (acquisition) {this.#acquiring = false;}};
    void pending.then(settled, settled);
    // Acquisition must settle before closing: its result may contain the only close capability.
    return await (acquisition ? pending : Promise.race([pending, this.#cancelled])) as Value | undefined;
  }

  public async closeTransport(): Promise<boolean> {
    if (this.#closure !== undefined) {return await this.#closure;}
    if (!this.#acquired) {return true;}
    const close = this.#close;
    if (close === undefined) {this.quarantine(); return false;}
    this.#closing = true;
    this.#closure = (async () => {
      try {await close(); return true;} catch {this.quarantine(); return false;}
      finally {this.#closing = false;}
    })();
    return await this.#closure;
  }
  public releaseTransport(): void {this.#transport = undefined; this.#writeExact = undefined; this.#close = undefined;}

  public async dispose(): Promise<"closed" | "quarantined"> {
    if (this.#state === "closed") {return "closed";}
    if (this.quarantined) {return "quarantined";}
    // Acquisition and close callbacks may themselves await disposal. Their unsettled resource
    // custody cannot be called closed; quarantine breaks the cycle and late settlement still cleans up.
    if (this.#acquiring || this.#closing) {
      this.quarantine(); return "quarantined";
    }
    if (this.#state === "open" || this.#state === "active") {this.#state = "closing";}
    this.#cancel();
    if (this.#flight !== undefined) {await this.#flight;}
    if (this.#owners.size > 0) {this.quarantine(); return "quarantined";}
    if (this.quarantined || !await this.closeTransport()) {return "quarantined";}
    this.releaseTransport(); this.#state = "closed"; return "closed";
  }
}
