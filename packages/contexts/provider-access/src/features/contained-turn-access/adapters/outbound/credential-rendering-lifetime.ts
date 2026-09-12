import { isNativePromise, isRuntimeProxy } from "../provider-access-data.js";
import { eraseGeneration, renderGeneration } from "./credential-rendering-bytes.js";
import type { CredentialGenerationRequest, RenderedCredentialFields } from "./credential-rendering-contracts.js";

const aborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")?.get;
const addListener = EventTarget.prototype.addEventListener;
const removeListener = EventTarget.prototype.removeEventListener;
const dependentSignal = AbortSignal.any;
const then = Promise.prototype.then;
const closed = (): never => {throw new TypeError("credential rendering unavailable");};
export const signalAborted = (signal: AbortSignal): boolean => {
  if (!aborted || signal === null || typeof signal !== "object" || isRuntimeProxy(signal) ||
    Object.getPrototypeOf(signal) !== AbortSignal.prototype || Object.hasOwn(signal, "aborted") || Object.hasOwn(signal, "reason")) {return closed();}
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
  readonly #cancellationSignal: AbortSignal;
  readonly #deadline: number;
  readonly #controller = new AbortController();
  readonly #cancelled: Promise<never>;
  readonly #timer: ReturnType<typeof setTimeout>;
  readonly #onAbort = () => {this.close();};
  #reject!: (reason: Error) => void;
  #closed = false;

  constructor(signal: AbortSignal, deadline: number) {
    if (signalAborted(signal)) {closed();}
    this.#signal = signal;
    // A private dependent signal cannot lose cancellation to a source listener
    // that stops propagation. Keep the original signal for authority checks.
    this.#cancellationSignal = Reflect.apply(dependentSignal, AbortSignal, [[signal]]) as AbortSignal;
    this.#deadline = deadline;
    this.#cancelled = new Promise<never>((_resolve, reject) => {this.#reject = reject;});
    // Keep cancellation handled even when it precedes the first wait.
    void this.#cancelled.catch(() => null);
    this.#timer = setTimeout(this.#onAbort, Math.max(0, deadline - performance.now()));
    Reflect.apply(addListener, this.#cancellationSignal, ["abort", this.#onAbort, {once: true}]);
    if (signalAborted(signal) || signalAborted(this.#cancellationSignal) || performance.now() >= deadline) {this.close();}
  }
  get signal(): AbortSignal {return this.#controller.signal;}
  check(): void {
    if (this.#closed || signalAborted(this.#signal) || performance.now() >= this.#deadline) {this.close(); closed();}
  }
  close(): void {
    if (this.#closed) {return;}
    this.#closed = true;
    clearTimeout(this.#timer);
    Reflect.apply(removeListener, this.#cancellationSignal, ["abort", this.#onAbort]);
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
