import { snapshotHttpBytes, zeroHttpBytes } from "./http-byte-intrinsics.js";
import { NodeHostHttpConnectionError } from "./node-host-http-connection-config.js";
import type { OwnedNodeHostHttpSocket } from "./node-host-http-connection-config.js";

/** One outstanding write, no application write queue. Custody owns event faults. */
export class NodeHostHttpSocketWrite {
  readonly #socket: OwnedNodeHostHttpSocket;
  readonly #completion = Promise.withResolvers<void>();
  readonly #cutoff: AbortController;
  #bytes: Uint8Array | undefined;
  #returned = false;
  #callback = false;
  #needsDrain = false;
  #drained = false;
  #failed = false;
  #settled = false;

  public constructor(socket: OwnedNodeHostHttpSocket, cutoff: AbortController) {
    this.#socket = socket;
    this.#cutoff = cutoff;
    void this.#completion.promise.catch(() => {});
  }
  public get completion(): Promise<void> {return this.#completion.promise;}
  public get succeeded(): boolean {return this.#settled && !this.#failed;}
  public get uncertain(): boolean {return this.#failed;}

  public start(chunk: Uint8Array, maximum: number): void {
    this.#bytes = snapshotHttpBytes(chunk, maximum);
    if (this.#bytes === undefined || this.#bytes.byteLength === 0) {this.fail(); return;}
    try {
      const accepted = this.#socket.write(this.#bytes, error => {
        if (this.#callback || (error !== undefined && error !== null)) {this.fail(); return;}
        this.#callback = true;
        this.#check();
      });
      this.#needsDrain = !accepted;
      this.#returned = true;
      this.#check();
    } catch {
      // A reentrant successful callback cannot override a later thrown write.
      this.fail();
    }
  }

  public drain(): void {this.#drained = true; this.#check();}

  #check(): void {
    if (!this.#returned || !this.#callback || this.#failed || this.#settled) {return;}
    // With exactly one owned write a successful callback cannot leave queued bytes.
    if (this.#socket.writableLength !== 0 || this.#socket.destroyed || this.#socket.closed) {
      this.fail(); return;
    }
    if (this.#needsDrain && !this.#drained) {return;}
    this.#settled = true;
    zeroHttpBytes(this.#bytes);
    this.#bytes = undefined;
    this.#completion.resolve();
  }

  public fail(): void {
    this.#failed = true;
    this.#settled = true;
    const error = new NodeHostHttpConnectionError("write_failed");
    this.#completion.reject(error);
    // The shared one-way cutoff reaches custody, the future binder and upstream.
    if (!this.#cutoff.signal.aborted) {this.#cutoff.abort(error);}
    // Keep bytes until actual close: callback loss/throw may leave kernel custody.
  }

  public closed(): void {
    if (!this.#settled) {this.fail();}
    zeroHttpBytes(this.#bytes);
    this.#bytes = undefined;
  }
}
