import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { execFileAsync } from "../../live/provider-candidate-source.mjs";

// Executed by the package functional test in a fresh process. Keep all refusal
// and zero-import assertions here so an assertion failure fails that process.
let candidateImports = 0;
const hook = registerHooks({resolve(specifier, context, nextResolve) {
  if (specifier.includes("/dist/") || specifier === "@anthropic-ai/claude-agent-sdk") {
    candidateImports++; throw Error("candidate import forbidden");
  }
  return nextResolve(specifier, context);
}});
try {
  const codex = await import("../../live/codex-contained-turn-live-canary.mjs");
  const claude = await import("../../live/claude-contained-turn-live-canary.mjs");
  assert.equal(candidateImports, 0);
  await assert.rejects(codex.runCanary(), /separately trusted exact/u);
  await assert.rejects(claude.runCanary(), /separately trusted exact/u);
  assert.equal(candidateImports, 0);
  for (const provider of ["codex", "claude"]) {
    const entry = new URL(`../../live/${provider}-contained-turn-live-canary.mjs`, import.meta.url);
    await assert.rejects(execFileAsync(process.execPath, [entry.pathname], {env: {}}), /separate trusted composition required/u);
  }
} finally {hook.deregister();}
process.stdout.write("canary entrypoint inertness assertions passed\n");
