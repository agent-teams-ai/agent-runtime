import assert from "node:assert/strict";
import {execFile} from "node:child_process";
import {createHash} from "node:crypto";
import {cp, mkdir, mkdtemp, readFile, rename, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {dirname, join, resolve} from "node:path";
import {createRequire} from "node:module";
import {fileURLToPath} from "node:url";
import {promisify} from "node:util";
import test from "node:test";

const run = promisify(execFile);
const require = createRequire(import.meta.url);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

test("packed canonical SPI compiles outside checkout with no SDK/workspace dependencies and exports no runtime values", async () => {
  const root = await mkdtemp(join(tmpdir(), "TEST-interactive-contracts-pack-"));
  try {
    const stage = join(root, "stage", "package"); await mkdir(stage, {recursive: true});
    await cp(join(packageRoot, "dist"), join(stage, "dist"), {recursive: true});
    await cp(join(packageRoot, "package.json"), join(stage, "package.json"));
    const archive = join(root, "agent-execution.tgz");
    await run("tar", ["-czf", archive, "-C", join(root, "stage"), "package"]);
    const consumer = join(root, "consumer"); const modules = join(consumer, "node_modules", "@agent-teams");
    await mkdir(modules, {recursive: true});
    await run("tar", ["-xzf", archive, "-C", modules]);
    await rename(join(modules, "package"), join(modules, "agent-execution"));
    await writeFile(join(consumer, "package.json"), '{"type":"module"}\n');
    await writeFile(join(consumer, "tsconfig.json"), JSON.stringify({compilerOptions: {target: "ES2024", module: "NodeNext", moduleResolution: "NodeNext", strict: true, skipLibCheck: false, types: [], noEmit: true}, files: ["consumer.ts"]}));
    await writeFile(join(consumer, "consumer.ts"), `import type {DriverFactory, Event, Session} from "@agent-teams/agent-execution/interactive-contracts";
      export const consume = async (factory: DriverFactory, event: Event): Promise<Session> => {
        const opened = await factory.open({tenantId:"TEST",projectId:"TEST",sessionId:"TEST",generation:1,configRevision:"TEST",requiredCapabilities:[]});
        if (event.operationRef) {await opened.driver.interrupt(event.operationRef);}
        return opened.driver;
      };\n`);
    const compiler = join(dirname(require.resolve("typescript/package.json")), "bin", "tsc");
    await run(process.execPath, [compiler, "--project", join(consumer, "tsconfig.json"), "--pretty", "false"], {cwd: consumer, timeout: 20000});
    const runtime = await run(process.execPath, ["--input-type=module", "-e", 'const value=await import("@agent-teams/agent-execution/interactive-contracts"); if(Object.keys(value).length) process.exit(1);'], {cwd: consumer, timeout: 10000});
    assert.equal(runtime.stderr, "");
    const installed = JSON.parse(await readFile(join(modules, "agent-execution", "package.json"), "utf8"));
    assert.deepEqual(installed.exports["./interactive-contracts"], {types: "./dist/interactive-contracts.d.ts", import: "./dist/interactive-contracts.js"});
    await writeFile(join(consumer, "consumer.ts"), 'import type {ClaudeConfig} from "@agent-teams/agent-execution/interactive-contracts";\n');
    await assert.rejects(run(process.execPath, [compiler, "--project", join(consumer, "tsconfig.json"), "--pretty", "false"], {cwd: consumer, timeout: 20000}), error => {
      assert.match(String((error as {stdout?: string}).stdout), /TS2305.*ClaudeConfig/u); return true;
    });
    console.log("INTERACTIVE_PUBLIC_IMPORT_OBSERVATION " + JSON.stringify({
      packageName: installed.name, exportPath: "./interactive-contracts", targets: installed.exports["./interactive-contracts"],
      archiveSha256: sha256(await readFile(archive)), manifestSha256: sha256(await readFile(join(modules, "agent-execution", "package.json"))),
      strictTypesWithoutSdkOrWorkspace: true, runtimeExports: [], providerSpecificTypeRejected: true,
    }));
  } finally {await rm(root, {recursive: true, force: true});}
});
