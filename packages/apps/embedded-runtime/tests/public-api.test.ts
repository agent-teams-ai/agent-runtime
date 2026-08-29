import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const readDeclarationClosure = async (entrypoint: string): Promise<string> => {
  const pending = [entrypoint];
  const visited = new Set<string>();
  const declarations: string[] = [];
  while (pending.length > 0) {
    const declarationPath = pending.pop()!;
    if (visited.has(declarationPath)) {
      continue;
    }
    visited.add(declarationPath);
    const declaration = await readFile(declarationPath, "utf8");
    declarations.push(declaration);
    for (const match of declaration.matchAll(/["'](\.[^"']+)["']/gu)) {
      const specifier = match[1]!;
      const referencedPath = resolve(
        dirname(declarationPath),
        specifier.endsWith(".js") ? `${specifier.slice(0, -3)}.d.ts` : specifier,
      );
      pending.push(referencedPath);
    }
  }
  return declarations.join("\n");
};

test("root API exposes only product capabilities and keeps Host in composition", async () => {
  const rootDeclaration = await readFile(join(packageRoot, "dist", "index.d.ts"), "utf8");
  const capabilityDeclaration = await readFile(
    join(packageRoot, "dist", "contracts", "runtime-access.d.ts"),
    "utf8",
  );
  const publicSurface = `${rootDeclaration}\n${capabilityDeclaration}`;
  assert.match(publicSurface, /RuntimeAccessHandle/u);
  assert.match(publicSurface, /codexSetup/u);
  assert.match(publicSurface, /claudeCodeSetup/u);
  assert.match(publicSurface, /containedTurn/u);
  assert.match(publicSurface, /submit/u);
  assert.match(publicSurface, /observe/u);
  assert.match(publicSurface, /cancel/u);
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

test("contained-turn declarations stay owned across root and composition closure", async () => {
  const runtimeAccessSource = await readFile(
    join(packageRoot, "src", "contracts", "runtime-access.ts"),
    "utf8",
  );
  const runtimeAccessDeclaration = await readFile(
    join(packageRoot, "dist", "contracts", "runtime-access.d.ts"),
    "utf8",
  );

  for (const contract of [runtimeAccessSource, runtimeAccessDeclaration]) {
    assert.doesNotMatch(contract, /@agent-teams\/agent-execution/u);
    assert.doesNotMatch(contract, /\bContainedTurnView\b/u);
    assert.match(contract, /interface RuntimeContainedTurnView/u);
    assert.match(contract, /readonly artifactManifestRef\?: string/u);
    assert.match(contract, /readonly commandId: string/u);
    assert.match(contract, /readonly effectId: string/u);
    assert.match(contract, /readonly operationId: string/u);
    assert.match(contract, /readonly output: readonly RuntimeContainedTurnOutputView\[\]/u);
    assert.match(contract, /readonly provider: RuntimeContainedTurnProvider/u);
    assert.match(contract, /readonly resultRef\?: string/u);
    assert.match(contract, /readonly revision: number/u);
    assert.match(contract, /readonly status: RuntimeContainedTurnStatus/u);
  }
  assert.doesNotMatch(
    runtimeAccessSource,
    /interface\s+RuntimeContainedTurnView\s+extends|type\s+RuntimeContainedTurnView\s*=\s*ContainedTurnView/u,
  );

  const [rootClosure, compositionClosure] = await Promise.all([
    readDeclarationClosure(join(packageRoot, "dist", "index.d.ts")),
    readDeclarationClosure(join(packageRoot, "dist", "composition.d.ts")),
  ]);
  assert.doesNotMatch(rootClosure, /@agent-teams\/agent-execution|\bContainedTurnView\b|ContainedTurnFeatureApi/u);
  assert.doesNotMatch(compositionClosure, /\bContainedTurnView\b|ContainedTurnFeatureApi/u);
  assert.match(compositionClosure, /interface ContainedTurnCapabilityBundle/u);
  assert.match(compositionClosure, /expectedProvider: string/u);
});

test("passive setup slice has no process, network, ambient env or write adapter", async () => {
  const repositoryRoot = resolve(packageRoot, "../../..");
  const roots = [
    join(repositoryRoot, "packages", "apps", "embedded-runtime", "src"),
    join(repositoryRoot, "packages", "contexts", "agent-execution", "src", "features", "runtime-installation-discovery"),
    join(repositoryRoot, "packages", "contexts", "runtime-configuration", "src"),
    join(repositoryRoot, "packages", "contexts", "runtime-security", "src"),
    join(repositoryRoot, "packages", "platform", "filesystem-custody", "src"),
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
    /node:(?:child_process|dgram|dns|http|https|net|tls)|process\.(?:cwd|env)|\b(?:fetch|spawn|exec|execFile|fork)\s*\(|\b(?:appendFile|chmod|chown|copyFile|cp|link|lchmod|lchown|lutimes|mkdir|mkdtemp|rename|rm|rmdir|symlink|truncate|unlink|utimes|write|writeFile)\s*\(|\bO_(?:APPEND|CREAT|RDWR|TRUNC|WRONLY)\b/u,
  );
});

test("application and contracts stay independent from adapters and runtime frameworks", async () => {
  const repositoryRoot = resolve(packageRoot, "../../..");
  const roots = [
    join(repositoryRoot, "packages", "apps", "embedded-runtime", "src"),
    join(repositoryRoot, "packages", "contexts", "agent-execution", "src"),
    join(repositoryRoot, "packages", "contexts", "runtime-configuration", "src"),
    join(repositoryRoot, "packages", "contexts", "runtime-security", "src"),
    join(repositoryRoot, "packages", "platform", "filesystem-custody", "src"),
  ];
  const files: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
      } else if (
        entry.name.endsWith(".ts") &&
        (path.includes("/application/") || path.includes("/contracts/"))
      ) {
        files.push(path);
      }
    }
  };
  for (const root of roots) {
    await walk(root);
  }

  for (const file of files) {
    const source = await readFile(file, "utf8");
    const imports = [...source.matchAll(/(?:from\s+|import\s*)["']([^"']+)["']/gu)]
      .map(match => match[1]);
    assert.equal(
      imports.some(specifier =>
        specifier !== undefined &&
        (/node:(?:child_process|dgram|dns|fs|http|https|module|net|tls)/u.test(specifier) ||
          /(?:^|\/)(?:adapters|composition)(?:\/|$)|container|module-graph|registry|transport/u.test(specifier)),
      ),
      false,
      `forbidden inward dependency in ${file}`,
    );
  }
});
