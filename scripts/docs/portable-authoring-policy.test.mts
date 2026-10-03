import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { assertQualificationAllocationDisposed } from "./portable-authoring-test-support.mts";
import { assertPortableCommand, assertPortableResults, portableCommand, portableFiles, portableScenarioIds } from "./portable-authoring-policy.mts";
import type { ScopeEvidence, Terminal } from "./portable-authoring-policy.mts";

const terminals: Terminal[] = portableScenarioIds.map(id => ({ name: `portable authoring preserves ${id}`, status: "pass" }));
const scopes: ScopeEvidence[] = portableScenarioIds.map((id, index) => {
  const scope = `/TEST/${id}`;
  return { id, runId: "d5cc90e5-dbdd-48e7-8302-2b0b4d96a7b7", entryFile: `/TEST/repository/${portableFiles[index]!}`, pid: index + 1, scope, outer: `${scope}/t/outer`, inner: `${scope}/t/inner/consumer`, cwd: `${scope}/t/outer`,
    home: `${scope}/h`, cache: `${scope}/c`, temp: `${scope}/t`, start: 10 + index * 10, end: 19 + index * 10, cleaned: true };
});
test("portable gate refuses omitted, duplicated, no-op and unbounded command selections", () => {
  assertPortableCommand(portableCommand);
  for (const command of [portableCommand.replace(` ${portableFiles[0]}`, ""), portableCommand + ` ${portableFiles[0]}`,
    "node -e ''", portableCommand.replace("concurrency=2", "concurrency=3")]) {assert.throws(() => assertPortableCommand(command));}
});
test("portable inventory refuses missing, duplicate, nonpassing and overlapping writable evidence", () => {
  assertPortableResults(terminals, scopes);
  assert.throws(() => assertPortableResults(terminals.slice(1), scopes));
  assert.throws(() => assertPortableResults([...terminals, terminals[0]!], scopes));
  for (const change of [{ status: "fail" as const }, { skip: true }, { todo: true }, { skip: "" }, { todo: "" }]) {
    assert.throws(() => assertPortableResults(terminals.map((item, index) => index === 0 ? { ...item, ...change } : item), scopes));
  }
  assert.throws(() => assertPortableResults(terminals, []));
  assert.throws(() => assertPortableResults(terminals, scopes.map((item, index) => index === 1 ? { ...scopes[0]!, id: item.id, pid: item.pid, start: item.start, end: item.end } : item)));
  assert.throws(() => assertPortableResults(terminals, scopes.map(item => ({ ...item, inner: item.outer }))));
  assert.throws(() => assertPortableResults(terminals, scopes.map(item => ({ ...item, start: 1, end: 100 }))));
});
test("actual Node reporter refuses an empty entry and a passing test without real qualification evidence", async () => {
  // A deleted registration or early-return helper otherwise produces a green Node command.
  const root = await mkdtemp(join(tmpdir(), "dq-refusal-"));
  try {
    const file = join(root, "no-op.test.mts");
    for (const source of ["", 'import test from "node:test"; test("portable authoring preserves runtime-index", () => {});',
      'import test from "node:test";\n' + portableScenarioIds.map(id => `test("portable authoring preserves ${id}", () => {});`).join("\n")]) {
      await writeFile(file, source);
      const result = spawnSync(process.execPath, ["--import=" + new URL("./portable-authoring-policy.mts", import.meta.url).pathname, "--test", "--test-reporter=" + new URL("./portable-authoring-reporter.mts", import.meta.url).pathname, file], { encoding: "utf8", env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "NODE_TEST_CONTEXT")) });
      assert.notEqual(result.status, 0, result.stdout + result.stderr);
      assert.match(result.stderr, /missing, duplicate or unexpected portable test|missing or duplicate real qualification scope|unexpected portable test identity|foreign Node entry file/u);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("actual Node children refuse previous-run scope replay and foreign current-run entry evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "dq-replay-"));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "NODE_TEST_CONTEXT"));
  try {
    for (const foreign of [false, true]) {
      const files: string[] = [];
      for (const [index, id] of portableScenarioIds.entries()) {
        const expected = join(root, portableFiles[index]!);
        const file = foreign ? join(root, `foreign-${index}.test.mts`) : expected;
        await mkdir(dirname(file), { recursive: true });
        const evidence = { ...scopes[index]!, entryFile: expected };
        // Otherwise-valid stored evidence; these actual children perform no qualification.
        const source = 'import test from "node:test";\n' +
          `const evidence = ${JSON.stringify(evidence)};\n` +
          (foreign ? 'evidence.runId = process.env.DOCS_PORTABLE_RUN_ID;\n' : "") +
          `test("portable authoring preserves ${id}", () => { console.log("DOCS_SCOPE " + JSON.stringify(evidence)); });\n`;
        await writeFile(file, source);
        files.push(file);
      }
      const result = spawnSync(process.execPath, [
        "--import=" + fileURLToPath(new URL("./portable-authoring-policy.mts", import.meta.url)),
        "--test", "--test-concurrency=2",
        "--test-reporter=" + fileURLToPath(new URL("./portable-authoring-reporter.mts", import.meta.url)), ...files.map(file => relative(root, file))
      ], { encoding: "utf8", cwd: root, env });
      assert.notEqual(result.status, 0, result.stdout + result.stderr);
      assert.match(result.stderr, foreign ? /foreign Node entry file/u : /outside the current run/u);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("portable cleanup refuses a retained SDK allocation before broad consumer cleanup", async () => {
  const scope = await mkdtemp(join(tmpdir(), "dq-cleanup-"));
  const allocation = join(scope, "t", "atd-q-retained"), inner = join(allocation, "consumer");
  try {
    await mkdir(inner, { recursive: true });
    await writeFile(join(inner, "package.json"), "{}\n");
    const journal = join(allocation, "retained-journal.json");
    await writeFile(journal, "owned SDK cleanup debt\n");
    await rm(inner, { recursive: true });
    await assert.rejects(readFile(join(inner, "package.json")), { code: "ENOENT" });
    await assert.rejects(assertQualificationAllocationDisposed(inner), /fully disposed before consumer cleanup/u);
    assert.equal(await readFile(journal, "utf8"), "owned SDK cleanup debt\n");
    await rm(allocation, { recursive: true });
    await assertQualificationAllocationDisposed(inner);
  } finally { await rm(scope, { recursive: true, force: true }); }
});
