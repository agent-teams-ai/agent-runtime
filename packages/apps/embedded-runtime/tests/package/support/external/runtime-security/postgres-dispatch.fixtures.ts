import assert from "node:assert/strict";
import { createContainedTurnDispatchAuthorityFeature, createNodeSha256DispatchDigest,createPostgresDispatchConsumptionRepository } from "@agent-teams/runtime-security/composition";
import type { DispatchPgClient, DispatchPgDeadlines, DispatchPgPool } from
  "@agent-teams/runtime-security/composition";
import { authority, input, scope } from "./contained-turn-dispatch-authority.fixtures.ts";
export { authority, input, scope };

type Row = Record<string, unknown>;
type Result = { rows: Row[]; rowCount: number | null };
type Table = "decisions" | "authority_heads" | "consume_requests" | "consumptions" | "settlement_requests";
type Write = { table: Table; key: string; row: Row };
export const deferred = <Value = void>() => {
  let complete!: (value: Value | PromiseLike<Value>) => void;
  const promise = new Promise<Value>(resolve => {complete = resolve;});
  return { promise, resolve: complete };
};
const result = (rows: Row[] = [], rowCount = rows.length): Result => ({ rows, rowCount });
// The adapter stores JSON source text, preserving lone UTF-16 surrogates losslessly.
const storedText = (value: unknown): string => String(value);

/** Synthetic SQL driver only: staged writes, shared committed state, connection locks.
 * This is fault-injection evidence, not an implementation of PostgreSQL or a durability claim.
 */
export class DispatchDatabase implements DispatchPgPool {
  version: number | undefined;
  readonly tables: Record<Table, Map<string, Row>> = {
    decisions: new Map(), authority_heads: new Map(), consume_requests: new Map(),
    consumptions: new Map(), settlement_requests: new Map(),
  };
  readonly clients: DispatchClient[] = [];
  readonly events: { client: number; sql: string; values: unknown[] }[] = [];
  readonly locks = new Map<string, DispatchClient>();
  private readonly waiters = new Map<string, (() => void)[]>();
  hook?: (client: DispatchClient, sql: string, values: unknown[],
    execute: () => Promise<Result>) => Promise<Result>;
  connectHook?: (client: DispatchClient) => Promise<void>;
  async connect(): Promise<DispatchClient> {
    const client = new DispatchClient(this, this.clients.length);
    this.clients.push(client);
    await this.connectHook?.(client);
    return client;
  }
  async acquire(key: string, client: DispatchClient): Promise<void> {
    while (this.locks.has(key)) {
      await new Promise<void>(resolve => {
        const queue = this.waiters.get(key) ?? [];
        queue.push(resolve);
        this.waiters.set(key, queue);
      });
    }
    if (client.released) {throw new Error("discarded waiter");}
    this.locks.set(key, client);
  }
  unlock(client: DispatchClient): void {
    for (const [key, holder] of this.locks) {
      if (holder !== client) {continue;}
      this.locks.delete(key);
      this.waiters.get(key)?.shift()?.();
    }
  }
  assertReleased(): void {
    assert.equal(this.locks.size, 0);
    for (const client of this.clients) {assert.equal(client.releaseCount, 1);}
  }
}
export class DispatchClient implements DispatchPgClient {
  released = false;
  releaseCount = 0;
  discarded = false;
  begun = false;
  private writes: Write[] = [];
  private migrated = false;
  readonly db: DispatchDatabase;
  readonly id: number;
  constructor(db: DispatchDatabase, id: number) {this.db = db; this.id = id;}
  async query(sql: string, values: unknown[] = []): Promise<Result> {
    this.db.events.push({ client: this.id, sql, values: structuredClone(values) });
    const execute = () => this.execute(sql, values);
    return this.db.hook === undefined ? execute() : this.db.hook(this, sql, values, execute);
  }
  release(discard = false): void {
    this.releaseCount += 1;
    assert.equal(this.releaseCount, 1);
    this.released = true;
    this.discarded = discard;
    this.writes = [];
    this.db.unlock(this);
  }
  private rows(table: Table): Map<string, Row> {
    return new Map([...this.db.tables[table], ...this.writes.filter(w => w.table === table)
      .map(w => [w.key, w.row] as const)]);
  }
  private readConsumption(values: unknown[]): Result {
      const c = this.rows("consumptions").get(String(values[0]));
      if (c === undefined) {return result();}
      const r = this.rows("consume_requests").get(String(c.request_key));
      return result([{ ...c, consume_fact: r !== undefined && r.operation_key === c.operation_key ? r.fact : null }]);
  }
  private async execute(sql: string, values: unknown[]): Promise<Result> {
    assert.equal(this.released, false);
    if (sql.startsWith("BEGIN")) {assert.equal(this.begun, false); this.begun = true; return result();}
    assert.equal(this.begun, true);
    if (sql === "COMMIT" || sql === "ROLLBACK") {
      return this.finishTransaction(sql);
    }
    if (sql.includes("set_config(")) {return result();}
    if (sql.includes("pg_advisory_xact_lock")) {
      await this.db.acquire(String(values[0]), this);
      return result();
    }
    if (sql.includes("CREATE SCHEMA")) {this.migrated = true; return result();}
    if (sql.includes("SELECT version")) {
      const version = this.db.version ?? (this.migrated ? 1 : undefined);
      if (version === undefined) {throw new Error("unmigrated synthetic schema");}
      return result([{ version }]);
    }
    assert.ok([...this.db.locks.values()].includes(this), "owner lock precedes reads and writes");
    if (sql.startsWith("SELECT c.operation_key")) {return this.readConsumption(values);}
    if (sql.includes("FROM runtime_security_dispatch_v1.settlement_requests WHERE operation_key")) {
      return result([...this.rows("settlement_requests").values()].filter(row => row.operation_key === values[0]).map(row => structuredClone(row)));
    }
    if (sql.includes('runtime_security_dispatch_acceptance_v1.decisions')) {
      return this.acceptanceDecision(sql, values);
    }
    const table = sql.match(/runtime_security_dispatch_v1\.(authority_heads|consume_requests|consumptions|settlement_requests)/u)?.[1] as Table;
    assert.ok(table, `unsupported synthetic SQL: ${sql}`);
    if (sql.startsWith("SELECT")) {
      const row = this.rows(table).get(String(values[0]));
      return result(row === undefined ? [] : [structuredClone(row)]);
    }
    return this.writeRow(sql, values, table);
  }
  private finishTransaction(sql: string): Result {
    if (sql === "COMMIT") {
      for (const { table, key, row } of this.writes) {this.db.tables[table].set(key, row);}
      if (this.migrated) {this.db.version ??= 1;}
    }
    this.writes = [];
    this.begun = false;
    this.db.unlock(this);
    return result();
  }
  private acceptanceDecision(sql: string, values: unknown[]): Result {
    const key = String(values[0]);
    const current = this.rows('decisions').get(key);
    if (sql.startsWith('SELECT')) {return result(current === undefined ? [] : [structuredClone(current)]);}
    assert.ok(sql.startsWith('INSERT') && sql.includes('ON CONFLICT'));
    if (current !== undefined) {return result([], 0);}
    this.writes.push({ table: 'decisions', key, row: { decision: values[1] } });
    return result([], 1);
  }
  private writeRow(sql: string, values: unknown[], table: Table): Result {
    const key = String(values[0]);
    const current = this.rows(table).get(key);
    if (sql.startsWith("UPDATE")) {
      assert.equal(table, "authority_heads", "historical rows must never be updated");
      if (current === undefined || current.head_version !== values[4] || current.selector !== storedText(values[1])) {
        return result([], 0);
      }
      assert.equal(BigInt(String(values[2])), BigInt(String(current.head_version)) + 1n);
    } else {
      assert.ok(sql.startsWith("INSERT"));
      assert.equal(current, undefined, "unique scoped record");
    }
    let row: Row;
    if (table === "authority_heads") {
      row = { operation_key: key, selector: storedText(values[1]), head_version: values[2],
        authority: values[3] === null ? null : storedText(values[3]) };
    } else if (table === "consumptions") {
      assert.equal(this.rows("consume_requests").get(String(values[1]))?.operation_key, key);
      row = { operation_key: key, request_key: values[1], receipt: storedText(values[2]) };
    } else if (table === "consume_requests") {
      row = { request_key: key, operation_key: values[1], fact: storedText(values[2]) };
    } else {
      if (values[2] === true) {
        assert.equal([...this.rows(table).values()].some(r =>
          r.operation_key === values[1] && r.applies === true), false, "one applied settlement");
      }
      row = { request_key: key, operation_key: values[1], applies: values[2], fact: storedText(values[3]) };
    }
    this.writes.push({ table, key, row });
    return result([], 1);
  }
}

export const operation = (value = input()) => ({ scope: value.scope, providerId: value.providerId,
  authorityGeneration: value.authorityGeneration, operationId: value.operationId });
export const grant = (value = input()) => ({ ...operation(value), grantRequestId: value.grantRequestId });
export const createHarness = (db = new DispatchDatabase(), options: Partial<DispatchPgDeadlines> = {}) => {
  let now = 100;
  const digest = createNodeSha256DispatchDigest();
  const repository = createPostgresDispatchConsumptionRepository({ pool: db, digest,
    connectTimeoutMs: 200, queryTimeoutMs: 200, transactionTimeoutMs: 2_000, ...options });
  const api = createContainedTurnDispatchAuthorityFeature({ repository, digest,
    clock: { now: () => now } }).dispatchAuthorityV1;
  return { db, repository, api, setTime: (value: number) => {now = value;} };
};
export const seeded = async () => {
  const fixture = createHarness();
  await fixture.repository.migrate();
  assert.deepEqual(await fixture.repository.replaceAuthority(authority(), "0"),
    { status: "applied", headVersion: "1" });
  return fixture;
};
export const settlement = (consumptionDigest: string, overrides = {}) => ({
  ...grant(), settlementRequestId: "settlement-a", consumptionDigest,
  disposition: "claim_committed" as const, ...overrides,
});
export const unavailable = Object.freeze({ status: "indeterminate", reason: "owner_unavailable" });
