import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("root API exposes only product capabilities and keeps Host in composition", async () => {
  const rootDeclaration = await readFile(join(packageRoot, "dist", "index.d.ts"), "utf8");
  const capabilityDeclaration = await readFile(
    join(packageRoot, "dist", "contracts", "runtime-access.d.ts"),
    "utf8",
  );
  const publicSurface = `${rootDeclaration}\n${capabilityDeclaration}`;
  assert.match(publicSurface, /RuntimeAccessHandle/u);
  assert.match(publicSurface, /codexSetup/u);
  assert.match(publicSurface, /inspect/u);
  assert.doesNotMatch(
    publicSurface,
    /AgentRuntimeHost|TrustedRuntimeAccessScope|ModuleDefinition|Container|Registry|Repository|Transport/u,
  );

  const manifest = JSON.parse(
    await readFile(join(packageRoot, "package.json"), "utf8"),
  ) as { readonly exports: Readonly<Record<string, unknown>> };
  assert.deepEqual(Object.keys(manifest.exports).toSorted(), [".", "./composition"]);
});

test("production slice has no process, network, ambient env or write adapter", async () => {
  const repositoryRoot = resolve(packageRoot, "../../..");
  const roots = [
    join(repositoryRoot, "packages", "apps", "embedded-runtime", "src"),
    join(repositoryRoot, "packages", "contexts", "agent-execution", "src"),
    join(repositoryRoot, "packages", "contexts", "runtime-configuration", "src"),
    join(repositoryRoot, "packages", "contexts", "runtime-security", "src"),
  ];
  const files: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
      } else if (entry.name.endsWith(".ts")) {
        files.push(path);
      }
    }
  };
  for (const root of roots) {
    await walk(root);
  }
  const source = (await Promise.all(files.map(file => readFile(file, "utf8")))).join("\n");
  assert.doesNotMatch(
    source,
    /node:(?:child_process|http|https|net|tls)|process\.env|spawn\(|execFile\(|writeFile\(|appendFile\(/u,
  );
});
