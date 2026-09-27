import assert from "node:assert/strict";
import test from "node:test";
import {auditNodeEngineCompatibility, satisfiesNodeRange} from "./audit-node-engine-compatibility.mjs";

test("qualified Node versions accept production 24 and Node 26 while skipping 25", () => {
  const range = ">=24.18.0 <25 || >=26.10.0 <27";
  for (const target of ["24.18.0", "24.21.0", "26.10.0", "26.14.2"]) {
    assert.equal(satisfiesNodeRange(range, target), true, target);
  }
  for (const target of ["24.17.9", "25.0.0", "26.9.9", "27.0.0"]) {
    assert.equal(satisfiesNodeRange(range, target), false, target);
  }
});

test("published engine ranges catch a dependency that rejects Node 26", () => {
  const lockfile = `packages:\n\n  'example@1.0.0':\n    engines: {node: '>=24.18.0 <25'}\n`;
  const result = auditNodeEngineCompatibility([], lockfile);
  assert.deepEqual(result.find(({target}) => target === "24.18.0"), {target: "24.18.0", blockers: []});
  assert.deepEqual(result.find(({target}) => target === "26.10.0"), {
    target: "26.10.0",
    blockers: [{name: "example@1.0.0", range: ">=24.18.0 <25"}],
  });
});

test("common transitive engine forms remain portable across both qualified majors", () => {
  for (const range of ["18 || 20 || >=22", "^20.19.0 || >=22.12.0", "^22.22.2 || ^24.15.0 || >=26.0.0"]) {
    assert.equal(satisfiesNodeRange(range, "24.18.0"), true, range);
    assert.equal(satisfiesNodeRange(range, "26.10.0"), true, range);
  }
});
