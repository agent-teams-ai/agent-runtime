import type { Pool, PoolClient } from "pg";

export interface ContainedTurnPostgresTimeouts {
  readonly connectionTimeoutMs: number;
  readonly idleInTransactionTimeoutMs: number;
  readonly lockTimeoutMs: number;
  readonly statementTimeoutMs: number;
}

export interface ContainedTurnPostgresRuntimeFence {
  readonly advisoryLockId: number;
  readonly component: string;
  readonly migrationDigest: string;
  readonly schemaVersion: number;
}

export const CONTAINED_TURN_POSTGRES_TIMEOUT_DEFAULTS: ContainedTurnPostgresTimeouts = Object.freeze({
  connectionTimeoutMs: 5_000,
  idleInTransactionTimeoutMs: 30_000,
  lockTimeoutMs: 5_000,
  statementTimeoutMs: 30_000,
});

const normalizeTimeouts = (
  overrides: Partial<ContainedTurnPostgresTimeouts> = {},
): ContainedTurnPostgresTimeouts => {
  const timeouts = Object.freeze({ ...CONTAINED_TURN_POSTGRES_TIMEOUT_DEFAULTS, ...overrides });
  for (const [name, value] of Object.entries(timeouts)) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 300_000) {
      throw new TypeError(`contained turn PostgreSQL ${name} must be between 1 and 300000 milliseconds`);
    }
  }
  return timeouts;
};

export class PostgresCommitIndeterminateError extends Error {
  public constructor(cause: unknown) {
    super("PostgreSQL commit acknowledgement was indeterminate", { cause });
    this.name = "PostgresCommitIndeterminateError";
  }
}

export class ContainedTurnPostgresTransactions {
  readonly #pool: Pool;
  readonly #runtimeFence: ContainedTurnPostgresRuntimeFence;
  readonly #timeouts: ContainedTurnPostgresTimeouts;

  public constructor(
    pool: Pool,
    runtimeFence: ContainedTurnPostgresRuntimeFence,
    timeouts?: Partial<ContainedTurnPostgresTimeouts>,
  ) {
    this.#pool = pool;
    this.#runtimeFence = runtimeFence;
    this.#timeouts = normalizeTimeouts(timeouts);
  }

  async #connect(): Promise<PoolClient> {
    const pending = this.#pool.connect();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error("contained turn PostgreSQL pool acquisition timed out")),
        this.#timeouts.connectionTimeoutMs,
      );
    });
    try {
      return await Promise.race([pending, timeout]);
    } catch (error) {
      void pending.then(client => client.release(true), () => {});
      throw error;
    } finally {
      if (timer !== undefined) {clearTimeout(timer);}
    }
  }

  async #begin(client: PoolClient, readOnly = false, repeatableRead = false): Promise<void> {
    await client.query(readOnly
      ? "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY"
      : repeatableRead ? "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ" : "BEGIN");
    await client.query(
      `SELECT set_config('lock_timeout', $1, true),
              set_config('statement_timeout', $2, true),
              set_config('idle_in_transaction_session_timeout', $3, true)`,
      [`${String(this.#timeouts.lockTimeoutMs)}ms`, `${String(this.#timeouts.statementTimeoutMs)}ms`,
        `${String(this.#timeouts.idleInTransactionTimeoutMs)}ms`],
    );
    await client.query("SELECT pg_advisory_xact_lock_shared($1)", [this.#runtimeFence.advisoryLockId]);
    const migration = await client.query<{ migration_digest: string; version: number }>(
      `SELECT version, migration_digest
         FROM agent_execution.schema_migration
        WHERE component = $1`,
      [this.#runtimeFence.component],
    );
    const current = migration.rows[0];
    if (current?.version !== this.#runtimeFence.schemaVersion ||
        current.migration_digest !== this.#runtimeFence.migrationDigest) {
      throw new Error("contained turn PostgreSQL runtime schema fence rejected this binary");
    }
    await client.query(
      "SELECT set_config('agent_execution.contained_turn_schema_version', $1, true)",
      [String(this.#runtimeFence.schemaVersion)],
    );
  }

  public async write<Result>(
    work: (client: PoolClient) => Promise<Result>,
    repeatableRead = false,
  ): Promise<Result> {
    const client = await this.#connect();
    let commitStarted = false;
    let discardClient = false;
    try {
      await this.#begin(client, false, repeatableRead);
      const result = await work(client);
      commitStarted = true;
      await client.query("COMMIT");
      return result;
    } catch (error) {
      if (commitStarted) {
        discardClient = true;
        throw new PostgresCommitIndeterminateError(error);
      }
      try {await client.query("ROLLBACK");} catch {discardClient = true;}
      throw error;
    } finally {
      client.release(discardClient);
    }
  }

  public async read<Result>(work: (client: PoolClient) => Promise<Result>): Promise<Result> {
    const client = await this.#connect();
    let discardClient = false;
    try {
      await this.#begin(client, true);
      const result = await work(client);
      await client.query("ROLLBACK");
      return result;
    } catch (error) {
      try {await client.query("ROLLBACK");} catch {discardClient = true;}
      throw error;
    } finally {
      client.release(discardClient);
    }
  }
}
