import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("freezes the prospective provider-specific no-product-input Claude contract", async () => {
  const declaration = await readFile(
    join(packageRoot, "dist", "contracts", "runtime-access.d.ts"),
    "utf8",
  );
  assert.match(
    declaration,
    /interface ClaudeCodeRuntimeAccessHandle[\s\S]*?claudeCodeSetup: ClaudeCodeRuntimeSetupQueries/u,
  );
  assert.match(
    declaration,
    /interface ClaudeCodeRuntimeSetupQueries[\s\S]*?inspect\(options\?: \{[\s\S]*?signal\?: AbortSignal/u,
  );
  assert.doesNotMatch(
    declaration.match(/interface ClaudeCodeRuntimeSetupQueries[\s\S]*?\n\}/u)?.[0] ?? "",
    /nativeProfile|input:/u,
  );
  assert.match(declaration, /managedPolicy: "unobserved"/u);
  assert.match(declaration, /sessionOverrides: "unobserved"/u);
  assert.match(declaration, /interactiveShellPath: "unobserved"/u);
  assert.doesNotMatch(declaration, /"max"/u);
});

test("keeps the Claude composition provider-passive", async () => {
  const source = await readFile(
    join(packageRoot, "src", "composition", "claude-code-contract-spine.ts"),
    "utf8",
  );
  assert.doesNotMatch(source, /child_process|fetch|node:(?:http|https|net|tls)|process\.(?:env|cwd)/u);
  assert.match(source, /assertClaudeCodeContractSpine/u);
});

test("composes the private callable without provider execution or ambient input", async () => {
  const source = await readFile(
    join(packageRoot, "src", "composition", "agent-runtime-host.ts"),
    "utf8",
  );
  assert.match(source, /claudeCodeSetup/u);
  assert.doesNotMatch(
    source,
    /ClaudeCodeSetupNotImplementedError|child_process|fetch|process\.(?:env|cwd)|claude --version|claude doctor/u,
  );
});
