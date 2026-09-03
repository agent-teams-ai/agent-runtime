export const raceWithAbort = <T>(operation: Promise<T>, signal: AbortSignal): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    let settled = false;
    const settle = (callback: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      signal.removeEventListener("abort", abort);
      callback();
    };
    const abort = (): void => {
      settle(() => reject(
        signal.reason ?? new DOMException("Agent Runtime operation was cancelled", "AbortError"),
      ));
    };

    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
    operation.then(
      value => settle(() => resolve(value)),
      error => settle(() => reject(error)),
    );
  });
