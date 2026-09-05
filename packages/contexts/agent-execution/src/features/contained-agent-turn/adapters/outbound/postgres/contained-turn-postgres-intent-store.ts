import type { PoolClient } from "pg";

import { containedTurnCancellationFingerprint, containedTurnScopeDigest, type ContainedTurnScope } from "../../../domain/contained-turn-authority.js";
import { containedTurnIdentity } from "../../../domain/contained-turn-identities.js";
import { containedTurnIntentAuthorityDigest, validateContainedTurnGuardDigest, validateContainedTurnPreventionCommand, type ContainedTurnIntentAuthority, type ContainedTurnPreventionReceipt } from "../../../domain/contained-turn-intent-guard.js";
import type { ContainedTurnKernelOperation } from "../../../domain/contained-turn-kernel-model.js";
import { detachAndFreezeContainedTurnValue } from "../../../domain/contained-turn-record.js";
import { mutateContainedTurnOperation } from "../../../domain/contained-turn-transitions.js";
import type { ContainedTurnKernelOperationStore } from "../../../application/ports/outbound/contained-turn-operation-store.js";
import { containedTurnPostgresOperationBinding } from "./contained-turn-postgres-operation-authority.js";
import type { ContainedTurnPostgresOperationRepository } from "./contained-turn-postgres-operation-repository.js";
import { CONTAINED_TURN_GUARD_SELECTION, decodeContainedTurnIntentGuard, encodeContainedTurnIntentGuard, type ContainedTurnGuardRow } from "./contained-turn-intent-guard-codec.js";
import { PostgresCommitIndeterminateError, type ContainedTurnPostgresTransactions } from "./contained-turn-postgres-transactions.js";

interface IntentRow {
  readonly authority_digest: string;
  readonly command_fingerprint: string;
  readonly operation_id: string | null;
}
type IntentKey = Readonly<{ commandId: string; commandFingerprint: string; scope: ContainedTurnScope }>;

/** All writers lock namespace -> intent -> operation. No provider or external authority call runs here. */
export class ContainedTurnPostgresIntentStore {
  readonly #authority: ContainedTurnIntentAuthority | undefined;
  readonly #authorityDigest: string | undefined;

  public constructor(
    authority: ContainedTurnIntentAuthority | undefined,
    private readonly operations: ContainedTurnPostgresOperationRepository,
    private readonly transactions: ContainedTurnPostgresTransactions,
  ) {
    this.#authorityDigest = authority === undefined ? undefined : containedTurnIntentAuthorityDigest(authority);
    this.#authority = authority === undefined ? undefined : detachAndFreezeContainedTurnValue(authority);
  }

  /** Missing root authority is a dormant production seam, never inferred from request data. */
  public async lock(client: PoolClient, scope: ContainedTurnScope): Promise<boolean> {
    if (this.#authorityDigest === undefined) {return false;}
    await client.query(
      `INSERT INTO agent_execution.contained_turn_intent_namespace_v1(tenant_id,project_id,authority_digest)
       VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
      [scope.tenantId, scope.projectId, this.#authorityDigest],
    );
    const result = await client.query<{ authority_digest: string }>(
      "SELECT authority_digest FROM agent_execution.contained_turn_intent_namespace_v1 WHERE tenant_id=$1 AND project_id=$2 FOR UPDATE",
      [scope.tenantId, scope.projectId],
    );
    return result.rows[0]?.authority_digest === this.#authorityDigest;
  }

  public async readIntent(client: PoolClient, key: IntentKey): Promise<IntentRow | undefined> {
    const result = await client.query<IntentRow>(
      "SELECT authority_digest,command_fingerprint,operation_id FROM agent_execution.contained_turn_intent_v1 WHERE tenant_id=$1 AND project_id=$2 AND command_id=$3",
      [key.scope.tenantId, key.scope.projectId, key.commandId],
    );
    const row = result.rows[0];
    if (row !== undefined) {
      validateContainedTurnGuardDigest(row.command_fingerprint);
      if (row.authority_digest !== this.#authorityDigest) {throw new TypeError("intent authority mismatch");}
      if (row.operation_id !== null) {containedTurnIdentity("operation", row.operation_id);}
    }
    return row;
  }

  public async readGuard(client: PoolClient, key: IntentKey): Promise<ContainedTurnPreventionReceipt | undefined> {
    const result = await client.query<ContainedTurnGuardRow>(
      `SELECT ${CONTAINED_TURN_GUARD_SELECTION} FROM agent_execution.contained_turn_intent_guard_v1 WHERE tenant_id=$1 AND project_id=$2 AND command_id=$3`,
      [key.scope.tenantId, key.scope.projectId, key.commandId],
    );
    const receipt = result.rows[0] === undefined ? undefined : decodeContainedTurnIntentGuard(result.rows[0]);
    if (receipt !== undefined && (receipt.command.commandId !== key.commandId ||
        receipt.command.scope.tenantId !== key.scope.tenantId || receipt.command.scope.projectId !== key.scope.projectId ||
        containedTurnIntentAuthorityDigest(receipt.command.authority) !== this.#authorityDigest)) {
      throw new TypeError("intent guard row binding mismatch");
    }
    return receipt;
  }

  public async admission(client: PoolClient, key: IntentKey): Promise<"clear" | "denied" | "fingerprint_conflict"> {
    if (!await this.lock(client, key.scope)) {return "denied";}
    const row = await this.readIntent(client, key);
    const guard = await this.readGuard(client, key);
    if (row !== undefined && row.command_fingerprint !== key.commandFingerprint) {return "fingerprint_conflict";}
    if (guard !== undefined) {
      if (row === undefined || guard.command.commandFingerprint !== row.command_fingerprint || guard.operationId !== row.operation_id) {
        throw new TypeError("intent guard and admission truth disagree");
      }
      return "denied";
    }
    if (row?.operation_id === null) {throw new TypeError("negative intent lost its durable guard");}
    return "clear";
  }

  public async recordAcceptance(client: PoolClient, operation: ContainedTurnKernelOperation): Promise<void> {
    await client.query(
      `INSERT INTO agent_execution.contained_turn_intent_v1(tenant_id,project_id,command_id,command_fingerprint,authority_digest,operation_id)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [operation.scope.tenantId, operation.scope.projectId, operation.commandId, operation.commandFingerprint, this.#authorityDigest, operation.operationId],
    );
  }

  public async claimAllowed(client: PoolClient, operation: ContainedTurnKernelOperation): Promise<boolean> {
    const key = { commandId: operation.commandId, commandFingerprint: operation.commandFingerprint, scope: operation.scope };
    if (await this.admission(client, key) !== "clear") {return false;}
    const row = await this.readIntent(client, key);
    return row?.operation_id === operation.operationId;
  }

  public async prevent(input: Parameters<ContainedTurnKernelOperationStore["preventIntent"]>[0]): ReturnType<ContainedTurnKernelOperationStore["preventIntent"]> {
    validateContainedTurnPreventionCommand(input.command);
    const command = detachAndFreezeContainedTurnValue(input.command);
    if (command.scope.tenantId !== input.scope.tenantId || command.scope.projectId !== input.scope.projectId ||
        this.#authority === undefined || containedTurnIntentAuthorityDigest(command.authority) !== this.#authorityDigest) {
      return { kind: "denied" };
    }
    try {
      return await this.transactions.write(async client => {
        if (!await this.lock(client, input.scope)) {return { kind: "denied" as const };}
        const replay = await client.query<ContainedTurnGuardRow>(
          `SELECT ${CONTAINED_TURN_GUARD_SELECTION} FROM agent_execution.contained_turn_intent_guard_v1 WHERE tenant_id=$1 AND project_id=$2 AND prevention_command_id=$3`,
          [input.scope.tenantId, input.scope.projectId, command.preventionCommandId],
        );
        if (replay.rows[0] !== undefined) {
          const receipt = decodeContainedTurnIntentGuard(replay.rows[0]);
          return receipt.command.preventionDigest === command.preventionDigest
            ? { kind: "committed" as const, receipt } : { kind: "conflict" as const };
        }
        const key = { commandId: command.commandId, commandFingerprint: command.commandFingerprint, scope: input.scope };
        const row = await this.readIntent(client, key);
        if (row !== undefined && row.command_fingerprint !== command.commandFingerprint || await this.readGuard(client, key) !== undefined) {
          return { kind: "conflict" as const };
        }
        const operation = row?.operation_id === undefined || row.operation_id === null
          ? undefined : await this.operations.load(client, row.operation_id, true, input.scope);
        if (row !== undefined && operation === undefined) {throw new TypeError("intent operation or guard missing");}
        if (operation !== undefined && (operation.commandId !== command.commandId || operation.commandFingerprint !== command.commandFingerprint)) {
          throw new TypeError("intent operation binding mismatch");
        }
        let current = operation;
        if (operation !== undefined && operation.terminal.kind !== "final" && operation.cancellation.kind !== "requested") {
          const binding = { ...containedTurnPostgresOperationBinding(operation), cancellationCommandId: command.preventionCommandId };
          const fingerprint = containedTurnCancellationFingerprint({ cancellationCommandId: command.preventionCommandId, operationId: operation.operationId, scopeDigest: containedTurnScopeDigest(input.scope) });
          current = mutateContainedTurnOperation(operation, {
            command: { cancellationCommandId: command.preventionCommandId, fingerprint, operationId: operation.operationId, scopeDigest: containedTurnScopeDigest(input.scope) },
            cutoffProof: { binding, kind: "cutoff", proofId: containedTurnIdentity("proof", `proof:intent-cutoff:${command.preventionDigest}`) },
            kind: "request_cancellation",
            proof: { binding: { ...binding, cancellationFingerprint: fingerprint }, kind: "cancellation", proofId: containedTurnIdentity("proof", `proof:intent-cancellation:${command.preventionDigest}`) },
          });
          if (current.dispatch.kind === "claimed") {
            current = mutateContainedTurnOperation(current, {
              evidenceId: containedTurnIdentity("evidence", `evidence:intent-cutoff:${command.preventionDigest}`),
              kind: "record_reconciliation_debt", source: "dispatch_authority",
            });
          }
          await this.operations.persist(client, operation, current);
        }
        if (row === undefined) {
          await client.query(
            `INSERT INTO agent_execution.contained_turn_intent_v1(tenant_id,project_id,command_id,command_fingerprint,authority_digest,operation_id)
             VALUES ($1,$2,$3,$4,$5,NULL)`,
            [input.scope.tenantId, input.scope.projectId, command.commandId, command.commandFingerprint, this.#authorityDigest],
          );
        }
        const receipt: ContainedTurnPreventionReceipt = {
          command,
          cutoffProofId: current?.operationCutoff.kind === "closed" ? current.operationCutoff.proofId ?? null : null,
          disposition: current === undefined ? "intent_guarded" : current.terminal.kind === "final" ? "already_terminal" : current.dispatch.kind === "claimed" ? "cutoff_requested" : "operation_fenced",
          operationId: current?.operationId ?? null,
          operationRevision: current?.revision ?? null,
          receiptId: containedTurnIdentity("proof", `proof:intent-receipt:${command.preventionDigest}`),
          version: 1,
        };
        const encoded = encodeContainedTurnIntentGuard(receipt);
        await client.query(
          `INSERT INTO agent_execution.contained_turn_intent_guard_v1(tenant_id,project_id,command_id,prevention_command_id,state_codec_version,state,state_digest)
           VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)`,
          [input.scope.tenantId, input.scope.projectId, command.commandId, command.preventionCommandId, encoded.codecVersion, encoded.json, encoded.digest],
        );
        return { kind: "committed" as const, receipt: detachAndFreezeContainedTurnValue(receipt) };
      });
    } catch (error) {
      if (error instanceof PostgresCommitIndeterminateError) {return { kind: "indeterminate" };}
      throw error;
    }
  }
}
