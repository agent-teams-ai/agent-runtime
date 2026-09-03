import type { ContainedTurnKernelOperationStore } from "../../../application/ports/outbound/contained-turn-ports.js";
import { containedTurnPreparationToken } from "../../../application/contained-turn-preparation-cleanup.js";
import {
  containedTurnProviderAccessSnapshotDigest,
  containedTurnScopeDigest,
} from "../../../domain/contained-turn-authority.js";
import { digestContainedTurnCanonicalValue } from "../../../domain/contained-turn-codecs.js";
import {
  bindContainedTurnPreparationGrantRequests,
  claimContainedTurnDispatchPreparation,
  recordContainedTurnPreparationCleanup,
  retireContainedTurnDispatchPreparation,
  type ContainedTurnDispatchPreparation,
} from "../../../domain/contained-turn-dispatch-preparation.js";
import { validateContainedTurnConsumedGrantReceipts } from "../../../domain/contained-turn-dispatch-authority.js";
import { containedTurnIdentity } from "../../../domain/contained-turn-identities.js";
import type { ContainedTurnKernelOperation } from "../../../domain/contained-turn-kernel-model.js";
import type { ContainedTurnProof } from "../../../domain/contained-turn-proofs.js";
import { mutateContainedTurnOperation } from "../../../domain/contained-turn-transitions.js";
import { validateContainedTurnOperation } from "../../../domain/contained-turn-validation.js";
import {
  assertContainedTurnPostgresAuthority as assertAuthority,
  type ContainedTurnPostgresIdentitySource,
  containedTurnPostgresOperationBinding as operationBinding,
} from "./contained-turn-postgres-operation-authority.js";
import type { ContainedTurnPostgresOperationRepository } from "./contained-turn-postgres-operation-repository.js";
import type { ContainedTurnPostgresTransactions } from "./contained-turn-postgres-transactions.js";
import { decodeContainedTurnPreparation, encodeContainedTurnPreparation } from "./contained-turn-preparation-codec.js";
import {
  CONTAINED_TURN_POSTGRES_JSON_BUDGET,
  ContainedTurnStateBudgetError,
} from "./contained-turn-state-codec.js";

interface PreparationRow {
  readonly state: unknown;
  readonly state_codec_version: number;
  readonly state_digest: string | null;
  readonly state_within_budget: boolean;
}

const PREPARATION_STATE_SELECTION = `CASE
  WHEN octet_length(state::text) <= ${String(CONTAINED_TURN_POSTGRES_JSON_BUDGET.maximumSerializedBytes)}
  THEN state END AS state,
  octet_length(state::text) <= ${String(CONTAINED_TURN_POSTGRES_JSON_BUDGET.maximumSerializedBytes)}
    AS state_within_budget,state_codec_version,state_digest`;

const decodePreparationRow = (row: PreparationRow): ContainedTurnDispatchPreparation => {
  if (!row.state_within_budget) {throw new ContainedTurnStateBudgetError();}
  return decodeContainedTurnPreparation(row.state, row.state_digest, row.state_codec_version);
};

export class ContainedTurnPostgresPreparationStore {
  public constructor(
    private readonly identities: ContainedTurnPostgresIdentitySource,
    private readonly operations: ContainedTurnPostgresOperationRepository,
    private readonly transactions: ContainedTurnPostgresTransactions,
  ) {}

  async #load(client: import("pg").PoolClient, operationId: string, scope: import("../../../domain/contained-turn-authority.js").ContainedTurnScope) {
    return this.operations.load(client, operationId, true, scope);
  }

  async #persist(
    client: import("pg").PoolClient,
    previous: ContainedTurnKernelOperation,
    next: ContainedTurnKernelOperation,
  ): Promise<void> {
    validateContainedTurnOperation(next, { previous });
    return this.operations.persist(client, previous, next);
  }

  public prepare(
    input: Parameters<ContainedTurnKernelOperationStore["prepareDispatch"]>[0],
  ): ReturnType<ContainedTurnKernelOperationStore["prepareDispatch"]> {
    assertAuthority(input.authority, input.operation);
    const workspaceId = input.operation.workspaceId;
    if (workspaceId === undefined) {throw new TypeError("dispatch preparation requires workspace custody");}
    return this.transactions.write(async client => {
      const current = await this.#load(client, input.authority.operationId, input.authority.scope);
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
      const attemptId = containedTurnIdentity("attempt", this.identities.nextId("attempt", `preparation:${seed}:attempt`));
      const custodyId = containedTurnIdentity("custody", this.identities.nextId("custody", `preparation:${seed}:custody`));
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
      if (inserted.rowCount !== 1) {throw new Error("dispatch preparation identity collision");}
      return Object.freeze({
        attemptId,
        claimProofId: containedTurnIdentity("proof", this.identities.nextId("proof", `preparation:${seed}:claim`)),
        custodyId,
        cutoffProofId: containedTurnIdentity("proof", this.identities.nextId("proof", `preparation:${seed}:cutoff`)),
        executionGenerationId: containedTurnIdentity("execution_generation", this.identities.nextId("execution_generation", `preparation:${seed}:generation`)),
        writerFence: containedTurnIdentity("writer_fence", this.identities.nextId("writer_fence", `preparation:${seed}:writer`)),
      });
    });
  }

  public claim(
    input: Parameters<ContainedTurnKernelOperationStore["claimPreparedDispatch"]>[0],
  ): ReturnType<ContainedTurnKernelOperationStore["claimPreparedDispatch"]> {
    const consumedReceipts = validateContainedTurnConsumedGrantReceipts(
      input.subject, input.consumedGrantReceipts,
    );
    const claimSeed = digestContainedTurnCanonicalValue({
      attemptId: input.subject.attemptId,
      operationId: input.subject.operationId,
      preparationToken: input.subject.preparationToken,
    });
    const startAuthority = this.identities.nextId("start_authority", `claim:${claimSeed}`);
    return this.transactions.write(async client => {
      const current = await this.#load(client, input.authority.operationId, input.authority.scope);
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
        kind: "dispatch_claim", proofId: containedTurnIdentity("proof", this.identities.nextId("proof", `claim:${claimSeed}:dispatch`)),
      };
      const next = mutateContainedTurnOperation(current, {
        attemptId: input.subject.attemptId, consumedGrantReceipts: consumedReceipts, claimProof, custodyId: input.subject.custodyId,
        cutoffProof: { binding: operationBinding(current), kind: "cutoff", proofId: containedTurnIdentity("proof", this.identities.nextId("proof", `claim:${claimSeed}:cutoff`)) },
        executionGenerationId: input.subject.executionGenerationId, hostBootId: input.subject.hostBootId,
        hostCustodyProof: input.hostCustodyProof, hostInstanceId: input.subject.hostInstanceId, kind: "claim_dispatch",
        preparationToken: input.subject.preparationToken, providerAccessDispatchProof: providerAccessProof,
        runtimeSecurityDispatchProof: runtimeSecurityProof, writerFence: containedTurnIdentity("writer_fence", this.identities.nextId("writer_fence", `claim:${claimSeed}:writer`)),
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

  public retire(
    input: Parameters<ContainedTurnKernelOperationStore["retireDispatchPreparation"]>[0],
  ): ReturnType<ContainedTurnKernelOperationStore["retireDispatchPreparation"]> {
    return this.transactions.write(async client => {
      const current = await this.#load(client, input.authority.operationId, input.authority.scope);
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
        this.identities.nextId("cleanup", `retirement:${digestContainedTurnCanonicalValue({
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

  public recordCleanup(
    input: Parameters<ContainedTurnKernelOperationStore["recordDispatchPreparationCleanup"]>[0],
  ): ReturnType<ContainedTurnKernelOperationStore["recordDispatchPreparationCleanup"]> {
    return this.transactions.write(async client => {
      const current = await this.#load(client, input.authority.operationId, input.authority.scope);
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
}
