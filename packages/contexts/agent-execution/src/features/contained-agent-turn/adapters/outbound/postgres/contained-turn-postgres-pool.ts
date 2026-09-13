/** Private driver boundary. The caller owns the pool and its shutdown. */
export interface ContainedTurnPostgresQueryResult<Row = Record<string, unknown>> {
  rows: Row[];
  rowCount: number | null;
}

export interface ContainedTurnPostgresClient {
  query<Row = Record<string, unknown>>(
    sql: string,
    values?: unknown[],
  ): Promise<ContainedTurnPostgresQueryResult<Row>>;
  release(discard?: boolean): void;
}

export interface ContainedTurnPostgresPool {
  connect(): Promise<ContainedTurnPostgresClient>;
}
