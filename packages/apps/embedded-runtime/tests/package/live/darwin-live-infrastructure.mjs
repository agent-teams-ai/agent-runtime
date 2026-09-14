import {createHash} from "node:crypto";
import {lstat, readFile, realpath, open} from "node:fs/promises";
import {isAbsolute, join, dirname} from "node:path";
import {lstatSync, readFileSync} from "node:fs";
import {createConnection} from "node:net";
import {plainJson} from "./darwin-live-activation-manifest.mjs";

const refused = reason => new Error(`DARWIN_LIVE_INFRASTRUCTURE_REFUSED: ${reason}`);
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const quote = value => `"${value.replaceAll('"', '""')}"`;
const databaseConnection = value => {
  if (!value || Object.keys(value).some(key => !["database", "host", "port", "user"].includes(key)) ||
      !/^(?:ar69_test|ar_canary)_[a-z0-9_]+$/u.test(value.database ?? "") ||
      (!["127.0.0.1", "::1"].includes(value.host) && !isAbsolute(value.host ?? "")) ||
      !Number.isInteger(value.port) || value.port < 1 || value.port > 65535 ||
      typeof value.user !== "string" || value.user.length === 0) {throw refused("dedicated test database configuration required");}
  return {database: value.database, host: value.host, port: value.port, user: value.user,
    transport: isAbsolute(value.host) ? "unix" : "tcp"};
};
const verifyDatabaseSocket = async connection => {
  if (connection.transport !== "unix") {return;}
  const directory = await lstat(connection.host);
  if (await realpath(connection.host) !== connection.host || !directory.isDirectory() || directory.isSymbolicLink()) {
    throw refused("database socket directory is not canonical");
  }
};
const verifyDatabaseIdentity = async (client, connection) => {
  const identity = await client.query("SELECT current_database() AS database, current_user AS username, inet_server_addr()::text AS address, inet_server_port() AS port");
  // Postgres returns NULL from both inet_server_addr() and inet_server_port()
  // for a Unix-domain-socket connection (documented, unconditional server
  // behavior) -- the connection's own port still identifies which socket file
  // (.s.PGSQL.<port>) was dialed, but the server-reported port column cannot
  // echo it back over that transport, so it needs the same unix exception
  // already applied to address.
  const expectedAddress = connection.transport === "unix" ? null : connection.host;
  const expectedPort = connection.transport === "unix" ? null : connection.port;
  if (identity.rows.length !== 1 || identity.rows[0].database !== connection.database ||
      identity.rows[0].username !== connection.user || identity.rows[0].address !== expectedAddress ||
      identity.rows[0].port !== expectedPort) {throw refused("database identity differs");}
};
const postgresConnection = ({transport: _transport, ...connection}) => connection;
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
  await verifyDatabaseSocket(connection);
  const Pool = dependencies?.Pool ?? (await import("pg")).Pool;
  const pool = new Pool({...postgresConnection(connection), max: 1, connectionTimeoutMillis: 2000,
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

/** Persistence and policy acquisition shared by the concrete infrastructure
 * root. Native custody and consumer settlement are joined separately below. */
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
  await verifyDatabaseSocket(connection);
  const pool = new deps.Pool({...postgresConnection(connection), max: 4, connectionTimeoutMillis: 2000});
  const cleanupState = {repositoryClosed: false, decisionsClosed: false, poolClosed: false,
    database: {kind: "unavailable", inspectorClosed: false}};
  const actions = [async () => {await pool.end(); cleanupState.poolClosed = true;}];
  const lifetime = new AbortController();
  let generation = 1, closing, inspectOnDispose = false;
  const inspectReleasedDatabase = async () => {
    const inspectorPool = new deps.Pool({...postgresConnection(connection), max: 1, connectionTimeoutMillis: 2000,
      statement_timeout: 2000, query_timeout: 3000});
    let client;
    try {
      client = await inspectorPool.connect();
      await verifyDatabaseIdentity(client, connection);
      const result = await client.query("SELECT (SELECT count(*)::integer FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()) AS other_sessions, (SELECT count(*)::integer FROM pg_prepared_xacts WHERE database = current_database()) AS prepared_transactions");
      if (result.rows.length !== 1 || !Number.isInteger(result.rows[0].other_sessions) ||
          !Number.isInteger(result.rows[0].prepared_transactions)) {throw refused("database cleanup inspection differs");}
      cleanupState.database = {kind: "observed", otherSessions: result.rows[0].other_sessions,
        preparedTransactions: result.rows[0].prepared_transactions, inspectorClosed: false};
    } finally {
      try {client?.release(true);} finally {
        await inspectorPool.end();
        cleanupState.database = {...cleanupState.database, inspectorClosed: true};
      }
    }
  };
  const dispose = () => {
    if (closing) {return closing;}
    lifetime.abort(); generation += 1;
    closing = (async () => {
      const failures = [];
      for (const action of actions.toReversed()) {try {await action();} catch (error) {failures.push(error);}}
      if (inspectOnDispose && cleanupState.poolClosed) {
        try {await inspectReleasedDatabase();} catch (error) {failures.push(error);}
      }
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
    actions.push(async () => {await repository.close(); cleanupState.repositoryClosed = true;});
    const decisions = deps.runtimeSecurity.createPostgresDispatchAcceptanceStore(sql);
    actions.push(async () => {await decisions.close(); cleanupState.decisionsClosed = true;});
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
    inspectOnDispose = true;
    return Object.freeze({pool, repository, acceptance, privateAuth,
      operatorApproval: plainJson(config.providerAccess.operatorApproval),
      policyRevision: config.runtimeSecurity.policyRevision, dispose,
      readCleanup: () => Object.freeze({persistence: Object.freeze({repositoryClosed: cleanupState.repositoryClosed,
        decisionsClosed: cleanupState.decisionsClosed}), pool: Object.freeze({closed: cleanupState.poolClosed}),
        database: Object.freeze({...cleanupState.database})})});
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

/** Native output acknowledgment follows fsync, including the first directory
 * entry. This private binary journal is never projected into public output. */
export async function createDarwinNativeOutputOwner(path) {
  if (!isAbsolute(path) || await realpath(dirname(path)) !== dirname(path)) {throw refused("output directory is not canonical");}
  const directory = await open(dirname(path), "r");
  let file;
  try {file = await open(path, "wx", 0o600); await directory.sync();}
  catch (error) {await file?.close(); throw error;}
  finally {await directory.close();}
  let tail = Promise.resolve(), bytes = 0, frames = 0, closed = false, failure;
  const digest = createHash("sha256");
  let finalDigest, disposal;
  return Object.freeze({
    write(stream, input) {
      if (closed || failure || !["stdout", "stderr"].includes(stream) || !(input instanceof Uint8Array) ||
          input.byteLength === 0 || input.byteLength > 16384 || frames >= 65536 ||
          input.byteLength > 8 * 1024 * 1024 - bytes) {return Promise.reject(refused("native output closed or budget exhausted"));}
      const captured = Buffer.from(input), header = Buffer.alloc(5);
      header[0] = stream === "stdout" ? 1 : 2; header.writeUInt32BE(captured.length, 1);
      bytes += captured.length; frames += 1;
      const framed = Buffer.concat([header, captured]); captured.fill(0);
      const write = tail.then(async () => {
        if (failure) {throw failure;}
        try {await file.writeFile(framed); await file.sync(); digest.update(framed); return null;}
        finally {framed.fill(0);}
      });
      tail = write.catch(error => {failure = error; throw error;});
      void tail.catch(() => {});
      return tail;
    },
    dispose() {
      closed = true;
      disposal ??= (async () => {
        try {await tail; await file.sync(); finalDigest = digest.digest("hex");}
        finally {await file.close();}
      })();
      return disposal;
    },
    readback: () => Object.freeze({path, bytes, frames, closed: closed && finalDigest !== undefined && !failure,
      ...(finalDigest === undefined ? {} : {sha256: finalDigest})}),
  });
}

/** One runtime clock domain shared by RS signing, HTTP and local cut. */
export function createDarwinControlClock(identity) {
  if (typeof identity?.authorityId !== "string" || !identity.authorityId || typeof identity.epoch !== "string" || !identity.epoch) {
    throw refused("clock identity missing");
  }
  const controlTimeAtAnchor = Date.now(), monotonicAtAnchor = performance.now();
  const now = () => controlTimeAtAnchor + Math.floor(performance.now() - monotonicAtAnchor);
  const within = (deadline, operation, requestSignal) => new Promise((resolve, reject) => {
    const remaining = deadline - now();
    if (!Number.isSafeInteger(deadline) || remaining <= 0 || requestSignal?.aborted) {
      reject(refused("clock deadline or lifetime ended")); return;
    }
    const abort = () => {clearTimeout(timer); detach(); reject(refused("bounded operation aborted"));};
    const detach = () => {requestSignal?.removeEventListener("abort", abort);};
    const timer = setTimeout(() => {detach(); reject(refused("bounded operation timed out"));}, remaining);
    requestSignal?.addEventListener("abort", abort, {once: true});
    Promise.resolve().then(operation).then(value => {clearTimeout(timer); detach(); resolve(value); return null;},
      error => {clearTimeout(timer); detach(); reject(error); return null;});
  });
  return Object.freeze({now, within, read: () => Object.freeze({authorityId: identity.authorityId, epoch: identity.epoch, controlTime: now()}),
    controlTimeAtAnchor, monotonicAtAnchor});
}

function retainedEgressPolicy(activation, clock, lifetime, deadline) {
  const {runtimeSecurity} = activation.infrastructure;
  return Object.freeze({currentPolicy(acknowledged) {
    const identity = runtimeSecurity.policyFile;
    const stat = lstatSync(identity.path), bytes = readFileSync(identity.path);
    if (lifetime.signal.aborted || stat.isSymbolicLink() || !stat.isFile() || (stat.mode & 0o022) || hash(bytes) !== identity.sha256) {
      throw refused("retained egress policy changed");
    }
    const policy = plainJson(JSON.parse(bytes));
    const subject = acknowledged.input.subject;
    if (policy.tenantId !== subject.scope.tenantId || policy.projectId !== subject.scope.projectId ||
        subject.operationId !== activation.turn.operationId || policy.policyRevision !== runtimeSecurity.policyRevision ||
        !Number.isSafeInteger(policy.validFrom) || !Number.isSafeInteger(policy.expiresAt) ||
        policy.validFrom > Date.now() || policy.expiresAt <= Date.now() || !policy.egress?.rule || !policy.egress.approval) {
      throw refused("retained egress approval unavailable");
    }
    return Object.freeze({rule: policy.egress.rule, approval: policy.egress.approval,
      timing: Object.freeze({controlTimeAtAnchor: clock.controlTimeAtAnchor, monotonicAtAnchor: clock.monotonicAtAnchor,
        operationDeadlineMonotonic: clock.monotonicAtAnchor + deadline - clock.controlTimeAtAnchor,
        readTimeoutMilliseconds: 5000}), monotonicNow: () => performance.now()});
  }});
}

async function capturePreparationFiles(activation) {
  const config = activation.infrastructure.deployment;
  const catalog = await readFile(config.catalog.path);
  if (hash(catalog) !== config.catalog.sha256) {throw refused("catalog digest differs");}
  const directory = await lstat(config.durableRoot, {bigint: true});
  if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o022n) ||
      await realpath(config.durableRoot) !== config.durableRoot) {throw refused("route directory custody differs");}
  return Object.freeze({catalogSource: catalog,
    durableRoot: Object.freeze({path: config.durableRoot, dev: String(directory.dev), ino: String(directory.ino)})});
}

function filesystemConfigurations(config) {
  const filesystem = config.filesystem;
  const common = {canonicalProjectRoot: filesystem.sourceRoot, disposableRoot: filesystem.disposableRoot};
  for (const path of [...Object.values(common), filesystem.workspaceRoot, filesystem.artifactRoot, filesystem.rehydrationRoot]) {
    if (!isAbsolute(path ?? "")) {throw refused("filesystem owner paths incomplete");}
  }
  return Object.freeze({workspace: Object.freeze({...common, root: filesystem.workspaceRoot}),
    artifacts: Object.freeze({...common, root: filesystem.artifactRoot,
      rehydrationRoot: filesystem.rehydrationRoot, workspaceRoot: filesystem.workspaceRoot})});
}

async function loadInfrastructureDependencies() {
  const [agentExecution, runtimeSecurity, postgres, verification] = await Promise.all([
    import("@agent-teams/agent-execution/composition"), import("@agent-teams/runtime-security/composition"),
    import("pg"), import("./darwin-live-verification.mjs"),
  ]);
  return {agentExecution, runtimeSecurity, Pool: postgres.Pool, verification};
}

/** The fixed Darwin root owns this one-operation composition. Native capture
 * alone receives the opaque completion factory; JSON supplies only configuration. */
export async function acquireDarwinInfrastructureOwners(rawActivation, dependencies) {
  const activation = plainJson(rawActivation), config = activation.infrastructure;
  const deps = dependencies ?? await loadInfrastructureDependencies();
  const filesystem = filesystemConfigurations(config);
  const persistence = await acquireDarwinPersistenceOwners(activation, deps);
  const actions = [persistence.dispose], lifetime = new AbortController();
  let outputOwner, effectOwner, workspaceOwner, artifacts, nativeLaunch, selected, joined, disposal;
  let compositionEntered = false, preparationEntered = false;
  const sealAdmission = () => {lifetime.abort(); effectOwner?.cutoff();};
  const dispose = () => disposal ??= (async () => {
    sealAdmission(); const failures = [];
    for (const action of actions.toReversed()) {try {await action();} catch (error) {failures.push(error);}}
    if (failures.length) {throw new AggregateError(failures, "Darwin infrastructure cleanup failed");}
  })();
  try {
    const operationStore = createDarwinOperationStore(activation, persistence.pool, deps.agentExecution);
    outputOwner = await createDarwinNativeOutputOwner(join(activation.evidenceDirectory, "native-output.bin"));
    actions.push(outputOwner.dispose);
    effectOwner = deps.agentExecution.createDarwinCodexEffectCustodyOwner(); actions.push(effectOwner.dispose);
    const clock = createDarwinControlClock(config.deployment.clock);
    const duration = config.deployment.operationTimeoutMs;
    if (!Number.isSafeInteger(duration) || duration < 1 || duration > 3600000) {throw refused("operation deadline invalid");}
    const deadline = clock.now() + duration;
    const capturedFiles = await capturePreparationFiles(activation);
    const operationLocator = deps.agentExecution.darwinDigest(JSON.stringify(["darwin-operation-locator/v1",
      activation.turn.scope.tenantId, activation.turn.scope.projectId, activation.turn.operationId]));
    const routeLifecyclePath = join(capturedFiles.durableRoot.path, `${operationLocator}.darwin-lifecycle-v1`);
    // Current-kernel reservations supply the genuine issued launch directly.
    // The generic fallback resolver cannot launch anything.
    const hostCustody = new deps.agentExecution.DarwinCooperativeProcessCustody({
      hostLifecycleGeneration: config.host.lifecycleGeneration,
      launchPlans: Object.freeze({async resolve() {throw refused("unbound generic launch");}}),
      monotonicNow: () => performance.now()});
    const projection = await deps.verification.createDarwinLiveVerification({activation, pool: persistence.pool,
      operationStore, agentExecution: deps.agentExecution, getWorkspaceOwner: () => workspaceOwner,
      getArtifacts: () => artifacts, outputOwner, lifetime, hostCustody, readCleanup: persistence.readCleanup,
      readHostCustodyEvidence(identity) {
        const evidence = hostCustody.evidenceForAttempt(identity);
        return evidence ? Object.freeze({kind: "found", ...identity, evidence}) : Object.freeze({kind: "missing", ...identity});
      },
      readHttpRequestIdentities(identity) {
        return deps.agentExecution.inspectDarwinRouteRequestInventory(routeLifecyclePath, identity);
      }});
    let consumersBound = false;
    const nativeConsumers = completion => {
      if (consumersBound || lifetime.signal.aborted) {throw refused("native consumers already bound or closed");}
      consumersBound = true;
      // Genuine workspace/artifact owners read their durable records before
      // these calls. Native route owner calls only after quiescence succeeds.
      const acknowledge = async () => {
        if (!joined) {throw refused("native consumers not joined");}
        return completion;
      };
      return Object.freeze({workspace: acknowledge, artifactResult: acknowledge,
        launchRoute: acknowledge, privateMaterial: acknowledge,
        async output(stream, bytes) {await outputOwner.write(stream, bytes); return completion;}});
    };
    const createWorkspaceComposition = async input => {
      if (compositionEntered || lifetime.signal.aborted || !input.workspaceOwner || !input.artifacts) {throw refused("workspace composition unavailable");}
      compositionEntered = true;
      selected = input.selectedNativeWorkspace;
      nativeLaunch = await deps.agentExecution.prepareDarwinCodexNativeLaunchInput(selected, "workspace-write");
      workspaceOwner = input.workspaceOwner; artifacts = input.artifacts;
      const owner = Object.freeze({hostBootId: config.host.bootId, hostInstanceId: config.host.instanceId,
        hostCustody, workspaceOwner, effectCustody: effectOwner.authority,
        platformTarget: Object.freeze({platform: "darwin", architecture: "arm64"}),
        launchRecords: createDarwinLaunchRecords(activation, nativeLaunch, input.withCredentialOutputInventory)});
      const {hostCustody: _borrowed, ...selectedOwner} = owner;
      joined = Object.freeze({deployment: Object.freeze({owner,
        qualificationTarget: config.deployment.qualificationTarget, runtimeSecurity: persistence.repository,
        deploymentId: config.deployment.id, policyOwner: retainedEgressPolicy(activation, clock, lifetime, deadline),
        signer: Object.freeze({...config.deployment.signer, clock: Object.freeze({read: clock.read})}),
        dns: config.deployment.dns, transport: config.deployment.transport,
        clock: Object.freeze({now: clock.now, within: clock.within})}),
      host: Object.freeze({authorityRevision: config.host.authorityRevision, capabilities: Object.freeze({}),
        containedTurn: Object.freeze({authority: "current", hostCustody,
          selectedProvider: Object.freeze({kind: "codex", owner: Object.freeze(selectedOwner)})})})});
      return joined;
    };
    const createPostClaimPreparation = async (selection, httpLaunchAuthority) => {
      if (!joined || selected !== selection || !httpLaunchAuthority || lifetime.signal.aborted || preparationEntered) {throw refused("native preparation authority differs");}
      preparationEntered = true;
      return Object.freeze({...capturedFiles, boundary: nativeLaunch.boundary, tmpDir: nativeLaunch.tmpDir,
        hostCustody, effectCustody: effectOwner, httpLaunchAuthority,
        executable: Object.freeze({path: activation.codex.path, sha256: activation.codex.sha256}), observer: config.deployment.observer,
        launcherSha256: config.deployment.launcherSha256, nodeSha256: config.deployment.nodeSha256,
        limits: Object.freeze({...config.deployment.limits, deadline, closureDeadline: deadline + 30000}),
        localCut: Object.freeze({expectedClock: config.deployment.clock,
          clock: Object.freeze({read: clock.read, within: clock.within}), operationDeadline: deadline,
          hostShutdownSignal: lifetime.signal})});
    };
    return Object.freeze({...persistence, operationId: activation.turn.operationId, dispose,
      assembly: Object.freeze({...filesystem, nativeConsumers, operationStore, createWorkspaceComposition,
        createPostClaimPreparation, sealAdmission, ...projection})});
  } catch (error) {
    try {await dispose();} catch (cleanupError) {throw persistenceAcquisitionFailure(error, cleanupError);}
    throw error;
  }
}
