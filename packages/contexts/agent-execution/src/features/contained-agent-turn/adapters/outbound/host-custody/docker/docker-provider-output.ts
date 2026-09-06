/** One rendezvous slot per stream, with no prefetch or queued reader promises.
 * The session awaits push, so at most one output chunk is held across both streams. */
export class DockerProviderOutput implements AsyncIterable<Uint8Array> {
  #claimed = false;
  #ended = false;
  #error: Error | undefined;
  #slot: {bytes: Uint8Array; consumed: () => void} | undefined;
  #reader: ReturnType<typeof Promise.withResolvers<IteratorResult<Uint8Array>>> | undefined;

  public constructor(private readonly cancel: (error: Error) => void) {}

  public push(bytes: Uint8Array): Promise<void> {
    if (this.#error !== undefined) {return Promise.reject(this.#error);}
    if (this.#ended || this.#slot !== undefined) {throw new TypeError("Docker output rendezvous is unavailable");}
    if (this.#reader !== undefined) {
      const reader = this.#reader; this.#reader = undefined;
      reader.resolve({done: false, value: bytes});
      return Promise.resolve();
    }
    return new Promise(resolve => {this.#slot = {bytes, consumed: resolve};});
  }

  public finish(error?: Error): void {
    if (this.#ended) {return;}
    this.#ended = true; this.#error = error;
    // Failure discards the unconsumed chunk and releases the session callback.
    this.#slot?.consumed(); this.#slot = undefined;
    if (error === undefined) {this.#reader?.resolve({done: true, value: undefined});}
    else {this.#reader?.reject(error);}
    this.#reader = undefined;
  }

  public [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    if (this.#claimed) {throw new TypeError("Docker provider output has one reader");}
    this.#claimed = true;
    return Object.freeze({
      next: () => this.next(),
      return: async () => {
        this.cancel(new Error("Docker provider output reader cancelled"));
        return {done: true as const, value: undefined};
      },
      throw: async () => {
        const error = new Error("Docker provider output reader failed"); this.cancel(error); throw error;
      },
    });
  }

  private next(): Promise<IteratorResult<Uint8Array>> {
    if (this.#error !== undefined) {return Promise.reject(this.#error);}
    if (this.#slot !== undefined) {
      const slot = this.#slot; this.#slot = undefined; slot.consumed();
      return Promise.resolve({done: false, value: slot.bytes});
    }
    if (this.#ended) {return Promise.resolve({done: true, value: undefined});}
    if (this.#reader !== undefined) {return Promise.reject(new TypeError("Docker output permits one pending read"));}
    this.#reader = Promise.withResolvers<IteratorResult<Uint8Array>>();
    return this.#reader.promise;
  }
}
