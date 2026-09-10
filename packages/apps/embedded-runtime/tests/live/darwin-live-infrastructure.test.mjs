import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp, mkdir, writeFile, rm, realpath} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createHash} from "node:crypto";
import {preflightDarwinInfrastructure, acquireDarwinInfrastructureOwners,
  createDarwinNativeOutputOwner, createDarwinControlClock} from "./darwin-live-infrastructure.mjs";
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
  {Pool: function Pool() {constructed = true;}}), /database configuration/);
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

test("operation store binds real methods and fixed one-attempt identities", async () => {
  const {createDarwinOperationStore} = await import("./darwin-live-infrastructure.mjs");
  let captured;
  const methods = ["accept", "appendOutput", "claimPreparedDispatch", "commit", "identifyAcceptance",
    "listDispatchPreparations", "preventIntent", "prepareCancellation", "prepareDispatch",
    "proofsForAcceptedEffect", "proofsForPrevention", "proofsForProcessNoStart", "proveDispatchPreparationClosure",
    "read", "recordDispatchPreparationCleanup", "requestCancellation", "retireDispatchPreparation", "terminalProof"];
  function Store(options) {captured = options; for (const name of methods) {this[name] = function() {assert.equal(this instanceof Store, true); return name;};}}
  const store = createDarwinOperationStore({turn: {operationId: "op", attemptId: "attempt", effectId: "effect", executionGenerationId: "generation"},
    infrastructure: {host: {intentAuthority: {audience: "test"}}}}, {}, {PostgresContainedTurnOperationStore: Store});
  assert.equal(store.read(), "read");
  assert.equal(captured.identities.nextId("operation"), "op");
  assert.equal(captured.identities.nextId("proof", "a"), captured.identities.nextId("proof", "a"));
  assert.notEqual(captured.identities.nextId("proof", "a"), captured.identities.nextId("proof", "b"));
  assert.throws(() => captured.identities.nextId("unknown"), /identity domain/);
});

async function assemblyFixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ar69-assembly-")));
  const events = [], catalog = Buffer.from("{}"), policy = {tenantId: "tenant", projectId: "project",
    policyRevision: "policy-1", validFrom: Date.now() - 1000, expiresAt: Date.now() + 60000,
    egress: {rule: {revision: "rule-1"}, approval: {ruleRevision: "rule-1", bindingDigest: "approved"}}};
  await writeFile(join(root, "catalog"), catalog);
  const policyBytes = Buffer.from(JSON.stringify(policy)); await writeFile(join(root, "policy"), policyBytes, {mode: 0o400});
  const activation = {evidenceDirectory: root, codex: {path: "/test/codex", sha256: "a".repeat(64)},
    turn: {operationId: "op", attemptId: "attempt", effectId: "effect", executionGenerationId: "generation",
      scope: {tenantId: "tenant", projectId: "project"}}, infrastructure: {
      database: {connection: {database: "ar69_test_assembly", user: "test", host: "127.0.0.1", port: 5432}},
      runtimeSecurity: {policyRevision: "policy-1", policyFile: {path: join(root, "policy"), sha256: createHash("sha256").update(policyBytes).digest("hex")}},
      providerAccess: {codexHome: root, sandbox: root, operatorApproval: {}},
      filesystem: {sourceRoot: root, disposableRoot: root, workspaceRoot: join(root, "workspace"),
        artifactRoot: join(root, "artifacts"), rehydrationRoot: join(root, "rehydrate")},
      host: {bootId: "boot", instanceId: "host", lifecycleGeneration: "generation", authorityRevision: "revision", intentAuthority: {}},
      deployment: {clock: {authorityId: "clock", epoch: "epoch"}, operationTimeoutMs: 30000,
        catalog: {path: join(root, "catalog"), sha256: createHash("sha256").update(catalog).digest("hex")},
        durableRoot: root, qualificationTarget: {}, id: "deployment", signer: {}, dns: {}, transport: {},
        observer: {}, launcherSha256: "b".repeat(64), nodeSha256: "c".repeat(64), limits: {maximumBytes: 1024}}}};
  class Pool {
    async connect() {return {release() {}, async query() {return {rows: [{database: "ar69_test_assembly", username: "test", address: "127.0.0.1", port: 5432}]};}};}
    async query() {return {rows: []};} async end() {events.push("pool closed");}
  }
  const methods = ["accept", "appendOutput", "claimPreparedDispatch", "commit", "identifyAcceptance",
    "listDispatchPreparations", "preventIntent", "prepareCancellation", "prepareDispatch",
    "proofsForAcceptedEffect", "proofsForPrevention", "proofsForProcessNoStart", "proveDispatchPreparationClosure",
    "read", "recordDispatchPreparationCleanup", "requestCancellation", "retireDispatchPreparation", "terminalProof"];
  function Store() {for (const name of methods) {this[name] = () => name;}}
  const effect = {authority: {}, cutoff() {events.push("effect cut");}, dispose() {events.push("effect closed");}};
  const native = {boundary: {}, privateRootPath: "/test/private", tmpDir: "/test/tmp"};
  let projectionInput, custodyInput, selected;
  const repository = {async migrate() {}, async close() {events.push("repository closed");}, readAuthority() {}};
  const dependencies = {Pool, agentExecution: {
    async applyContainedTurnPostgresSchema() {}, async initializePostgresHttpEgressEvidence() {},
    PostgresContainedTurnOperationStore: Store,
    createDarwinCodexEffectCustodyOwner: () => effect,
    DarwinCooperativeProcessCustody: function Custody(input) {custodyInput = input;},
    async prepareDarwinCodexNativeLaunchInput(selection, mode) {assert.equal(mode, "workspace-write"); selected = selection; return native;},
  }, runtimeSecurity: {createNodeSha256DispatchDigest: () => ({}),
    createPostgresDispatchConsumptionRepository: () => repository,
    createPostgresDispatchAcceptanceStore: () => ({async migrate() {}, async close() {events.push("decisions closed");}}),
    createDispatchAcceptanceFeature: () => ({})},
  verification: {createDarwinLiveVerification(input) {projectionInput = input; return {verification: {}, reconciliation: {}, cleanup: {}};}}};
  return {activation, dependencies, events, root, effect, native, repository,
    read: () => ({projectionInput, custodyInput, selected})};
}

test("full assembly joins genuine owners, retained callbacks, shared clocks and native preparation", async () => {
  const f = await assemblyFixture(); let acquired;
  try {
    acquired = await acquireDarwinInfrastructureOwners(f.activation, f.dependencies);
    const {assembly} = acquired, completion = Object.freeze({}), callbacks = assembly.nativeConsumers(completion);
    assert.throws(() => assembly.nativeConsumers(completion), /already bound/);
    await assert.rejects(callbacks.workspace(), /not joined/);
    const workspaceOwner = {}, artifacts = {}, selectedNativeWorkspace = {}, httpLaunchAuthority = {};
    const joined = await assembly.createWorkspaceComposition({workspaceOwner, artifacts, selectedNativeWorkspace,
      withCredentialOutputInventory() {}});
    const prep = await assembly.createPostClaimPreparation(selectedNativeWorkspace, httpLaunchAuthority);
    assert.equal(joined.deployment.owner.workspaceOwner, workspaceOwner);
    assert.equal(joined.deployment.owner.effectCustody, f.effect.authority);
    assert.equal(prep.effectCustody, f.effect);
    assert.equal(prep.httpLaunchAuthority, httpLaunchAuthority);
    assert.equal(prep.boundary, f.native.boundary);
    assert.equal(joined.host.containedTurn.selectedProvider.owner.workspaceOwner, workspaceOwner);
    assert.equal(joined.host.containedTurn.authority, "current");
    assert.equal(joined.host.containedTurn.hostCustody, prep.hostCustody);
    assert.equal(joined.deployment.owner.hostCustody, prep.hostCustody);
    assert.equal(joined.deployment.runtimeSecurity, f.repository);
    assert.equal(f.read().selected, selectedNativeWorkspace);
    assert.equal(f.read().projectionInput.getWorkspaceOwner(), workspaceOwner);
    assert.equal(f.read().projectionInput.getArtifacts(), artifacts);
    assert.deepEqual(prep.catalogSource, Buffer.from("{}"));
    assert.equal(prep.localCut.clock.read().authorityId, "clock");
    assert.equal(prep.localCut.clock.read, joined.deployment.signer.clock.read);
    for (const name of ["workspace", "artifactResult", "launchRoute", "privateMaterial"]) {assert.equal(await callbacks[name](), completion);}
    assert.equal(await callbacks.output("stdout", Buffer.from("synthetic output")), completion);
    const approved = joined.deployment.policyOwner.currentPolicy({input: {subject: {scope: f.activation.turn.scope, operationId: "op"}}});
    assert.equal(approved.approval.bindingDigest, "approved");
    assert.throws(() => joined.deployment.policyOwner.currentPolicy({input: {subject: {scope: f.activation.turn.scope, operationId: "foreign"}}}), /unavailable/);
    await assert.rejects(assembly.createPostClaimPreparation({}, httpLaunchAuthority), /authority differs/);
    await assert.rejects(f.read().custodyInput.launchPlans.resolve(), /unbound generic launch/);
    await acquired.dispose();
    assert.equal(f.read().projectionInput.outputOwner.readback().closed, true);
    assert.equal(acquired.dispose(), acquired.dispose());
    assert.deepEqual(f.events, ["effect cut", "effect closed", "decisions closed", "repository closed", "pool closed"]);
  } finally {await acquired?.dispose(); await rm(f.root, {recursive: true, force: true});}
});

test("full assembly failure cleans persistence and native output; activation functions never execute", async () => {
  const f = await assemblyFixture();
  try {
    f.dependencies.agentExecution.createDarwinCodexEffectCustodyOwner = () => {throw new Error("effect refused");};
    await assert.rejects(acquireDarwinInfrastructureOwners(f.activation, f.dependencies), /effect refused/);
    assert.deepEqual(f.events, ["decisions closed", "repository closed", "pool closed"]);
    let called = false;
    await assert.rejects(acquireDarwinInfrastructureOwners({...f.activation, get callback() {called = true; return {}; }}, f.dependencies));
    assert.equal(called, false);
  } finally {await rm(f.root, {recursive: true, force: true});}
});

test("native output is durable, bounded, one-owner and rejects writes after close", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ar69-output-")));
  try {
    const path = join(root, "output"), owner = await createDarwinNativeOutputOwner(path);
    await owner.write("stdout", Buffer.from("hello"));
    await assert.rejects(createDarwinNativeOutputOwner(path), /EEXIST/);
    await assert.rejects(owner.write("unknown", Buffer.from("x")), /budget/);
    await assert.rejects(owner.write("stderr", Buffer.alloc(8 * 1024 * 1024)), /budget/);
    await owner.dispose();
    const result = owner.readback();
    assert.equal(result.closed, true); assert.equal(result.frames, 1); assert.equal(result.bytes, 5);
    await assert.rejects(owner.write("stdout", Buffer.from("x")), /closed/);
  } finally {await rm(root, {recursive: true, force: true});}
});

test("control clock bounds hung work and cancellation without losing closure clock", async () => {
  const clock = createDarwinControlClock({authorityId: "clock", epoch: "epoch"});
  await assert.rejects(clock.within(clock.now() + 5, () => new Promise(() => {})), /timed out/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(clock.within(clock.now() + 100, async () => "unused", controller.signal), /ended/);
  assert.equal(await clock.within(clock.now() + 100, async () => "closure"), "closure");
});
