import type { Pool } from "pg";

import type {
  ContainedTurnKernelOperationStore,
  ContainedTurnOwnerStoreAuthority,
} from "../../../application/ports/outbound/contained-turn-ports.js";
import { digestContainedTurnCanonicalValue } from "../../../domain/contained-turn-codecs.js";
import { containedTurnIdentity } from "../../../domain/contained-turn-identities.js";
import type { ContainedTurnEvidenceId } from "../../../domain/contained-turn-identities.js";
import type { ContainedTurnKernelOperation } from "../../../domain/contained-turn-kernel-model.js";
import { appendContainedTurnOutputForOwnerStore } from "../../../domain/contained-turn-output-transitions.js";
import { mutateContainedTurnOperation } from "../../../domain/contained-turn-transitions.js";
import { validateContainedTurnOperation } from "../../../domain/contained-turn-validation.js";
import { encodeContainedTurnState } from "./contained-turn-state-codec.js";
import type { ContainedTurnIntentAuthority } from "../../../domain/contained-turn-intent-guard.js";
import { ContainedTurnPostgresIntentStore } from "./contained-turn-postgres-intent-store.js";
import { ContainedTurnPostgresOperationRepository } from "./contained-turn-postgres-operation-repository.js";
import { ContainedTurnPostgresPreparationRecovery } from "./contained-turn-postgres-preparation-recovery.js";
import { ContainedTurnPostgresPreparationStore } from "./contained-turn-postgres-preparation-store.js";
import {
  assertContainedTurnPostgresAuthority as assertAuthority,
  type ContainedTurnPostgresIdentitySource,
  defaultContainedTurnPostgresIdentities,
} from "./contained-turn-postgres-operation-authority.js";
import { ContainedTurnPostgresOperationEvidence } from "./contained-turn-postgres-operation-evidence.js";
import { containedTurnPostgresAcceptanceMatches } from "./contained-turn-postgres-acceptance-reconciliation.js";
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

export type { ContainedTurnPostgresIdentitySource } from "./contained-turn-postgres-operation-authority.js";
export interface PostgresContainedTurnOperationStoreOptions {
  /** Trusted composition only. Omission closes admission and claim pending product seam authority. */
  readonly intentAuthority?: ContainedTurnIntentAuthority;
  readonly identities?: ContainedTurnPostgresIdentitySource;
  readonly pool: Pool;
  /** Used only for deterministic mixed-version migration tests and staged drains. */
  readonly runtimeSchemaVersion?: 1 | 2 | 3 | 4 | 5 | 6 | 7;
  readonly timeouts?: Partial<ContainedTurnPostgresTimeouts>;
}

export class PostgresContainedTurnOperationStore implements ContainedTurnKernelOperationStore {
  readonly #evidence: ContainedTurnPostgresOperationEvidence;
  readonly #identities: ContainedTurnPostgresIdentitySource;
  readonly #intents: ContainedTurnPostgresIntentStore;
  readonly #operations = new ContainedTurnPostgresOperationRepository();
  readonly #preparations: ContainedTurnPostgresPreparationStore;
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
    this.#intents = new ContainedTurnPostgresIntentStore(options.intentAuthority, this.#operations, this.#transactions);
    this.#preparationRecovery = new ContainedTurnPostgresPreparationRecovery(
      this.#operations, this.#runtimeSchemaVersion, this.#transactions,
    );
    this.#preparations = new ContainedTurnPostgresPreparationStore(
      this.#identities, this.#operations, this.#transactions, this.#intents,
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
        if (current.dispatch.kind !== "claimed" && input.candidate.dispatch.kind === "claimed") {
          throw new TypeError("dispatch claim requires the guarded prepared-claim transaction");
        }
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
    return this.#transactions.write(async client => {
      const admission = await this.#intents.admission(client, input);
      if (admission !== "clear") {
        return { kind: admission === "denied" ? "not_found" as const : "fingerprint_conflict" as const };
      }
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
    type AttemptOutcome =
      | { readonly kind: "accepted"; readonly operation: ContainedTurnKernelOperation }
      | { readonly kind: "replayed"; readonly operation: ContainedTurnKernelOperation }
      | { readonly kind: "fingerprint_conflict" }
      | { readonly kind: "not_found" };
    let attempted: AttemptOutcome | undefined;
    try {
      return await this.#transactions.write(async client => {
        const admission = await this.#intents.admission(client, {
          commandId: candidate.commandId, commandFingerprint: candidate.commandFingerprint, scope: authority.scope,
        });
        if (admission !== "clear") {
          attempted = { kind: admission === "denied" ? "not_found" : "fingerprint_conflict" };
          return attempted;
        }
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
          await this.#intents.recordAcceptance(client, candidate);
          await this.#project(client, undefined, candidate);
          attempted = { kind: "accepted", operation: candidate };
          return attempted;
        }
        const existing = await client.query<{ operation_id: string }>(
          "SELECT operation_id FROM agent_execution.contained_turn_operation_v1 WHERE tenant_id=$1 AND project_id=$2 AND command_id=$3 FOR UPDATE",
          [candidate.scope.tenantId, candidate.scope.projectId, candidate.commandId],
        );
        const operationId = existing.rows[0]?.operation_id;
        if (operationId === undefined) {
          attempted = { kind: "not_found" };
          return attempted;
        }
        const operation = await this.#load(client, operationId, false, candidate.scope);
        if (operation === undefined) {
          attempted = { kind: "not_found" };
          return attempted;
        }
        attempted = operation.commandFingerprint === candidate.commandFingerprint
          ? { kind: "replayed", operation }
          : { kind: "fingerprint_conflict" };
        return attempted;
      });
    } catch (error) {
      if (!(error instanceof PostgresCommitIndeterminateError)) {throw error;}
      if (attempted?.kind === "not_found") {return attempted;}
      const evidenceId = containedTurnIdentity(
        "evidence", `evidence:postgres-acceptance-commit:${digestContainedTurnCanonicalValue({
          commandId: candidate.commandId,
          operationId: candidate.operationId,
          stateDigest: encodeContainedTurnState(candidate).digest,
          scope: {
            projectId: candidate.scope.projectId,
            tenantId: candidate.scope.tenantId,
          },
        })}`,
      );
      try {
        const observed = await this.#transactions.read(async client => {
          const result = await client.query<{ operation_id: string }>(
            "SELECT operation_id FROM agent_execution.contained_turn_operation_v1 WHERE tenant_id=$1 AND project_id=$2 AND command_id=$3",
            [candidate.scope.tenantId, candidate.scope.projectId, candidate.commandId],
          );
          const operationId = result.rows[0]?.operation_id;
          return operationId === undefined
            ? undefined
            : this.#load(client, operationId, false, candidate.scope);
        });
        if (attempted?.kind === "accepted" && observed !== undefined &&
            containedTurnPostgresAcceptanceMatches(observed, candidate)) {
          return { kind: "accepted" as const, operation: observed };
        }
        if (attempted?.kind === "replayed" && observed !== undefined &&
            observed.commandFingerprint === candidate.commandFingerprint &&
            containedTurnPostgresAcceptanceMatches(observed, attempted.operation)) {
          return { kind: "replayed" as const, operation: observed };
        }
        if (attempted?.kind === "fingerprint_conflict" && observed !== undefined &&
            observed.commandFingerprint !== candidate.commandFingerprint) {
          return { kind: "fingerprint_conflict" as const };
        }
      } catch {
        // The single bounded exact observation did not establish durable truth.
      }
      return { candidateOperation: candidate, evidenceId, kind: "potential_acceptance" as const };
    }
  }

  public commit(input: Parameters<ContainedTurnKernelOperationStore["commit"]>[0]) {return this.#cas(input);}
  public preventIntent(input: Parameters<ContainedTurnKernelOperationStore["preventIntent"]>[0]) {return this.#intents.prevent(input);}
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

  public proveDispatchPreparationClosure(
    input: Parameters<NonNullable<ContainedTurnKernelOperationStore["proveDispatchPreparationClosure"]>>[0],
  ) {
    return this.#preparations.proveClosure(input);
  }

  public async prepareDispatch(input: Parameters<ContainedTurnKernelOperationStore["prepareDispatch"]>[0]) {
    return this.#preparations.prepare(input);
  }

  public async claimPreparedDispatch(input: Parameters<ContainedTurnKernelOperationStore["claimPreparedDispatch"]>[0]) {
    return this.#preparations.claim(input);
  }

  public async retireDispatchPreparation(
    input: Parameters<ContainedTurnKernelOperationStore["retireDispatchPreparation"]>[0],
  ): ReturnType<ContainedTurnKernelOperationStore["retireDispatchPreparation"]> {
    return this.#preparations.retire(input);
  }

  public async recordDispatchPreparationCleanup(input: Parameters<ContainedTurnKernelOperationStore["recordDispatchPreparationCleanup"]>[0]) {
    return this.#preparations.recordCleanup(input);
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
