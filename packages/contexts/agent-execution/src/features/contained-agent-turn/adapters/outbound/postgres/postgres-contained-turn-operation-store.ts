import { randomUUID } from "node:crypto";

import type { Pool, PoolClient } from "pg";

import type {
  ContainedTurnKernelOperationStore,
  ContainedTurnOwnerStoreAuthority,
} from "../../../application/ports/outbound/contained-turn-ports.js";
import { containedTurnCancellationFingerprint, containedTurnProviderAccessSnapshotDigest } from "../../../domain/contained-turn-authority.js";
import { digestContainedTurnCanonicalValue } from "../../../domain/contained-turn-codecs.js";
import {
  claimContainedTurnDispatchPreparation,
  recordContainedTurnPreparationCleanup,
  retireContainedTurnDispatchPreparation,
  type ContainedTurnDispatchPreparation,
} from "../../../domain/contained-turn-dispatch-preparation.js";
import { validateContainedTurnConsumedGrantReceipts } from "../../../domain/contained-turn-dispatch-authority.js";
import { containedTurnIdentity } from "../../../domain/contained-turn-identities.js";
import type { ContainedTurnKernelOperation } from "../../../domain/contained-turn-kernel-model.js";
import { appendContainedTurnOutputForOwnerStore } from "../../../domain/contained-turn-output-transitions.js";
import type { ContainedTurnProof } from "../../../domain/contained-turn-proofs.js";
import { containedTurnSatisfactionDigest } from "../../../domain/contained-turn-satisfaction.js";
import { mutateContainedTurnOperation } from "../../../domain/contained-turn-transitions.js";
import { validateContainedTurnOperation } from "../../../domain/contained-turn-validation.js";
import { containedTurnPreparationToken } from "../../../application/contained-turn-preparation-cleanup.js";
import { decodeContainedTurnState, encodeContainedTurnState } from "./contained-turn-state-codec.js";
export { applyContainedTurnPostgresSchema } from "./contained-turn-postgres-schema.js";

interface OperationRow {
  readonly command_fingerprint: string;
  readonly command_id: string;
  readonly effect_id: string;
  readonly operation_id: string;
  readonly revision: string;
  readonly state: unknown;
  readonly state_digest: string;
  readonly tenant_id: string;
  readonly terminal: boolean;
}

interface OutputRow { readonly cursor: number; readonly output_kind: string; readonly output_text: string }
interface ProofRow { readonly receipt_kind: string; readonly receipt_ref: string }
interface PreparationRow { readonly state: unknown }

export interface ContainedTurnPostgresIdentitySource {
  nextId(kind: "attempt" | "cancellation_command" | "cleanup" | "effect" | "execution_generation" | "operation" | "proof" | "writer_fence"): string;
}

export interface PostgresContainedTurnOperationStoreOptions {
  readonly identities?: ContainedTurnPostgresIdentitySource;
  readonly pool: Pool;
}

const defaultIdentities: ContainedTurnPostgresIdentitySource = Object.freeze({
  nextId(kind: Parameters<ContainedTurnPostgresIdentitySource["nextId"]>[0]) {return `${kind.replaceAll("_", "-")}:${randomUUID()}`;},
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

const decodePreparation = (state: unknown): ContainedTurnDispatchPreparation => {
  if (state === null || typeof state !== "object" || Array.isArray(state) || !("kind" in state)) {
    throw new TypeError("contained turn PostgreSQL preparation state is malformed");
  }
  return Object.freeze(state) as ContainedTurnDispatchPreparation;
};

export class PostgresContainedTurnOperationStore implements ContainedTurnKernelOperationStore {
  readonly #identities: ContainedTurnPostgresIdentitySource;
  readonly #pool: Pool;

  public constructor(options: PostgresContainedTurnOperationStoreOptions) {
    this.#pool = options.pool;
    this.#identities = options.identities ?? defaultIdentities;
  }

  async #transaction<Result>(work: (client: PoolClient) => Promise<Result>): Promise<Result> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {client.release();}
  }

  async #load(client: PoolClient, operationId: string, lock = false): Promise<ContainedTurnKernelOperation | undefined> {
    const result = await client.query<OperationRow>(
      `SELECT operation_id, tenant_id, command_id, command_fingerprint, effect_id,
              revision::text, state, state_digest, terminal
         FROM agent_execution.contained_turn_operation_v1
        WHERE operation_id = $1${lock ? " FOR UPDATE" : ""}`,
      [operationId],
    );
    const row = result.rows[0];
    if (row === undefined) {return undefined;}
    const operation = decodeContainedTurnState(row.state, row.state_digest);
    if (operation.operationId !== row.operation_id || operation.scope.tenantId !== row.tenant_id ||
        operation.commandId !== row.command_id || operation.commandFingerprint !== row.command_fingerprint ||
        operation.effectId !== row.effect_id || operation.revision !== Number(row.revision) ||
        (operation.terminal.kind === "final") !== row.terminal) {
      throw new Error("contained turn authoritative PostgreSQL row mismatch");
    }
    const [outputs, proofs] = await Promise.all([
      client.query<OutputRow>("SELECT cursor, output_kind, output_text FROM agent_execution.contained_turn_output_v1 WHERE operation_id = $1 ORDER BY cursor", [operationId]),
      client.query<ProofRow>("SELECT receipt_kind, receipt_ref FROM agent_execution.contained_turn_receipt_v1 WHERE operation_id = $1 ORDER BY receipt_ref", [operationId]),
    ]);
    if (outputs.rows.length !== operation.output.chunks.length || proofs.rows.length !== operation.proofs.length) {
      throw new Error("contained turn PostgreSQL projection cardinality mismatch");
    }
    for (const [index, chunk] of operation.output.chunks.entries()) {
      const output = outputs.rows[index];
      if (output?.cursor !== chunk.cursor || output.output_kind !== chunk.kind || output.output_text !== chunk.text) {
        throw new Error("contained turn PostgreSQL output projection mismatch");
      }
    }
    const proofById = new Map(proofs.rows.map(proof => [proof.receipt_ref, proof.receipt_kind]));
    for (const proof of operation.proofs) {
      if (proofById.get(proof.proofId) !== proof.kind) {throw new Error("contained turn PostgreSQL proof projection mismatch");}
    }
    return operation;
  }

  async #project(client: PoolClient, previous: ContainedTurnKernelOperation | undefined, next: ContainedTurnKernelOperation): Promise<void> {
    const previousChunks = previous?.output.chunks ?? [];
    for (const chunk of next.output.chunks.slice(previousChunks.length)) {
      await client.query("INSERT INTO agent_execution.contained_turn_output_v1(operation_id, cursor, output_kind, output_text) VALUES ($1,$2,$3,$4)", [next.operationId, chunk.cursor, chunk.kind, chunk.text]);
    }
    const previousProofIds = new Set(previous?.proofs.map(proof => proof.proofId));
    for (const proof of next.proofs) {
      if (!previousProofIds.has(proof.proofId)) {
        await client.query("INSERT INTO agent_execution.contained_turn_receipt_v1(operation_id, receipt_kind, receipt_ref) VALUES ($1,$2,$3)", [next.operationId, proof.kind, proof.proofId]);
      }
    }
  }

  async #persist(client: PoolClient, previous: ContainedTurnKernelOperation, next: ContainedTurnKernelOperation): Promise<void> {
    validateContainedTurnOperation(next, { previous });
    const encoded = encodeContainedTurnState(next);
    const result = await client.query(
      "UPDATE agent_execution.contained_turn_operation_v1 SET revision=$3,state=$4::jsonb,state_digest=$5,terminal=$6 WHERE operation_id=$1 AND revision=$2",
      [next.operationId, previous.revision, next.revision, encoded.json, encoded.digest, next.terminal.kind === "final"],
    );
    if (result.rowCount !== 1) {throw new Error("contained turn PostgreSQL revision fence failed");}
    await this.#project(client, previous, next);
  }

  async #cas(input: Parameters<ContainedTurnKernelOperationStore["commit"]>[0]) {
    return this.#transaction(async client => {
      const current = await this.#load(client, input.authority.operationId, true);
      if (current === undefined) {return { kind: "not_found" as const };}
      assertAuthority(input.authority, current);
      if (current.revision !== input.expectedRevision) {return { current, kind: "stale" as const };}
      await this.#persist(client, current, input.candidate);
      return { kind: "applied" as const, operation: input.candidate };
    });
  }

  public async identifyAcceptance(input: Parameters<ContainedTurnKernelOperationStore["identifyAcceptance"]>[0]) {
    const result = await this.#pool.query<{ operation_id: string }>(
      "SELECT operation_id FROM agent_execution.contained_turn_operation_v1 WHERE tenant_id=$1 AND command_id=$2",
      [input.scope.tenantId, input.commandId],
    );
    const operationId = result.rows[0]?.operation_id;
    if (operationId !== undefined) {
      const operation = await this.read({ operationId: containedTurnIdentity("operation", operationId), scope: input.scope });
      if (operation === undefined) {return { kind: "not_found" as const };}
      return operation.commandFingerprint === input.commandFingerprint
        ? { kind: "replayed" as const, operation }
        : { kind: "fingerprint_conflict" as const };
    }
    return {
      acceptanceProofId: containedTurnIdentity("proof", this.#identities.nextId("proof")),
      effectId: containedTurnIdentity("effect", this.#identities.nextId("effect")),
      kind: "available" as const,
      operationAuthorityRevision: `postgres-operation-authority:${randomUUID()}`,
      operationId: containedTurnIdentity("operation", this.#identities.nextId("operation")),
    };
  }

  public async accept(candidate: ContainedTurnKernelOperation, authority: ContainedTurnOwnerStoreAuthority) {
    assertAuthority(authority, candidate);
    return this.#transaction(async client => {
      const encoded = encodeContainedTurnState(candidate);
      const inserted = await client.query(
        `INSERT INTO agent_execution.contained_turn_operation_v1(operation_id,tenant_id,command_id,command_fingerprint,effect_id,revision,state,state_digest,terminal)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,false) ON CONFLICT (tenant_id,command_id) DO NOTHING RETURNING operation_id`,
        [candidate.operationId, candidate.scope.tenantId, candidate.commandId, candidate.commandFingerprint, candidate.effectId, candidate.revision, encoded.json, encoded.digest],
      );
      if (inserted.rowCount === 1) {
        await this.#project(client, undefined, candidate);
        return { kind: "accepted" as const, operation: candidate };
      }
      const existing = await client.query<{ operation_id: string }>("SELECT operation_id FROM agent_execution.contained_turn_operation_v1 WHERE tenant_id=$1 AND command_id=$2 FOR UPDATE", [candidate.scope.tenantId, candidate.commandId]);
      const operationId = existing.rows[0]?.operation_id;
      if (operationId === undefined) {return { kind: "not_found" as const };}
      const operation = await this.#load(client, operationId);
      if (operation === undefined) {return { kind: "not_found" as const };}
      return operation.commandFingerprint === candidate.commandFingerprint
        ? { kind: "replayed" as const, operation }
        : { kind: "fingerprint_conflict" as const };
    });
  }

  public commit(input: Parameters<ContainedTurnKernelOperationStore["commit"]>[0]) {return this.#cas(input);}
  public requestCancellation(input: Parameters<ContainedTurnKernelOperationStore["requestCancellation"]>[0]) {return this.#cas(input);}

  public async appendOutput(input: Parameters<ContainedTurnKernelOperationStore["appendOutput"]>[0]) {
    return this.#transaction(async client => {
      const current = await this.#load(client, input.authority.operationId, true);
      if (current === undefined) {return { kind: "not_found" as const };}
      assertAuthority(input.authority, current);
      if (current.revision !== input.expectedRevision) {return { current, kind: "stale" as const };}
      if (current.output.chunks.length !== input.expectedCursor) {return { current, kind: "stale" as const };}
      const next = appendContainedTurnOutputForOwnerStore(current, input.output);
      await this.#persist(client, current, next);
      return { kind: "applied" as const, operation: next };
    });
  }

  public async read(input: Parameters<ContainedTurnKernelOperationStore["read"]>[0]) {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const operation = await this.#load(client, input.operationId);
      await client.query("COMMIT");
      return operation?.scope.projectId === input.scope.projectId && operation.scope.tenantId === input.scope.tenantId
        ? operation : undefined;
    } catch (error) {await client.query("ROLLBACK"); throw error;} finally {client.release();}
  }

  public async prepareDispatch(input: Parameters<ContainedTurnKernelOperationStore["prepareDispatch"]>[0]) {
    assertAuthority(input.authority, input.operation);
    if (input.operation.workspaceId === undefined) {throw new TypeError("dispatch preparation requires workspace custody");}
    const attemptId = containedTurnIdentity("attempt", this.#identities.nextId("attempt"));
    const custodyId = containedTurnIdentity("custody", `custody:postgres:${randomUUID()}`);
    const preparationToken = containedTurnPreparationToken({ attemptId, custodyId, operationId: input.operation.operationId });
    const preparation: ContainedTurnDispatchPreparation = Object.freeze({
      attemptId, custodyId, kind: "active", operationCutoffRevision: input.operation.operationCutoff.revision,
      operationId: input.operation.operationId, preparationToken, preparedOperationRevision: input.operation.revision,
      providerAccessGrantRequestId: `provider-access-grant:${randomUUID()}`,
      runtimeSecurityGrantRequestId: `runtime-security-grant:${randomUUID()}`,
      workspaceId: input.operation.workspaceId,
    });
    await this.#pool.query(
      "INSERT INTO agent_execution.contained_turn_dispatch_preparation_v1(operation_id,preparation_token,state) VALUES ($1,$2,$3::jsonb) ON CONFLICT DO NOTHING",
      [input.operation.operationId, preparationToken, JSON.stringify(preparation)],
    );
    return Object.freeze({
      attemptId,
      claimProofId: containedTurnIdentity("proof", this.#identities.nextId("proof")),
      custodyId,
      cutoffProofId: containedTurnIdentity("proof", this.#identities.nextId("proof")),
      executionGenerationId: containedTurnIdentity("execution_generation", this.#identities.nextId("execution_generation")),
      writerFence: containedTurnIdentity("writer_fence", this.#identities.nextId("writer_fence")),
    });
  }

  public async claimPreparedDispatch(input: Parameters<ContainedTurnKernelOperationStore["claimPreparedDispatch"]>[0]) {
    validateContainedTurnConsumedGrantReceipts(input.subject, input.consumedGrantReceipts);
    const startAuthority = `host-start-once:${randomUUID()}`;
    return this.#transaction(async client => {
      const current = await this.#load(client, input.authority.operationId, true);
      if (current === undefined) {return { kind: "not_found" as const };}
      assertAuthority(input.authority, current);
      if (current.dispatch.kind === "claimed" && current.dispatch.preparationToken === input.subject.preparationToken) {
        return { kind: "observed_claim" as const, operation: current };
      }
      if (current.revision !== input.expectedOperationRevision) {return { current, kind: "stale" as const };}
      const row = await client.query<PreparationRow>("SELECT state FROM agent_execution.contained_turn_dispatch_preparation_v1 WHERE operation_id=$1 AND preparation_token=$2 FOR UPDATE", [current.operationId, input.subject.preparationToken]);
      const preparation = row.rows[0] === undefined ? undefined : decodePreparation(row.rows[0].state);
      if (preparation === undefined || preparation.kind !== "active") {return { current, kind: "stale" as const };}
      const providerAccessReceipt = input.consumedGrantReceipts[0];
      const runtimeSecurityReceipt = input.consumedGrantReceipts[1];
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
        kind: "dispatch_claim", proofId: containedTurnIdentity("proof", this.#identities.nextId("proof")),
      };
      const next = mutateContainedTurnOperation(current, {
        attemptId: input.subject.attemptId, claimProof, custodyId: input.subject.custodyId,
        cutoffProof: { binding: operationBinding(current), kind: "cutoff", proofId: containedTurnIdentity("proof", this.#identities.nextId("proof")) },
        executionGenerationId: input.subject.executionGenerationId, hostBootId: input.subject.hostBootId,
        hostCustodyProof: input.hostCustodyProof, hostInstanceId: input.subject.hostInstanceId, kind: "claim_dispatch",
        preparationToken: input.subject.preparationToken, providerAccessDispatchProof: providerAccessProof,
        runtimeSecurityDispatchProof: runtimeSecurityProof, writerFence: containedTurnIdentity("writer_fence", this.#identities.nextId("writer_fence")),
      });
      await this.#persist(client, current, next);
      const claimed = claimContainedTurnDispatchPreparation(preparation);
      await client.query("UPDATE agent_execution.contained_turn_dispatch_preparation_v1 SET state=$3::jsonb WHERE operation_id=$1 AND preparation_token=$2", [current.operationId, input.subject.preparationToken, JSON.stringify(claimed)]);
      return { kind: "claimed" as const, operation: next, startAuthority };
    });
  }

  public async retireDispatchPreparation(
    input: Parameters<ContainedTurnKernelOperationStore["retireDispatchPreparation"]>[0],
  ): ReturnType<ContainedTurnKernelOperationStore["retireDispatchPreparation"]> {
    return this.#transaction(async client => {
      const current = await this.#load(client, input.authority.operationId, true);
      if (current === undefined) {return { evidenceId: containedTurnIdentity("evidence", `evidence:postgres-retire-missing:${digestContainedTurnCanonicalValue({ operationId: input.authority.operationId, preparationToken: input.preparationToken })}`), kind: "indeterminate" as const };}
      assertAuthority(input.authority, current);
      if (current.dispatch.kind === "claimed" && current.dispatch.preparationToken === input.preparationToken) {return { kind: "claimed" as const, operation: current };}
      const row = await client.query<PreparationRow>("SELECT state FROM agent_execution.contained_turn_dispatch_preparation_v1 WHERE operation_id=$1 AND preparation_token=$2 FOR UPDATE", [current.operationId, input.preparationToken]);
      const preparation = row.rows[0] === undefined ? undefined : decodePreparation(row.rows[0].state);
      if (preparation === undefined) {return { current, kind: "stale" as const };}
      if (preparation.kind === "claimed") {return { current, kind: "stale" as const };}
      const retired = retireContainedTurnDispatchPreparation(preparation, this.#identities.nextId("cleanup"));
      await client.query("UPDATE agent_execution.contained_turn_dispatch_preparation_v1 SET state=$3::jsonb WHERE operation_id=$1 AND preparation_token=$2", [current.operationId, input.preparationToken, JSON.stringify(retired)]);
      return retired.kind === "cleanup_pending" ? { kind: "retired" as const, preparation: retired } : { current, kind: "stale" as const };
    });
  }

  public async recordDispatchPreparationCleanup(input: Parameters<ContainedTurnKernelOperationStore["recordDispatchPreparationCleanup"]>[0]) {
    return this.#transaction(async client => {
      const current = await this.#load(client, input.authority.operationId, true);
      if (current === undefined) {throw new Error("cleanup operation disappeared");}
      assertAuthority(input.authority, current);
      const row = await client.query<PreparationRow>("SELECT state FROM agent_execution.contained_turn_dispatch_preparation_v1 WHERE operation_id=$1 AND preparation_token=$2 FOR UPDATE", [current.operationId, input.permit.preparationToken]);
      if (row.rows[0] === undefined) {throw new Error("cleanup preparation disappeared");}
      const next = recordContainedTurnPreparationCleanup(decodePreparation(row.rows[0].state), input);
      await client.query("UPDATE agent_execution.contained_turn_dispatch_preparation_v1 SET state=$3::jsonb WHERE operation_id=$1 AND preparation_token=$2", [current.operationId, input.permit.preparationToken, JSON.stringify(next)]);
      return next;
    });
  }

  public async prepareCancellation(input: Parameters<ContainedTurnKernelOperationStore["prepareCancellation"]>[0]) {
    assertAuthority(input.authority, input.operation);
    const cancellationCommandId = containedTurnIdentity("cancellation_command", this.#identities.nextId("cancellation_command"));
    const fingerprint = containedTurnCancellationFingerprint({ cancellationCommandId, operationId: input.operation.operationId, scopeDigest: input.operation.acceptedAuthorityVector.scopeDigest });
    return Object.freeze({
      command: Object.freeze({ cancellationCommandId, fingerprint, operationId: input.operation.operationId, scopeDigest: input.operation.acceptedAuthorityVector.scopeDigest }),
      cutoffProof: Object.freeze({ binding: { ...operationBinding(input.operation), cancellationCommandId }, kind: "cutoff" as const, proofId: containedTurnIdentity("proof", this.#identities.nextId("proof")) }),
      preventionProofId: containedTurnIdentity("proof", this.#identities.nextId("proof")),
      proof: Object.freeze({ binding: { ...operationBinding(input.operation), cancellationCommandId, cancellationFingerprint: fingerprint }, kind: "cancellation" as const, proofId: containedTurnIdentity("proof", this.#identities.nextId("proof")) }),
    });
  }

  public async proofsForAcceptedEffect(input: Parameters<ContainedTurnKernelOperationStore["proofsForAcceptedEffect"]>[0]) {
    assertAuthority(input.authority, input.operation);
    const binding = attemptBinding(input.operation);
    return Object.freeze({
      acceptanceProof: { binding: { ...binding, disposition: "accepted" as const }, kind: "provider_acceptance" as const, proofId: containedTurnIdentity("proof", this.#identities.nextId("proof")) },
      effectProof: { binding: { ...binding, disposition: "committed" as const }, kind: "effect_resolution" as const, proofId: containedTurnIdentity("proof", this.#identities.nextId("proof")) },
      kind: "proved" as const,
    });
  }

  public async proofsForProcessNoStart(input: Parameters<ContainedTurnKernelOperationStore["proofsForProcessNoStart"]>[0]) {
    assertAuthority(input.authority, input.operation);
    const binding = operationBinding(input.operation);
    return Object.freeze({
      containmentProof: { binding: { ...binding, effectId: input.operation.effectId }, kind: "containment_not_required" as const, proofId: containedTurnIdentity("proof", this.#identities.nextId("proof")) },
      effectProof: { binding: { ...binding, disposition: "not_committed" as const, effectId: input.operation.effectId }, kind: "effect_no_start" as const, proofId: containedTurnIdentity("proof", this.#identities.nextId("proof")) },
      executionProof: { binding: { ...binding, effectId: input.operation.effectId }, kind: "no_start" as const, proofId: containedTurnIdentity("proof", this.#identities.nextId("proof")) },
      outputProof: { binding: { ...binding, finalCursor: input.operation.output.chunks.length }, kind: "output_no_start_drain" as const, proofId: containedTurnIdentity("proof", this.#identities.nextId("proof")) },
      providerProof: { binding: { ...binding, effectId: input.operation.effectId }, kind: "provider_not_started" as const, proofId: containedTurnIdentity("proof", this.#identities.nextId("proof")) },
    });
  }

  public async proofsForPrevention(input: Parameters<ContainedTurnKernelOperationStore["proofsForPrevention"]>[0]) {
    assertAuthority(input.authority, input.operation);
    const binding = operationBinding(input.operation);
    const proof = (kind: Parameters<ContainedTurnPostgresIdentitySource["nextId"]>[0] = "proof") => containedTurnIdentity("proof", this.#identities.nextId(kind));
    return Object.freeze({
      containmentProof: { binding: { ...binding, effectId: input.operation.effectId }, kind: "containment_not_required" as const, proofId: proof() },
      cutoffProof: { binding, kind: "cutoff" as const, proofId: proof() },
      effectProof: { binding: { ...binding, disposition: "not_committed" as const, effectId: input.operation.effectId }, kind: "effect_no_start" as const, proofId: proof() },
      executionProof: { binding: { ...binding, effectId: input.operation.effectId }, kind: "no_start" as const, proofId: proof() },
      hostCustodyProof: { binding: { ...binding, effectId: input.operation.effectId }, kind: "host_custody_no_start" as const, proofId: proof() },
      noDispatchProof: { binding: { ...binding, effectId: input.operation.effectId }, kind: "no_dispatch" as const, proofId: input.preventionProofId },
      outputProof: { binding: { ...binding, finalCursor: 0 }, kind: "output_no_start_drain" as const, proofId: proof() },
      providerProof: { binding: { ...binding, effectId: input.operation.effectId }, kind: "provider_not_started" as const, proofId: proof() },
    });
  }

  public async terminalProof(input: Parameters<ContainedTurnKernelOperationStore["terminalProof"]>[0]) {
    assertAuthority(input.authority, input.operation);
    if (input.satisfactionDigest !== containedTurnSatisfactionDigest(input.operation) || input.operation.providerExecution.kind !== "closed") {throw new TypeError("terminal proof precondition mismatch");}
    return Object.freeze({
      binding: { ...operationBinding(input.operation), requiredReceiptSetDigest: input.operation.requiredReceiptSetDigest, requiredReceiptSetVersion: input.operation.requiredReceiptSet.setVersion, satisfactionDigest: input.satisfactionDigest, terminalOutcome: input.operation.providerExecution.outcome },
      kind: "terminal_truth" as const,
      proofId: containedTurnIdentity("proof", this.#identities.nextId("proof")),
    });
  }
}
