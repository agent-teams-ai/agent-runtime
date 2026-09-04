/**
 * Runs the live-canary body around an exact kernel custody reservation.
 * A rejected open has no kernel reservation that this layer is authorized to
 * contain. Partial Host allocation must be represented by an explicit typed
 * cleanup/rollback result; this layer never infers that result.
 */
export const runContainedTurnLiveCanaryLifecycle = async input => {
  let failure;
  let failed = false;
  let opened = false;
  let physicalContainment;
  let value;
  const preserveFirstFailure = error => {
    if (!failed) {
      failed = true;
      failure = error;
    }
  };

  try {
    const reservation = await input.open();
    opened = true;
    value = await input.execute(reservation);
  } catch (error) {
    preserveFirstFailure(error);
  }

  if (opened) {
    try {
      physicalContainment = await input.requestPhysicalContainment();
    } catch (error) {
      preserveFirstFailure(error);
    }
  }

  try {
    await input.dispose();
  } catch (error) {
    preserveFirstFailure(error);
  }

  if (failed) { throw failure; }
  return Object.freeze({ physicalContainment, value });
};

/**
 * No caller boolean, environment variable, or evidence document can authorize
 * the missing enforced route. Keep this closed until the repository's exact
 * route owner can supply qualified Provider Access and Runtime Security ports.
 * In particular, do not replace these owners with synthetic grant receipts.
 * @returns {Pick<import('../../dist/composition.js').ContainedTurnFeatureDependencies, 'security' | 'providerAccess'>}
 */
export const requireContainedTurnLiveCanaryAuthorities = () => {
  throw Object.assign(new Error("route-enforcement-unqualified"), {
    reason: "route-enforcement-unqualified",
  });
};

/**
 * Only the kernel submits, prepares, claims, starts, drains, and terminalizes.
 * This seam is also exercised with provider-free owners; it never builds proof
 * fields or retries submission. Unknown/cancelled outcomes remain typed views.
 * @param {{dependencies: import('../../dist/composition.js').ContainedTurnFeatureDependencies,
 * owner: Pick<import('../../dist/composition.js').CodexCurrentKernelOwner, 'dispose'>,
 * command: import('../../dist/features/contained-agent-turn/contracts/contained-agent-turn.js').SubmitContainedTurnInput}} input
 */
export const submitContainedTurnLiveCanary = async input => {
  const { createContainedTurnFeature } = await import("../../dist/composition.js");
  let failed = false;
  try {
    const feature = createContainedTurnFeature(input.dependencies);
    const outcome = await feature.submit.execute(input.command);
    if (outcome.status !== "observed") {
      throw new Error(`canary command not observed: ${outcome.status}`);
    }
    const turn = outcome.turn;
    for (const [cursor, chunk] of turn.output.entries()) {
      if (chunk.cursor !== cursor) {throw new Error("canary output is not zero-based and contiguous");}
    }
    const { containedTurnIdentity } = await import("../../dist/features/contained-agent-turn/domain/contained-turn-identities.js");
    const operation = await input.dependencies.operationStore.read({
      operationId: containedTurnIdentity("operation", turn.operationId), scope: input.command.scope,
    });
    if (operation === undefined || operation.commandId !== turn.commandId ||
        operation.effectId !== turn.effectId || operation.commandId !== input.command.commandId) {
      throw new Error("canary durable identity mismatch");
    }
    if (turn.status === "succeeded" && (operation.terminal.kind !== "final" ||
        turn.artifactManifestRef === undefined || turn.resultRef === undefined ||
        !operation.proofs.some(proof => proof.kind === "output_drain") ||
        !operation.proofs.some(proof => proof.kind === "terminal_truth"))) {
      throw new Error("canary success lacks durable drain, artifact, or terminal evidence");
    }
    return Object.freeze({physicalContainment: operation.physicalContainment.kind === "contained"
      ? operation.physicalContainment : Object.freeze({kind: "indeterminate"}), turn});
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    try {await input.owner.dispose();} catch (error) {
      if (!failed) {throw error;}
      // The durable kernel owns containment and reconciliation after acceptance.
      // Disposal cannot replace the primary failure or authorize another start.
    }
  }
};

/**
 * Explicitly supplied, unused disposable database and sandbox only. There is no
 * ambient PG URL fallback, schema reset, provider launch, or cleanup deletion.
 * @param {{authorities: Pick<import('../../dist/composition.js').ContainedTurnFeatureDependencies, 'security' | 'providerAccess'>,
 * canaryRoot: string, canonicalProjectRoot: string, databaseUrl: string}} input
 */
export const createDisposableContainedTurnCanaryRuntime = async input => {
  const { lstat, mkdir, open, readdir, realpath } = await import("node:fs/promises");
  const { isAbsolute, join, relative } = await import("node:path");
  const { Pool } = await import("pg");
  const { applyContainedTurnPostgresSchema, PostgresContainedTurnOperationStore,
    createNodeContainedTurnArtifacts } = await import("../../dist/composition.js");
  const { createNodeContainedTurnWorkspaceOwner } = await import(
    "../../dist/features/contained-agent-turn/adapters/outbound/filesystem/node-contained-turn-workspace-owner.js"
  );
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
      /** @param {Pick<import('../../dist/composition.js').CodexCurrentKernelOwner, 'custody' | 'provider'>} owner */
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
