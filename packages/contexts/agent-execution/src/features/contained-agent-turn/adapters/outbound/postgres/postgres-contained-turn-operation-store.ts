/* oxlint-disable max-lines -- this adapter is the single durable owner-store surface. */

import type { Pool } from "pg";

import type {
  ContainedTurnKernelOperationStore,
  ContainedTurnOwnerStoreAuthority,
} from "../../../application/ports/outbound/contained-turn-ports.js";
import {
  containedTurnCancellationFingerprint,
  containedTurnProviderAccessSnapshotDigest,
  containedTurnScopeDigest,
} from "../../../domain/contained-turn-authority.js";
import { digestContainedTurnCanonicalValue } from "../../../domain/contained-turn-codecs.js";
import {
  claimContainedTurnDispatchPreparation,
  bindContainedTurnPreparationGrantRequests,
  recordContainedTurnPreparationCleanup,
  retireContainedTurnDispatchPreparation,
  type ContainedTurnDispatchPreparation,
} from "../../../domain/contained-turn-dispatch-preparation.js";
import { validateContainedTurnConsumedGrantReceipts } from "../../../domain/contained-turn-dispatch-authority.js";
import { containedTurnIdentity } from "../../../domain/contained-turn-identities.js";
import type { ContainedTurnEvidenceId } from "../../../domain/contained-turn-identities.js";
import type { ContainedTurnKernelOperation } from "../../../domain/contained-turn-kernel-model.js";
import { appendContainedTurnOutputForOwnerStore } from "../../../domain/contained-turn-output-transitions.js";
import type { ContainedTurnProof } from "../../../domain/contained-turn-proofs.js";
import { containedTurnSatisfactionDigest } from "../../../domain/contained-turn-satisfaction.js";
import { mutateContainedTurnOperation } from "../../../domain/contained-turn-transitions.js";
import { containedTurnPreparationToken } from "../../../application/contained-turn-preparation-cleanup.js";
import { validateContainedTurnOperation } from "../../../domain/contained-turn-validation.js";
import {
  CONTAINED_TURN_PREPARATION_CODEC_VERSION,
  decodeContainedTurnPreparation,
  encodeContainedTurnPreparation,
} from "./contained-turn-preparation-codec.js";
import { ContainedTurnPostgresOperationRepository } from "./contained-turn-postgres-operation-repository.js";
import {
  ContainedTurnPostgresTransactions,
  PostgresCommitIndeterminateError,
  type ContainedTurnPostgresTimeouts,
} from "./contained-turn-postgres-transactions.js";
import { encodeContainedTurnState } from "./contained-turn-state-codec.js";
export { applyContainedTurnPostgresSchema } from "./contained-turn-postgres-schema.js";
export {
  CONTAINED_TURN_POSTGRES_TIMEOUT_DEFAULTS,
  type ContainedTurnPostgresTimeouts,
} from "./contained-turn-postgres-transactions.js";

interface PreparationRow {
  readonly state: unknown;
  readonly state_codec_version: number;
  readonly state_digest: string | null;
}

interface PreparationRecoveryRow extends PreparationRow {
  readonly operation_id: string;
}

export interface ContainedTurnPostgresIdentitySource {
  nextId(kind: "attempt" | "cancellation_command" | "cleanup" | "custody" | "effect" |
    "execution_generation" | "operation" | "operation_authority" | "proof" | "start_authority" |
    "writer_fence", seed?: string): string;
}

export interface PostgresContainedTurnOperationStoreOptions {
  readonly identities?: ContainedTurnPostgresIdentitySource;
  readonly pool: Pool;
  readonly timeouts?: Partial<ContainedTurnPostgresTimeouts>;
}

const defaultIdentities: ContainedTurnPostgresIdentitySource = Object.freeze({
  nextId(
    kind: Parameters<ContainedTurnPostgresIdentitySource["nextId"]>[0],
    seed = kind,
  ) {
    return `${kind.replaceAll("_", "-")}:${digestContainedTurnCanonicalValue({ kind, seed })}`;
  },
});

const sameScope = (authority: ContainedTurnOwnerStoreAuthority, operation: ContainedTurnKernelOperation): boolean =>
  authority.operationId === operation.operationId && authority.commandId === operation.commandId &&
  authority.effectId === operation.effectId && authority.scope.projectId === operation.scope.projectId &&
  authority.scope.tenantId === operation.scope.tenantId;

const assertAuthority = (authority: ContainedTurnOwnerStoreAuthority, operation: ContainedTurnKernelOperation): void => {
  if (!sameScope(authority, operation)) {throw new TypeError("PostgreSQL owner-store authority mismatch");}
};

const operationBinding = (operation: ContainedTurnKernelOperation) => Object.freeze({
  authorityVectorDigest: operation.acceptedAuthorityVectorDigest,
  operationId: operation.operationId,
});

const attemptBinding = (operation: ContainedTurnKernelOperation) => {
  if (operation.dispatch.kind !== "claimed") {throw new TypeError("attempt proof requires the durable claim");}
  return Object.freeze({
    ...operationBinding(operation),
    attemptId: operation.dispatch.attemptId,
    effectId: operation.effectId,
  });
};


export class PostgresContainedTurnOperationStore implements ContainedTurnKernelOperationStore {
  readonly #identities: ContainedTurnPostgresIdentitySource;
  readonly #operations = new ContainedTurnPostgresOperationRepository();
  readonly #transactions: ContainedTurnPostgresTransactions;

  public constructor(options: PostgresContainedTurnOperationStoreOptions) {
    this.#identities = options.identities ?? defaultIdentities;
    this.#transactions = new ContainedTurnPostgresTransactions(options.pool, options.timeouts);
  }

  async #transaction<Result>(work: (client: import("pg").PoolClient) => Promise<Result>): Promise<Result> {
    return this.#transactions.write(work);
  }

  async #readTransaction<Result>(work: (client: import("pg").PoolClient) => Promise<Result>): Promise<Result> {
    return this.#transactions.read(work);
  }

  async #load(
    client: import("pg").PoolClient,
    operationId: string,
    lock = false,
    scope?: import("../../../domain/contained-turn-authority.js").ContainedTurnScope,
  ): Promise<ContainedTurnKernelOperation | undefined> {
    return this.#operations.load(client, operationId, lock, scope);
  }

  async #project(
    client: import("pg").PoolClient,
    previous: ContainedTurnKernelOperation | undefined,
    next: ContainedTurnKernelOperation,
  ): Promise<void> {
    return this.#operations.project(client, previous, next);
  }

  async #persist(
    client: import("pg").PoolClient,
    previous: ContainedTurnKernelOperation,
    next: ContainedTurnKernelOperation,
  ): Promise<void> {
    validateContainedTurnOperation(next, { previous });
    return this.#operations.persist(client, previous, next);
  }

  async #reconcileIndeterminateCommit(
    authority: ContainedTurnOwnerStoreAuthority,
    candidate: ContainedTurnKernelOperation,
    evidenceId: ContainedTurnEvidenceId,
  ) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await this.#transaction(async client => {
          const current = await this.#load(client, authority.operationId, true, authority.scope);
          if (current === undefined) {return { kind: "not_found" as const };}
          assertAuthority(authority, current);
          const observedDigest = encodeContainedTurnState(current).digest;
          const candidateDigest = encodeContainedTurnState(candidate).digest;
          if (current.revision === candidate.revision && observedDigest === candidateDigest) {
            return { kind: "applied" as const, operation: current };
          }
          if (current.reconciliation.kind === "required" &&
              current.reconciliation.evidenceIds.includes(evidenceId)) {
            return { debtOperation: current, evidenceId, kind: "indeterminate" as const };
          }
          if (current.terminal.kind === "final") {
            return { current, kind: "stale" as const };
          }
          const debtOperation = mutateContainedTurnOperation(current, {
            evidenceId,
            kind: "record_reconciliation_debt",
            source: "store_commit",
          });
          await this.#persist(client, current, debtOperation);
          return { debtOperation, evidenceId, kind: "indeterminate" as const };
        });
      } catch (error) {
        if (!(error instanceof PostgresCommitIndeterminateError)) {throw error;}
        const observed = await this.read({
          operationId: authority.operationId,
          scope: authority.scope,
        });
        if (observed?.reconciliation.kind === "required" &&
            observed.reconciliation.evidenceIds.includes(evidenceId)) {
          return { debtOperation: observed, evidenceId, kind: "indeterminate" as const };
        }
      }
    }
    throw new Error("PostgreSQL reconciliation-debt commit remained indeterminate");
  }

  async #cas(input: Parameters<ContainedTurnKernelOperationStore["commit"]>[0]) {
    try {
      return await this.#transaction(async client => {
        const current = await this.#load(
          client, input.authority.operationId, true, input.authority.scope,
        );
        if (current === undefined) {return { kind: "not_found" as const };}
        assertAuthority(input.authority, current);
        if (current.revision !== input.expectedRevision) {return { current, kind: "stale" as const };}
        await this.#persist(client, current, input.candidate);
        return { kind: "applied" as const, operation: input.candidate };
      });
    } catch (error) {
      if (!(error instanceof PostgresCommitIndeterminateError)) {throw error;}
      const evidenceId = containedTurnIdentity(
        "evidence", `evidence:postgres-store-commit:${digestContainedTurnCanonicalValue({
          candidateRevision: input.candidate.revision,
          operationId: input.authority.operationId,
          stateDigest: encodeContainedTurnState(input.candidate).digest,
        })}`,
      );
      return this.#reconcileIndeterminateCommit(input.authority, input.candidate, evidenceId);
    }
  }

  public async identifyAcceptance(input: Parameters<ContainedTurnKernelOperationStore["identifyAcceptance"]>[0]) {
    return this.#readTransaction(async client => {
      const result = await client.query<{ operation_id: string }>(
        "SELECT operation_id FROM agent_execution.contained_turn_operation_v1 WHERE tenant_id=$1 AND project_id=$2 AND command_id=$3",
        [input.scope.tenantId, input.scope.projectId, input.commandId],
      );
      const operationId = result.rows[0]?.operation_id;
      if (operationId !== undefined) {
        const operation = await this.#load(client, operationId, false, input.scope);
        if (operation === undefined) {return { kind: "not_found" as const };}
        return operation.commandFingerprint === input.commandFingerprint
          ? { kind: "replayed" as const, operation }
          : { kind: "fingerprint_conflict" as const };
      }
      const seed = digestContainedTurnCanonicalValue({
        commandFingerprint: input.commandFingerprint,
        commandId: input.commandId,
        projectId: input.scope.projectId,
        tenantId: input.scope.tenantId,
      });
      return {
        acceptanceProofId: containedTurnIdentity("proof", this.#identities.nextId("proof", `acceptance:${seed}`)),
        effectId: containedTurnIdentity("effect", this.#identities.nextId("effect", `acceptance:${seed}`)),
        kind: "available" as const,
        operationAuthorityRevision: this.#identities.nextId("operation_authority", `acceptance:${seed}`),
        operationId: containedTurnIdentity("operation", this.#identities.nextId("operation", `acceptance:${seed}`)),
      };
    });
  }

  public async accept(candidate: ContainedTurnKernelOperation, authority: ContainedTurnOwnerStoreAuthority) {
    assertAuthority(authority, candidate);
    return this.#transaction(async client => {
      const encoded = encodeContainedTurnState(candidate);
      const inserted = await client.query(
        `INSERT INTO agent_execution.contained_turn_operation_v1(operation_id,tenant_id,project_id,command_id,command_fingerprint,effect_id,revision,state,state_codec_version,state_digest,terminal)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,false)
         ON CONFLICT (tenant_id,project_id,command_id) DO NOTHING RETURNING operation_id`,
        [candidate.operationId, candidate.scope.tenantId, candidate.scope.projectId,
          candidate.commandId, candidate.commandFingerprint, candidate.effectId, candidate.revision,
          encoded.json, encoded.codecVersion, encoded.digest],
      );
      if (inserted.rowCount === 1) {
        await this.#project(client, undefined, candidate);
        return { kind: "accepted" as const, operation: candidate };
      }
      const existing = await client.query<{ operation_id: string }>(
        "SELECT operation_id FROM agent_execution.contained_turn_operation_v1 WHERE tenant_id=$1 AND project_id=$2 AND command_id=$3 FOR UPDATE",
        [candidate.scope.tenantId, candidate.scope.projectId, candidate.commandId],
      );
      const operationId = existing.rows[0]?.operation_id;
      if (operationId === undefined) {return { kind: "not_found" as const };}
      const operation = await this.#load(client, operationId, false, candidate.scope);
      if (operation === undefined) {return { kind: "not_found" as const };}
      return operation.commandFingerprint === candidate.commandFingerprint
        ? { kind: "replayed" as const, operation }
        : { kind: "fingerprint_conflict" as const };
    });
  }

  public commit(input: Parameters<ContainedTurnKernelOperationStore["commit"]>[0]) {return this.#cas(input);}
  public requestCancellation(input: Parameters<ContainedTurnKernelOperationStore["requestCancellation"]>[0]) {return this.#cas(input);}

  public async appendOutput(input: Parameters<ContainedTurnKernelOperationStore["appendOutput"]>[0]) {
    let candidate: ContainedTurnKernelOperation | undefined;
    try {
      return await this.#transaction(async client => {
        const current = await this.#load(
          client, input.authority.operationId, true, input.authority.scope,
        );
        if (current === undefined) {return { kind: "not_found" as const };}
        assertAuthority(input.authority, current);
        if (current.revision !== input.expectedRevision) {return { current, kind: "stale" as const };}
        if (current.output.chunks.length !== input.expectedCursor) {return { current, kind: "stale" as const };}
        candidate = appendContainedTurnOutputForOwnerStore(current, input.output);
        await this.#persist(client, current, candidate);
        return { kind: "applied" as const, operation: candidate };
      });
    } catch (error) {
      if (!(error instanceof PostgresCommitIndeterminateError) || candidate === undefined) {throw error;}
      const evidenceId = containedTurnIdentity(
        "evidence", `evidence:postgres-output-commit:${digestContainedTurnCanonicalValue({
          candidateRevision: candidate.revision,
          operationId: input.authority.operationId,
          stateDigest: encodeContainedTurnState(candidate).digest,
        })}`,
      );
      return this.#reconcileIndeterminateCommit(input.authority, candidate, evidenceId);
    }
  }

  public async read(input: Parameters<ContainedTurnKernelOperationStore["read"]>[0]) {
    return this.#readTransaction(client =>
      this.#load(client, input.operationId, false, input.scope));
  }

  public async rebuildProjections(
    input: Parameters<ContainedTurnKernelOperationStore["read"]>[0],
  ): Promise<ContainedTurnKernelOperation | undefined> {
    return this.#transaction(client => this.#operations.rebuildProjections(client, input));
  }

  public async listDispatchPreparations(
    input: Parameters<NonNullable<ContainedTurnKernelOperationStore["listDispatchPreparations"]>>[0],
  ): ReturnType<NonNullable<ContainedTurnKernelOperationStore["listDispatchPreparations"]>> {
    const limit = input.limit ?? 100;
    const kinds = input.kinds ?? ["active", "cleanup_pending"] as const;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000 ||
        kinds.length === 0 || kinds.some(kind => kind !== "active" && kind !== "cleanup_pending")) {
      throw new TypeError("invalid dispatch preparation recovery query");
    }
    return this.#readTransaction(async client => {
      const rows = await client.query<PreparationRecoveryRow>(
        `SELECT p.operation_id,p.state,p.state_codec_version,p.state_digest
           FROM agent_execution.contained_turn_dispatch_preparation_v1 AS p
           JOIN agent_execution.contained_turn_operation_v1 AS o
             ON o.operation_id = p.operation_id
          WHERE o.tenant_id = $1 AND o.project_id = $2
            AND (((p.state_codec_version = $4 AND p.state #>> '{payload,kind}') = ANY($3::text[]))
                 OR ((p.state_codec_version = 1 AND p.state #>> '{kind}') = ANY($3::text[]))
                 OR p.state_codec_version NOT IN (1, $4))
          ORDER BY p.operation_id,p.preparation_token
          LIMIT $5`,
        [input.scope.tenantId, input.scope.projectId, kinds,
          CONTAINED_TURN_PREPARATION_CODEC_VERSION, limit],
      );
      const recoveries = [];
      for (const row of rows.rows) {
        const preparation = decodeContainedTurnPreparation(
          row.state, row.state_digest, row.state_codec_version,
        );
        if (preparation.kind !== "active" && preparation.kind !== "cleanup_pending") {continue;}
        const operation = await this.#load(client, row.operation_id, false, input.scope);
        if (operation === undefined) {
          throw new Error("dispatch preparation recovery operation disappeared");
        }
        recoveries.push(Object.freeze({ operation, preparation }));
      }
      return Object.freeze(recoveries);
    });
  }

  public async prepareDispatch(input: Parameters<ContainedTurnKernelOperationStore["prepareDispatch"]>[0]) {
    assertAuthority(input.authority, input.operation);
    const workspaceId = input.operation.workspaceId;
    if (workspaceId === undefined) {throw new TypeError("dispatch preparation requires workspace custody");}
    return this.#transaction(async client => {
      const current = await this.#load(client, input.authority.operationId, true, input.authority.scope);
      if (current === undefined || current.revision !== input.operation.revision) {
        throw new Error("dispatch preparation lost its operation revision fence");
      }
      assertAuthority(input.authority, current);
      const ordinalResult = await client.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM agent_execution.contained_turn_dispatch_preparation_v1 WHERE operation_id=$1",
        [input.operation.operationId],
      );
      const ordinal = Number(ordinalResult.rows[0]?.count ?? "0");
      if (!Number.isSafeInteger(ordinal) || ordinal < 0) {
        throw new Error("dispatch preparation identity ordinal is invalid");
      }
      const seed = digestContainedTurnCanonicalValue({
        operationId: input.operation.operationId,
        operationRevision: input.operation.revision,
        ordinal,
      });
      const attemptId = containedTurnIdentity("attempt", this.#identities.nextId("attempt", `preparation:${seed}:attempt`));
      const custodyId = containedTurnIdentity("custody", this.#identities.nextId("custody", `preparation:${seed}:custody`));
      const preparationToken = containedTurnPreparationToken({ attemptId, custodyId, operationId: input.operation.operationId });
      const preparation: ContainedTurnDispatchPreparation = Object.freeze({
        attemptId, custodyId, kind: "active", operationCutoffRevision: input.operation.operationCutoff.revision,
        operationId: input.operation.operationId, preparationToken, preparedOperationRevision: input.operation.revision,
        providerAccessGrantRequestId: null,
        runtimeSecurityGrantRequestId: null,
        workspaceId,
      });
      const encoded = encodeContainedTurnPreparation(preparation);
      const inserted = await client.query(
        `INSERT INTO agent_execution.contained_turn_dispatch_preparation_v1
           (operation_id,preparation_token,state_codec_version,state,state_digest)
         VALUES ($1,$2,$3,$4::jsonb,$5) ON CONFLICT DO NOTHING`,
        [input.operation.operationId, preparationToken, encoded.codecVersion, encoded.json, encoded.digest],
      );
      if (inserted.rowCount !== 1) {
        throw new Error("dispatch preparation identity collision");
      }
      return Object.freeze({
        attemptId,
        claimProofId: containedTurnIdentity("proof", this.#identities.nextId("proof", `preparation:${seed}:claim`)),
        custodyId,
        cutoffProofId: containedTurnIdentity("proof", this.#identities.nextId("proof", `preparation:${seed}:cutoff`)),
        executionGenerationId: containedTurnIdentity("execution_generation", this.#identities.nextId("execution_generation", `preparation:${seed}:generation`)),
        writerFence: containedTurnIdentity("writer_fence", this.#identities.nextId("writer_fence", `preparation:${seed}:writer`)),
      });
    });
  }

  public async claimPreparedDispatch(input: Parameters<ContainedTurnKernelOperationStore["claimPreparedDispatch"]>[0]) {
    const consumedReceipts = validateContainedTurnConsumedGrantReceipts(
      input.subject, input.consumedGrantReceipts,
    );
    const claimSeed = digestContainedTurnCanonicalValue({
      attemptId: input.subject.attemptId,
      operationId: input.subject.operationId,
      preparationToken: input.subject.preparationToken,
    });
    const startAuthority = this.#identities.nextId("start_authority", `claim:${claimSeed}`);
    return this.#transaction(async client => {
      const current = await this.#load(
        client, input.authority.operationId, true, input.authority.scope,
      );
      if (current === undefined) {return { kind: "not_found" as const };}
      assertAuthority(input.authority, current);
      if (current.dispatch.kind === "claimed" && current.dispatch.preparationToken === input.subject.preparationToken) {
        return { kind: "observed_claim" as const, operation: current };
      }
      const row = await client.query<PreparationRow>(
        "SELECT state,state_codec_version,state_digest FROM agent_execution.contained_turn_dispatch_preparation_v1 WHERE operation_id=$1 AND preparation_token=$2 FOR UPDATE",
        [current.operationId, input.subject.preparationToken],
      );
      const persisted = row.rows[0];
      const preparation = persisted === undefined ? undefined : decodeContainedTurnPreparation(
        persisted.state, persisted.state_digest, persisted.state_codec_version,
      );
      if (preparation === undefined || preparation.kind !== "active") {return { current, kind: "stale" as const };}
      if (preparation.operationId !== current.operationId ||
          preparation.operationId !== input.subject.operationId ||
          preparation.preparationToken !== input.subject.preparationToken ||
          preparation.attemptId !== input.subject.attemptId ||
          preparation.custodyId !== input.subject.custodyId ||
          preparation.workspaceId !== current.workspaceId ||
          preparation.workspaceId !== input.subject.workspaceId ||
          preparation.operationCutoffRevision !== input.subject.operationCutoffRevision ||
          preparation.preparedOperationRevision !== input.expectedOperationRevision ||
          current.effectId !== input.subject.effectId ||
          containedTurnScopeDigest(current.scope) !== input.subject.scopeDigest) {
        return { current, kind: "stale" as const };
      }
      const providerAccessReceipt = consumedReceipts[0];
      const runtimeSecurityReceipt = consumedReceipts[1];
      const bound = bindContainedTurnPreparationGrantRequests(preparation, {
        providerAccessGrantRequestId: providerAccessReceipt.grantRequestId,
        runtimeSecurityGrantRequestId: runtimeSecurityReceipt.grantRequestId,
      });
      const encodedBound = encodeContainedTurnPreparation(bound);
      await client.query(
        "UPDATE agent_execution.contained_turn_dispatch_preparation_v1 SET state=$3::jsonb,state_codec_version=$4,state_digest=$5 WHERE operation_id=$1 AND preparation_token=$2",
        [current.operationId, input.subject.preparationToken, encodedBound.json,
          encodedBound.codecVersion, encodedBound.digest],
      );
      if (current.revision !== input.expectedOperationRevision) {return { current, kind: "stale" as const };}
      const providerAccessProof: Extract<ContainedTurnProof, { kind: "provider_access_dispatch" }> = {
        binding: { ...operationBinding(current), acceptedSnapshotDigest: containedTurnProviderAccessSnapshotDigest(current.providerAccessSnapshot), resolutionDigest: providerAccessReceipt.ownerReceiptDigest },
        kind: "provider_access_dispatch", proofId: containedTurnIdentity("proof", `proof:provider-access-grant:${providerAccessReceipt.ownerReceiptDigest}`),
      };
      const runtimeSecurityProof: Extract<ContainedTurnProof, { kind: "runtime_security_dispatch" }> = {
        binding: { ...operationBinding(current), acceptedSecurityDecisionDigest: current.acceptedAuthorityVector.securityDecisionDigest, currentSecurityDecisionDigest: runtimeSecurityReceipt.ownerReceiptDigest, securityAuthorityRevision: current.acceptedAuthorityVector.securityAuthorityRevision },
        kind: "runtime_security_dispatch", proofId: containedTurnIdentity("proof", `proof:runtime-security-grant:${runtimeSecurityReceipt.ownerReceiptDigest}`),
      };
      const claimProof: Extract<ContainedTurnProof, { kind: "dispatch_claim" }> = {
        binding: { ...operationBinding(current), attemptId: input.subject.attemptId, effectId: current.effectId, preparationToken: input.subject.preparationToken, providerAccessDispatchProofId: providerAccessProof.proofId, runtimeSecurityDispatchProofId: runtimeSecurityProof.proofId },
        kind: "dispatch_claim", proofId: containedTurnIdentity("proof", this.#identities.nextId("proof", `claim:${claimSeed}:dispatch`)),
      };
      const next = mutateContainedTurnOperation(current, {
        attemptId: input.subject.attemptId, claimProof, custodyId: input.subject.custodyId,
        cutoffProof: { binding: operationBinding(current), kind: "cutoff", proofId: containedTurnIdentity("proof", this.#identities.nextId("proof", `claim:${claimSeed}:cutoff`)) },
        executionGenerationId: input.subject.executionGenerationId, hostBootId: input.subject.hostBootId,
        hostCustodyProof: input.hostCustodyProof, hostInstanceId: input.subject.hostInstanceId, kind: "claim_dispatch",
        preparationToken: input.subject.preparationToken, providerAccessDispatchProof: providerAccessProof,
        runtimeSecurityDispatchProof: runtimeSecurityProof, writerFence: containedTurnIdentity("writer_fence", this.#identities.nextId("writer_fence", `claim:${claimSeed}:writer`)),
      });
      await this.#persist(client, current, next);
      const claimed = encodeContainedTurnPreparation(claimContainedTurnDispatchPreparation(bound));
      await client.query(
        "UPDATE agent_execution.contained_turn_dispatch_preparation_v1 SET state=$3::jsonb,state_codec_version=$4,state_digest=$5 WHERE operation_id=$1 AND preparation_token=$2",
        [current.operationId, input.subject.preparationToken, claimed.json,
          claimed.codecVersion, claimed.digest],
      );
      return { kind: "claimed" as const, operation: next, startAuthority };
    });
  }

  public async retireDispatchPreparation(
    input: Parameters<ContainedTurnKernelOperationStore["retireDispatchPreparation"]>[0],
  ): ReturnType<ContainedTurnKernelOperationStore["retireDispatchPreparation"]> {
    return this.#transaction(async client => {
      const current = await this.#load(client, input.authority.operationId, true, input.authority.scope);
      if (current === undefined) {return { evidenceId: containedTurnIdentity("evidence", `evidence:postgres-retire-missing:${digestContainedTurnCanonicalValue({ operationId: input.authority.operationId, preparationToken: input.preparationToken })}`), kind: "indeterminate" as const };}
      assertAuthority(input.authority, current);
      if (current.dispatch.kind === "claimed" && current.dispatch.preparationToken === input.preparationToken) {return { kind: "claimed" as const, operation: current };}
      const row = await client.query<PreparationRow>(
        "SELECT state,state_codec_version,state_digest FROM agent_execution.contained_turn_dispatch_preparation_v1 WHERE operation_id=$1 AND preparation_token=$2 FOR UPDATE",
        [current.operationId, input.preparationToken],
      );
      const persisted = row.rows[0];
      const preparation = persisted === undefined ? undefined : decodeContainedTurnPreparation(
        persisted.state, persisted.state_digest, persisted.state_codec_version,
      );
      if (preparation === undefined) {return { current, kind: "stale" as const };}
      if (preparation.kind === "claimed") {return { current, kind: "stale" as const };}
      if (preparation.operationId !== current.operationId ||
          preparation.workspaceId !== current.workspaceId ||
          preparation.operationCutoffRevision !== current.operationCutoff.revision ||
          preparation.preparedOperationRevision !== input.expectedOperationRevision ||
          preparation.operationCutoffRevision !== input.expectedOperationCutoffRevision) {
        return { current, kind: "stale" as const };
      }
      const retired = retireContainedTurnDispatchPreparation(
        preparation,
        this.#identities.nextId("cleanup", `retirement:${digestContainedTurnCanonicalValue({
          operationId: current.operationId,
          preparationToken: input.preparationToken,
          reason: input.reason,
        })}`),
        input.consumedGrantRequestIds,
      );
      const encoded = encodeContainedTurnPreparation(retired);
      await client.query(
        "UPDATE agent_execution.contained_turn_dispatch_preparation_v1 SET state=$3::jsonb,state_codec_version=$4,state_digest=$5 WHERE operation_id=$1 AND preparation_token=$2",
        [current.operationId, input.preparationToken, encoded.json, encoded.codecVersion, encoded.digest],
      );
      return retired.kind === "cleanup_pending" ? { kind: "retired" as const, preparation: retired } : { current, kind: "stale" as const };
    });
  }

  public async recordDispatchPreparationCleanup(input: Parameters<ContainedTurnKernelOperationStore["recordDispatchPreparationCleanup"]>[0]) {
    return this.#transaction(async client => {
      const current = await this.#load(client, input.authority.operationId, true, input.authority.scope);
      if (current === undefined) {throw new Error("cleanup operation disappeared");}
      assertAuthority(input.authority, current);
      const row = await client.query<PreparationRow>(
        "SELECT state,state_codec_version,state_digest FROM agent_execution.contained_turn_dispatch_preparation_v1 WHERE operation_id=$1 AND preparation_token=$2 FOR UPDATE",
        [current.operationId, input.permit.preparationToken],
      );
      const persisted = row.rows[0];
      if (persisted === undefined) {throw new Error("cleanup preparation disappeared");}
      const next = recordContainedTurnPreparationCleanup(decodeContainedTurnPreparation(
        persisted.state, persisted.state_digest, persisted.state_codec_version,
      ), input);
      const encoded = encodeContainedTurnPreparation(next);
      await client.query("UPDATE agent_execution.contained_turn_dispatch_preparation_v1 SET state=$3::jsonb,state_codec_version=$4,state_digest=$5 WHERE operation_id=$1 AND preparation_token=$2", [current.operationId, input.permit.preparationToken, encoded.json, encoded.codecVersion, encoded.digest]);
      return next;
    });
  }

  public async prepareCancellation(input: Parameters<ContainedTurnKernelOperationStore["prepareCancellation"]>[0]) {
    assertAuthority(input.authority, input.operation);
    const cancellationSeed = digestContainedTurnCanonicalValue({
      operationId: input.operation.operationId,
      revision: input.operation.revision,
      scopeDigest: input.operation.acceptedAuthorityVector.scopeDigest,
    });
    const cancellationCommandId = containedTurnIdentity("cancellation_command", this.#identities.nextId("cancellation_command", `cancellation:${cancellationSeed}:command`));
    const fingerprint = containedTurnCancellationFingerprint({ cancellationCommandId, operationId: input.operation.operationId, scopeDigest: input.operation.acceptedAuthorityVector.scopeDigest });
    return Object.freeze({
      command: Object.freeze({ cancellationCommandId, fingerprint, operationId: input.operation.operationId, scopeDigest: input.operation.acceptedAuthorityVector.scopeDigest }),
      cutoffProof: Object.freeze({ binding: { ...operationBinding(input.operation), cancellationCommandId }, kind: "cutoff" as const, proofId: containedTurnIdentity("proof", this.#identities.nextId("proof", `cancellation:${cancellationSeed}:cutoff`)) }),
      preventionProofId: containedTurnIdentity("proof", this.#identities.nextId("proof", `cancellation:${cancellationSeed}:prevention`)),
      proof: Object.freeze({ binding: { ...operationBinding(input.operation), cancellationCommandId, cancellationFingerprint: fingerprint }, kind: "cancellation" as const, proofId: containedTurnIdentity("proof", this.#identities.nextId("proof", `cancellation:${cancellationSeed}:command`)) }),
    });
  }

  public async proofsForAcceptedEffect(input: Parameters<ContainedTurnKernelOperationStore["proofsForAcceptedEffect"]>[0]) {
    assertAuthority(input.authority, input.operation);
    const binding = attemptBinding(input.operation);
    const seed = digestContainedTurnCanonicalValue({
      attemptId: binding.attemptId,
      operationId: input.operation.operationId,
      revision: input.operation.revision,
    });
    return Object.freeze({
      acceptanceProof: { binding: { ...binding, disposition: "accepted" as const }, kind: "provider_acceptance" as const, proofId: containedTurnIdentity("proof", this.#identities.nextId("proof", `effect:${seed}:acceptance`)) },
      effectProof: { binding: { ...binding, disposition: "committed" as const }, kind: "effect_resolution" as const, proofId: containedTurnIdentity("proof", this.#identities.nextId("proof", `effect:${seed}:resolution`)) },
      kind: "proved" as const,
    });
  }

  public async proofsForProcessNoStart(input: Parameters<ContainedTurnKernelOperationStore["proofsForProcessNoStart"]>[0]) {
    assertAuthority(input.authority, input.operation);
    const binding = operationBinding(input.operation);
    const seed = digestContainedTurnCanonicalValue({ operationId: input.operation.operationId, revision: input.operation.revision });
    const proof = (role: string) => containedTurnIdentity("proof", this.#identities.nextId("proof", `no-start:${seed}:${role}`));
    return Object.freeze({
      containmentProof: { binding: { ...binding, effectId: input.operation.effectId }, kind: "containment_not_required" as const, proofId: proof("containment") },
      effectProof: { binding: { ...binding, disposition: "not_committed" as const, effectId: input.operation.effectId }, kind: "effect_no_start" as const, proofId: proof("effect") },
      executionProof: { binding: { ...binding, effectId: input.operation.effectId }, kind: "no_start" as const, proofId: proof("execution") },
      outputProof: { binding: { ...binding, finalCursor: input.operation.output.chunks.length }, kind: "output_no_start_drain" as const, proofId: proof("output") },
      providerProof: { binding: { ...binding, effectId: input.operation.effectId }, kind: "provider_not_started" as const, proofId: proof("provider") },
    });
  }

  public async proofsForPrevention(input: Parameters<ContainedTurnKernelOperationStore["proofsForPrevention"]>[0]) {
    assertAuthority(input.authority, input.operation);
    const binding = operationBinding(input.operation);
    const seed = digestContainedTurnCanonicalValue({
      operationId: input.operation.operationId,
      preventionProofId: input.preventionProofId,
      revision: input.operation.revision,
    });
    const proof = (role: string) => containedTurnIdentity("proof", this.#identities.nextId("proof", `prevention:${seed}:${role}`));
    return Object.freeze({
      containmentProof: { binding: { ...binding, effectId: input.operation.effectId }, kind: "containment_not_required" as const, proofId: proof("containment") },
      cutoffProof: { binding, kind: "cutoff" as const, proofId: proof("cutoff") },
      effectProof: { binding: { ...binding, disposition: "not_committed" as const, effectId: input.operation.effectId }, kind: "effect_no_start" as const, proofId: proof("effect") },
      executionProof: { binding: { ...binding, effectId: input.operation.effectId }, kind: "no_start" as const, proofId: proof("execution") },
      hostCustodyProof: { binding: { ...binding, effectId: input.operation.effectId }, kind: "host_custody_no_start" as const, proofId: proof("custody") },
      noDispatchProof: { binding: { ...binding, effectId: input.operation.effectId }, kind: "no_dispatch" as const, proofId: input.preventionProofId },
      outputProof: { binding: { ...binding, finalCursor: 0 }, kind: "output_no_start_drain" as const, proofId: proof("output") },
      providerProof: { binding: { ...binding, effectId: input.operation.effectId }, kind: "provider_not_started" as const, proofId: proof("provider") },
    });
  }

  public async terminalProof(input: Parameters<ContainedTurnKernelOperationStore["terminalProof"]>[0]) {
    assertAuthority(input.authority, input.operation);
    if (input.satisfactionDigest !== containedTurnSatisfactionDigest(input.operation) || input.operation.providerExecution.kind !== "closed") {throw new TypeError("terminal proof precondition mismatch");}
    const seed = digestContainedTurnCanonicalValue({
      operationId: input.operation.operationId,
      revision: input.operation.revision,
      satisfactionDigest: input.satisfactionDigest,
    });
    return Object.freeze({
      binding: { ...operationBinding(input.operation), requiredReceiptSetDigest: input.operation.requiredReceiptSetDigest, requiredReceiptSetVersion: input.operation.requiredReceiptSet.setVersion, satisfactionDigest: input.satisfactionDigest, terminalOutcome: input.operation.providerExecution.outcome },
      kind: "terminal_truth" as const,
      proofId: containedTurnIdentity("proof", this.#identities.nextId("proof", `terminal:${seed}`)),
    });
  }
}
