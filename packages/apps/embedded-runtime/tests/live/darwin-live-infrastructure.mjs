import {createHash} from "node:crypto";
import {lstat, readFile, realpath} from "node:fs/promises";
import {isAbsolute} from "node:path";
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
    const identity = await client.query("SELECT current_database() AS database, current_user AS username");
    if (identity.rows[0]?.database !== database.connection.database ||
        identity.rows[0]?.username !== database.connection.user) {throw refused("database identity differs");}
    const prepared = await client.query("SELECT gid FROM pg_prepared_xacts WHERE database = current_database()");
    if (prepared.rows.length !== 0) {throw refused("prepared transactions exist");}
    // The complete dedicated database must be fresh. Metadata tables can carry
    // migrations; every other application table is read, including unknown tables.
    const tables = await client.query("SELECT schemaname, tablename FROM pg_tables WHERE schemaname NOT IN ('pg_catalog', 'information_schema')");
    const metadata = new Set(["schema_version", "materialization_schema", "dispatch_schema", "dispatch_operation_schema", "route_selection_schema"]);
    for (const {schemaname, tablename} of tables.rows) {
      if (metadata.has(tablename)) {continue;}
      const rows = await client.query(`SELECT 1 FROM ${quote(schemaname)}.${quote(tablename)} LIMIT 1`);
      if (rows.rows.length) {throw refused("dedicated database contains application rows");}
    }
    const root = await realpath(filesystem.sourceRoot);
    if (root !== filesystem.sourceRoot || !activation.turn.resultPath.startsWith(root + "/")) {throw refused("result outside test source");}
    try {await lstat(activation.turn.resultPath); throw refused("source result exists");}
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
