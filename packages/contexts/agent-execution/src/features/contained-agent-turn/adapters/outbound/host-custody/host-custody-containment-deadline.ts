type ContainmentOptions = {readonly monotonicNow: () => number};
export const DEADLINE_EXCEEDED = Symbol("host-custody-deadline-exceeded");
export const FINALITY_FAILED = Symbol("host-custody-finality-failed");
export const PHASE_TIMEOUT = Symbol("host-custody-phase-timeout");

export type DeadlineAwait<Value> = Value | typeof DEADLINE_EXCEEDED | typeof PHASE_TIMEOUT;
type FinalityAwait<Value> = DeadlineAwait<Value> | typeof FINALITY_FAILED;

export const deadlineOpen = (deadline: number, options: ContainmentOptions): boolean =>
  deadline - options.monotonicNow() > 0;

export const awaitWithDeadline = async <Value>(
  promise: (maximumMs: number) => Promise<Value>,
  deadline: number,
  options: ContainmentOptions,
  phaseMaximumMs = Number.POSITIVE_INFINITY,
): Promise<DeadlineAwait<Value>> => {
  const remainingBefore = deadline - options.monotonicNow();
  if (remainingBefore <= 0) {return DEADLINE_EXCEEDED;}
  const maximumMs = Math.min(remainingBefore, phaseMaximumMs);
  const timeout = Symbol("host-custody-phase-timeout");
  let timer: ReturnType<typeof setTimeout> | undefined;
  let result: { readonly kind: "value"; readonly value: Value } | typeof timeout;
  try {
    result = await Promise.race([
      promise(maximumMs).then(
        value => ({ kind: "value" as const, value }),
        (error: unknown) => {throw error;},
      ),
      new Promise<typeof timeout>(resolve => {timer = setTimeout(() => {resolve(timeout);}, maximumMs);}),
    ]);
  } finally {
    if (timer !== undefined) {clearTimeout(timer);}
  }
  if (deadline - options.monotonicNow() <= 0) {return DEADLINE_EXCEEDED;}
  return result === timeout ? PHASE_TIMEOUT : result.value;
};

export const invokeFinalityWithDeadline = async <Value>(
  promise: () => Promise<Value>,
  deadline: number,
  options: ContainmentOptions,
  phaseMaximumMs = Number.POSITIVE_INFINITY,
): Promise<FinalityAwait<Value>> => {
  let invoked: Promise<Value>;
  try {
    invoked = promise();
  } catch {
    return FINALITY_FAILED;
  }
  const observed = invoked.then<Value, typeof FINALITY_FAILED>(
    value => value,
    () => FINALITY_FAILED,
  );
  if (!deadlineOpen(deadline, options)) {
    return DEADLINE_EXCEEDED;
  }
  return awaitWithDeadline(() => observed, deadline, options, phaseMaximumMs);
};

