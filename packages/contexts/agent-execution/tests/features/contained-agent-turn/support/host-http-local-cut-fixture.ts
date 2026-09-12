import {createHostHttpEgressSession} from "../../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/egress/host-http-egress-session.js";
import {createHostHttpLocalCutOwner, type HostHttpLocalCutInput} from "../../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/egress/host-http-local-cut-owner.js";
import type {HttpEgressTransportSession} from "../../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/egress/http-egress-ports.js";
import {containedTurnOperationCutoffRevision} from "../../../../dist/features/contained-agent-turn/domain/contained-turn-output-authority.js";
import {adapterSnapshot, attemptId, authorityDigest, commandId, custodyId, effectId, hostBootId, hostInstanceId,
  operationId, preparationToken, proofId, providerAccessSnapshot, workspaceId} from "../../../contained-turn-kernel-fixtures.ts";
import {committedDispatchProofFixture} from "./committed-dispatch-proof-fixture.ts";
import {createEgressFixture, type FixtureOptions} from "../http-egress-test-fixture.ts";

export const tick = (): Promise<void> => new Promise(resolve => {setImmediate(resolve);});
export const deferred = <T>() => Promise.withResolvers<T>();

export const localCutFixture = (options: FixtureOptions = {}) => {
  const proof = committedDispatchProofFixture({adapterSnapshot, attemptId, authorityVectorDigest: authorityDigest,
    commandId, custodyId, effectId, intentMode: "analysis", operationId,
    operationCutoffRevision: containedTurnOperationCutoffRevision(0), operationRevision: 1,
    preparationToken, providerAccessSnapshot, workspaceId}, {custodyId, hostBootId, hostInstanceId,
    hostCustodyProof: {kind: "host_custody", proofId: proofId("proof:synthetic-host-reservation"),
      binding: {attemptId, authorityVectorDigest: authorityDigest, custodyId, effectId, operationId}}});
  const fixture = createEgressFixture({...options,
    mutateProvisional: original => {
      const value = {...original, scope: {...original.scope, operationId},
        signingKey: {...original.signingKey, hostReservationId: custodyId},
        signature: {...original.signature, hostReservationId: custodyId}};
      return options.mutateProvisional?.(value) ?? value;
    },
    mutateGrant: original => {
      const value = {...original, signature: {...original.signature, hostReservationId: custodyId},
        evidence: {...original.evidence, signingKey: {...original.evidence.signingKey, hostReservationId: custodyId}},
        payload: {...original.payload, consumption: {...original.payload.consumption,
          journalKey: {...original.payload.consumption.journalKey, operationId}}}};
      return options.mutateGrant?.(value) ?? value;
    }});
  const custody = new AbortController(); const shutdown = new AbortController();
  const state = {authorityId: "clock-authority", epoch: "epoch-1", controlTime: 0, reads: 0,
    throwClock: false, journalCalls: 0, consumeHook: () => {},
    dispatchSignal: undefined as AbortSignal | undefined,
    dispatchHook: undefined as undefined | ((result: ReturnType<HttpEgressTransportSession["dispatch"]>) =>
      ReturnType<HttpEgressTransportSession["dispatch"]>)};
  const keys = new Set<string>(); const deadlines: number[] = []; const phaseSignals: AbortSignal[] = [];
  const clock = {
    read() {state.reads += 1; if (state.throwClock) {throw new Error("synthetic clock failure");}
      return {authorityId: state.authorityId, epoch: state.epoch, controlTime: state.controlTime};},
    async within<T>(deadline: number, action: () => Promise<T>, signal?: AbortSignal): Promise<T> {
      deadlines.push(deadline); if (signal !== undefined) {phaseSignals.push(signal);}
      signal?.throwIfAborted();
      if (state.controlTime >= deadline) {throw new Error("synthetic deadline");}
      const abort = deferred<never>(); const cancel = () => abort.reject(new Error("synthetic abort"));
      signal?.addEventListener("abort", cancel, {once: true});
      try {
        const result = await Promise.race([action(), abort.promise]);
        signal?.throwIfAborted();
        if (state.controlTime >= deadline) {throw new Error("synthetic deadline");}
        return result;
      } finally {signal?.removeEventListener("abort", cancel);}
    },
  };
  const input: HostHttpLocalCutInput = {claimed: {committedDispatchProof: proof, signal: custody.signal,
    underlyingCustodyRef: "host:opaque-retained-reservation"},
    identity: {operationId, attemptId, custodyId, hostBootId,
      liveProcessSessionIdentity: fixture.ports.identity.liveProcessSessionIdentity},
    expectedClock: {authorityId: "clock-authority", epoch: "epoch-1"}, clock,
    operationDeadline: fixture.operation.limits.deadline, hostShutdownSignal: shutdown.signal};
  const ports = {...fixture.ports,
    verifier: {...fixture.ports.verifier, signingKey: {...fixture.ports.verifier.signingKey, hostReservationId: custodyId}},
    journal: {consume(key: object) {
      state.journalCalls += 1; const identity = JSON.stringify(key);
      if (keys.has(identity)) {return "duplicate" as const;}
      keys.add(identity); state.consumeHook(); return "consumed" as const;
    }},
    transport: {beginOpen: (...args: Parameters<typeof fixture.ports.transport.beginOpen>) => {
      const attempt = fixture.ports.transport.beginOpen(...args);
      return {...attempt, async ready() {
        const session = await attempt.ready();
        return {...session, dispatch(consume: () => Uint8Array | undefined, signal?: AbortSignal) {
          state.dispatchSignal = signal;
          const pending = session.dispatch(consume, signal);
          return state.dispatchHook?.(pending) ?? pending;
        }};
      }};
    }},
  };
  const operation = {...fixture.operation, operationId, attemptId};
  const owner = createHostHttpLocalCutOwner(input);
  return {fixture, input, owner, ports, operation, custody, shutdown, state, keys, deadlines, phaseSignals,
    openSession: createHostHttpEgressSession};
};
