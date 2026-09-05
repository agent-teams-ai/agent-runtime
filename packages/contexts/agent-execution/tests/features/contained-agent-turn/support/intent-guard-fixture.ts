import assert from "node:assert/strict";
import type { Pool } from "pg";
import { PostgresContainedTurnOperationStore } from "../../../../dist/features/contained-agent-turn/adapters/outbound/postgres/postgres-contained-turn-operation-store.js";
import { createContainedTurnFeature } from "../../../../dist/features/contained-agent-turn/composition/feature-module-factory.js";
import { containedTurnCommandFingerprint } from "../../../../dist/features/contained-agent-turn/domain/contained-turn-authority.js";
import { digestContainedTurnCanonicalValue } from "../../../../dist/features/contained-agent-turn/domain/contained-turn-codecs.js";
import { containedTurnIdentity } from "../../../../dist/features/contained-agent-turn/domain/contained-turn-identities.js";
import { containedTurnPreventionDigest, type ContainedTurnIntentAuthority, type ContainedTurnPreventionCommand } from "../../../../dist/features/contained-agent-turn/domain/contained-turn-intent-guard.js";
import type { ContainedTurnKernelDependencies } from "../../../../dist/features/contained-agent-turn/application/ports/outbound/contained-turn-ports.js";
export { awaitFixtureGate } from "./contained-agent-turn-fixture.ts";
import { createDependencies } from "./contained-agent-turn-fixture.ts";

export const intentAuthority: ContainedTurnIntentAuthority = Object.freeze({
  audience: "agent-runtime:contained-turn-v1", authorityRevision: "authority:one", deploymentId: "deployment:test",
  deploymentIncarnation: "incarnation:one", runtimeScopeRevision: "runtime-scope:one",
  externalAuthorityDigest: digestContainedTurnCanonicalValue({ applicability: "synthetic-no-external-authority" }),
});
export const submission = Object.freeze({
  commandId: "command:one", expectedProvider: "codex", intent: Object.freeze({ mode: "analysis" as const, prompt: "synthetic guarded intent" }),
  scope: Object.freeze({ projectId: "project:one", tenantId: "tenant:one" }),
});
export const prevention = (overrides: Partial<Omit<ContainedTurnPreventionCommand, "preventionDigest">> = {}): ContainedTurnPreventionCommand => {
  const preimage = {
    authority: intentAuthority, commandFingerprint: containedTurnCommandFingerprint({ intent: submission.intent, provider: submission.expectedProvider, scope: submission.scope }),
    commandId: containedTurnIdentity("command", submission.commandId), preventionCommandId: containedTurnIdentity("cancellation_command", "cancellation-command:prevent-one"),
    scope: submission.scope, targetIntentCorrelation: null, version: 1 as const, ...overrides,
  };
  return Object.freeze({ ...preimage, preventionDigest: containedTurnPreventionDigest(preimage) });
};
export const gate = () => {
  let release!: () => void;
  const promise = new Promise<void>(resolve => {release = resolve;});
  return { promise, release };
};

/** Real factory, application and PostgreSQL owner; only external effect ports are synthetic. */
export const intentHarness = (pool: Pool, hooks: Readonly<{
  beforeAcceptance?: () => Promise<void>;
  beforeClaim?: () => Promise<void>;
  beforeClaimCas?: (input: Parameters<PostgresContainedTurnOperationStore["claimPreparedDispatch"]>[0]) => Promise<void>;
  beforeProvider?: () => Promise<void>;
}> = {}) => {
  const fixture = createDependencies();
  class ObservedStore extends PostgresContainedTurnOperationStore {
    override async claimPreparedDispatch(input: Parameters<PostgresContainedTurnOperationStore["claimPreparedDispatch"]>[0]) {
      await hooks.beforeClaimCas?.(input);
      return super.claimPreparedDispatch(input);
    }
  }
  const store = new ObservedStore({ pool, intentAuthority });
  const counts = { custodyOpen: 0, custodyStart: 0, provider: 0, workspace: 0, access: 0, security: 0 };
  const dependencies: ContainedTurnKernelDependencies = {
    ...fixture.dependencies, operationStore: store,
    workspace: { ...fixture.dependencies.workspace, create: async () => {
      counts.workspace += 1;
      return { workspaceId: containedTurnIdentity("workspace", "workspace:intent-test") };
    } },
    providerAccess: { ...fixture.dependencies.providerAccess, resolveForAcceptance: async input => {
      counts.access += 1; await hooks.beforeAcceptance?.();
      return fixture.dependencies.providerAccess.resolveForAcceptance(input);
    } },
    security: { ...fixture.dependencies.security,
      authorizeForAcceptance: async input => {counts.security += 1; return fixture.dependencies.security.authorizeForAcceptance(input);},
      consumeForDispatch: async input => {await hooks.beforeClaim?.(); return fixture.dependencies.security.consumeForDispatch(input);},
    },
    custody: { ...fixture.dependencies.custody,
      open: async input => {
        counts.custodyOpen += 1;
        return {
          custodyId: input.custodyId, hostBootId: containedTurnIdentity("host_boot", "host-boot:intent"), hostInstanceId: containedTurnIdentity("host_instance", "host-instance:intent"),
          hostCustodyProof: { kind: "host_custody", proofId: containedTurnIdentity("proof", "proof:intent-custody"), binding: {
            attemptId: input.attemptId, authorityVectorDigest: input.authorityVectorDigest, custodyId: input.custodyId, effectId: input.effectId, operationId: input.operationId,
          } },
        };
      },
      start: async input => {
        counts.custodyStart += 1;
        const operation = await store.read({ operationId: input.operationId, scope: submission.scope });
        assert.ok(operation?.dispatch.kind === "claimed");
        const proof = { kind: "provider_process_start" as const, proofId: containedTurnIdentity("proof", "proof:intent-start"), binding: {
          attemptId: input.attemptId, authorityVectorDigest: operation.acceptedAuthorityVectorDigest, custodyId: input.custodyId,
          effectId: operation.effectId, hostBootId: operation.hostBootId!, hostInstanceId: operation.hostInstanceId!, operationId: input.operationId,
        } };
        const observation = Promise.resolve({ kind: "execution_started" as const, proof });
        return { kind: "execution_started", proof, execution: input.execute({ createProcess: creator => creator(), observation }) };
      },
      ensurePhysicalContainment: async () => ({ kind: "indeterminate", evidenceId: containedTurnIdentity("evidence", "evidence:synthetic-containment-unproven") }),
    },
    provider: { ...fixture.dependencies.provider, execute: async input => {
      counts.provider += 1;
      input.start.createProcess(() => Object.freeze({ synthetic: true }));
      await hooks.beforeProvider?.();
      return { kind: "indeterminate", evidenceId: containedTurnIdentity("evidence", "evidence:synthetic-provider-unknown") };
    } },
  };
  return { counts, dependencies, feature: createContainedTurnFeature(dependencies), store };
};
