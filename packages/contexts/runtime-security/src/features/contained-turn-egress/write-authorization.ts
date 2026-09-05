import type { EgressPolicyTimeAuthorityV1, ProviderRouteAuthoritySnapshotV1 } from "./composition.js";
import type { createEgressValidation, PolicyAuthority } from "./validation.js";
import { monotonicNow } from "./node-boundary.js";

export const frozenExact = <Name extends string>(validation: ReturnType<typeof createEgressValidation>, value: unknown,
  names: readonly Name[]) => {try {const captured = validation.exact(value, names);
    return captured !== undefined && Object.isFrozen(value) ? captured : undefined;} catch {return;}};

/** Ephemeral, one-use joint authority. The trusted writer consumes it at emission after signing/verification.
 * The monotonic lease starts before the asynchronous policy read, so owner latency cannot extend it. */
export const createWriteAuthorization = (input: Readonly<{
  validation: ReturnType<typeof createEgressValidation>; owner: EgressPolicyTimeAuthorityV1;
  route: ProviderRouteAuthoritySnapshotV1; policy: PolicyAuthority; issuedAt: number;
  startedAt: number; deadlineMs: number; active(): boolean;
}>) => {
  let used = false; let consumed = false; let rejected = false;
  const {validation, owner, route, policy, issuedAt, startedAt, deadlineMs} = input;
  const validFor = Math.min(1_000, policy.expiresAt - issuedAt, deadlineMs - (issuedAt - policy.observedAt));
  const inTime = () => {const elapsed = monotonicNow() - startedAt;
    return Number.isFinite(elapsed) && elapsed >= 0 && elapsed < validFor;};
  return Object.freeze({
    consumeAuthorization(): boolean {
      if (used) {rejected = true; return false;} used = true;
      if (!input.active() || !inTime()) {rejected = true; return false;}
      let current;
      try {current = frozenExact(validation, owner.consumeFirstWrite(Object.freeze({route, policy, issuedAt})),
        ["status", "observedAt"]);} catch {rejected = true; return false;}
      const now = current?.observedAt;
      consumed = current?.status === "current" && Number.isSafeInteger(now) && (now as number) >= issuedAt &&
        (now as number) < policy.expiresAt && (now as number) - policy.observedAt < deadlineMs &&
        input.active() && inTime();
      rejected = !consumed; return consumed;
    },
    get consumed() {return consumed;}, get rejected() {return rejected;},
  });
};
