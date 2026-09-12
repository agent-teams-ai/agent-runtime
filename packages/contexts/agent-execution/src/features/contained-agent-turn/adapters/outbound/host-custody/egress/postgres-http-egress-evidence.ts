import {createHash} from "node:crypto";
import type {HttpEgressReceipt} from "./http-egress-contracts.js";
import type {HttpEgressEvidence} from "./http-egress-ports.js";
import {canonicalHttpEvidenceReceipt, snapshotHttpEvidenceIdentity, snapshotHttpEvidenceScope,
  type PostgresHttpEgressReceiptIdentity,
  type PostgresHttpEgressEvidenceScope} from "./postgres-http-egress-evidence-codec.js";
import {HTTP_EVIDENCE_FENCE, PostgresHttpEvidenceTransactions, type ContainedTurnPostgresPool} from "./postgres-http-egress-evidence-transactions.js";
export type {PostgresHttpEgressEvidenceScope} from "./postgres-http-egress-evidence-codec.js";

/** Explicit administrative initialization of an empty private Host schema.
 * Existing schemas are verified, never repaired or automatically upgraded.
 * The caller owns the borrowed pool and its database/role selection.
 */
export const initializePostgresHttpEgressEvidence = async (pool: ContainedTurnPostgresPool): Promise<void> => {
  await new PostgresHttpEvidenceTransactions(pool).run(async (_client, query) => {
    await query("SELECT pg_advisory_xact_lock(721903522)");
    const existing = await query("SELECT 1 FROM pg_namespace WHERE nspname = 'host_http_egress'");
    if (existing.rows.length === 0) {
      await query("CREATE SCHEMA host_http_egress");
      await query(`CREATE TABLE host_http_egress.version_fence (
        singleton boolean PRIMARY KEY CHECK (singleton), version integer NOT NULL, format text NOT NULL)`);
      await query("INSERT INTO host_http_egress.version_fence VALUES (true, 1, $1)", [HTTP_EVIDENCE_FENCE]);
      await query(`CREATE TABLE host_http_egress.receipt (
        tenant_id text NOT NULL, project_id text NOT NULL, deployment_id text NOT NULL,
        operation_id text NOT NULL, attempt_id text NOT NULL, request_id text NOT NULL,
        canonical_receipt text NOT NULL CHECK (octet_length(canonical_receipt) <= 32768),
        receipt_key text PRIMARY KEY CHECK (length(receipt_key) = 64))`);
    }
    const fence = await query("SELECT version, format FROM host_http_egress.version_fence WHERE singleton = true");
    const fenceRow = fence.rows[0];
    if (fence.rows.length !== 1 || fenceRow === undefined || fenceRow.version !== 1 || fenceRow.format !== HTTP_EVIDENCE_FENCE) {
      throw new Error("HTTP evidence schema fence mismatch");
    }
    await query("SELECT canonical_receipt FROM host_http_egress.receipt LIMIT 0");
    // Match PostgreSQL's column arbiter inference: INCLUDE columns are allowed,
    // but partial, expression and multi-key indexes cannot arbitrate this insert.
    // A matching deferred index also makes ON CONFLICT unusable, even if another
    // matching immediate index exists. Never repair an incompatible schema.
    const uniqueness = await query(`SELECT 1 FROM pg_index i
      JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
      WHERE i.indrelid = 'host_http_egress.receipt'::regclass
        AND a.attname = 'receipt_key' AND NOT a.attisdropped
        AND i.indisunique AND i.indisvalid AND i.indnkeyatts = 1
        AND i.indexprs IS NULL AND i.indpred IS NULL
      HAVING bool_and(i.indimmediate) AND bool_or(i.indisready AND i.indislive)`);
    if (uniqueness.rows.length !== 1) {throw new Error("HTTP evidence receipt_key uniqueness mismatch");}
  });
};

/** Host adapter for the existing HTTP evidence port. No provider effects or retries.
 * Invalid input throws before I/O; uncertain storage returns unknown. Storage
 * retries may only replay the original receipt, never the broker's ack-lost result.
 */
export class PostgresHttpEgressEvidence implements HttpEgressEvidence {
  readonly #scope: PostgresHttpEgressEvidenceScope;
  readonly #transactions: PostgresHttpEvidenceTransactions;
  public constructor(pool: ContainedTurnPostgresPool, scope: PostgresHttpEgressEvidenceScope) {
    this.#scope = snapshotHttpEvidenceScope(scope);
    this.#transactions = new PostgresHttpEvidenceTransactions(pool);
  }
  public digest(parts: readonly Uint8Array[]): string {
    const hash = createHash("sha256");
    for (const part of parts) {hash.update(part);}
    // Request projections cross into RS before signing and use its algorithm-tagged digest contract.
    return `sha256:${hash.digest("hex")}`;
  }
  /** Exact historical HTTP receipt readback, never native listener/execution
   * generation authority or a cleanup/consume command. Missing is not closure.
   * The borrowed pool's role/RLS remains authoritative; this adds no SQL surface.
   */
  public async read(input: PostgresHttpEgressReceiptIdentity): Promise<
    Readonly<{kind: "found"; receipt: HttpEgressReceipt}> | Readonly<{kind: "missing" | "unknown"}>
  > {
    const identity = snapshotHttpEvidenceIdentity(input);
    const key = [this.#scope.tenantId, this.#scope.projectId, this.#scope.deploymentId,
      identity.operationId, identity.attemptId, identity.requestId];
    const keyDigest = createHash("sha256").update(JSON.stringify(key)).digest("hex");
    try {
      return await this.#transactions.run(async (_client, query) => {
        const fence = await query(`SELECT version, format FROM host_http_egress.version_fence
          WHERE singleton = true FOR SHARE`);
        const fenceRow = fence.rows[0];
        if (fence.rows.length !== 1 || fenceRow === undefined || fenceRow.version !== 1 || fenceRow.format !== HTTP_EVIDENCE_FENCE) {
          throw new Error("HTTP evidence schema fence mismatch");
        }
        const stored = await query(`SELECT canonical_receipt FROM host_http_egress.receipt WHERE
          tenant_id=$1 AND project_id=$2 AND deployment_id=$3 AND operation_id=$4 AND attempt_id=$5 AND request_id=$6 AND receipt_key=$7 LIMIT 2`, [...key, keyDigest]);
        if (stored.rows.length === 0) {return Object.freeze({kind: "missing" as const});}
        if (stored.rows.length !== 1) {throw new Error("HTTP evidence read uncertain");}
        const retained: unknown = stored.rows[0]?.canonical_receipt;
        if (typeof retained !== "string" || Buffer.byteLength(retained, "utf8") > 32_768) {
          throw new Error("HTTP evidence retained text invalid");
        }
        const validated = canonicalHttpEvidenceReceipt(JSON.parse(retained));
        if (validated.canonical !== retained || validated.receipt.operationId !== identity.operationId
          || validated.receipt.attemptId !== identity.attemptId || validated.receipt.requestId !== identity.requestId) {
          throw new Error("HTTP evidence retained receipt invalid");
        }
        return Object.freeze({kind: "found" as const, receipt: validated.receipt});
      });
    } catch {return Object.freeze({kind: "unknown" as const});}
  }
  public async record(input: HttpEgressReceipt): Promise<"recorded" | "conflict" | "unknown"> {
    const {receipt, canonical} = canonicalHttpEvidenceReceipt(input);
    const key = [this.#scope.tenantId, this.#scope.projectId, this.#scope.deploymentId,
      receipt.operationId, receipt.attemptId, receipt.requestId];
    // Fixed-size index avoids PostgreSQL btree limits for valid long scoped IDs.
    // Full identity is still compared on read; a hash collision cannot acknowledge another key.
    const keyDigest = createHash("sha256").update(JSON.stringify(key)).digest("hex");
    try {
      return await this.#transactions.run(async (_client, query) => {
        const fence = await query(`SELECT version, format FROM host_http_egress.version_fence
          WHERE singleton = true FOR SHARE`);
        const fenceRow = fence.rows[0];
        if (fence.rows.length !== 1 || fenceRow === undefined || fenceRow.version !== 1 || fenceRow.format !== HTTP_EVIDENCE_FENCE) {
          throw new Error("HTTP evidence schema fence mismatch");
        }
        await query(`INSERT INTO host_http_egress.receipt
          (tenant_id, project_id, deployment_id, operation_id, attempt_id, request_id, canonical_receipt, receipt_key)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (receipt_key) DO NOTHING`, [...key, canonical, keyDigest]);
        // Separate READ COMMITTED statement sees the winner after unique-index waiting.
        const stored = await query(`SELECT canonical_receipt FROM host_http_egress.receipt WHERE
          tenant_id=$1 AND project_id=$2 AND deployment_id=$3 AND operation_id=$4 AND attempt_id=$5 AND request_id=$6 AND receipt_key=$7`, [...key, keyDigest]);
        if (stored.rows.length !== 1) {throw new Error("HTTP evidence read uncertain");}
        const retained: unknown = stored.rows[0]?.canonical_receipt;
        // Retained DB text is untrusted: bound bytes before parsing, then verify
        // the complete canonical receipt and its binding to the selected key.
        if (typeof retained !== "string" || Buffer.byteLength(retained, "utf8") > 32_768) {
          throw new Error("HTTP evidence retained text invalid");
        }
        const validated = canonicalHttpEvidenceReceipt(JSON.parse(retained));
        if (validated.canonical !== retained || validated.receipt.operationId !== receipt.operationId
          || validated.receipt.attemptId !== receipt.attemptId || validated.receipt.requestId !== receipt.requestId) {
          throw new Error("HTTP evidence retained receipt invalid");
        }
        return retained === canonical ? "recorded" : "conflict";
      });
    } catch {return "unknown";}
  }
}
