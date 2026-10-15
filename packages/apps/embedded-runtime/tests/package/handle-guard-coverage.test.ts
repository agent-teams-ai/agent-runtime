import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, test } from "node:test";
import { guardHandles } from "@get-modular/conformance";
import { testProcesses } from "../../scripts/run-package-tests.mjs";

const handles = guardHandles();

// --test-force-exit hides a leak in any file that does not check its handles, so every such file must.
test("every file of a force-exit test process checks its handles last", async () => {
  for (const argv of testProcesses.filter(process => process.includes("--test-force-exit"))) {
    for (const file of argv.filter(argument => argument.startsWith("tests/"))) {
      const source = await readFile(new URL(`../../${file}`, import.meta.url), "utf8");
      assert.match(source, /^const handles = guardHandles\(\);$/mu, file);
      assert.match(source, /after\(\(\) => handles\.check\(\)\);\s*$/u, file);
    }
  }
});

after(() => handles.check());
