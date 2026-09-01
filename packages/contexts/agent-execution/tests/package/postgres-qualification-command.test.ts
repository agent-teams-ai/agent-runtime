import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

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

test("explicit PostgreSQL qualification fails for an unreachable configured service", () => {
  const unreachableUrl =
    "postgresql://qualification-user:qualification-secret@127.0.0.1:0/qualification";
  const result = spawnSync(process.execPath, [qualificationCommand], {
    cwd: packageRoot,
    encoding: "utf8",
    env: {
      ...environmentWithoutDatabaseUrl(),
      POSTGRES_DURABILITY_URL: unreachableUrl,
    },
    timeout: 10_000,
  });

  assert.equal(result.error, undefined);
  assert.notEqual(result.status, null);
  assert.notEqual(result.status, 0);
  const output = `${result.stdout}\n${result.stderr}`;
  assert.equal(output.includes(unreachableUrl), false);
  assert.doesNotMatch(output, /qualification-secret/u);
  assert.doesNotMatch(result.stdout, /# skipped 13/u);
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
