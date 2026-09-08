import assert from "node:assert/strict";
import type {Pool} from "pg";
import {createNodeContainedTurnArtifacts, createNodeContainedTurnWorkspace, type ContainedTurnFeatureDependencies} from "../../../../contexts/agent-execution/dist/composition.js";
import {PostgresContainedTurnOperationStore} from "../../../../contexts/agent-execution/dist/features/contained-agent-turn/adapters/outbound/postgres/postgres-contained-turn-operation-store.js";
import {containedTurnIdentity as identity} from "../../../../contexts/agent-execution/dist/features/contained-agent-turn/domain/contained-turn-identities.js";
import {intentAuthority} from "../../../../contexts/agent-execution/tests/features/contained-agent-turn/support/intent-guard-fixture.ts";
import {createDependencies} from "../../../../contexts/agent-execution/tests/features/contained-agent-turn/support/contained-agent-turn-fixture.ts";
import {createSyntheticFilesystemLayout} from "../../../../contexts/agent-execution/tests/filesystem-contained-turn/fixture.ts";

const unknown = async () => ({kind: "indeterminate" as const,
  evidenceId: identity("evidence", "evidence:synthetic-current-pg-unknown")});

// Real SQL and filesystem owners; synthetic custody deliberately cannot prove finality.
export const createPostgresCurrentAuthorityFixture = async (pool: Pool, scope: {projectId: string; tenantId: string},
  afterReservation?: () => Promise<void>,
  afterClaim?: (operation: Awaited<ReturnType<PostgresContainedTurnOperationStore["read"]>>) => Promise<void>) => {
  const layout = await createSyntheticFilesystemLayout();
  try {
    const workspace = await createNodeContainedTurnWorkspace(layout.workspaceOptions);
    const artifacts = await createNodeContainedTurnArtifacts(layout.artifactOptions);
    const fixture = createDependencies();
    const counts = {provider: 0, starts: 0, released: 0, boundaries: 0};
    const rebuildStore = () => {
      const durable = new PostgresContainedTurnOperationStore({pool, intentAuthority});
      // Expose receiver-bound own methods to the strict seven-port capture.
      const operationStore = Object.freeze({
        accept: durable.accept.bind(durable),
        appendOutput: durable.appendOutput.bind(durable),
        claimPreparedDispatch: durable.claimPreparedDispatch.bind(durable),
        commit: durable.commit.bind(durable),
        identifyAcceptance: durable.identifyAcceptance.bind(durable),
        listDispatchPreparations: durable.listDispatchPreparations.bind(durable),
        preventIntent: durable.preventIntent.bind(durable),
        prepareCancellation: durable.prepareCancellation.bind(durable),
        prepareDispatch: durable.prepareDispatch.bind(durable),
        proofsForAcceptedEffect: durable.proofsForAcceptedEffect.bind(durable),
        proofsForPrevention: durable.proofsForPrevention.bind(durable),
        proofsForProcessNoStart: durable.proofsForProcessNoStart.bind(durable),
        proveDispatchPreparationClosure: durable.proveDispatchPreparationClosure.bind(durable),
        read: durable.read.bind(durable),
        recordDispatchPreparationCleanup: durable.recordDispatchPreparationCleanup.bind(durable),
        requestCancellation: durable.requestCancellation.bind(durable),
        retireDispatchPreparation: durable.retireDispatchPreparation.bind(durable),
        terminalProof: durable.terminalProof.bind(durable),
      });
      return {durable, operationStore};
    };
    const {durable, operationStore} = rebuildStore();
    const custody: ContainedTurnFeatureDependencies["custody"] = {
      ...fixture.dependencies.custody,
      async open(input) {
        await afterReservation?.();
        return {custodyId: input.custodyId,
          hostBootId: identity("host_boot", "host-boot:synthetic-pg"),
          hostInstanceId: identity("host_instance", "host-instance:synthetic-pg"),
          hostCustodyProof: {kind: "host_custody", proofId: identity("proof", `proof:${input.custodyId}`),
            binding: {attemptId: input.attemptId, authorityVectorDigest: input.authorityVectorDigest,
              custodyId: input.custodyId, effectId: input.effectId, operationId: input.operationId}}};
      },
      async start(input) {
        const operation = await durable.read({operationId: input.operationId, scope});
        assert.ok(operation && operation.dispatch.kind === "claimed");
        assert.ok(operation.hostBootId && operation.hostInstanceId);
        await afterClaim?.(operation);
        counts.starts++;
        const proof = {kind: "provider_process_start" as const, proofId: identity("proof", `proof:start:${input.custodyId}`),
          binding: {attemptId: input.attemptId, authorityVectorDigest: operation.acceptedAuthorityVectorDigest,
            custodyId: input.custodyId, effectId: operation.effectId, operationId: input.operationId,
            hostBootId: operation.hostBootId, hostInstanceId: operation.hostInstanceId}};
        const observation = Promise.resolve({kind: "execution_started" as const, proof});
        return {kind: "execution_started", proof,
          execution: input.execute({createProcess: creator => creator(), observation})};
      },
      completionBoundary() {
        counts.boundaries++;
        return {expiration: new Promise(() => {}), release() {counts.boundaries--;}};
      },
      async releaseReservation() {counts.released++;},
      async releaseRetiredReservation() {counts.released++; return {kind: "released"};},
      attestExecutionClosure: unknown, ensurePhysicalContainment: unknown, queryPhysicalContainment: unknown,
      requestPhysicalContainment: unknown, attestContainment: unknown, queryContainmentAttestation: unknown,
      requestContainment: unknown,
    };
    const dependencies = {operationStore, workspace, artifacts, custody,
      provider: {...fixture.dependencies.provider, async execute(input: Parameters<ContainedTurnFeatureDependencies["provider"]["execute"]>[0]) {
        counts.provider++;
        input.start.createProcess(() => Object.freeze({synthetic: true}));
        return unknown();
      }}};
    return {dependencies, durable, rebuildStore, counts, cleanup: layout.cleanup};
  } catch (error) {
    await layout.cleanup();
    throw error;
  }
};
