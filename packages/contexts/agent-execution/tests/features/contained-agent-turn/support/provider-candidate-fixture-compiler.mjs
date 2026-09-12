import { mkdir, readFile, writeFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { dirname, join } from "node:path";

// Dependency-free compiler stand-in ONLY for the disposable provenance fixture.
// It consumes actual source bytes and emits executable JS. This exercises the
// fixed subprocess recipe and stale-output rejection, not TypeScript qualification.
const project = process.argv[process.argv.indexOf("--project") + 1];
const root = dirname(project);
const config = JSON.parse(await readFile(project, "utf8"));
const source = await readFile(join(root, config.compilerOptions.rootDir, "runtime.ts"), "utf8");
await mkdir(join(root, config.compilerOptions.outDir), {recursive: true});
await writeFile(join(root, config.compilerOptions.outDir, "runtime.js"), stripTypeScriptTypes(source));
