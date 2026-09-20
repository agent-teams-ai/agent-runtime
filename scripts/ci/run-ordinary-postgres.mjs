import {run} from "node:test";
import {resolve} from "node:path";
import {fileURLToPath, pathToFileURL} from "node:url";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const requiredTests = [
  ["agent-execution", "contained-agent-turn/ordinary-core-postgres.test.ts",
    "disposable PostgreSQL ordinary namespace: concurrent accept and claim, durable restart and scope isolation"],
  ["runtime-security", "contained-turn-dispatch-authority/ordinary-security-postgres.test.ts",
    "ordinary security durable consumed identity, unknown-commit readback, settlement and no persisted secrets"],
  ["provider-access", "contained-turn-access/ordinary-pa-postgres.test.ts",
    "ordinary PA PostgreSQL grants, counters, retirement and original rendering authority"],
].map(([owner, suffix, name]) => ({file: resolve(repositoryRoot, `packages/contexts/${owner}/tests/features/${suffix}`), name}));

// This gate is deliberately limited to a fresh local test cluster. Generic package
// tests may omit PostgreSQL, but this mandatory CI entrypoint must never skip it.
export const ordinaryPostgresEnvironment = (environment) => {
  const result = {};
  for (const key of ["PATH", "TMPDIR", "TEMP", "TMP", "SystemRoot"]) {
    if (environment[key] !== undefined) {result[key] = environment[key];}
  }
  for (const key of ["ORDINARY_TEST_POSTGRES_URL", "ORDINARY_PA_TEST_POSTGRES_URL"]) {
    let url;
    try {url = new URL(environment[key]);} catch {throw new Error(`${key}: disposable socket URL required`);}
    if (url.protocol !== "postgresql:" || url.hostname !== "localhost" || url.port !== ""
      || url.pathname !== "/postgres" || url.password !== "" || url.hash !== ""
      || JSON.stringify([...url.searchParams.keys()]) !== '["host"]'
      || !/^\/tmp\/ordinary-pa-pg-TEST-[a-zA-Z0-9_-]+$/u.test(url.searchParams.get("host"))) {
      throw new Error(`${key}: disposable socket URL required`);
    }
    result[key] = url.href;
  }
  return result;
};

export const runOrdinaryPostgres = async ({environment = process.env, runTests = run,
  write = message => process.stdout.write(message)} = {}) => {
  const env = ordinaryPostgresEnvironment(environment);
  const seen = new Set();
  let failed = false;
  let completed = false;
  const events = runTests({files: requiredTests.map(test => test.file), concurrency: 1,
    isolation: "process", cwd: repositoryRoot, env, execArgv: [], timeout: 180_000,
    signal: AbortSignal.timeout(240_000)});
  for await (const {type, data} of events) {
    if (type === "test:fail" || data.skip || data.todo) {failed = true;}
    if (type === "test:pass" || type === "test:fail") {
      const expected = requiredTests.find(test => test.file === data.file && test.name === data.name);
      if (expected && type === "test:pass" && !data.skip && !data.todo) {seen.add(expected.file);}
      write(`${type}: ${data.name}${data.skip ? " SKIP" : ""}${data.todo ? " TODO" : ""}\n`);
      if (type === "test:fail") {write(`${String(data.details?.error ?? "test failed")}\n`);}
    }
    if (type === "test:summary" && data.file === undefined) {
      completed = data.success === true && data.counts.failed === 0
        && data.counts.cancelled === 0 && data.counts.skipped === 0 && data.counts.todo === 0;
    }
  }
  if (failed || !completed || seen.size !== requiredTests.length) {
    throw new Error(`Ordinary PostgreSQL gate incomplete: ${seen.size}/${requiredTests.length} required tests passed without skips`);
  }
  write("Ordinary PostgreSQL gate: all 3 required integration tests passed without skips\n");
};

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 2) {throw new Error("Ordinary PostgreSQL gate accepts no arguments");}
    await runOrdinaryPostgres();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
