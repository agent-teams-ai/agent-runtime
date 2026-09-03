export interface ClaudeAgentSdkControlClock {
  now(): number;
  wait(milliseconds: number, signal: AbortSignal): Promise<void>;
}
export type ObservedSettlement<T> =
  | { readonly kind: "fulfilled"; readonly value: T }
  | { readonly error: unknown; readonly kind: "rejected" };
export type BoundedSettlement<T> =
  | ObservedSettlement<T>
  | { readonly kind: "abandoned" }
  | { readonly kind: "timed_out" };
export const observeCall = <T>(call: () => T | PromiseLike<T>): Promise<ObservedSettlement<T>> => {
  let started: T | PromiseLike<T>;
  try {
    started = call();
  } catch (error) {
    return Promise.resolve({ error, kind: "rejected" });
  }
  return Promise.resolve(started).then<ObservedSettlement<T>, ObservedSettlement<T>>(
    value => ({ kind: "fulfilled", value }),
    error => ({ error, kind: "rejected" }),
  );
};
export class OperationDeadlineClock {
  readonly #clock: ClaudeAgentSdkControlClock;
  #latest: number;

  public constructor(clock: ClaudeAgentSdkControlClock) {
    this.#clock = clock;
    this.#latest = this.#read();
  }
  public add(deadline: number, milliseconds: number): number {
    return Math.min(Number.MAX_SAFE_INTEGER, deadline + milliseconds);
  }
  public deadlineAfter(milliseconds: number): number {
    return this.add(this.now(), milliseconds);
  }
  public now(): number {
    this.#latest = Math.max(this.#latest, this.#read());
    return this.#latest;
  }
  public async pauseUntil(deadline: number, signal: AbortSignal): Promise<"abandoned" | "elapsed"> {
    if (signal.aborted) {
      return "abandoned";
    }
    try {
      await this.#waitUntil(deadline, signal);
    } catch {
      return signal.aborted ? "abandoned" : "elapsed";
    }
    return signal.aborted ? "abandoned" : "elapsed";
  }
  public async settle<T>(
    observed: Promise<ObservedSettlement<T>>,
    deadline: number,
    abandonSignal?: AbortSignal,
  ): Promise<BoundedSettlement<T>> {
    const abandoned = (): boolean => abandonSignal?.aborted === true;
    if (abandoned()) {
      return { kind: "abandoned" };
    }
    if (this.now() >= deadline) {
      return { kind: "timed_out" };
    }
    const timerAbort = new AbortController();
    const timeout = this.#timeout(deadline, timerAbort.signal);
    const abandonment = this.#abandonment(abandonSignal);
    const outcome = await Promise.race(abandonment === undefined
      ? [observed, timeout]
      : [observed, timeout, abandonment.promise]);
    timerAbort.abort();
    abandonment?.remove();
    if (abandoned()) {
      return { kind: "abandoned" };
    }
    if (outcome.kind === "fulfilled" && this.now() >= deadline) {
      return { kind: "timed_out" };
    }
    return outcome;
  }
  public settleCall<T>(
    call: () => T | PromiseLike<T>,
    deadline: number,
    abandonSignal?: AbortSignal,
  ): Promise<BoundedSettlement<T>> {
    if (abandonSignal?.aborted === true) {
      return Promise.resolve({ kind: "abandoned" });
    }
    if (this.now() >= deadline) {
      return Promise.resolve({ kind: "timed_out" });
    }
    return this.settle(observeCall(call), deadline, abandonSignal);
  }
  #abandonment(signal?: AbortSignal): { promise: Promise<BoundedSettlement<never>>; remove(): void } | undefined {
    if (signal === undefined) {
      return undefined;
    }
    let listener: (() => void) | undefined;
    const promise = new Promise<BoundedSettlement<never>>(resolve => {
      listener = () => resolve({ kind: "abandoned" });
      signal.addEventListener("abort", listener, { once: true });
    });
    return {
      promise,
      remove: () => {
        if (listener !== undefined) {
          signal.removeEventListener("abort", listener);
        }
      },
    };
  }
  readonly #read = (): number => {
    const observed = this.#clock.now();
    if (!Number.isFinite(observed)) {
      throw new TypeError("Claude control clock must return a finite value");
    }
    return observed;
  };
  async #timeout(deadline: number, signal: AbortSignal): Promise<BoundedSettlement<never>> {
    try {
      await this.#waitUntil(deadline, signal);
    } catch {
      if (signal.aborted) {
        return new Promise<BoundedSettlement<never>>(() => {});
      }
    }
    return { kind: "timed_out" };
  }
  async #waitUntil(deadline: number, signal: AbortSignal): Promise<void> {
    const started = this.now();
    const duration = Math.max(0, deadline - started);
    try {
      if (duration > 0) {
        await this.#clock.wait(duration, signal);
      }
    } catch (error) {
      if (!signal.aborted) {
        this.#latest = Math.max(this.#latest, deadline);
      }
      throw error;
    }
    if (!signal.aborted) {
      this.#latest = Math.max(this.#latest, started + duration, this.#read());
    }
  }
}
