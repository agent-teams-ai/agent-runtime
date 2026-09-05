import assert from "node:assert/strict";

import { createContainedTurnEngine } from "../../../../dist/features/contained-agent-turn/application/contained-turn-engine.js";
import type { ContainedTurnKernelDependencies } from "../../../../dist/features/contained-agent-turn/application/ports/outbound/contained-turn-ports.js";
import { containedTurnIdentity } from "../../../../dist/features/contained-agent-turn/domain/contained-turn-identities.js";
import { createDependencies } from "./contained-agent-turn-fixture.ts";

type Store = ContainedTurnKernelDependencies["operationStore"];
type Scope = Parameters<Store["read"]>[0]["scope"];

const syntheticCustody = (
  base: ContainedTurnKernelDependencies["custody"], store: Store, scope: Scope, starts: { value: number },
): ContainedTurnKernelDependencies["custody"] => {
  const hostBootId = containedTurnIdentity("host_boot", "host-boot:fresh-process");
  const hostInstanceId = containedTurnIdentity("host_instance", "host-instance:fresh-process");
  return {
    ...base,
    open: async input => ({
      custodyId: input.custodyId, hostBootId, hostInstanceId,
      hostCustodyProof: {
        binding: {
          operationId: input.operationId, effectId: input.effectId,
          authorityVectorDigest: input.authorityVectorDigest,
          attemptId: input.attemptId, custodyId: input.custodyId,
        },
        kind: "host_custody",
        proofId: containedTurnIdentity("proof", "proof:fresh-process-custody"),
      },
    }),
    start: async input => {
      starts.value += 1;
      const current = await store.read({ operationId: input.operationId, scope });
      assert.ok(current);
      assert.equal(current.dispatch.kind, "claimed");
      assert.equal(input.committedDispatchProof.operationId, current.operationId);
      const proof = {
        binding: {
          operationId: current.operationId, effectId: current.effectId,
          authorityVectorDigest: current.acceptedAuthorityVectorDigest,
          attemptId: input.attemptId, custodyId: input.custodyId,
          hostBootId, hostInstanceId,
        },
        kind: "provider_process_start" as const,
        proofId: containedTurnIdentity("proof", "proof:fresh-process-start"),
      };
      const observation = { kind: "execution_started" as const, proof };
      const execution = input.execute({
        createProcess: createProcess => createProcess(),
        observation: Promise.resolve(observation),
      });
      return { ...observation, execution };
    },
    ensurePhysicalContainment: async () => ({
      kind: "indeterminate",
      evidenceId: containedTurnIdentity("evidence", "evidence:fresh-process-containment"),
    }),
  };
};

// Every invocation constructs new owner ports; only the supplied store is durable.
export const createPostgresReplayApplication = (store: Store, scope: Scope) => {
  const { dependencies } = createDependencies();
  const providerCalls = { value: 0 };
  const starts = { value: 0 };
  const claims: Parameters<Store["claimPreparedDispatch"]>[0][] = [];
  const operationStore = new Proxy(store, {
    get(target, property) {
      if (property === "claimPreparedDispatch") {
        return (input: Parameters<Store["claimPreparedDispatch"]>[0]) => {
          claims.push(input);
          return target.claimPreparedDispatch(input);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const application = createContainedTurnEngine({
    ...dependencies,
    operationStore,
    custody: syntheticCustody(dependencies.custody, store, scope, starts),
    providerAccess: {
      ...dependencies.providerAccess,
      resolveForAcceptance: async input => {
        const result = await dependencies.providerAccess.resolveForAcceptance(input);
        return result.kind === "resolved"
          ? { ...result, snapshot: { ...result.snapshot, ...input.scope } }
          : result;
      },
    },
    provider: {
      ...dependencies.provider,
      execute: async input => {
        providerCalls.value += 1;
        input.start.createProcess(() => Object.freeze({}));
        await input.emit({ cursor: 0, kind: "assistant", text: "committed before process exit" });
        return {
          kind: "indeterminate",
          evidenceId: containedTurnIdentity("evidence", "evidence:fresh-process-ambiguous"),
        };
      },
    },
  });
  return { application, claims, providerCalls, starts };
};
