import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const manifestPath = fileURLToPath(import.meta.resolve("@agent-teams/engineering-foundation/package.json"));
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const cli = join(dirname(manifestPath), manifest.bin["agent-teams-foundation"]);

function fixture(t, governedRoot = "src") {
  const root = mkdtempSync(join(tmpdir(), "ar-source-inputs-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (path, content) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), typeof content === "string" ? content : JSON.stringify(content));
  };
  write("package.json", { name: "disposable-quality-consumer", private: true, type: "module" });
  write("pnpm-workspace.yaml", { packages: [] });
  write("foundation.config.yaml", { schemaVersion: 2, project: { id: "disposable-quality-consumer" },
    capabilities: { "architecture.source-dependencies": { configPath: "source-policy.yaml" } } });
  write("source-policy.yaml", {
    schemaVersion: 3, workspace: { kind: "pnpm", manifest: "pnpm-workspace.yaml" },
    rootPackage: true, packageRoots: [], governedRoots: [governedRoot],
    boundaries: [{ id: "consumer.policy", dependencyMode: "runtime", roots: [governedRoot],
      entrypoints: [`${governedRoot}/index.ts`],
      allow: { boundaries: [], packages: [], builtins: [], runtimeReferences: [] } }]
  });
  write(`${governedRoot}/index.ts`, "export const value = 1;\n");
  const check = () => {
    const result = spawnSync(process.execPath, [cli, "check", "architecture.source-dependencies", "--consumer", root, "--json"], {
      encoding: "utf8", timeout: 30_000
    });
    assert.equal(result.error, undefined, result.stderr);
    return { status: result.status, envelope: JSON.parse(result.stdout) };
  };
  return { root, write, check };
}

test("installed source boundary accepts the ordinary complete declared input", t => {
  const result = fixture(t).check();
  assert.equal(result.status, 0, JSON.stringify(result.envelope));
});
test("installed source boundary rejects a missing declared root", t => {
  const context = fixture(t);
  rmSync(join(context.root, "src"), { recursive: true });
  const result = context.check();
  assert.equal(result.status, 2, JSON.stringify(result.envelope));
  assert.equal(result.envelope.outcome, "invalid-input");
});
test("installed source boundary rejects a declared policy that is not readable as a file", t => {
  const context = fixture(t);
  rmSync(join(context.root, "source-policy.yaml"));
  mkdirSync(join(context.root, "source-policy.yaml"));
  const result = context.check();
  assert.equal(result.status, 2, JSON.stringify(result.envelope));
  assert.equal(result.envelope.outcome, "invalid-input");
});
test("explicitly governed package dist source reaches the installed import boundary", t => {
  const context = fixture(t, "dist");
  assert.equal(context.check().status, 0);
  context.write("dist/index.ts", 'import fs from "node:fs";\nexport const value = fs;\n');
  const result = context.check();
  assert.equal(result.status, 1, JSON.stringify(result.envelope));
  assert.ok(result.envelope.capabilities[0].diagnostics.some(diagnostic =>
    diagnostic.ruleId === "architecture.source-dependencies.forbidden-builtin-dependency"
    && diagnostic.location.path === "dist/index.ts"), JSON.stringify(result.envelope));
});
