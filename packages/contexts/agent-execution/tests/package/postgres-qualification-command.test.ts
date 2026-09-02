import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  POSTGRES_QUALIFICATION_CHILD_TIMEOUT_MS,
  POSTGRES_QUALIFICATION_TIMEOUT_DIAGNOSTIC,
  runPostgresQualification,
} from "../../scripts/run-postgres-qualification.mjs";

const packageRoot = fileURLToPath(new URL("../../", import.meta.url));
const repositoryRoot = fileURLToPath(new URL("../../../../../", import.meta.url));
const qualificationCommand = join(packageRoot, "scripts/run-postgres-qualification.mjs");
const containedTurnTestRoot = join(packageRoot, "tests/features/contained-agent-turn");
const qualificationDatabaseUrl =
  "postgresql://qualification-user:qualification-secret@db.internal:5432/qualification";
const postgresTests = [
  join(containedTurnTestRoot, "postgres-contained-turn.test.ts"),
  join(containedTurnTestRoot, "postgres-current-owner-submit-integration.test.ts"),
  join(containedTurnTestRoot, "postgres-contained-turn-recovery.test.ts"),
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
  databaseUrl = qualificationDatabaseUrl,
  environment = {},
  result,
  spawn = () => result,
}: Readonly<{
  args?: readonly string[];
  databaseUrl?: string;
  environment?: NodeJS.ProcessEnv;
  result: SpawnResult;
  spawn?: (...arguments_: readonly unknown[]) => SpawnResult;
}>) => {
  let stdout = "";
  let stderr = "";
  const status = runPostgresQualification({
    args,
    databaseUrl,
    environment,
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

test("PostgreSQL qualification uses bounded pipes and a minimal child environment", () => {
  let invocationOptions: unknown;
  const result = invokeQualification({
    environment: {
      ComSpec: "C:\\Windows\\System32\\cmd.exe",
      Path: "/qualification/bin",
      POSTGRES_DURABILITY_URL: "postgresql://ambient:must-not-win@ambient.invalid/wrong",
      SYNTHETIC_UNRELATED_SECRET: "must-not-reach-postgres-child",
      SYSTEMROOT: "C:\\Windows",
      TMPDIR: "/qualification/tmp",
    },
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
    env: {
      ComSpec: "C:\\Windows\\System32\\cmd.exe",
      PATH: "/qualification/bin",
      POSTGRES_DURABILITY_URL: qualificationDatabaseUrl,
      SystemRoot: "C:\\Windows",
      TMPDIR: "/qualification/tmp",
    },
    maxBuffer: 256 * 1024,
    killSignal: "SIGTERM",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: POSTGRES_QUALIFICATION_CHILD_TIMEOUT_MS,
  });
  assert.ok(POSTGRES_QUALIFICATION_CHILD_TIMEOUT_MS < 20 * 60 * 1000);
});

test("PostgreSQL qualification uses exact argv for every focused PostgreSQL test file", async () => {
  let invokedExecutable: unknown;
  let invocationArguments: readonly string[] | undefined;
  const result = invokeQualification({
    result: successfulChild,
    spawn: (executable, arguments_) => {
      invokedExecutable = executable;
      invocationArguments = arguments_ as readonly string[];
      return successfulChild;
    },
  });
  const discoveredTests = (await readdir(containedTurnTestRoot))
    .filter((entry) => /^postgres-.*\.test\.ts$/u.test(entry))
    .map((entry) => join(containedTurnTestRoot, entry))
    .sort();

  assert.equal(result.status, 0);
  assert.equal(invokedExecutable, process.execPath);
  assert.deepEqual(invocationArguments, [
    "--test",
    "--test-concurrency=1",
    ...postgresTests,
  ]);
  assert.deepEqual([...postgresTests].sort(), discoveredTests);
  assert.ok(
    discoveredTests.includes(
      join(containedTurnTestRoot, "postgres-contained-turn-recovery.test.ts"),
    ),
  );
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
      stderr: `child was interrupted while using ${qualificationDatabaseUrl}\n`,
      stdout: "",
    },
  });

  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.doesNotMatch(result.stderr, /qualification-user|qualification-secret|db\.internal/u);
  assert.match(result.stderr, /child was interrupted while using \*+/u);
  assert.match(result.stderr, /test runner terminated by a signal/u);
});

test("PostgreSQL qualification fails closed on a child spawn error", () => {
  const spawnError = Object.assign(new Error("spawn failed"), { code: "ENOENT" });
  const result = invokeQualification({
    result: {
      error: spawnError,
      signal: null,
      status: null,
      stderr: `spawn context ${qualificationDatabaseUrl}\n`,
      stdout: "",
    },
  });

  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.doesNotMatch(result.stderr, /qualification-user|qualification-secret|db\.internal/u);
  assert.match(result.stderr, /spawn context \*+/u);
  assert.match(result.stderr, /test runner could not be started/u);
});

test("PostgreSQL qualification classifies timeout first without leaking child context", () => {
  const timeoutError = Object.assign(new Error("timeout included a raw path"), {
    code: "ETIMEDOUT",
    path: "/sensitive/qualification/runner",
  });
  const result = invokeQualification({
    environment: { SYNTHETIC_UNRELATED_SECRET: "ambient-secret" },
    result: {
      error: timeoutError,
      signal: "SIGTERM",
      status: null,
      stderr: `stderr ${qualificationDatabaseUrl} ambient-secret /sensitive/qualification/runner\n`,
      stdout: `stdout ${qualificationDatabaseUrl}\n`,
    },
  });

  assert.deepEqual(result, {
    status: 1,
    stdout: "",
    stderr: POSTGRES_QUALIFICATION_TIMEOUT_DIAGNOSTIC,
  });
});

test("PostgreSQL qualification fails closed when spawn throws", () => {
  const result = invokeQualification({
    result: successfulChild,
    spawn: () => {
      throw new Error(`must not escape ${qualificationDatabaseUrl}`);
    },
  });

  assert.deepEqual(result, {
    status: 1,
    stdout: "",
    stderr: "PostgreSQL qualification failed: test runner could not be started.\n",
  });
});

test("PostgreSQL qualification suppresses all raw output on ENOBUFS", () => {
  const overflowError = Object.assign(new Error("capture overflow"), { code: "ENOBUFS" });
  const result = invokeQualification({
    result: {
      error: overflowError,
      signal: "SIGTERM",
      status: null,
      stderr: `bounded failure context ${qualificationDatabaseUrl}\n`,
      stdout: "untrusted partial stdout\n",
    },
  });

  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(
    result.stderr,
    "PostgreSQL qualification failed: test runner output exceeded the safe capture limit.\n",
  );
});

test("PostgreSQL qualification suppresses oversized raw output without an ENOBUFS marker", () => {
  const result = invokeQualification({
    result: {
      signal: null,
      status: 1,
      stderr: `${qualificationDatabaseUrl}${"x".repeat(256 * 1024)}`,
      stdout: "untrusted stdout must also be withheld\n",
    },
  });

  assert.deepEqual(result, {
    status: 1,
    stdout: "",
    stderr:
      "PostgreSQL qualification failed: test runner output exceeded the safe capture limit.\n",
  });
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
  assert.match(diagnostics, /connection failed for \*+/u);
  assert.match(diagnostics, /PostgreSQL qualification failed: test runner exited unsuccessfully/u);
});

test("PostgreSQL qualification redacts short URL components in one bounded pass", () => {
  const databaseUrl = "postgresql://u:p@h:1/d?q=x#y";
  const rawDiagnostic = `u|p|h|1|d|q|x|y|${databaseUrl}\n`;
  const result = invokeQualification({
    databaseUrl,
    result: {
      signal: null,
      status: 0,
      stdout: rawDiagnostic,
      stderr: "",
    },
  });

  assert.equal(result.status, 0);
  assert.equal(Buffer.byteLength(result.stdout), Buffer.byteLength(rawDiagnostic));
  assert.equal(result.stdout, `*|*|*|*|*|*|*|*|${"*".repeat(databaseUrl.length)}\n`);
  assert.equal(result.stderr, "");
});

test("PostgreSQL qualification rejects malformed URLs before spawn without echoing input", () => {
  for (const [databaseUrl, args] of [
    ["not-a-postgres-url-sensitive-fragment", []],
    ["https://qualification-secret@example.invalid/database", []],
    [`postgresql://${"s".repeat(8193)}@example.invalid/database`, []],
    ["not-a-postgres-url-sensitive-fragment", ["--preflight"]],
  ] as const) {
    let spawnCalls = 0;
    const result = invokeQualification({
      args,
      databaseUrl,
      result: successfulChild,
      spawn: () => {
        spawnCalls += 1;
        return successfulChild;
      },
    });

    assert.deepEqual(result, {
      status: 1,
      stdout: "",
      stderr: "PostgreSQL qualification failed: POSTGRES_DURABILITY_URL is malformed.\n",
    });
    assert.equal(spawnCalls, 0);
  }
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

  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  assert.match(result.stdout, /skipped 16/u);
  assert.match(result.stdout, /pass 3/u);
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

test("ci.yml invokes the required PostgreSQL wrapper with its disposable URL", async () => {
  const workflow = await readFile(join(repositoryRoot, ".github/workflows/ci.yml"), "utf8");
  const requiredInvocation =
    "run: pnpm --filter @agent-teams/agent-execution test:postgres";

  assert.equal(workflow.split(requiredInvocation).length - 1, 1);
  assert.match(
    workflow,
    /postgres-durability:[\s\S]*?services:[\s\S]*?postgres:[\s\S]*?POSTGRES_DURABILITY_URL: postgresql:\/\/postgres:postgres@127\.0\.0\.1:5432\/contained_turn_test\n\s+run: pnpm --filter @agent-teams\/agent-execution test:postgres/u,
  );
  assert.doesNotMatch(
    workflow,
    /postgres-durability:[\s\S]*?run: node --test[^\n]*postgres-/u,
  );
});
