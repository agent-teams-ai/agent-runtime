import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const databaseUrl = process.env.POSTGRES_DURABILITY_URL;
const preflightOnly = process.argv.length === 3 && process.argv[2] === "--preflight";

if (databaseUrl === undefined || databaseUrl.trim() === "") {
  process.stderr.write(
    "PostgreSQL qualification failed: POSTGRES_DURABILITY_URL is required and must not be empty.\n",
  );
  process.exitCode = 1;
} else if (process.argv.length > 2 && !preflightOnly) {
  process.stderr.write("PostgreSQL qualification failed: unsupported runner arguments.\n");
  process.exitCode = 1;
} else if (preflightOnly) {
  process.exitCode = 0;
} else {
  const packageRoot = fileURLToPath(new URL("../", import.meta.url));
  const testFiles = [
    fileURLToPath(
      new URL(
        "../tests/features/contained-agent-turn/postgres-contained-turn.test.ts",
        import.meta.url,
      ),
    ),
    fileURLToPath(
      new URL(
        "../tests/features/contained-agent-turn/postgres-current-owner-submit-integration.test.ts",
        import.meta.url,
      ),
    ),
  ];
  const result = spawnSync(
    process.execPath,
    ["--test", "--test-concurrency=1", ...testFiles],
    {
      cwd: packageRoot,
      env: process.env,
      stdio: "inherit",
    },
  );

  if (result.error !== undefined) {
    process.stderr.write("PostgreSQL qualification failed: test runner could not be started.\n");
    process.exitCode = 1;
  } else {
    process.exitCode = result.status ?? 1;
  }
}
