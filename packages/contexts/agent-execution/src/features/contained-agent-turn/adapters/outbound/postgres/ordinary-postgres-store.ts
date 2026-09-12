import {randomUUID} from "node:crypto";
import type {Pool, PoolClient, QueryConfig} from "pg";
import type {OrdinaryOperationStore} from "../../../application/ordinary-ports.js";
import {containedTurnCommandFingerprint} from "../../../domain/contained-turn-authority.js";
import {ORDINARY_PROFILE, type OrdinaryOperation, type OrdinaryPreparation, type OrdinaryReceipt, type OrdinaryOperationRef, type OrdinaryInput, type OrdinaryOutput} from "../../../domain/ordinary-model.js";
import {ordinaryPreparationDigest, ordinaryTerminalStatus, validateOrdinaryInput, validateOrdinaryOperation} from "../../../domain/ordinary-validation.js";
import {decodeOrdinaryState, encodeOrdinaryState} from "./ordinary-state-codec.js";

const query = (text: string, values: unknown[] = []): QueryConfig<unknown[]> & {readonly query_timeout: number} => ({text, values, query_timeout: 5000});
export const ORDINARY_POSTGRES_SCHEMA = `CREATE TABLE IF NOT EXISTS ordinary_turn_operations_v3 (
 tenant_id text NOT NULL, project_id text NOT NULL, command_id text NOT NULL,
 operation_id text NOT NULL, revision bigint NOT NULL CHECK (revision >= 0), state text NOT NULL,
 PRIMARY KEY (tenant_id, project_id, operation_id), UNIQUE (tenant_id, project_id, command_id)
)`;
/** Explicit migration, never an effect of constructing the borrowed-pool adapter. */
export const applyOrdinaryPostgresSchema = async (pool: Pool): Promise<void> => {await pool.query(query(ORDINARY_POSTGRES_SCHEMA));};
class UnknownCommit extends Error {constructor() {super("ordinary transaction outcome requires readback");}}
interface StateRow {readonly state: string}
const refValues = (ref: OrdinaryOperationRef): readonly string[] => [ref.scope.tenantId, ref.scope.projectId, ref.operationId];
const refFor = (operation: OrdinaryOperation): OrdinaryOperationRef => ({operationId: operation.operationId, scope: operation.scope});
export class PostgresOrdinaryOperationStore implements OrdinaryOperationStore {
  readonly #pool: Pool;
  constructor(options: {readonly pool: Pool}) {this.#pool = options.pool;}
  async #transaction<T>(body: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await new Promise<PoolClient>((resolve, reject) => {
      let expired = false;
      const timer = setTimeout(() => {expired = true; reject(new Error("ordinary database acquisition timed out"));}, 5000);
      void this.#pool.connect().then(acquired => {clearTimeout(timer); if (expired) {acquired.release();} else {resolve(acquired);}}, error => {clearTimeout(timer); if (!expired) {reject(error);}});
    }); let committing = false; let broken = false;
    try {
      await client.query(query("BEGIN"));
      await client.query("SET LOCAL statement_timeout = '5000ms'");
      await client.query("SET LOCAL lock_timeout = '3000ms'");
      await client.query("SET LOCAL idle_in_transaction_session_timeout = '10000ms'");
      const result = await body(client); committing = true;
      await client.query(query("COMMIT")); return result;
    } catch (error) {
      if (committing) {broken = true; throw new UnknownCommit();}
      try {await client.query(query("ROLLBACK"));} catch {broken = true;}
      throw error;
    } finally {client.release(broken);}
  }
  async #read(client: Pick<PoolClient, "query">, ref: OrdinaryOperationRef, locked = false): Promise<OrdinaryOperation | undefined> {
    const result = await client.query<StateRow>(query(`SELECT state FROM ordinary_turn_operations_v3 WHERE tenant_id=$1 AND project_id=$2 AND operation_id=$3${locked ? " FOR UPDATE" : ""}`, [...refValues(ref)]));
    const row = result.rows[0]; return row === undefined ? undefined : decodeOrdinaryState(row.state);
  }
  async #write(client: PoolClient, previous: OrdinaryOperation, next: OrdinaryOperation): Promise<OrdinaryOperation> {
    validateOrdinaryOperation(next);
    const result = await client.query("UPDATE ordinary_turn_operations_v3 SET state=$4, revision=$5 WHERE tenant_id=$1 AND project_id=$2 AND operation_id=$3 AND revision=$6", [...refValues(refFor(previous)), encodeOrdinaryState(next), next.revision, previous.revision]);
    if (result.rowCount !== 1) {throw new Error("ordinary operation CAS conflict");}
    return next;
  }
  async accept(input: OrdinaryInput): ReturnType<OrdinaryOperationStore["accept"]> {
    validateOrdinaryInput(input);
    const fingerprint = containedTurnCommandFingerprint({scope: input.scope, intent: input.intent, provider: input.expectedProvider});
    const operation: OrdinaryOperation = {schemaVersion: 3, ...ORDINARY_PROFILE, operationId: `ordinary:${randomUUID()}`, attemptId: `attempt:${randomUUID()}`, effectId: `effect:${randomUUID()}`, commandId: input.commandId, fingerprint, scope: {...input.scope}, input: {commandId: input.commandId, expectedProvider: input.expectedProvider, intent: {...input.intent}, scope: {...input.scope}}, preparation: null, revision: 0, status: "accepted", cancellationRequested: false, output: [], receipts: []};
    try {return await this.#transaction(async client => {
      const inserted = await client.query("INSERT INTO ordinary_turn_operations_v3 (tenant_id,project_id,command_id,operation_id,revision,state) VALUES ($1,$2,$3,$4,0,$5) ON CONFLICT (tenant_id,project_id,command_id) DO NOTHING", [input.scope.tenantId, input.scope.projectId, input.commandId, operation.operationId, encodeOrdinaryState(operation)]);
      if (inserted.rowCount === 1) {return {kind: "accepted", operation};}
      const existing = await client.query<StateRow>("SELECT state FROM ordinary_turn_operations_v3 WHERE tenant_id=$1 AND project_id=$2 AND command_id=$3", [input.scope.tenantId, input.scope.projectId, input.commandId]);
      const row = existing.rows[0]; if (row === undefined) {throw new Error("ordinary acceptance disappeared");}
      const prior = decodeOrdinaryState(row.state);
      return prior.fingerprint === fingerprint ? {kind: "duplicate", operation: prior} : {kind: "conflict"};
    });} catch (error) {
      if (!(error instanceof UnknownCommit)) {throw error;}
      // Even positive readback is a duplicate; an unacknowledged accept never grants dispatch ownership.
      try {
        const prior = await this.read(refFor(operation));
        if (prior !== undefined) {return {kind: "duplicate", operation: prior};}
      } catch { /* retain uncertainty without retry */ }
      return {kind: "unknown", candidateOperationId: operation.operationId, evidenceId: `unknown:${randomUUID()}`};
    }
  }
  async read(ref: OrdinaryOperationRef): Promise<OrdinaryOperation | undefined> {return this.#read(this.#pool, ref);}
  async prepare(operation: OrdinaryOperation, preparation: OrdinaryPreparation): Promise<OrdinaryOperation> {
    const now = Date.now();
    if ([preparation.providerAccess.expiresAt, preparation.security.expiresAt].some(expiry => expiry <= now + 10000 || expiry > now + 60000)) {throw new Error("ordinary preparation authority deadline rejected");}
    return this.#transaction(async client => {
      const current = await this.#read(client, refFor(operation), true);
      if (current === undefined || current.revision !== operation.revision || current.status !== "accepted" || current.cancellationRequested || current.preparation !== null) {throw new Error("ordinary preparation rejected");}
      return this.#write(client, current, {...current, revision: current.revision + 1, preparation});
    });
  }
  async claim(operation: OrdinaryOperation): ReturnType<OrdinaryOperationStore["claim"]> {
    try {return await this.#transaction(async client => {
      const current = await this.#read(client, refFor(operation), true);
      if (current === undefined || current.revision !== operation.revision || current.status !== "accepted" || current.cancellationRequested || current.preparation === null || Math.min(current.preparation.security.expiresAt, current.preparation.providerAccess.expiresAt) <= Date.now() + 10000) {return {kind: "not_claimed"};}
      const receipt = {operationId: current.operationId, attemptId: current.attemptId, executionProfile: current.executionProfile, capabilityManifestRevision: current.capabilityManifestRevision, kind: "dispatch_claim", claimId: `claim:${randomUUID()}`, reservationId: current.preparation.reservationId, preparationDigest: ordinaryPreparationDigest(current.preparation), committedRevision: current.revision + 1} as const;
      const next = await this.#write(client, current, {...current, revision: current.revision + 1, status: "running", receipts: [receipt]});
      return {kind: "claimed", operation: next, receipt};
    });} catch (error) {if (error instanceof UnknownCommit) {return {kind: "unknown"};} throw error;}
  }
  async cancel(ref: OrdinaryOperationRef): Promise<OrdinaryOperation | undefined> {
    return this.#transaction(async client => {
      const current = await this.#read(client, ref, true);
      if (current === undefined || !["accepted", "running"].includes(current.status) || current.cancellationRequested) {return current;}
      return this.#write(client, current, {...current, revision: current.revision + 1, cancellationRequested: true});
    });
  }
  async append(operation: OrdinaryOperation, output: Omit<OrdinaryOutput, "cursor">): Promise<OrdinaryOperation> {
    return this.#transaction(async client => {
      const current = await this.#read(client, refFor(operation), true);
      if (current === undefined || current.status !== "running" || current.attemptId !== operation.attemptId) {throw new Error("ordinary output rejected");}
      return this.#write(client, current, {...current, revision: current.revision + 1, output: [...current.output, {cursor: current.output.length + 1, kind: output.kind, text: output.text}]});
    });
  }
  async #terminal(operation: OrdinaryOperation, receipts: readonly OrdinaryReceipt[], reconcile: boolean): Promise<OrdinaryOperation> {
    return this.#transaction(async client => {
      const current = await this.#read(client, refFor(operation), true);
      if (current === undefined || current.attemptId !== operation.attemptId) {throw new Error("ordinary terminal operation missing");}
      if (!["accepted", "running", "reconcile_required"].includes(current.status)) {return current;}
      const merged = [...current.receipts];
      for (const receipt of receipts) {
        const previous = merged.find(item => item.kind === receipt.kind);
        if (previous !== undefined && JSON.stringify(previous) !== JSON.stringify(receipt)) {throw new Error("ordinary immutable receipt conflict");}
        if (previous === undefined) {merged.push(receipt);}
      }
      const candidate = {...current, revision: current.revision + 1, receipts: merged};
      return this.#write(client, current, {...candidate, status: reconcile ? "reconcile_required" : ordinaryTerminalStatus(candidate, merged)});
    });
  }
  async finish(operation: OrdinaryOperation, receipts: readonly OrdinaryReceipt[]): Promise<OrdinaryOperation> {return this.#terminal(operation, receipts, false);}
  async reconcile(operation: OrdinaryOperation, receipts: readonly OrdinaryReceipt[]): Promise<OrdinaryOperation> {return this.#terminal(operation, receipts, true);}
}
