import {createHash} from "node:crypto";
import {lstat, readFile, realpath} from "node:fs/promises";
import {isAbsolute, join} from "node:path";
import {createConnection} from "node:net";
import {plainJson} from "./darwin-live-activation-manifest.mjs";

const refused = reason => new Error(`DARWIN_LIVE_INFRASTRUCTURE_REFUSED: ${reason}`);
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const quote = value => `"${value.replaceAll('"', '""')}"`;
const socketProbe = path => new Promise((resolve, reject) => {
  const socket = createConnection(path);
  socket.setTimeout(2000);
  socket.once("connect", () => {socket.destroy(); resolve();});
  socket.once("error", reject);
  socket.once("timeout", () => socket.destroy(refused("host endpoint timeout")));
});

/** Read-only pre-claim inspection. No migration, auth capture, provider request,
 * native launch, policy installation or attempt marker is performed here. */
export async function preflightDarwinInfrastructure(activation, dependencies) {
  const config = plainJson(activation?.infrastructure);
  const {database, filesystem, runtimeSecurity, providerAccess, host} = config;
  const scope = activation.turn?.scope;
  if (!scope || !/^ar69_test_[a-z0-9_]+$/u.test(database?.connection?.database ?? "") ||
      !["127.0.0.1", "::1"].includes(database.connection.host) ||
      !Number.isInteger(database.connection.port) || !database.connection.user ||
      !isAbsolute(host?.endpointPath ?? "") || !isAbsolute(activation.turn?.resultPath ?? "") ||
      !isAbsolute(filesystem?.sourceRoot ?? "")) {throw refused("dedicated test configuration required");}
  const Pool = dependencies?.Pool ?? (await import("pg")).Pool;
  const pool = new Pool({...database.connection, max: 1, connectionTimeoutMillis: 2000,
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
    const identity = await client.query("SELECT current_database() AS database, current_user AS username");
    if (identity.rows[0]?.database !== database.connection.database ||
        identity.rows[0]?.username !== database.connection.user) {throw refused("database identity differs");}
    const prepared = await client.query("SELECT gid FROM pg_prepared_xacts WHERE database = current_database()");
    if (prepared.rows.length !== 0) {throw refused("prepared transactions exist");}
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
    const root = await realpath(filesystem.sourceRoot);
    if (root !== filesystem.sourceRoot) {throw refused("result outside test source");}
    try {await lstat(join(root, "result.txt")); throw refused("source result exists");}
    catch (error) {if (error.code !== "ENOENT") {throw error;}}
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
    for (const path of [providerAccess?.codexHome, providerAccess?.sandbox]) {
      if (!isAbsolute(path ?? "") || await realpath(path) !== path) {throw refused("private PA directory missing");}
      const directory = await lstat(path);
      if (!directory.isDirectory() || (directory.mode & 0o077) ||
          directory.uid !== activation.native?.packet?.hostUid) {throw refused("private PA directory custody differs");}
    }
    await (dependencies?.socketProbe ?? socketProbe)(host.endpointPath);
    await client.query("ROLLBACK");
    return Object.freeze({hostEndpointReachable: true, databaseEmpty: true,
      sourceResultAbsent: true, providerAuthoritiesFresh: true, mutated: false});
  } finally {
    try {if (client) {client.release(true);}} finally {await pool.end();}
  }
}

/** Persistence and policy owners used by the eventual full infrastructure root.
 * This is deliberately not exported as acquireDarwinInfrastructureOwners: native
 * settlement and effect-custody composition must be joined before that contract
 * can honestly be returned. */
export async function acquireDarwinPersistenceOwners(activation, dependencies) {
  const config = plainJson(activation.infrastructure);
  if (!/^ar69_test_[a-z0-9_]+$/u.test(config.database?.connection?.database ?? "") ||
      !["127.0.0.1", "::1"].includes(config.database.connection.host)) {throw refused("dedicated test database required");}
  const deps = dependencies ?? await (async () => {
    const [agentExecution, runtimeSecurity, postgres] = await Promise.all([
      import("@agent-teams/agent-execution/composition"),
      import("@agent-teams/runtime-security/composition"), import("pg"),
    ]);
    return {agentExecution, runtimeSecurity, Pool: postgres.Pool};
  })();
  const pool = new deps.Pool({...config.database.connection, max: 4, connectionTimeoutMillis: 2000});
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
          intent.policyRevision !== config.runtimeSecurity.policyRevision) {return undefined;}
      const identity = config.runtimeSecurity.policyFile;
      const bytes = await readFile(identity.path), stat = await lstat(identity.path);
      if (lifetime.signal.aborted || !stat.isFile() || stat.isSymbolicLink() ||
          (stat.mode & 0o022) || hash(bytes) !== identity.sha256) {return undefined;}
      const retained = JSON.parse(bytes);
      if (!Number.isSafeInteger(retained.validFrom) || !Number.isSafeInteger(retained.expiresAt) ||
          retained.validFrom > Date.now() || retained.expiresAt <= Date.now()) {return undefined;}
      const value = retained.dispatch;
      if (!value || value.scope?.tenantId !== intent.scope.tenantId ||
          value.scope?.projectId !== intent.scope.projectId || value.providerId !== intent.providerId ||
          value.intentDigest !== intent.intentDigest || value.policyRevision !== intent.policyRevision) {return undefined;}
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
    try {await dispose();} catch (cleanupError) {throw new AggregateError([error, cleanupError], "Darwin persistence acquisition failed");}
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
        input.providerBinding?.provider !== "codex") {return undefined;}
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
    if (!captured) {return undefined;}
    return Object.freeze({boundary: nativeLaunch.boundary, credentialOutputInventory: captured,
      executablePath: activation.codex.path, privateRootPath: nativeLaunch.privateRootPath,
      tmpDir: nativeLaunch.tmpDir});
  }});
}
