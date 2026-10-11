import {randomUUID} from "node:crypto";
import {after, test} from "node:test";
import {applyOrdinaryPostgresSchema, PostgresOrdinaryOperationStore} from "@agent-teams/agent-execution/composition";
import {guardHandles, runContractSuite} from "@get-modular/conformance";
import {Pool, type PoolConfig} from "pg";
import {ordinaryStoreDeclaration} from "../../../dist/composition/ordinary-runtime-assembly.js";
import {ordinaryStoreSuite} from "./support/ordinary-store-suite.ts";

const handles = guardHandles();
const connectionString = process.env.ORDINARY_TEST_POSTGRES_URL;

// A pool discards clients after a failed query and closes their sockets without awaiting them; `release` waits for those too.
// The wait has no sleep; in CI the runner's per-test timeout and AbortSignal.timeout bound it.
const ownedPool = (config: PoolConfig): {readonly pool: Pool; readonly release: () => Promise<void>} => {
  const pool = new Pool({connectionString, connectionTimeoutMillis: 5000, ...config});
  const connections: Promise<void>[] = [];
  pool.on("connect", client => {connections.push(new Promise(resolve => {client.once("end", () => {resolve();});}));});
  return {pool, release: async () => {await pool.end(); await Promise.all(connections);}};
};

test("ordinary operation store contract suite against PostgreSQL", {skip: connectionString === undefined}, async t => {
  const pending: Promise<unknown>[] = [];
  runContractSuite(ordinaryStoreSuite, {
    name: "postgres",
    declaration: ordinaryStoreDeclaration,
    create: async ({resources}) => {
      // One schema per case, as in ordinary-core-postgres.test.ts; released in reverse order.
      const schema = `ordinary_suite_${randomUUID().replaceAll("-", "")}`;
      await resources.setup({
        name: "schema",
        setup: async () => {
          const admin = ownedPool({max: 1, query_timeout: 5000});
          try {await admin.pool.query(`CREATE SCHEMA ${schema}`);} catch (error) {await admin.release(); throw error;}
          return admin;
        },
        cleanup: async admin => {
          try {await admin.pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);} finally {await admin.release();}
        },
      });
      const {pool} = await resources.setup({
        name: "pool",
        setup: () => ownedPool({options: `-c search_path=${schema}`, max: 4, query_timeout: 10000}),
        cleanup: owned => owned.release(),
      });
      await applyOrdinaryPostgresSchema(pool);
      return new PostgresOrdinaryOperationStore({pool});
    },
  }, (name, body) => {pending.push(t.test(name, body));});
  await Promise.all(pending);
});

after(() => handles.check());
