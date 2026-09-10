import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp, mkdir, writeFile, rm, realpath} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createHash} from "node:crypto";
import {preflightDarwinInfrastructure} from "./darwin-live-infrastructure.mjs";
import {plainJson} from "./darwin-live-activation-manifest.mjs";

test("activation rejects nested executable material without invoking accessors", () => {
  for (const value of [{nested: {callback() {}}}, {nested: {credentials: "secret"}}, {nested: undefined}]) {
    assert.throws(() => plainJson(value), /activation infrastructure/);
  }
  let called = false;
  assert.throws(() => plainJson({get nested() {called = true; return {};}}));
  assert.equal(called, false);
  assert.deepEqual(plainJson({nested: {count: 1, names: ["x"]}}), {nested: {count: 1, names: ["x"]}});
});

test("preflight actively reads database, filesystem, policy and socket and awaits pool close", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ar69-preflight-")));
  try {
    for (const name of ["auth", "sandbox"]) {await mkdir(join(root, name), {mode: 0o700});}
    const policy = Buffer.from(JSON.stringify({tenantId: "test-t", projectId: "test-p", policyRevision: "test-v1",
      validFrom: Date.now() - 1000, expiresAt: Date.now() + 60000}));
    const policyPath = join(root, "policy.json"); await writeFile(policyPath, policy, {mode: 0o400});
    const activation = {turn: {scope: {tenantId: "test-t", projectId: "test-p"}, resultPath: join(root, "result.txt")},
      native: {packet: {hostUid: process.getuid()}}, infrastructure: {
        database: {connection: {database: "ar69_test_probe", host: "127.0.0.1", port: 5432, user: "test"}},
        filesystem: {sourceRoot: root}, host: {endpointPath: join(root, "host.sock")},
        runtimeSecurity: {policyRevision: "test-v1", policyFile: {path: policyPath, sha256: createHash("sha256").update(policy).digest("hex")}},
        providerAccess: {codexHome: join(root, "auth"), sandbox: join(root, "sandbox")}}};
    let closed = false, socketRead = false, occupied = false, bypassRls = true;
    const statements = [];
    let tables = [{schemaname: "application", tablename: "operations"}];
    class Pool {
      async connect() {return {release() {}, async query(sql) {
        statements.push(sql);
        if (sql.includes("FROM pg_roles")) {return {rows: [{rolsuper: false, rolbypassrls: bypassRls}]};}
        if (sql.startsWith("SELECT current_database")) {return {rows: [{database: "ar69_test_probe", username: "test", address: "127.0.0.1", port: 5432}]};}
        if (sql.includes("FROM pg_tables")) {return {rows: tables};}
        if (sql.startsWith("SELECT 1")) {return {rows: occupied ? [{}] : []};}
        return {rows: []};
      }};}
      async end() {await Promise.resolve(); closed = true;}
    }
    const deps = {Pool, socketProbe: async () => {socketRead = true;}};
    assert.deepEqual(await preflightDarwinInfrastructure(activation, deps), {
      hostEndpointReachable: true, databaseEmpty: true, sourceResultAbsent: true, providerAuthoritiesFresh: true, mutated: false});
    assert.equal(closed, true); assert.equal(socketRead, true);
    assert.ok(statements.includes("BEGIN READ ONLY")); assert.ok(statements.includes("ROLLBACK"));
    bypassRls = false;
    await assert.rejects(preflightDarwinInfrastructure(activation, deps), /row visibility/);
    bypassRls = true;
    assert.ok(statements.includes("SET LOCAL row_security = off"));
    occupied = true; closed = false;
    await assert.rejects(preflightDarwinInfrastructure(activation, deps), /application rows/);
    assert.equal(closed, true);
    occupied = true;
    tables = [{schemaname: "agent_execution", tablename: "schema_migration"},
      {schemaname: "agent_execution", tablename: "schema_migration_history"}];
    await preflightDarwinInfrastructure(activation, deps);
    tables = [{schemaname: "arbitrary", tablename: "schema_migration"}];
    await assert.rejects(preflightDarwinInfrastructure(activation, deps), /application rows/);
    tables = []; occupied = false;
    const originalRoot = activation.infrastructure.filesystem.sourceRoot;
    activation.infrastructure.filesystem.sourceRoot = originalRoot + "/../" + originalRoot.split("/").at(-1);
    await assert.rejects(preflightDarwinInfrastructure(activation, deps), /result outside test source/);
    activation.infrastructure.filesystem.sourceRoot = originalRoot;
    occupied = false; await writeFile(activation.turn.resultPath, "already ran");
    await assert.rejects(preflightDarwinInfrastructure(activation, deps), /source result exists/);
  } finally {await rm(root, {recursive: true, force: true});}
});

test("persistence uses public migrations and closes owners and pool after construction failure", async () => {
  const {acquireDarwinPersistenceOwners} = await import("./darwin-live-infrastructure.mjs");
  const events = [];
  class Pool {async connect() {return {release() {}, async query() {return {rows: [{database: "ar69_test_lifecycle", username: "test", address: "127.0.0.1", port: 5432}]};}};} async query() {return {rows: []};} async end() {await Promise.resolve(); events.push("pool-end");}}
  const repository = {async migrate() {events.push("rs-migrate");}, async close() {await Promise.resolve(); events.push("rs-close");}};
  const decisions = {async migrate() {throw new Error("migration refused");}, async close() {await Promise.resolve(); events.push("decisions-close");}};
  const dependencies = {Pool, agentExecution: {
    async applyContainedTurnPostgresSchema() {events.push("ae-migrate");},
    async initializePostgresHttpEgressEvidence() {events.push("http-migrate");},
  }, runtimeSecurity: {createNodeSha256DispatchDigest: () => ({}),
    createPostgresDispatchConsumptionRepository: () => repository,
    createPostgresDispatchAcceptanceStore: () => decisions}};
  await assert.rejects(acquireDarwinPersistenceOwners({infrastructure: {
    database: {connection: {database: "ar69_test_lifecycle", host: "127.0.0.1", port: 5432, user: "test"}}}}, dependencies), /migration refused/);
  assert.deepEqual(events, ["ae-migrate", "http-migrate", "rs-migrate", "decisions-close", "rs-close", "pool-end"]);
});

test("launch records retain PA credential inventory without expecting a fabricated return boolean", async () => {
  const {createDarwinLaunchRecords} = await import("./darwin-live-infrastructure.mjs");
  const activation = {turn: {operationId: "op", attemptId: "attempt", effectId: "effect"}, codex: {path: "/test/codex"}};
  const native = {boundary: {}, privateRootPath: "/test/private", tmpDir: "/test/tmp"};
  let count = 0;
  const owner = createDarwinLaunchRecords(activation, native, (operation, consume) => {
    count += 1; assert.equal(operation, "op");
    assert.equal(consume({credentialBindingDigest: "digest", credentialGeneration: 1, sensitiveOutputTokens: ["synthetic-secret"]}), true);
    // Accepted PA returns void after verifying the callback result.
  });
  const input = {operationId: "op", attemptId: "attempt", effectId: "effect", providerBinding: {provider: "codex"},
    credentialBindingDigest: "digest", credentialGeneration: 1};
  assert.equal(await owner.resolve({...input, operationId: "foreign"}), undefined);
  assert.equal(count, 0);
  const record = await owner.resolve(input);
  assert.equal(record.boundary, native.boundary);
  assert.deepEqual(record.credentialOutputInventory.sensitiveOutputTokens, ["synthetic-secret"]);
  assert.equal(count, 1);
});

 test("database connection overrides refuse before constructing a pool", async () => {
  const {acquireDarwinPersistenceOwners} = await import("./darwin-live-infrastructure.mjs");
  let constructed = false;
  await assert.rejects(acquireDarwinPersistenceOwners({infrastructure: {database: {connection: {
    database: "ar69_test_probe", host: "127.0.0.1", port: 5432, user: "test",
    connectionString: "postgresql://production.example/production"}}}},
  {Pool: class {constructor() {constructed = true;}}}), /database configuration/);
  assert.equal(constructed, false);
});

test("database identity mismatch prevents all migrations and awaits close", async () => {
  const {acquireDarwinPersistenceOwners} = await import("./darwin-live-infrastructure.mjs");
  let migrated = false, closed = false;
  class Pool {
    async connect() {return {release() {}, async query() {return {rows: [{database: "production", username: "test", address: "127.0.0.1", port: 5432}]};}};}
    async end() {await Promise.resolve(); closed = true;}
  }
  await assert.rejects(acquireDarwinPersistenceOwners({infrastructure: {database: {connection: {
    database: "ar69_test_probe", host: "127.0.0.1", port: 5432, user: "test"}}}},
  {Pool, agentExecution: {async applyContainedTurnPostgresSchema() {migrated = true;}}}), /database identity differs/);
  assert.equal(migrated, false); assert.equal(closed, true);
});
