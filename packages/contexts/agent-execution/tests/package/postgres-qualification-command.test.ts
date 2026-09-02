import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { runPostgresQualification } from "../../scripts/run-postgres-qualification.mjs";

const packageRoot = fileURLToPath(new URL("../../", import.meta.url));
const qualificationCommand = join(packageRoot, "scripts/run-postgres-qualification.mjs");
const postgresTests = [
  join(packageRoot, "tests/features/contained-agent-turn/postgres-contained-turn.test.ts"),
  join(packageRoot, "tests/features/contained-agent-turn/postgres-current-owner-submit-integration.test.ts"),
];

const environmentWithoutDatabaseUrl = (): NodeJS.ProcessEnv => {
  const environment = { ...process.env };
  delete environment.NODE_TEST_CONTEXT;
  delete environment.POSTGRES_DURABILITY_URL;
  return environment;
};

type SpawnResult = Readonly<{
  error?: NodeJS.ErrnoException;
  signal: NodeJS.Signals | null;
  status: number | null;
  stderr: string;
  stdout: string;
}>;

const invokeQualification = ({
  args = [],
  databaseUrl = "postgresql://qualification-user:qualification-secret@db.internal:5432/qualification",
  result,
  spawn = () => result,
}: Readonly<{
  args?: readonly string[];
  databaseUrl?: string;
  result: SpawnResult;
  spawn?: (...arguments_: readonly unknown[]) => SpawnResult;
}>) => {
  let stdout = "";
  let stderr = "";
  const status = runPostgresQualification({
    args,
    databaseUrl,
    environment: {},
    executable: process.execPath,
    spawn,
    writeStdout: (diagnostic: string) => {
      stdout += diagnostic;
    },
    writeStderr: (diagnostic: string) => {
      stderr += diagnostic;
    },
  });
  return { status, stderr, stdout };
};

const successfulChild: SpawnResult = {
  signal: null,
  status: 0,
  stderr: "",
  stdout: "runner tests passed\n",
};

test("PostgreSQL qualification rejects unsupported arguments before starting tests", () => {
  let spawnCalls = 0;
  const result = invokeQualification({
    args: ["--unknown"],
    result: successfulChild,
    spawn: () => {
      spawnCalls += 1;
      return successfulChild;
    },
  });

  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(
    result.stderr,
    "PostgreSQL qualification failed: unsupported runner arguments.\n",
  );
  assert.equal(spawnCalls, 0);
});

test("successful PostgreSQL preflight does not fall through into long tests", () => {
  let spawnCalls = 0;
  const result = invokeQualification({
    args: ["--preflight"],
    result: successfulChild,
    spawn: () => {
      spawnCalls += 1;
      return successfulChild;
    },
  });

  assert.deepEqual(result, { status: 0, stderr: "", stdout: "" });
  assert.equal(spawnCalls, 0);
});

test("PostgreSQL qualification captures child diagnostics with bounded pipes", () => {
  let invocationOptions: unknown;
  const result = invokeQualification({
    result: successfulChild,
    spawn: (_executable, _arguments, options) => {
      invocationOptions = options;
      return successfulChild;
    },
  });

  assert.deepEqual(result, {
    status: 0,
    stderr: "",
    stdout: "runner tests passed\n",
  });
  assert.deepEqual(invocationOptions, {
    cwd: packageRoot,
    encoding: "utf8",
    env: {},
    maxBuffer: 256 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
});

test("PostgreSQL qualification fails closed on a child nonzero exit", () => {
  const result = invokeQualification({
    result: {
      signal: null,
      status: 2,
      stderr: "assertion context remains available\n",
      stdout: "test runner context remains available\n",
    },
  });

  assert.equal(result.status, 1);
  assert.equal(result.stdout, "test runner context remains available\n");
  assert.equal(
    result.stderr,
    "assertion context remains available\n" +
      "PostgreSQL qualification failed: test runner exited unsuccessfully.\n",
  );
});

test("PostgreSQL qualification fails closed on child signal and null status", () => {
  const result = invokeQualification({
    result: {
      signal: "SIGTERM",
      status: null,
      stderr: "child was interrupted\n",
      stdout: "",
    },
  });

  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(
    result.stderr,
    "child was interrupted\n" +
      "PostgreSQL qualification failed: test runner terminated by a signal.\n",
  );
});

test("PostgreSQL qualification fails closed on a child spawn error", () => {
  const spawnError = Object.assign(new Error("spawn failed"), { code: "ENOENT" });
  const result = invokeQualification({
    result: {
      error: spawnError,
      signal: null,
      status: null,
      stderr: "",
      stdout: "",
    },
  });

  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(
    result.stderr,
    "PostgreSQL qualification failed: test runner could not be started.\n",
  );
});

test("PostgreSQL qualification fails closed when captured output overflows", () => {
  const overflowError = Object.assign(new Error("capture overflow"), { code: "ENOBUFS" });
  const result = invokeQualification({
    result: {
      error: overflowError,
      signal: "SIGTERM",
      status: null,
      stderr: "bounded failure context\n",
      stdout: "",
    },
  });

  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(
    result.stderr,
    "bounded failure context\n" +
      "PostgreSQL qualification failed: test runner output exceeded the safe capture limit.\n",
  );
});

test("PostgreSQL qualification redacts URL credentials and host from child diagnostics", () => {
  const databaseUrl =
    "postgresql://sensitive-user:p%40ssword@private.db.internal:5432/private_database?sslpassword=query-secret";
  const result = invokeQualification({
    databaseUrl,
    result: {
      signal: null,
      status: 1,
      stdout: `connection failed for ${databaseUrl}\n`,
      stderr:
        "user sensitive-user password p@ssword encoded p%40ssword " +
        "host private.db.internal:5432 database private_database query query-secret\n",
    },
  });
  const diagnostics = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 1);
  assert.doesNotMatch(diagnostics, /sensitive-user/u);
  assert.doesNotMatch(diagnostics, /p@ssword|p%40ssword/u);
  assert.doesNotMatch(diagnostics, /private\.db\.internal/u);
  assert.doesNotMatch(diagnostics, /5432/u);
  assert.doesNotMatch(diagnostics, /private_database|query-secret/u);
  assert.equal(diagnostics.includes(databaseUrl), false);
  assert.match(diagnostics, /connection failed for \[REDACTED\]/u);
  assert.match(diagnostics, /PostgreSQL qualification failed: test runner exited unsuccessfully/u);
});

test("explicit PostgreSQL gates fail closed without a durability URL", () => {
  for (const invocationArguments of [[], ["--preflight"]]) {
    const result = spawnSync(process.execPath, [qualificationCommand, ...invocationArguments], {
      cwd: packageRoot,
      encoding: "utf8",
      env: environmentWithoutDatabaseUrl(),
    });

    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.equal(
      result.stderr,
      "PostgreSQL qualification failed: POSTGRES_DURABILITY_URL is required and must not be empty.\n",
    );
  }
});

test("explicit PostgreSQL qualification rejects an empty durability URL", () => {
  const result = spawnSync(process.execPath, [qualificationCommand], {
    cwd: packageRoot,
    encoding: "utf8",
    env: { ...process.env, POSTGRES_DURABILITY_URL: "   " },
  });

  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(
    result.stderr,
    "PostgreSQL qualification failed: POSTGRES_DURABILITY_URL is required and must not be empty.\n",
  );
});

test("ordinary direct PostgreSQL test discovery remains optional without a service", () => {
  const result = spawnSync(
    process.execPath,
    ["--test", "--test-concurrency=1", ...postgresTests],
    {
      cwd: packageRoot,
      encoding: "utf8",
      env: environmentWithoutDatabaseUrl(),
    },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /skipped 13/u);
  assert.match(result.stdout, /fail 0/u);
});

test("package scripts reserve the fail-closed wrapper for the explicit gate", async () => {
  const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")) as {
    readonly scripts: Readonly<Record<string, string>>;
  };

  assert.equal(manifest.scripts["test:postgres"], "node scripts/run-postgres-qualification.mjs");
  assert.match(manifest.scripts.test ?? "", /tests\/features\/contained-agent-turn\/\*\.test\.ts/u);
  assert.doesNotMatch(manifest.scripts.test ?? "", /run-postgres-qualification/u);
  assert.match(
    manifest.scripts["test:contained-turn:acceptance"] ?? "",
    /^node scripts\/run-postgres-qualification\.mjs --preflight && .*pnpm run test:postgres$/u,
  );
});
