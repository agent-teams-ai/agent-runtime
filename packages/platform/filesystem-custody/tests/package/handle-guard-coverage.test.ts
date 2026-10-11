import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, test } from "node:test";
import { guardHandles } from "@get-modular/conformance";

const handles = guardHandles();

// --test-force-exit hides a leak in any file that does not check its handles, so every such file must.
test("every file of the force-exit test command checks its handles last", async () => {
  const manifest = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8")) as { scripts: { test: string } };
  const argv = manifest.scripts.test.split(/\s+/u);
  assert.ok(argv.includes("--test-force-exit"));
  for (const file of argv.filter(argument => argument.startsWith("tests/"))) {
    const source = await readFile(new URL(`../../${file}`, import.meta.url), "utf8");
    assert.match(source, /^const handles = guardHandles\(\);$/mu, file);
    assert.match(source, /after\(\(\) => handles\.check\(\)\);\s*$/u, file);
  }
});

after(() => handles.check());
