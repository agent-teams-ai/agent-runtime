import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { isAbsolute, relative, sep } from "node:path";
import { z } from "zod";

// Consumer policy, not a shared scheduler or qualification implementation.
export const portableScenarioIds = ["runtime-index", "runtime-architecture", "runtime-adr", "runtime-evidence", "runtime-qualification-plan"] as const;
export const portableFiles = portableScenarioIds.map(id => `scripts/docs/portable-authoring-${id.slice(8)}.test.mts`);
// Preloaded in the Node parent before test children inherit its fresh run identity.
if (process.env.NODE_TEST_CONTEXT === undefined) { process.env.DOCS_PORTABLE_RUN_ID = randomUUID(); }
export function currentPortableRunId() { return z.string().uuid().parse(process.env.DOCS_PORTABLE_RUN_ID); }
export const portableCommand = "node --import=./scripts/docs/portable-authoring-policy.mts --test --test-concurrency=2 --test-reporter=tap --test-reporter=./scripts/docs/portable-authoring-reporter.mts --test-reporter-destination=stdout --test-reporter-destination=stderr " + portableFiles.join(" ");
export const scopeSchema = z.object({ id: z.enum(portableScenarioIds), pid: z.number().int().positive(),
  runId: z.string().uuid(), entryFile: z.string(),
  start: z.number().positive(), end: z.number().positive(), scope: z.string(), outer: z.string(), inner: z.string(),
  cwd: z.string(), home: z.string(), cache: z.string(), temp: z.string(), cleaned: z.literal(true) });
export type ScopeEvidence = z.infer<typeof scopeSchema>;
export interface Terminal { name: string; status: "pass" | "fail"; skip?: string | boolean | undefined; todo?: string | boolean | undefined }

export function assertPortableCommand(command: string) {
  assert.equal(command, portableCommand, "portable gate must select all five once, with two standard Node processes and inventory enforcement");
}
function within(parent: string, child: string) {
  const path = relative(parent, child);
  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}
export function assertPortableResults(terminals: readonly Terminal[], scopes: readonly ScopeEvidence[]) {
  assert.deepEqual(terminals.map(item => item.name).toSorted(), portableScenarioIds.map(id => `portable authoring preserves ${id}`).toSorted(), "missing, duplicate or unexpected portable test");
  for (const item of terminals) {assert.ok(item.status === "pass" && (item.skip === undefined || item.skip === false) && (item.todo === undefined || item.todo === false), `nonpassing portable test: ${item.name}`);}
  assert.deepEqual(scopes.map(item => item.id).toSorted(), [...portableScenarioIds].toSorted(), "missing or duplicate real qualification scope");
  for (const item of scopes) {
    scopeSchema.parse(item);
    assert.ok(item.end > item.start && isAbsolute(item.scope));
    assert.equal(item.cwd, item.outer);
    for (const path of [item.outer, item.home, item.cache, item.temp]) {assert.ok(within(item.scope, path), "writable resource escapes scenario ownership");}
    assert.ok(within(item.temp, item.inner), "installed inner qualification needs a separate physical copy");
    const roots = [item.outer, item.inner, item.home, item.cache];
    for (const [index, path] of roots.entries()) {for (const other of roots.slice(index + 1)) {
      assert.ok(path !== other && !within(path, other) && !within(other, path), "overlapping writable resources within scenario");
    }}
  }
  for (const [index, item] of scopes.entries()) {for (const other of scopes.slice(index + 1)) {
    assert.notEqual(item.pid, other.pid, "portable entries need independent processes");
    assert.ok(item.scope !== other.scope && !within(item.scope, other.scope) && !within(other.scope, item.scope), "overlapping writable scenario roots");
  }}
  const transitions = scopes.flatMap(item => [{ at: item.start, delta: 1 }, { at: item.end, delta: -1 }]).toSorted((a, b) => a.at - b.at || a.delta - b.delta);
  let active = 0;
  for (const event of transitions) { active += event.delta; assert.ok(active <= 2, "more than two active portable scenarios"); }
}
