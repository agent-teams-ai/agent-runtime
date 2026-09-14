import assert from "node:assert/strict";
import {PostgresContainedTurnOperationStore, applyContainedTurnPostgresSchema,createContainedTurnEngine} from "@agent-teams/agent-execution/composition";
import {intentAuthority} from "../../support/external/agent-execution/features/contained-agent-turn/support/intent-guard-fixture.ts";
import {createDependencies} from "../../support/external/agent-execution/features/contained-agent-turn/support/contained-agent-turn-fixture.ts";
import {validateDisposablePostgresUrl} from "./external/provider-access/features/contained-turn-access/postgres-materialization-url.fixtures.ts";

// This database must be newly provisioned for this one test. Never reset an
// existing schema, and never substitute the memory fixture's closure callbacks.
export async function openPostgresHttpClosureStore(databaseUrl) {
  const {Pool} = await import("pg");
  const options = {connectionString: validateDisposablePostgresUrl(databaseUrl), max: 8,
    connectionTimeoutMillis: 2000, query_timeout: 5000, idleTimeoutMillis: 1000};
  const pool = new Pool(options);
  try {
    assert.equal((await pool.query("SELECT 1 FROM pg_namespace WHERE nspname = 'agent_execution'")).rowCount, 0,
      "Requires a new disposable AE database; existing state is never dropped");
    await applyContainedTurnPostgresSchema(pool);
  } catch (error) {await pool.end(); throw error;}
  let acceptedId;
  let claimedOperation;
  class AcceptanceObservedStore extends PostgresContainedTurnOperationStore {
    async claimPreparedDispatch(input) {
      const result = await super.claimPreparedDispatch(input);
      if (result.operation?.dispatch.kind === "claimed") {claimedOperation = result.operation;}
      return result;
    }
    async accept(candidate, authority) {
      const result = await super.accept(candidate, authority);
      if (result.kind === "accepted" || result.kind === "replayed") {acceptedId = result.operation.operationId;}
      return result;
    }
  }
  const store = new AcceptanceObservedStore({pool, intentAuthority});
  const readOperation = async ({scope}) => {
    assert.ok(acceptedId, "persisted acceptance must precede launch");
    const operation = await store.read({operationId: acceptedId, scope});
    assert.ok(operation);
    return operation;
  };
  const closureOwners = scope => {
    const binding = async input => {
      const operation = await readOperation({scope});
      assert.equal(input.operationId, operation.operationId);
      assert.equal(input.workspaceId, operation.workspaceId);
      return {authorityVectorDigest: operation.acceptedAuthorityVectorDigest, operationId: operation.operationId};
    };
    const close = async input => ({kind: "closed", proof: {kind: "workspace_closure",
      proofId: "proof:pg-http-workspace", binding: {...await binding(input), workspaceId: input.workspaceId}}});
    const seal = async input => {
      const bound = await binding(input);
      return {kind: "sealed", artifactProof: {kind: "artifact_manifest_seal", proofId: "proof:pg-http-artifact",
        binding: {...bound, artifactManifestRef: "artifact:pg-http", workspaceId: input.workspaceId}},
      resultProof: {kind: "result_publication", proofId: "proof:pg-http-result", binding: {...bound, resultRef: "result:pg-http"}}};
    };
    const ensureClosed = async input => ({kind: "proved", proof: (await close(input)).proof,
      requestId: input.requestId, requestDigest: input.requestDigest});
    const ensureSealed = async input => {
      const sealed = await seal(input);
      return {kind: "proved", proof: {artifactProof: sealed.artifactProof, resultProof: sealed.resultProof},
        requestId: input.requestId, requestDigest: input.requestDigest};
    };
    return {workspace: {async create() {return {workspaceId: "workspace:pg-http"};}, async quarantine() {},
      close, ensureClosed, queryClosure: ensureClosed},
    artifacts: {seal, ensureSealed, querySeal: ensureSealed}};
  };
  return {store, readOperation, closureOwners, current: () => claimedOperation, dispose: () => pool.end(),
    async verifyRecovery({operation, submit, assertUnresolvedReceipt}) {
      assertUnresolvedReceipt(operation);
      assert.equal(operation.physicalContainment.kind, "contained");
      assert.ok(operation.closureRecovery.evidenceIds.length > 0);
      const debt = operation.closureRecovery;
      // A separate pool/store cannot use the original store or its connections.
      const recoveryPool = new Pool(options);
      try {
      const restarted = new PostgresContainedTurnOperationStore({pool: recoveryPool, intentAuthority});
      const ref = {operationId: operation.operationId, scope: submit.scope};
      assert.deepEqual(await restarted.read(ref), operation);
      const fixture = createDependencies();
      const calls = {dispatch: 0, queries: 0};
      const forbidden = async () => {calls.dispatch++; throw new Error("recovery attempted a new effect");};
      const engine = createContainedTurnEngine({...fixture.dependencies, operationStore: restarted,
        workspace: { ...closureOwners(submit.scope).workspace, create: forbidden },
        provider: {...fixture.dependencies.provider, execute: forbidden},
        custody: {...fixture.dependencies.custody, open: forbidden, start: forbidden,
          attestContainment: forbidden,
          async queryContainmentAttestation(input) {
            calls.queries++;
            const saved = await restarted.read(ref);
            assert.equal(input.operationId, saved.operationId);
            assert.equal(input.requestId, debt.requestId);
            assert.equal(input.requestDigest, debt.requestDigest);
            // A fresh owner has no durable HTTP receipt that can resolve this debt.
            return {kind: "indeterminate", evidenceId: debt.evidenceIds[0]};
          }},
      });
      for (let attempt = 0; attempt < 2; attempt++) {
        const replay = await engine.submit(submit);
        assert.equal(replay.status, "observed");
        assertUnresolvedReceipt(replay.operation);
        const saved = await restarted.read(ref);
        assertUnresolvedReceipt(saved);
        assert.deepEqual(saved.closureRecovery, debt);
        assert.deepEqual(saved.dispatch, operation.dispatch);
        assert.deepEqual(saved.output, operation.output);
        assert.equal(saved.effectId, operation.effectId);
        assert.equal(saved.proofs.some(proof => proof.kind === "terminal_truth" || proof.kind === "containment"), false);
      }
      assert.equal(calls.queries, 2, "duplicate submission must exercise closure recovery");
      assert.equal(calls.dispatch, 0, "fresh recovery must never redispatch");
      } finally {await recoveryPool.end();}
    }};
}
