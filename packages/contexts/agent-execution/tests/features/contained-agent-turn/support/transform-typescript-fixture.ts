import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const compiler = join(dirname(createRequire(import.meta.url).resolve("typescript/package.json")), "bin/tsc");

// Node 26 only strips erasable syntax. Use the pinned compiler's stable CLI:
// TypeScript 7 does not expose the former transpileModule API.
// Compile one source in isolation, preserving ESM imports and native JS syntax.
export const transformTypeScriptFixture = (source: string): string => {
  const root = mkdtempSync(join(tmpdir(), "ar-typescript-fixture-"));
  try {
    writeFileSync(join(root, "fixture.ts"), source);
    writeFileSync(join(root, "tsconfig.json"), JSON.stringify({
      compilerOptions: {
        noCheck: true,
        noResolve: true,
        types: [],
        module: "ESNext",
        target: "ESNext",
        verbatimModuleSyntax: true,
        useDefineForClassFields: true,
        outDir: "output",
      },
      files: ["fixture.ts"],
    }));
    execFileSync(process.execPath, [compiler, "--project", join(root, "tsconfig.json")], {
      stdio: "pipe", timeout: 30_000,
    });
    return readFileSync(join(root, "output/fixture.js"), "utf8");
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
};
