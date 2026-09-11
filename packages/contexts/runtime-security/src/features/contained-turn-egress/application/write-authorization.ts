import type { ProviderRouteAuthoritySnapshotV1 } from "../domain/provider-route-authority.js";
import type { createEgressValidation, PolicyAuthority } from "../domain/validation.js";
import type { EgressPolicyTimeAuthorityV1 } from "./ports/outbound/egress-policy-time-authority.js";

export const frozenExact = <Name extends string>(validation: ReturnType<typeof createEgressValidation>, value: unknown,
  names: readonly Name[]) => {try {const captured = validation.exact(value, names);
    return captured !== undefined && Object.isFrozen(value) ? captured : undefined;} catch {return;}};

/** Ephemeral, one-use joint authority. The trusted writer consumes it at emission after signing/verification.
 * The monotonic lease starts before the asynchronous policy read, so owner latency cannot extend it. */
export const createWriteAuthorization = (input: Readonly<{
  validation: ReturnType<typeof createEgressValidation>; owner: EgressPolicyTimeAuthorityV1;
  route: ProviderRouteAuthoritySnapshotV1; policy: PolicyAuthority; issuedAt: number;
  startedAt: number; deadlineMs: number; active(): boolean; now(): number;
}>) => {
  let used = false; let consumed = false; let rejected = false;
  const {validation, owner, route, policy, issuedAt, startedAt, deadlineMs, now} = input;
  const validFor = Math.min(1_000, policy.expiresAt - issuedAt, deadlineMs - (issuedAt - policy.observedAt));
  const inTime = () => {const elapsed = now() - startedAt;
    return Number.isFinite(elapsed) && elapsed >= 0 && elapsed < validFor;};
  return Object.freeze({
    consumeAuthorization(): boolean {
      if (used) {rejected = true; return false;} used = true;
      if (!input.active() || !inTime()) {rejected = true; return false;}
      let current;
      try {current = frozenExact(validation, owner.consumeFirstWrite(Object.freeze({route, policy, issuedAt})),
        ["status", "observedAt"]);} catch {rejected = true; return false;}
      const observedAt = current?.observedAt;
      consumed = current?.status === "current" && Number.isSafeInteger(observedAt) && (observedAt as number) >= issuedAt &&
        (observedAt as number) < policy.expiresAt && (observedAt as number) - policy.observedAt < deadlineMs &&
        input.active() && inTime();
      rejected = !consumed; return consumed;
    },
    get consumed() {return consumed;}, get rejected() {return rejected;},
  });
};
