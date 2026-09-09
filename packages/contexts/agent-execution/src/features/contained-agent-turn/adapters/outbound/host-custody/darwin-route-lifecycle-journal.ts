import type { NodeCustodyHttpLifetime } from "./node-provider-process-custody-http-reservation.js";
import type { NodeCustodyHttpListenerLifecycle } from "./node-custody-http-resources.js";
import type { createNodeHostHttpListener } from "./egress/node-host-http-listener.js";
import { DarwinRouteDurableStorage } from "./darwin-route-durable-storage.js";

/** Allocation and observation are different records. No entry reconstructs a
 * live process/session capability. Unknown outcomes retain the durable locator. */
export class DarwinRouteLifecycleJournal {
  #opened = false; #closeIntent = false; #closed = false; #cut = false; #guardianAttempted = false;
  #processesClosed = false; #unknown = false;
  public constructor(public readonly storage: DarwinRouteDurableStorage, readonly lifetime: NodeCustodyHttpLifetime) {}
  public async prepare(): Promise<void> {
    await this.storage.open();
    this.storage.create("lifecycle", {claim: this.lifetime.committedDispatchProof,
      generation: this.lifetime.hostLifecycleGenerationSha256, locator: this.storage.path});
    if (this.lifetime.signal.aborted) {this.cutoff(); throw new Error("Darwin lifecycle cut during open");}
  }
  public record(kind: string, data: object = {}): void {
    try {this.storage.append("lifecycle", kind, data);} catch (error) {this.#unknown = true; throw error;}
  }
  public cutoff(): void {
    if (this.#cut) {return;} this.#cut = true;
    try {this.record("cut");} catch {this.#unknown = true;}
  }
  public guardianIntent(): void {this.#guardianAttempted = true; this.record("guardian_allocation_intent");}
  public processesClosed(): void {this.record("provider_guardian_streams_closed"); this.#processesClosed = true;}
  public readonly listenerLifecycle: NodeCustodyHttpListenerLifecycle = Object.freeze({bind: (lifetime: Parameters<NodeCustodyHttpListenerLifecycle["bind"]>[0]) => {
    if (lifetime !== this.lifetime) {throw new TypeError("Darwin listener lifetime conflicts");}
    return Object.freeze({recordOpen: async () => {
      if (this.#opened || this.#cut || lifetime.signal.aborted) {throw new Error("Darwin listener allocation sealed");}
      this.#opened = true; this.record("listener_open_intent"); return Object.freeze({kind: "recorded" as const});
    }, recordRelease: async () => {
      if (!this.#cut || this.#guardianAttempted && !this.#processesClosed) {throw new Error("Darwin listener release prerequisite missing");}
      if (!this.#closeIntent) {this.record("listener_close_intent"); this.#closeIntent = true;}
      // Same live adapter may retry its acknowledged intent, never resurrect an
      // on-disk duplicate or represent this permission as underlying closure.
      return Object.freeze({kind: "recorded" as const});
    }});
  }});
  public wrapListener(recipe: ReturnType<typeof createNodeHostHttpListener>) {
    // Capture the underlying cleanup owner before open can bind or throw.
    const close = recipe.close.bind(recipe); const open = recipe.open.bind(recipe);
    return Object.freeze({observe: recipe.observe.bind(recipe), sealAdmission: recipe.sealAdmission.bind(recipe),
      open: async (...args: Parameters<typeof recipe.open>) => {
        const listener = await open(...args);
        this.record("listener_bound", {address: listener.address});
        if (this.#cut) {listener.sealAdmission(); throw new Error("Darwin listener bound after cut");}
        return listener;
      }, close: async () => {
        if (!this.#closeIntent) {return Object.freeze({state: "unknown" as const});}
        if (this.#closed) {return Object.freeze({state: "closed" as const});}
        const result = await close();
        if (result.state === "closed") {
          this.record("listener_closed"); this.#closed = true;
        }
        return result;
      }});
  }
  public async close(resourcesReleased: boolean): Promise<boolean> {
    const clean = resourcesReleased && !this.#unknown && (!this.#opened || this.#closed) &&
      (!this.#guardianAttempted || this.#processesClosed);
    try {this.record(clean ? "retired" : "quarantined");} catch {this.#unknown = true;}
    const closed = await this.storage.close();
    return clean && closed && !this.#unknown;
  }
}
