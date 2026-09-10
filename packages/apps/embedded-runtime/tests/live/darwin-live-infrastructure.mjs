import {createHash} from "node:crypto";
import {lstat, readFile, realpath} from "node:fs/promises";
import {isAbsolute, join} from "node:path";
import {createConnection} from "node:net";
import {plainJson} from "./darwin-live-activation-manifest.mjs";

const refused = reason => new Error(`DARWIN_LIVE_INFRASTRUCTURE_REFUSED: ${reason}`);
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const quote = value => `"${value.replaceAll('"', '""')}"`;
const databaseConnection = value => {
  if (!value || Object.keys(value).some(key => !["database", "host", "port", "user"].includes(key)) ||
      !/^ar69_test_[a-z0-9_]+$/u.test(value.database ?? "") || !["127.0.0.1", "::1"].includes(value.host) ||
      !Number.isInteger(value.port) || value.port < 1 || value.port > 65535 ||
      typeof value.user !== "string" || value.user.length === 0) {throw refused("dedicated test database configuration required");}
  return {database: value.database, host: value.host, port: value.port, user: value.user};
};
const verifyDatabaseIdentity = async (client, connection) => {
  const identity = await client.query("SELECT current_database() AS database, current_user AS username, inet_server_addr()::text AS address, inet_server_port() AS port");
  if (identity.rows.length !== 1 || identity.rows[0].database !== connection.database ||
      identity.rows[0].username !== connection.user || identity.rows[0].address !== connection.host ||
      identity.rows[0].port !== connection.port) {throw refused("database identity differs");}
};
const socketProbe = path => new Promise((resolve, reject) => {
  const socket = createConnection(path);
  socket.setTimeout(2000);
  socket.once("connect", () => {socket.destroy(); resolve();});
  socket.once("error", reject);
  socket.once("timeout", () => socket.destroy(refused("host endpoint timeout")));
});

async function verifyEmptyTables(client) {
    // The complete dedicated database must be fresh. Metadata tables can carry
    // migrations; every other application table is read, including unknown tables.
    const tables = await client.query("SELECT schemaname, tablename FROM pg_tables WHERE schemaname NOT IN ('pg_catalog', 'information_schema')");
    const metadata = new Set(["runtime_security_dispatch_v1.schema_version",
      "provider_access.materialization_schema", "provider_access.dispatch_schema",
      "provider_access.dispatch_operation_schema", "provider_access.route_selection_schema",
      "agent_execution.schema_migration", "agent_execution.schema_migration_history"]);
    for (const {schemaname, tablename} of tables.rows) {
      if (metadata.has(`${schemaname}.${tablename}`)) {continue;}
      const rows = await client.query(`SELECT 1 FROM ${quote(schemaname)}.${quote(tablename)} LIMIT 1`);
      if (rows.rows.length) {throw refused("dedicated database contains application rows");}
    }
}

async function verifySourceRoot(filesystem) {
    const root = await realpath(filesystem.sourceRoot);
    if (root !== filesystem.sourceRoot) {throw refused("result outside test source");}
    try {await lstat(join(root, "result.txt")); throw refused("source result exists");}
    catch (error) {if (error.code !== "ENOENT") {throw error;}}
}

async function verifyCurrentPolicy(runtimeSecurity, scope) {
    // Immutable activation identifies policy; freshness comes from the retained
    // file and its bounded clock interval, never an activation boolean.
    const policy = runtimeSecurity?.policyFile;
    if (!isAbsolute(policy?.path ?? "") || !/^[a-f0-9]{64}$/u.test(policy.sha256 ?? "")) {throw refused("policy identity missing");}
    const stat = await lstat(policy.path), bytes = await readFile(policy.path);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o022) || hash(bytes) !== policy.sha256) {throw refused("policy file differs");}
    const observed = JSON.parse(bytes);
    const now = Date.now();
    if (observed.tenantId !== scope.tenantId || observed.projectId !== scope.projectId ||
        observed.policyRevision !== runtimeSecurity.policyRevision ||
        !Number.isSafeInteger(observed.validFrom) || !Number.isSafeInteger(observed.expiresAt) ||
        observed.validFrom > now || observed.expiresAt <= now) {throw refused("policy not current for scope");}
}

async function verifyPrivateDirectories(providerAccess, hostUid) {
    for (const path of [providerAccess?.codexHome, providerAccess?.sandbox]) {
      if (!isAbsolute(path ?? "") || await realpath(path) !== path) {throw refused("private PA directory missing");}
      const directory = await lstat(path);
      if (!directory.isDirectory() || (directory.mode & 0o077) ||
          directory.uid !== hostUid) {throw refused("private PA directory custody differs");}
    }
}

function validatePreflightPaths(scope, host, turn, filesystem) {
  if (!scope || !isAbsolute(host?.endpointPath ?? "") || !isAbsolute(turn?.resultPath ?? "") ||
      !isAbsolute(filesystem?.sourceRoot ?? "")) {throw refused("dedicated test configuration required");}
}

/** Read-only pre-claim inspection. No migration, auth capture, provider request,
 * native launch, policy installation or attempt marker is performed here. */
export async function preflightDarwinInfrastructure(activation, dependencies) {
  const config = plainJson(activation?.infrastructure);
  const {database, filesystem, runtimeSecurity, providerAccess, host} = config;
  const scope = activation.turn?.scope;
  validatePreflightPaths(scope, host, activation.turn, filesystem);
  const connection = databaseConnection(database?.connection);
  const Pool = dependencies?.Pool ?? (await import("pg")).Pool;
  const pool = new Pool({...connection, max: 1, connectionTimeoutMillis: 2000,
    statement_timeout: 2000, query_timeout: 3000});
  let client;
  try {
    client = await pool.connect();
    await client.query("BEGIN READ ONLY");
    await client.query("SET LOCAL row_security = off");
    const inspector = await client.query("SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user");
    if (inspector.rows.length !== 1 ||
        (inspector.rows[0].rolsuper !== true && inspector.rows[0].rolbypassrls !== true)) {
      throw refused("database inspector cannot prove row visibility");
    }
    await verifyDatabaseIdentity(client, connection);
    const prepared = await client.query("SELECT gid FROM pg_prepared_xacts WHERE database = current_database()");
    if (prepared.rows.length !== 0) {throw refused("prepared transactions exist");}
    await verifyEmptyTables(client);
    await verifySourceRoot(filesystem);
    await verifyCurrentPolicy(runtimeSecurity, scope);
    await verifyPrivateDirectories(providerAccess, activation.native?.packet?.hostUid);
    await (dependencies?.socketProbe ?? socketProbe)(host.endpointPath);
    await client.query("ROLLBACK");
    return Object.freeze({hostEndpointReachable: true, databaseEmpty: true,
      sourceResultAbsent: true, providerAuthoritiesFresh: true, mutated: false});
  } finally {
    try {if (client) {client.release(true);}} finally {await pool.end();}
  }
}

async function readRetainedPolicy(identity, signal) {
      const bytes = await readFile(identity.path), stat = await lstat(identity.path);
      if (signal.aborted || !stat.isFile() || stat.isSymbolicLink() ||
          (stat.mode & 0o022) || hash(bytes) !== identity.sha256) {return;}
      const retained = JSON.parse(bytes);
      if (!Number.isSafeInteger(retained.validFrom) || !Number.isSafeInteger(retained.expiresAt) ||
          retained.validFrom > Date.now() || retained.expiresAt <= Date.now()) {return;}
      return retained;
}

/** Persistence and policy owners used by the eventual full infrastructure root.
 * This is deliberately not exported as acquireDarwinInfrastructureOwners: native
 * settlement and effect-custody composition must be joined before that contract
 * can honestly be returned. */
export async function acquireDarwinPersistenceOwners(activation, dependencies) {
  const config = plainJson(activation.infrastructure);
  const connection = databaseConnection(config.database?.connection);
  const deps = dependencies ?? await (async () => {
    const [agentExecution, runtimeSecurity, postgres] = await Promise.all([
      import("@agent-teams/agent-execution/composition"),
      import("@agent-teams/runtime-security/composition"), import("pg"),
    ]);
    return {agentExecution, runtimeSecurity, Pool: postgres.Pool};
  })();
  const pool = new deps.Pool({...connection, max: 4, connectionTimeoutMillis: 2000});
  const actions = [() => pool.end()];
  const lifetime = new AbortController();
  let generation = 1, closing;
  const dispose = () => {
    if (closing) {return closing;}
    lifetime.abort(); generation += 1;
    closing = (async () => {
      const failures = [];
      for (const action of actions.toReversed()) {try {await action();} catch (error) {failures.push(error);}}
      if (failures.length) {throw new AggregateError(failures, "Darwin persistence cleanup failed");}
    })();
    return closing;
  };
  try {
    const inspector = await pool.connect();
    try {await verifyDatabaseIdentity(inspector, connection);} finally {inspector.release();}
    // Acquisition requires a completely unused owner namespace. Preflight is
    // informative; this fresh read closes the gap before explicit migrations.
    const existing = await pool.query("SELECT 1 FROM pg_namespace WHERE nspname IN ('agent_execution','provider_access','runtime_security_dispatch_v1','runtime_security_dispatch_acceptance_v1','host_http_egress')");
    if (existing.rows.length) {throw refused("owner schemas already exist");}
    await deps.agentExecution.applyContainedTurnPostgresSchema(pool);
    await deps.agentExecution.initializePostgresHttpEgressEvidence(pool);
    const digest = deps.runtimeSecurity.createNodeSha256DispatchDigest();
    const sql = {pool, connectTimeoutMs: 2000, queryTimeoutMs: 5000, transactionTimeoutMs: 10000};
    const repository = deps.runtimeSecurity.createPostgresDispatchConsumptionRepository({...sql, digest});
    actions.push(() => repository.close());
    const decisions = deps.runtimeSecurity.createPostgresDispatchAcceptanceStore(sql);
    actions.push(() => decisions.close());
    await repository.migrate(); await decisions.migrate();
    const policy = Object.freeze({async read(intent) {
      if (lifetime.signal.aborted || intent.operationId !== activation.turn.operationId ||
          intent.scope.tenantId !== activation.turn.scope.tenantId ||
          intent.scope.projectId !== activation.turn.scope.projectId ||
          intent.policyRevision !== config.runtimeSecurity.policyRevision) {return;}
      const retained = await readRetainedPolicy(config.runtimeSecurity.policyFile, lifetime.signal);
      if (!retained) {return;}
      const value = retained.dispatch;
      if (!value || value.scope?.tenantId !== intent.scope.tenantId ||
          value.scope?.projectId !== intent.scope.projectId || value.providerId !== intent.providerId ||
          value.intentDigest !== intent.intentDigest || value.policyRevision !== intent.policyRevision) {return;}
      return plainJson(value);
    }});
    const acceptance = deps.runtimeSecurity.createDispatchAcceptanceFeature({repository, decisions, digest,
      policy, clock: Object.freeze({now: () => Date.now()})});
    const privateAuth = Object.freeze({operationRef: activation.turn.operationId,
      executable: activation.codex.path, codexHome: config.providerAccess.codexHome,
      sandbox: config.providerAccess.sandbox, generation,
      readGeneration: () => generation, signal: lifetime.signal, deadline: performance.now() + 60000});
    return Object.freeze({pool, repository, acceptance, privateAuth,
      operatorApproval: plainJson(config.providerAccess.operatorApproval),
      policyRevision: config.runtimeSecurity.policyRevision, dispose});
  } catch (error) {
    try {await dispose();} catch (cleanupError) {throw persistenceAcquisitionFailure(error, cleanupError);}
    throw error;
  }
}

/** Keep sensitive inventory in the launch owner's memory only. No activation,
 * retained JSON, diagnostic, or verification projection receives these bytes. */
export function createDarwinLaunchRecords(activation, nativeLaunch, withCredentialOutputInventory) {
  const turn = plainJson(activation.turn);
  if (typeof withCredentialOutputInventory !== "function" || !nativeLaunch?.boundary ||
      !isAbsolute(nativeLaunch.privateRootPath ?? "") || !isAbsolute(nativeLaunch.tmpDir ?? "")) {
    throw refused("launch owner input incomplete");
  }
  return Object.freeze({async resolve(input) {
    if (input.operationId !== turn.operationId || input.attemptId !== turn.attemptId || input.effectId !== turn.effectId ||
        input.providerBinding?.provider !== "codex") {return;}
    let captured;
    withCredentialOutputInventory(input.operationId, inventory => {
      if (inventory.credentialBindingDigest !== input.credentialBindingDigest ||
          inventory.credentialGeneration !== input.credentialGeneration ||
          !Array.isArray(inventory.sensitiveOutputTokens) || !inventory.sensitiveOutputTokens.length ||
          inventory.sensitiveOutputTokens.some(value => typeof value !== "string" || !value.length)) {return false;}
      captured = Object.freeze({credentialBindingDigest: inventory.credentialBindingDigest,
        credentialGeneration: inventory.credentialGeneration,
        sensitiveOutputTokens: Object.freeze([...inventory.sensitiveOutputTokens])});
      return true;
    });
    if (!captured) {return;}
    return Object.freeze({boundary: nativeLaunch.boundary, credentialOutputInventory: captured,
      executablePath: activation.codex.path, privateRootPath: nativeLaunch.privateRootPath,
      tmpDir: nativeLaunch.tmpDir});
  }});
}

/** Fixed one-operation namespace. Dynamic proof/cancellation identities remain
 * deterministic per domain and seed; they never stand in for retained proofs. */
export function createDarwinOperationStore(activation, pool, agentExecution) {
  const config = plainJson(activation.infrastructure), turn = plainJson(activation.turn);
  const fixed = {operation: turn.operationId, attempt: turn.attemptId, effect: turn.effectId,
    execution_generation: turn.executionGenerationId};
  if (Object.values(fixed).some(value => typeof value !== "string" || !value.length)) {throw refused("operation identities missing");}
  const store = new agentExecution.PostgresContainedTurnOperationStore({pool,
    intentAuthority: config.host.intentAuthority,
    identities: Object.freeze({nextId(kind, seed = kind) {
      if (Object.hasOwn(fixed, kind)) {return fixed[kind];}
      if (!["cancellation_command", "cleanup", "custody", "operation_authority", "proof", "writer_fence"].includes(kind)) {
        throw refused("unknown identity domain");
      }
      return `${kind.replaceAll("_", "-")}:sha256:${hash(JSON.stringify([turn.operationId, kind, seed]))}`;
    }}),
  });
  return Object.freeze(Object.fromEntries([
    "accept", "appendOutput", "claimPreparedDispatch", "commit", "identifyAcceptance",
    "listDispatchPreparations", "preventIntent", "prepareCancellation", "prepareDispatch",
    "proofsForAcceptedEffect", "proofsForPrevention", "proofsForProcessNoStart",
    "proveDispatchPreparationClosure", "read", "recordDispatchPreparationCleanup",
    "requestCancellation", "retireDispatchPreparation", "terminalProof",
  ].map(name => [name, store[name].bind(store)])));
}

function persistenceAcquisitionFailure(error, cleanupError) {
  return new AggregateError([error, cleanupError], "Darwin persistence acquisition failed", {cause: error});
}
