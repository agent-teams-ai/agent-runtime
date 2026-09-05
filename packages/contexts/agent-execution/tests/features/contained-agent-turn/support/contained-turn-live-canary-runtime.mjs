/**
 * Explicitly supplied, unused disposable database and sandbox only. There is no
 * ambient PG URL fallback, schema reset, provider launch, or cleanup deletion.
 * @param {{authorities: Pick<import('../../../../dist/features/contained-agent-turn/internal.js').ContainedTurnFeatureDependencies, 'security' | 'providerAccess'>,
 * canaryRoot: string, canonicalProjectRoot: string, databaseUrl: string}} input
 */
export const createDisposableContainedTurnCanaryRuntime = async input => {
  const { mkdir } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { Pool } = await import("pg");
  const { applyContainedTurnPostgresSchema, PostgresContainedTurnOperationStore,
    createNodeContainedTurnArtifacts } = await import("../../../../dist/features/contained-agent-turn/internal.js");
  const { createNodeContainedTurnWorkspaceOwner } = await import(
    "../../../../dist/features/contained-agent-turn/adapters/outbound/filesystem/node-contained-turn-workspace-owner.js"
  );
  await claimDisposableCanarySandbox(input);
  const pool = new Pool({connectionString: input.databaseUrl, max: 4, connectionTimeoutMillis: 5_000});
  let workspaceOwner;
  try {
    const existing = await pool.query("SELECT nspname FROM pg_namespace WHERE nspname NOT LIKE 'pg_%' AND nspname NOT IN ('public', 'information_schema')");
    const tables = await pool.query("SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' LIMIT 1");
    if (existing.rows.length !== 0 || tables.rows.length !== 0) {
      throw new Error("unused disposable PostgreSQL database required");
    }
    // A separate, exclusive schema prevents two fresh sandboxes sharing one DB.
    await pool.query("CREATE SCHEMA live_canary_single_use");
    await applyContainedTurnPostgresSchema(pool);
    const disposableRoot = join(input.canaryRoot, "kernel");
    await mkdir(disposableRoot, {mode: 0o700});
    const root = join(disposableRoot, "workspaces");
    const artifactRoot = join(disposableRoot, "artifacts");
    const rehydrationRoot = join(disposableRoot, "rehydration");
    for (const path of [root, artifactRoot, rehydrationRoot]) {await mkdir(path, {mode: 0o700});}
    const filesystem = {canonicalProjectRoot: input.canonicalProjectRoot, disposableRoot};
    workspaceOwner = await createNodeContainedTurnWorkspaceOwner({...filesystem, root});
    const artifacts = await createNodeContainedTurnArtifacts({
      ...filesystem, rehydrationRoot, root: artifactRoot, workspaceRoot: root,
    });
    const operationStore = new PostgresContainedTurnOperationStore({pool});
    const selectedWorkspaceOwner = workspaceOwner;
    return Object.freeze({
      workspaceOwner,
      /** @param {Pick<import('../../../../dist/features/contained-agent-turn/internal.js').CodexCurrentKernelOwner, 'custody' | 'provider'>} owner */
      dependencies: owner => Object.freeze({
        operationStore, security: input.authorities.security, providerAccess: input.authorities.providerAccess,
        workspace: selectedWorkspaceOwner.workspace, artifacts, custody: owner.custody, provider: owner.provider,
      }),
      async dispose() {
        try {await selectedWorkspaceOwner.dispose();} finally {await pool.end();}
      },
    });
  } catch (error) {
    try {await workspaceOwner?.dispose();} finally {await pool.end();}
    throw error;
  }
};

const claimDisposableCanarySandbox = async input => {
  const { lstat, open, readdir, realpath } = await import("node:fs/promises");
  const { isAbsolute, join, relative } = await import("node:path");
  const url = new URL(input.databaseUrl);
  if (!["postgres:", "postgresql:"].includes(url.protocol) ||
      !/^\/ar_canary_[a-z0-9_]+$/u.test(url.pathname)) {
    throw new Error("explicit disposable PostgreSQL database ar_canary_* required");
  }
  for (const path of [input.canaryRoot, input.canonicalProjectRoot]) {
    const entry = await lstat(path);
    if (!entry.isDirectory() || entry.isSymbolicLink() || await realpath(path) !== path ||
        entry.uid !== process.getuid?.() || (entry.mode & 0o077) !== 0) {
      throw new Error("private canonical disposable directories required");
    }
  }
  const child = relative(input.canaryRoot, input.canonicalProjectRoot);
  if (!child || child.startsWith("..") || isAbsolute(child) ||
      (await readdir(input.canonicalProjectRoot)).length !== 0) {
    throw new Error("brand-new empty disposable project required");
  }
  const marker = await lstat(join(input.canaryRoot, ".agent-runtime-test-sandbox"));
  if (!marker.isFile() || marker.isSymbolicLink()) {throw new Error("disposable sandbox marker required");}
  // Exclusive creation makes concurrent or repeated invocation fail closed.
  const used = await open(join(input.canaryRoot, ".current-kernel-canary-used"), "wx", 0o600);
  await used.close();
};
