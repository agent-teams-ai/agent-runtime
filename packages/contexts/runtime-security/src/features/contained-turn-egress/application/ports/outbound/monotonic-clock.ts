export interface MonotonicClock {
  /** Returns a monotonic instant, e.g. `performance.now()`. Callers use it only to measure elapsed
   * duration within a single lease window; it is not calendar time and cannot go backwards. */
  now(): number;
}
