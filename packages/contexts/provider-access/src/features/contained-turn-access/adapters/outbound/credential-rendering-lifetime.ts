import { isNativePromise, isRuntimeProxy } from "../provider-access-data.js";
import { eraseGeneration, renderGeneration } from "./credential-rendering-bytes.js";
import type { CredentialGenerationRequest, RenderedCredentialFields } from "./credential-rendering-contracts.js";

const aborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")?.get;
const addListener = EventTarget.prototype.addEventListener;
const removeListener = EventTarget.prototype.removeEventListener;
const then = Promise.prototype.then;
const closed = (): never => {throw new TypeError("credential rendering unavailable");};
export const signalAborted = (signal: AbortSignal): boolean => {
  if (!aborted || signal === null || typeof signal !== "object" || isRuntimeProxy(signal) ||
    Object.getPrototypeOf(signal) !== AbortSignal.prototype) {return closed();}
  // Node's signal getter reads symbol-backed state. Reject shadows before it runs.
  if (Reflect.ownKeys(signal).some(key => {
    const descriptor = Object.getOwnPropertyDescriptor(signal, key);
    return !descriptor || !("value" in descriptor) || isRuntimeProxy(descriptor.value);
  })) {return closed();}
  return Reflect.apply(aborted, signal, []) as boolean;
};

/** Allocated only by explicit authorization/render/observe, never construction. */
export class CredentialRenderingLifetime {
  readonly #signal: AbortSignal;
  readonly #deadline: number;
  readonly #controller = new AbortController();
  readonly #cancelled: Promise<never>;
  readonly #timer: ReturnType<typeof setTimeout>;
  readonly #onAbort = () => {this.close();};
  #reject!: (reason: Error) => void;
  #closed = false;

  constructor(signal: AbortSignal, deadline: number) {
    this.#signal = signal;
    this.#deadline = deadline;
    this.#cancelled = new Promise<never>((_resolve, reject) => {this.#reject = reject;});
    // Keep cancellation handled even when it precedes the first wait.
    void this.#cancelled.catch(() => null);
    this.#timer = setTimeout(this.#onAbort, Math.max(0, deadline - performance.now()));
    Reflect.apply(addListener, signal, ["abort", this.#onAbort, {once: true}]);
    if (signalAborted(signal) || performance.now() >= deadline) {this.close();}
  }
  get signal(): AbortSignal {return this.#controller.signal;}
  check(): void {
    if (this.#closed || signalAborted(this.#signal) || performance.now() >= this.#deadline) {this.close(); closed();}
  }
  close(): void {
    if (this.#closed) {return;}
    this.#closed = true;
    clearTimeout(this.#timer);
    Reflect.apply(removeListener, this.#signal, ["abort", this.#onAbort]);
    this.#controller.abort();
    this.#reject(new TypeError("credential rendering unavailable"));
  }
  async wait<T>(pending: Promise<T>): Promise<T> {
    const result = await Promise.race([pending, this.#cancelled]);
    this.check();
    return result;
  }
  /** Validate/copy before any raw object can be resolved through another promise. */
  receive(pending: unknown, request: CredentialGenerationRequest): Promise<RenderedCredentialFields | undefined> {
    if (isRuntimeProxy(pending) || !isNativePromise(pending) || Object.getPrototypeOf(pending) !== Promise.prototype ||
      Object.hasOwn(pending, "constructor")) {return closed();}
    const received = new Promise<RenderedCredentialFields | undefined>((resolve, reject) => {
      Reflect.apply(then, pending, [
        (value: unknown) => {
          let credentials: RenderedCredentialFields | undefined;
          try {
            this.check();
            credentials = renderGeneration(value, request);
            this.check();
            resolve(credentials);
          } catch {
            credentials?.release();
            reject(new TypeError("credential rendering unavailable"));
          } finally {eraseGeneration(value);}
        },
        () => {reject(new TypeError("credential rendering unavailable"));},
      ]);
    });
    // A cancellation between receipt and the await continuation must erase the copy.
    return received;
  }
}
