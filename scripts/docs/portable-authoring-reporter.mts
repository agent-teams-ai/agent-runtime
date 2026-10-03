import assert from "node:assert/strict";
import { resolve } from "node:path";
import { z } from "zod";
import { assertPortableResults, currentPortableRunId, portableFiles, portableScenarioIds, scopeSchema } from "./portable-authoring-policy.mts";
import type { ScopeEvidence, Terminal } from "./portable-authoring-policy.mts";

const eventSchema = z.object({ type: z.string(), data: z.unknown() });
const terminalSchema = z.object({ name: z.string(), file: z.string(), skip: z.union([z.string(), z.boolean()]).optional(), todo: z.union([z.string(), z.boolean()]).optional() });
const stdoutSchema = z.object({ message: z.string(), file: z.string() });

// A second standard Node reporter enforces Runtime's inventory; built-in TAP retains details.
export default async function* reporter(source: AsyncIterable<unknown>) {
  const terminals: Terminal[] = [], scopes: ScopeEvidence[] = [];
  const runId = currentPortableRunId(), entryRoot = process.cwd();
  const entryFile = (id: typeof portableScenarioIds[number]) => resolve(entryRoot, portableFiles[portableScenarioIds.indexOf(id)]!);
  yield "DOCS_RUN " + JSON.stringify({ runId, entryRoot }) + "\n";
  for await (const input of source) {
    const event = eventSchema.parse(input);
    if (event.type === "test:pass" || event.type === "test:fail") {
      const terminal = terminalSchema.parse(event.data);
      const id = portableScenarioIds.find(candidate => terminal.name === `portable authoring preserves ${candidate}`);
      assert.ok(id, "unexpected portable test identity");
      assert.equal(resolve(entryRoot, terminal.file), entryFile(id), "portable terminal belongs to a foreign Node entry file");
      terminals.push({ ...terminal, status: event.type === "test:pass" ? "pass" : "fail" });
    }
    if (event.type === "test:stdout") {
      const { message, file } = stdoutSchema.parse(event.data);
      if (message.startsWith("DOCS_SCOPE ")) {
        const scope = scopeSchema.parse(JSON.parse(message.slice(11)));
        assert.equal(scope.runId, runId, "portable scope replay is outside the current run");
        const nodeEntryFile = resolve(entryRoot, file);
        assert.equal(scope.entryFile, nodeEntryFile, "portable scope belongs to a foreign Node entry file");
        assert.equal(nodeEntryFile, entryFile(scope.id), "portable scope does not match its selected Node entry file");
        scopes.push(scope);
      }
    }
    yield "";
  }
  assertPortableResults(terminals, scopes);
}
