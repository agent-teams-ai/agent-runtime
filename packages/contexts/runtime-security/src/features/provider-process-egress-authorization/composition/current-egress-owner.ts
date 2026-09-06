import { deepFreezeEgress } from "../application/immutable.js";
import type { EgressAuthorityReadOutcomeV2, EgressCurrentAuthorityV2,
  TrustedHostRequestProjectionV2 } from "../contracts/provider-process-egress-authorization-v2.js";
import type { ProviderProcessEgressAuthorizationV2AuthorityOwner } from "./ed25519-v2-candidate-factory.js";
import type { CurrentEgressDispatchHead, CurrentEgressEndorsement, CurrentEgressOwnerInput } from "./current-egress-inputs.js";
import { captureCurrentEgressEndorsement, captureCurrentEgressHead, captureCurrentEgressInput,
  captureCurrentEgressRead, captureCurrentEgressResolve, currentEgressDigest,
  matchesCurrentEgressRequest, requireCurrentEgress, sameCurrentEgress } from "./current-egress-validation.js";

const nativeThen = Promise.prototype.then;
const nativeApply = Reflect.apply;

type Context = { readonly generation: number; readonly authorityRef: string;
  readonly request: TrustedHostRequestProjectionV2; readonly expiresAt: number };
const denied = (): EgressAuthorityReadOutcomeV2 => ({ status: "denied", reason: "policy_denied" });
const unavailable = (): EgressAuthorityReadOutcomeV2 =>
  ({ status: "indeterminate", reason: "owner_unavailable" });

const rebuild = (input: CurrentEgressOwnerInput, context: Context,
  pa: CurrentEgressEndorsement, head: CurrentEgressDispatchHead): EgressCurrentAuthorityV2 => ({
  authorityRef: context.authorityRef,
  policy: { policyRef: input.rule.policyRef,
    // Includes the independently read-and-matched RS version/revision and full rule.
    policyRevision: currentEgressDigest({ domain: "rs-current-egress-policy/v1",
      ruleBindingDigest: input.approval.bindingDigest, headVersion: head.headVersion,
      authorityRevision: head.authority!.authorityRevision }),
    policyGeneration: head.authority!.operation.authorityGeneration,
    authorizedRequestDigest: currentEgressDigest(context.request), origin: input.rule.route.origin,
    dnsIdentity: input.rule.route.origin.hostname, tlsPolicyDigest: input.rule.tlsPolicyDigest,
    limits: input.rule.limits, decisionTtlMilliseconds: input.rule.decisionTtlMilliseconds, revoked: false },
  providerAccess: { accessRef: pa.accessRef, providerRef: pa.operation.providerId,
    accountRef: pa.accountRef, routeRef: pa.providerRouteRef,
    routeAuthorityDigest: pa.routeAuthorityDigest, credentialBindingDigest: pa.credentialBindingDigest,
    // Explicit existing Host receipt mapping; never substitute credentialGeneration.
    routeGeneration: String(pa.bindingRevision), credentialGeneration: pa.credentialGeneration },
});

/** Private, inert operation composition for the EXISTING V2 owner contract.
 * Each successful call observes RS / PA / RS. This is an observation point,
 * never a synchronous Host cutoff, durable grant, or admission promotion.
 * Host serializes admission: overlap supersedes the old ref and fails closed
 * without queuing requests or starting a second borrowed read.
 */
export const createCurrentEgressOwner = (value: CurrentEgressOwnerInput):
  ProviderProcessEgressAuthorizationV2AuthorityOwner & { dispose(): void } => {
  const input = captureCurrentEgressInput(value);
  const time = input.timing;
  // Dispatch owns the already committed claim window; HTTP uses its own lifetime.
  const deadline = time.operationDeadlineMonotonic;
  let closed = false;
  let generation = 0;
  let lastTime = time.monotonicAtAnchor;
  let context: Context | undefined;
  let busy = false;
  let cancelRead: (() => void) | undefined;
  const close = () => { closed = true; context = undefined; cancelRead?.(); };
  const now = () => {
    try {
      const current = input.monotonicNow();
      requireCurrentEgress(Number.isFinite(current) && current >= lastTime);
      lastTime = current;
      requireCurrentEgress(!closed && current < deadline);
      return current;
    } catch (error) {close(); throw error;}
  };
  const assertContext = (selected: Context) => {
    requireCurrentEgress(context === selected && selected.generation === generation && now() < selected.expiresAt);
  };
  const read = async <T>(callback: (operation: typeof input.operation) => Promise<unknown>,
    capture: (raw: unknown) => T, selected: Context): Promise<T> => {
    assertContext(selected);
    const started = now();
    const readDeadline = Math.min(started + input.timing.readTimeoutMilliseconds, deadline, selected.expiresAt);
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = (error?: unknown, result?: T) => {
        if (settled) {return;}
        settled = true; clearTimeout(timer); cancelRead = undefined;
        if (error !== undefined) {reject(error);} else {resolve(result!);}
      };
      const timer = setTimeout(() => finish(new Error("current read deadline")), readDeadline - started);
      cancelRead = () => finish(new Error("current read closed"));
      try {
        const pending = callback(input.operation);
        // Native async trusted readers return an intrinsic outer promise. Attach
        // both handlers immediately; raw promise suppliers are rejected before call.
        void nativeApply(nativeThen, pending, [(raw: unknown) => {
          if (settled) {return;}
          try {
            const detached = capture(raw); assertContext(selected);
            requireCurrentEgress(now() < readDeadline); finish(undefined, detached);
          }
          catch (error) {finish(error);}
        }, (error: unknown) => {finish(error ?? new Error("current read rejected"));}]);
      } catch (error) {finish(error);}
    });
  };
  const observe = async (selected: Context): Promise<EgressAuthorityReadOutcomeV2> => {
    busy = true;
    try {
      const first = await read(input.readRsHead, captureCurrentEgressHead, selected);
      requireCurrentEgress(sameCurrentEgress(first, input.acceptedDispatch));
      const pa = await read(input.readPaEndorsement, captureCurrentEgressEndorsement, selected);
      const second = await read(input.readRsHead, captureCurrentEgressHead, selected);
      requireCurrentEgress(sameCurrentEgress(first, second));
      requireCurrentEgress(pa !== null && pa.available && !pa.revoked && pa.bindingRevision >= 1);
      requireCurrentEgress(sameCurrentEgress(pa!.operation, input.operation) &&
        sameCurrentEgress(pa!.route, input.rule.route));
      requireCurrentEgress(selected.request.headers.credentialFields.every(field =>
        field.credentialBindingDigest === pa!.credentialBindingDigest));
      requireCurrentEgress(matchesCurrentEgressRequest(selected.request, input.rule.route) &&
        selected.request.body.byteLength <= input.rule.limits.requestBytes);
      assertContext(selected);
      return deepFreezeEgress({ status: "current", authority: rebuild(input, selected, pa!, second) });
    } catch { close(); return unavailable(); }
    finally { busy = false; }
  };
  return Object.freeze({
    async resolvePolicy(raw: Parameters<ProviderProcessEgressAuthorizationV2AuthorityOwner["resolvePolicy"]>[0]) {
      context = undefined;
      generation += 1;
      if (closed || busy || !Number.isSafeInteger(generation)) {close(); return denied();}
      try {
        const captured = captureCurrentEgressResolve(raw);
        requireCurrentEgress(sameCurrentEgress(captured.scope, input.operation.scope));
        requireCurrentEgress(matchesCurrentEgressRequest(captured.request, input.rule.route) &&
          captured.request.body.byteLength <= input.rule.limits.requestBytes);
        const expiresAt = Math.min(deadline, now() + input.rule.decisionTtlMilliseconds);
        const authorityRef = currentEgressDigest({ domain: "rs-current-egress-context/v1",
          nonce: crypto.randomUUID(), generation, operation: input.operation,
          authorizationRequestId: captured.authorizationRequestId, request: captured.request,
          approval: input.approval.bindingDigest });
        context = Object.freeze({ generation, authorityRef, request: captured.request, expiresAt });
        return await observe(context);
      } catch { if (lastTime >= deadline) {close();} return denied(); }
    },
    async readCurrent(raw: Parameters<ProviderProcessEgressAuthorizationV2AuthorityOwner["readCurrent"]>[0]) {
      if (closed || busy) {return denied();}
      try {
        const captured = captureCurrentEgressRead(raw);
        requireCurrentEgress(sameCurrentEgress(captured.scope, input.operation.scope) &&
          context !== undefined && captured.authorityRef === context.authorityRef);
        assertContext(context!);
        return await observe(context!);
      } catch { return denied(); }
    },
    dispose: close,
  });
};
