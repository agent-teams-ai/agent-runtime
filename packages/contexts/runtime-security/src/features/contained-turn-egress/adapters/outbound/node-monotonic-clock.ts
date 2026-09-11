import type { MonotonicClock } from "../../application/ports/outbound/monotonic-clock.js";

export const createNodeMonotonicClock = (): MonotonicClock =>
  Object.freeze({now: performance.now.bind(performance)});
