import type { ContainedTurnEgressResult, EgressTransportV1 } from "./composition.js";

type State = "open" | "active" | "closing" | "used" | "closed" | "quarantined";

export class EgressOneShotLifecycle {
  #state: State = "open";
  #transport: EgressTransportV1 | undefined;
  #writeExact: ((input: unknown) => unknown) | undefined;
  #closure: Promise<boolean> | undefined;
  #invokingClose = false;
  #flight: Promise<ContainedTurnEgressResult> | undefined;

  public activate(): boolean {
    if (this.#state !== "open") {return false;}
    this.#state = "active"; return true;
  }

  public get active(): boolean {return this.#state === "active";}
  public get quarantined(): boolean {return this.#state === "quarantined";}
  public get transport(): EgressTransportV1 | undefined {return this.#transport;}
  public get writeExact(): ((input: unknown) => unknown) | undefined {return this.#writeExact;}

  public attach(session: Readonly<{transport: EgressTransportV1; writeExact: (input: unknown) => unknown}>): void {
    this.#transport = session.transport; this.#writeExact = session.writeExact;
  }

  public markUsed(): void {if (this.#state === "active") {this.#state = "used";}}
  public quarantine(): void {this.#state = "quarantined";}
  public track(flight: Promise<ContainedTurnEgressResult>): void {this.#flight = flight;}

  public async closeTransport(): Promise<boolean> {
    if (this.#closure !== undefined) {return await this.#closure;}
    const current = this.#transport; if (current === undefined) {return true;}
    let settle!: (closed: boolean) => void;
    this.#closure = new Promise<boolean>(resolve => {settle = resolve;});
    let pending: PromiseLike<void>;
    try {this.#invokingClose = true; pending = current.close();}
    catch {this.#invokingClose = false; this.quarantine(); settle(false); return false;}
    this.#invokingClose = false;
    void (async () => {try {await pending; settle(true);} catch {this.quarantine(); settle(false);}})();
    return await this.#closure;
  }

  public releaseTransport(): void {this.#transport = undefined; this.#writeExact = undefined;}

  public async dispose(): Promise<"closed" | "quarantined"> {
    if (this.#state === "closed") {return "closed";}
    if (this.quarantined) {return "quarantined";}
    if (this.#invokingClose) {this.quarantine(); return "quarantined";}
    if (this.#state === "open" || this.#state === "active") {this.#state = "closing";}
    if (this.#flight !== undefined) {await this.#flight;}
    if (this.quarantined || !await this.closeTransport()) {return "quarantined";}
    this.releaseTransport(); this.#state = "closed"; return "closed";
  }
}
