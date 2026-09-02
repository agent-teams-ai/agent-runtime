import type { Pool } from "pg";

import type {
  ContainedTurnKernelOperationStore,
  ContainedTurnOwnerStoreAuthority,
} from "../../../application/ports/outbound/contained-turn-ports.js";
import {
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
import { mutateContainedTurnOperation } from "../../../domain/contained-turn-transitions.js";
import { containedTurnPreparationToken } from "../../../application/contained-turn-preparation-cleanup.js";
import { validateContainedTurnOperation } from "../../../domain/contained-turn-validation.js";
import { decodeContainedTurnPreparation, encodeContainedTurnPreparation } from "./contained-turn-preparation-codec.js";
import {
  CONTAINED_TURN_POSTGRES_JSON_BUDGET,
  ContainedTurnStateBudgetError,
  encodeContainedTurnState,
} from "./contained-turn-state-codec.js";
import { ContainedTurnPostgresOperationRepository } from "./contained-turn-postgres-operation-repository.js";
import { ContainedTurnPostgresPreparationRecovery } from "./contained-turn-postgres-preparation-recovery.js";
import {
  assertContainedTurnPostgresAuthority as assertAuthority,
  type ContainedTurnPostgresIdentitySource,
  containedTurnPostgresOperationBinding as operationBinding,
  defaultContainedTurnPostgresIdentities,
} from "./contained-turn-postgres-operation-authority.js";
import { ContainedTurnPostgresOperationEvidence } from "./contained-turn-postgres-operation-evidence.js";
import {
  CONTAINED_TURN_POSTGRES_MIGRATIONS,
  CONTAINED_TURN_POSTGRES_MIGRATION_NAMESPACE,
  CONTAINED_TURN_POSTGRES_SCHEMA_VERSION,
} from "./contained-turn-postgres-schema.js";
import {
  ContainedTurnPostgresTransactions,
  PostgresCommitIndeterminateError,
  type ContainedTurnPostgresTimeouts,
} from "./contained-turn-postgres-transactions.js";
export { applyContainedTurnPostgresSchema } from "./contained-turn-postgres-schema.js";
export {
  CONTAINED_TURN_POSTGRES_TIMEOUT_DEFAULTS,
  type ContainedTurnPostgresTimeouts,
} from "./contained-turn-postgres-transactions.js";

interface PreparationRow { readonly state: unknown; readonly state_codec_version: number;
  readonly state_digest: string | null; readonly state_within_budget: boolean; }
const PREPARATION_STATE_SELECTION = `CASE
  WHEN octet_length(state::text) <= ${String(CONTAINED_TURN_POSTGRES_JSON_BUDGET.maximumSerializedBytes)}
  THEN state END AS state,
  octet_length(state::text) <= ${String(CONTAINED_TURN_POSTGRES_JSON_BUDGET.maximumSerializedBytes)}
    AS state_within_budget,state_codec_version,state_digest`;

const decodePreparationRow = (row: PreparationRow): ContainedTurnDispatchPreparation => {
  if (!row.state_within_budget) {throw new ContainedTurnStateBudgetError();}
  return decodeContainedTurnPreparation(row.state, row.state_digest, row.state_codec_version);
};
export type { ContainedTurnPostgresIdentitySource } from "./contained-turn-postgres-operation-authority.js";
export interface PostgresContainedTurnOperationStoreOptions {
  readonly identities?: ContainedTurnPostgresIdentitySource;
  readonly pool: Pool;
  /** Used only for deterministic mixed-version migration tests and staged drains. */
  readonly runtimeSchemaVersion?: 1 | 2 | 3 | 4 | 5;
  readonly timeouts?: Partial<ContainedTurnPostgresTimeouts>;
}

export class PostgresContainedTurnOperationStore implements ContainedTurnKernelOperationStore {
  readonly #evidence: ContainedTurnPostgresOperationEvidence;
  readonly #identities: ContainedTurnPostgresIdentitySource;
  readonly #operations = new ContainedTurnPostgresOperationRepository();
  readonly #preparationRecovery: ContainedTurnPostgresPreparationRecovery;
  readonly #runtimeSchemaVersion: number;
  readonly #transactions: ContainedTurnPostgresTransactions;

  public constructor(options: PostgresContainedTurnOperationStoreOptions) {
    this.#identities = options.identities ?? defaultContainedTurnPostgresIdentities;
    this.#evidence = new ContainedTurnPostgresOperationEvidence(this.#identities);
    const schemaVersion = options.runtimeSchemaVersion ?? CONTAINED_TURN_POSTGRES_SCHEMA_VERSION;
    const migration = CONTAINED_TURN_POSTGRES_MIGRATIONS[schemaVersion - 1];
    if (migration === undefined) {
      throw new RangeError(`unsupported contained turn PostgreSQL runtime schema ${String(schemaVersion)}`);
    }
    this.#runtimeSchemaVersion = schemaVersion;
    this.#transactions = new ContainedTurnPostgresTransactions(options.pool, {
      advisoryLockId: CONTAINED_TURN_POSTGRES_MIGRATION_NAMESPACE.advisoryLockId,
      component: CONTAINED_TURN_POSTGRES_MIGRATION_NAMESPACE.component,
      migrationDigest: migration.digest,
      schemaVersion,
    }, options.timeouts);
    this.#preparationRecovery = new ContainedTurnPostgresPreparationRecovery(
      this.#operations, this.#runtimeSchemaVersion, this.#transactions,
    );
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
        return await this.#transactions.write(async client => {
          const current = await this.#load(client, authority.operationId, true, authority.scope);
          if (current === undefined) {return { kind: "not_found" as const };}
          assertAuthority(authority, current);
          const observedDigest = encodeContainedTurnState(current).digest;
          const candidateDigest = encodeContainedTurnState(candidate).digest;
          const observedCandidate = current.revision === candidate.revision &&
            observedDigest === candidateDigest;
          if (current.reconciliation.kind === "required" &&
              current.reconciliation.evidenceIds.includes(evidenceId)) {
            return { debtOperation: current, evidenceId, kind: "indeterminate" as const };
          }
          if (current.terminal.kind === "final") {
            return observedCandidate
              ? { kind: "applied" as const, operation: current }
              : { current, kind: "stale" as const };
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
      return await this.#transactions.write(async client => {
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
    return this.#transactions.read(async client => {
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
    return this.#transactions.write(async client => {
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
      return await this.#transactions.write(async client => {
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
    return this.#transactions.read(client =>
      this.#load(client, input.operationId, false, input.scope));
  }

  public async rebuildProjections(
    input: Parameters<ContainedTurnKernelOperationStore["read"]>[0],
  ): Promise<ContainedTurnKernelOperation | undefined> {
    return this.#transactions.write(client => this.#operations.rebuildProjections(client, input));
  }

  public async listDispatchPreparations(
    input: Parameters<NonNullable<ContainedTurnKernelOperationStore["listDispatchPreparations"]>>[0],
  ): ReturnType<NonNullable<ContainedTurnKernelOperationStore["listDispatchPreparations"]>> {
    return this.#preparationRecovery.list(input);
  }

  public async prepareDispatch(input: Parameters<ContainedTurnKernelOperationStore["prepareDispatch"]>[0]) {
    assertAuthority(input.authority, input.operation);
    const workspaceId = input.operation.workspaceId;
    if (workspaceId === undefined) {throw new TypeError("dispatch preparation requires workspace custody");}
    return this.#transactions.write(async client => {
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
    return this.#transactions.write(async client => {
      const current = await this.#load(
        client, input.authority.operationId, true, input.authority.scope,
      );
      if (current === undefined) {return { kind: "not_found" as const };}
      assertAuthority(input.authority, current);
      if (current.dispatch.kind === "claimed" && current.dispatch.preparationToken === input.subject.preparationToken) {
        return { kind: "observed_claim" as const, operation: current };
      }
      const row = await client.query<PreparationRow>(
        `SELECT ${PREPARATION_STATE_SELECTION} FROM agent_execution.contained_turn_dispatch_preparation_v1 WHERE operation_id=$1 AND preparation_token=$2 FOR UPDATE`,
        [current.operationId, input.subject.preparationToken],
      );
      const persisted = row.rows[0];
      const preparation = persisted === undefined ? undefined : decodePreparationRow(persisted);
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
        providerAccessConsumptionReceipt: providerAccessReceipt,
        providerAccessGrantRequestId: providerAccessReceipt.grantRequestId,
        runtimeSecurityConsumptionReceipt: runtimeSecurityReceipt,
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
        binding: { ...operationBinding(current), acceptedSnapshotDigest: containedTurnProviderAccessSnapshotDigest(current.providerAccessSnapshot), resolutionDigest: digestContainedTurnCanonicalValue(providerAccessReceipt as never) },
        kind: "provider_access_dispatch", proofId: containedTurnIdentity("proof", `proof:provider-access-grant:${digestContainedTurnCanonicalValue(providerAccessReceipt as never)}`),
      };
      const runtimeSecurityProof: Extract<ContainedTurnProof, { kind: "runtime_security_dispatch" }> = {
        binding: { ...operationBinding(current), acceptedSecurityDecisionDigest: current.acceptedAuthorityVector.securityDecisionDigest, currentSecurityDecisionDigest: digestContainedTurnCanonicalValue(runtimeSecurityReceipt as never), securityAuthorityRevision: current.acceptedAuthorityVector.securityAuthorityRevision },
        kind: "runtime_security_dispatch", proofId: containedTurnIdentity("proof", `proof:runtime-security-grant:${digestContainedTurnCanonicalValue(runtimeSecurityReceipt as never)}`),
      };
      const claimProof: Extract<ContainedTurnProof, { kind: "dispatch_claim" }> = {
        binding: { ...operationBinding(current), attemptId: input.subject.attemptId, effectId: current.effectId, preparationToken: input.subject.preparationToken, providerAccessDispatchProofId: providerAccessProof.proofId, runtimeSecurityDispatchProofId: runtimeSecurityProof.proofId },
        kind: "dispatch_claim", proofId: containedTurnIdentity("proof", this.#identities.nextId("proof", `claim:${claimSeed}:dispatch`)),
      };
      const next = mutateContainedTurnOperation(current, {
        attemptId: input.subject.attemptId, consumedGrantReceipts: consumedReceipts, claimProof, custodyId: input.subject.custodyId,
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
    return this.#transactions.write(async client => {
      const current = await this.#load(client, input.authority.operationId, true, input.authority.scope);
      if (current === undefined) {return { evidenceId: containedTurnIdentity("evidence", `evidence:postgres-retire-missing:${digestContainedTurnCanonicalValue({ operationId: input.authority.operationId, preparationToken: input.preparationToken })}`), kind: "indeterminate" as const };}
      assertAuthority(input.authority, current);
      if (current.dispatch.kind === "claimed" && current.dispatch.preparationToken === input.preparationToken) {return { kind: "claimed" as const, operation: current };}
      const row = await client.query<PreparationRow>(
        `SELECT ${PREPARATION_STATE_SELECTION} FROM agent_execution.contained_turn_dispatch_preparation_v1 WHERE operation_id=$1 AND preparation_token=$2 FOR UPDATE`,
        [current.operationId, input.preparationToken],
      );
      const persisted = row.rows[0];
      const preparation = persisted === undefined ? undefined : decodePreparationRow(persisted);
      if (preparation === undefined) {return { current, kind: "stale" as const };}
      if (preparation.kind === "claimed") {return { current, kind: "stale" as const };}
      if (preparation.operationId !== current.operationId ||
          preparation.preparationToken !== input.preparationToken ||
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
        input.consumptionEvidenceIds,
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
    return this.#transactions.write(async client => {
      const current = await this.#load(client, input.authority.operationId, true, input.authority.scope);
      if (current === undefined) {throw new Error("cleanup operation disappeared");}
      assertAuthority(input.authority, current);
      const row = await client.query<PreparationRow>(
        `SELECT ${PREPARATION_STATE_SELECTION} FROM agent_execution.contained_turn_dispatch_preparation_v1 WHERE operation_id=$1 AND preparation_token=$2 FOR UPDATE`,
        [current.operationId, input.permit.preparationToken],
      );
      const persisted = row.rows[0];
      if (persisted === undefined) {throw new Error("cleanup preparation disappeared");}
      const next = recordContainedTurnPreparationCleanup(decodePreparationRow(persisted), input);
      const encoded = encodeContainedTurnPreparation(next);
      await client.query("UPDATE agent_execution.contained_turn_dispatch_preparation_v1 SET state=$3::jsonb,state_codec_version=$4,state_digest=$5 WHERE operation_id=$1 AND preparation_token=$2", [current.operationId, input.permit.preparationToken, encoded.json, encoded.codecVersion, encoded.digest]);
      return next;
    });
  }

  public async prepareCancellation(input: Parameters<ContainedTurnKernelOperationStore["prepareCancellation"]>[0]) {
    return this.#evidence.prepareCancellation(input);
  }

  public async proofsForAcceptedEffect(input: Parameters<ContainedTurnKernelOperationStore["proofsForAcceptedEffect"]>[0]) {
    return this.#evidence.proofsForAcceptedEffect(input);
  }

  public async proofsForProcessNoStart(input: Parameters<ContainedTurnKernelOperationStore["proofsForProcessNoStart"]>[0]) {
    return this.#evidence.proofsForProcessNoStart(input);
  }

  public async proofsForPrevention(input: Parameters<ContainedTurnKernelOperationStore["proofsForPrevention"]>[0]) {
    return this.#evidence.proofsForPrevention(input);
  }

  public async terminalProof(input: Parameters<ContainedTurnKernelOperationStore["terminalProof"]>[0]) {
    return this.#evidence.terminalProof(input);
  }
}
