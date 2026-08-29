import { createHash, randomUUID } from "node:crypto";

import type { Pool, PoolClient } from "pg";

import type {
  AcceptContainedTurnCommandInput,
  AcceptContainedTurnCommandOutcome,
  ClaimContainedTurnDispatchOutcome,
  CompareAndSetContainedTurnOutcome,
  ContainedTurnOperationStore,
} from "../legacy/legacy-contained-turn-ports.js";
import {
  applyContainedTurnMutation,
  createAcceptedContainedTurnOperation,
  type ContainedTurnMutation,
  type ContainedTurnOperation,
} from "../../../domain/contained-turn-operation.js";
import { decodeContainedTurnState, encodeContainedTurnState } from "./contained-turn-state-codec.js";

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

interface OutputRow {
  readonly cursor: number;
  readonly output_kind: string;
  readonly output_text: string;
}

interface ReceiptRow {
  readonly receipt_kind: string;
  readonly receipt_ref: string;
}

export interface ContainedTurnPostgresIdentitySource {
  nextId(kind: "acceptance" | "attempt" | "claim" | "effect" | "operation"): string;
}

export interface PostgresContainedTurnOperationStoreOptions {
  readonly identities?: ContainedTurnPostgresIdentitySource;
  readonly pool: Pool;
}

const defaultIdentities: ContainedTurnPostgresIdentitySource = Object.freeze({
  nextId(kind: "acceptance" | "attempt" | "claim" | "effect" | "operation") {
    return `urn:agent-runtime:contained-turn:${kind}:${randomUUID()}`;
  },
});

const commandFingerprint = (input: AcceptContainedTurnCommandInput): string => createHash("sha256")
  .update(JSON.stringify([
    input.commandId,
    input.intent.mode,
    input.intent.prompt,
    input.providerBinding.provider,
    input.providerBinding.adapterRevision,
    input.providerBinding.binaryRevision,
    input.providerBinding.capabilityManifestRevision,
    input.providerBinding.credentialBindingDigest,
    input.providerBinding.providerRouteRef,
    input.scope.tenantId,
    input.scope.projectId,
    input.securityDecision.authorityRevision,
    input.securityDecision.decisionDigest,
  ]))
  .digest("hex");

const deterministicReceiptRef = (kind: "cancel" | "terminal", operationId: string): string =>
  `urn:agent-runtime:contained-turn:${kind}:${createHash("sha256").update(operationId).digest("hex")}`;

const assertStaticIdentity = (previous: ContainedTurnOperation, next: ContainedTurnOperation): void => {
  if (
    previous.operationId !== next.operationId || previous.commandId !== next.commandId ||
    previous.commandFingerprint !== next.commandFingerprint || previous.effectId !== next.effectId ||
    previous.scope.tenantId !== next.scope.tenantId || previous.scope.projectId !== next.scope.projectId
  ) {
    throw new Error("contained turn mutation changed static identity");
  }
  if (next.revision !== previous.revision + 1) {throw new Error("contained turn mutation did not advance one revision");}
};

const verifyProjections = (
  operation: ContainedTurnOperation,
  outputs: readonly OutputRow[],
  receipts: readonly ReceiptRow[],
): void => {
  if (outputs.length !== operation.output.chunks.length || receipts.length !== operation.receipts.length) {
    throw new Error("contained turn projection cardinality mismatch");
  }
  for (const [index, chunk] of operation.output.chunks.entries()) {
    const row = outputs[index];
    if (row?.cursor !== chunk.cursor || row.output_kind !== chunk.kind || row.output_text !== chunk.text) {
      throw new Error("contained turn output projection mismatch");
    }
  }
  const receiptByKind = new Map(receipts.map(receipt => [receipt.receipt_kind, receipt.receipt_ref]));
  for (const receipt of operation.receipts) {
    if (receiptByKind.get(receipt.kind) !== receipt.receiptRef) {
      throw new Error("contained turn receipt projection mismatch");
    }
  }
};

const verifyRowIdentity = (operation: ContainedTurnOperation, row: OperationRow): void => {
  if (
    operation.operationId !== row.operation_id || operation.commandId !== row.command_id ||
    operation.commandFingerprint !== row.command_fingerprint || operation.effectId !== row.effect_id ||
    operation.scope.tenantId !== row.tenant_id || operation.revision !== Number(row.revision) ||
    (operation.terminal.kind === "terminal") !== row.terminal
  ) {
    throw new Error("contained turn authoritative row mismatch");
  }
};

export class PostgresContainedTurnOperationStore implements ContainedTurnOperationStore {
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
    } finally {
      client.release();
    }
  }

  async #load(client: PoolClient, operationId: string, lock: boolean): Promise<ContainedTurnOperation | undefined> {
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
    verifyRowIdentity(operation, row);
    const outputs = await client.query<OutputRow>(
      `SELECT cursor, output_kind, output_text
         FROM agent_execution.contained_turn_output_v1
        WHERE operation_id = $1 ORDER BY cursor`,
      [operationId],
    );
    const receipts = await client.query<ReceiptRow>(
      `SELECT receipt_kind, receipt_ref
         FROM agent_execution.contained_turn_receipt_v1
        WHERE operation_id = $1 ORDER BY receipt_kind`,
      [operationId],
    );
    verifyProjections(operation, outputs.rows, receipts.rows);
    return operation;
  }

  async #insert(client: PoolClient, operation: ContainedTurnOperation): Promise<boolean> {
    const encoded = encodeContainedTurnState(operation);
    const inserted = await client.query(
      `INSERT INTO agent_execution.contained_turn_operation_v1(
         operation_id, tenant_id, command_id, command_fingerprint, effect_id,
         revision, state, state_digest, terminal
       ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)
       ON CONFLICT (tenant_id, command_id) DO NOTHING
       RETURNING operation_id`,
      [
        operation.operationId,
        operation.scope.tenantId,
        operation.commandId,
        operation.commandFingerprint,
        operation.effectId,
        operation.revision,
        encoded.json,
        encoded.digest,
        false,
      ],
    );
    if (inserted.rowCount !== 1) {return false;}
    await this.#insertNewProjections(client, undefined, operation);
    return true;
  }

  async #insertNewProjections(
    client: PoolClient,
    previous: ContainedTurnOperation | undefined,
    next: ContainedTurnOperation,
  ): Promise<void> {
    const previousReceipts = new Map(previous?.receipts.map(receipt => [receipt.kind, receipt.receiptRef]));
    const nextReceipts = new Map(next.receipts.map(receipt => [receipt.kind, receipt.receiptRef]));
    for (const [receiptKind, receiptRef] of previousReceipts) {
      if (nextReceipts.get(receiptKind) !== receiptRef) {throw new Error("contained turn receipt history is not append-only");}
    }
    for (const receipt of next.receipts) {
      if (previousReceipts.has(receipt.kind)) {continue;}
      await client.query(
        "INSERT INTO agent_execution.contained_turn_receipt_v1(operation_id, receipt_kind, receipt_ref) VALUES ($1, $2, $3)",
        [next.operationId, receipt.kind, receipt.receiptRef],
      );
    }
    const previousChunks = previous?.output.chunks ?? [];
    for (const [index, chunk] of previousChunks.entries()) {
      const nextChunk = next.output.chunks[index];
      if (nextChunk?.cursor !== chunk.cursor || nextChunk.kind !== chunk.kind || nextChunk.text !== chunk.text) {
        throw new Error("contained turn output history is not append-only");
      }
    }
    for (const chunk of next.output.chunks.slice(previousChunks.length)) {
      await client.query(
        "INSERT INTO agent_execution.contained_turn_output_v1(operation_id, cursor, output_kind, output_text) VALUES ($1, $2, $3, $4)",
        [next.operationId, chunk.cursor, chunk.kind, chunk.text],
      );
    }
  }

  async #persist(client: PoolClient, previous: ContainedTurnOperation, next: ContainedTurnOperation): Promise<void> {
    assertStaticIdentity(previous, next);
    const encoded = encodeContainedTurnState(next);
    const updated = await client.query(
      `UPDATE agent_execution.contained_turn_operation_v1
          SET revision = $3, state = $4::jsonb, state_digest = $5, terminal = $6
        WHERE operation_id = $1 AND revision = $2`,
      [
        next.operationId,
        previous.revision,
        next.revision,
        encoded.json,
        encoded.digest,
        next.terminal.kind === "terminal",
      ],
    );
    if (updated.rowCount !== 1) {throw new Error("contained turn PostgreSQL revision fence failed under row lock");}
    await this.#insertNewProjections(client, previous, next);
  }

  async #transition(
    operationId: string,
    expectedRevision: number,
    mutation: (current: ContainedTurnOperation) => ContainedTurnMutation,
  ): Promise<CompareAndSetContainedTurnOutcome> {
    return this.#transaction(async client => {
      const current = await this.#load(client, operationId, true);
      if (current === undefined) {return { kind: "not_found" };}
      if (current.revision !== expectedRevision) {return { current, kind: "stale" };}
      const next = applyContainedTurnMutation(current, mutation(current));
      await this.#persist(client, current, next);
      return { kind: "applied", operation: next };
    });
  }

  public async accept(input: AcceptContainedTurnCommandInput): Promise<AcceptContainedTurnCommandOutcome> {
    const fingerprint = commandFingerprint(input);
    return this.#transaction(async client => {
      const operation = createAcceptedContainedTurnOperation({
        acceptanceReceiptRef: this.#identities.nextId("acceptance"),
        commandFingerprint: fingerprint,
        commandId: input.commandId,
        effectId: this.#identities.nextId("effect"),
        intent: input.intent,
        operationId: this.#identities.nextId("operation"),
        providerBinding: input.providerBinding,
        scope: input.scope,
        securityDecision: input.securityDecision,
      });
      if (await this.#insert(client, operation)) {return { kind: "accepted", operation };}
      const existingId = await client.query<{ operation_id: string }>(
        `SELECT operation_id FROM agent_execution.contained_turn_operation_v1
          WHERE tenant_id = $1 AND command_id = $2 FOR UPDATE`,
        [input.scope.tenantId, input.commandId],
      );
      const operationId = existingId.rows[0]?.operation_id;
      if (operationId === undefined) {throw new Error("contained turn identity collision outside command authority");}
      const existing = await this.#load(client, operationId, false);
      if (existing === undefined) {throw new Error("contained turn disappeared after command conflict");}
      return existing.commandFingerprint === fingerprint
        ? { kind: "replayed", operation: existing }
        : { kind: "conflict" };
    });
  }

  public async claimDispatch(input: {
    readonly cutoffReceiptRef: string;
    readonly expectedRevision: number;
    readonly operationId: string;
  }): Promise<ClaimContainedTurnDispatchOutcome> {
    const result = await this.#transition(input.operationId, input.expectedRevision, () => ({
      attemptId: this.#identities.nextId("attempt"),
      claimRef: this.#identities.nextId("claim"),
      cutoffReceiptRef: input.cutoffReceiptRef,
      kind: "dispatch_claimed",
    }));
    return result.kind === "applied" ? { kind: "claimed", operation: result.operation } : result;
  }

  public compareAndSet(input: {
    readonly expectedRevision: number;
    readonly mutation: ContainedTurnMutation;
    readonly operationId: string;
  }): Promise<CompareAndSetContainedTurnOutcome> {
    return this.#transition(input.operationId, input.expectedRevision, () => input.mutation);
  }

  public preventDispatch(input: {
    readonly expectedRevision: number;
    readonly operationId: string;
    readonly proofRef: string;
  }): Promise<CompareAndSetContainedTurnOutcome> {
    return this.#transition(input.operationId, input.expectedRevision, () => ({
      kind: "dispatch_prevented",
      receiptRef: input.proofRef,
    }));
  }

  public async read(operationId: string): Promise<ContainedTurnOperation | undefined> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const operation = await this.#load(client, operationId, false);
      await client.query("COMMIT");
      return operation;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public requestCancellation(input: {
    readonly expectedRevision: number;
    readonly operationId: string;
  }): Promise<CompareAndSetContainedTurnOutcome> {
    return this.#transition(input.operationId, input.expectedRevision, () => ({
      kind: "cancellation_requested",
      requestRef: deterministicReceiptRef("cancel", input.operationId),
    }));
  }

  public terminalize(input: {
    readonly expectedRevision: number;
    readonly operationId: string;
  }): Promise<CompareAndSetContainedTurnOutcome> {
    return this.#transition(input.operationId, input.expectedRevision, () => ({
      kind: "terminalize",
      receiptRef: deterministicReceiptRef("terminal", input.operationId),
    }));
  }
}
