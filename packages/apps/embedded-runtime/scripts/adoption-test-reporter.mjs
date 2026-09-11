import assert from "node:assert/strict";
import { relative, resolve } from "node:path";

const skipReason = skip => skip ? (typeof skip === "string" ? skip : "registration skip option evaluated true") : null;

// Node 24's ordered start/pass/fail stream preserves ancestry even for concurrent tests.
// Per-file summaries bind helper registrations to the explicit manifest input suite.
export default async function* reporter(source) {
  const root = resolve(import.meta.dirname, "../../../..");
  const path = file => relative(root, file).split("\\").join("/");
  let pending = [], stack = [], ended = false;
  let occurrences = new Map();
  yield JSON.stringify({kind: "begin", version: 1}) + "\n";
  for await (const {type, data: d} of source) {
    if (type === "test:stdout" || type === "test:stderr") {
      yield JSON.stringify({kind: "output", stream: type.slice(5), message: d.message}) + "\n";
    } else if (type === "test:start") {
      assert.equal(stack.length, d.nesting);
      const ancestry = stack.map(item => item.segment);
      const site = [path(d.file), d.line, d.column, d.name];
      const key = JSON.stringify([ancestry, site]);
      const ordinal = (occurrences.get(key) ?? 0) + 1;
      occurrences.set(key, ordinal);
      stack.push({file: path(d.file), line: d.line, column: d.column,
        title: d.name, ancestry, ordinal, segment: [...site, ordinal]});
    } else if (type === "test:pass" || type === "test:fail") {
      const event = stack.pop();
      assert.equal(event?.title, d.name); assert.equal(stack.length, d.nesting);
      pending.push({...event, status: d.todo ? "todo" : type === "test:fail" ? "failed"
        : d.skip ? "skipped" : "passed", skip: d.skip ?? null, skipReason: skipReason(d.skip), type: d.details.type});
    } else if (type === "test:complete" && d.details.passed === false) {
      yield JSON.stringify({kind: "failure", file: d.file ? path(d.file) : null}) + "\n";
    } else if (type === "test:summary") {
      assert.equal(stack.length, 0);
      if (d.file) {
        const suite = path(d.file);
        for (const event of pending) {yield JSON.stringify({kind: "test", suite, ...event}) + "\n";}
        yield JSON.stringify({kind: "file", suite, counts: d.counts, success: d.success}) + "\n";
        pending = []; occurrences = new Map();
      } else {
        assert.equal(pending.length, 0);
        yield JSON.stringify({kind: "summary", counts: d.counts, success: d.success}) + "\n";
        ended = true;
      }
    }
  }
  assert.ok(ended, "missing process summary");
  yield JSON.stringify({kind: "end"}) + "\n";
}
