export interface DispatchControlClock {
  /** Returns owner control time. Callers and adapters cannot supply this value. */
  now(): number;
}
