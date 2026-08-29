import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";

import {
  CodexAppServerContainedTurnProvider,
  createCodexAppServerLaunchPlan,
  createStaticHostCustodyLaunchPlanResolver,
  NodeProviderProcessCustody,
} from "../../dist/composition.js";

const requiredEnvironment = name => {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {throw new Error(`missing ${name}`);}
  return value;
};

const canaryRoot = await realpath(requiredEnvironment("AR_CODEX_CANARY_ROOT"));
const workspaceRef = await realpath(requiredEnvironment("AR_CODEX_CANARY_WORKSPACE"));
const codexHome = await realpath(requiredEnvironment("AR_CODEX_CANARY_CODEX_HOME"));
const executablePath = await realpath(requiredEnvironment("AR_CODEX_BINARY"));
const executableSha256 = requiredEnvironment("AR_CODEX_BINARY_SHA256");
const expectedRootMarker = join(canaryRoot, ".agent-runtime-test-sandbox");

assert.equal((await lstat(expectedRootMarker)).isFile(), true);
assert.equal(workspaceRef.startsWith(`${canaryRoot}/`), true);
assert.equal(codexHome.startsWith(`${canaryRoot}/`), true);
assert.equal(createHash("sha256").update(await readFile(executablePath)).digest("hex"), executableSha256);

const authDigest = createHash("sha256").update(await readFile(join(codexHome, "auth.json"))).digest("hex");
const providerBinding = Object.freeze({
  adapterRevision: "codex-app-server-contained-turn:0.150.1",
  binaryRevision: "@openai/codex:0.150.1+linux-x64",
  capabilityManifestRevision: "contained-turn:v1:codex-app-server:0.150.1",
  credentialBindingDigest: `sha256:${authDigest}`,
  provider: "codex",
  providerRouteRef: "test-route:hosted-linux:codex-subscription",
});
const plan = createCodexAppServerLaunchPlan({
  binaryRevision: providerBinding.binaryRevision,
  environment: {
    CODEX_HOME: codexHome,
    HOME: canaryRoot,
    LANG: "C.UTF-8",
    PATH: "/usr/local/bin:/usr/bin:/bin",
    TMPDIR: join(canaryRoot, "tmp"),
  },
  executablePath,
  executableSha256,
});
const custody = new NodeProviderProcessCustody({
  forceKillAfterMs: 5_000,
  launchPlans: createStaticHostCustodyLaunchPlanResolver([{ plan, providerBinding }]),
  terminateAfterMs: 5_000,
});
const provider = new CodexAppServerContainedTurnProvider({
  cancellationPollMs: 50,
  manifest: {
    effectClass: "contained_unmediated_effect",
    providerBinding,
    supportedModes: ["analysis", "workspace-write"],
  },
  processes: custody,
  requestTimeoutMs: 30_000,
  turnTimeoutMs: 180_000,
});
const attemptId = "attempt:codex-live-canary";
const operationId = "operation:codex-live-canary";
const opened = await custody.open({ attemptId, operationId, providerBinding, workspaceRef });
const output = [];
let outcome;
let containment;
try {
  outcome = await provider.execute({
    attemptId,
    custody: opened,
    effectId: "effect:codex-live-canary",
    emit: async chunk => {output.push(chunk.text);},
    intent: {
      mode: "analysis",
      prompt: "Reply with exactly AR_CODEX_CANARY_OK. Do not invoke tools, spawn agents, or modify files.",
    },
    isCancellationRequested: async () => false,
    operationId,
    workspaceRef,
  });
} finally {
  containment = await custody.requestContainment({ attemptId, custodyRef: opened.custodyRef, operationId });
}

assert.equal(outcome?.kind, "completed");
assert.equal(outcome?.outcome, "succeeded");
assert.match(output.join(""), /AR_CODEX_CANARY_OK/u);
assert.equal(containment.kind, "contained");
process.stdout.write(`${JSON.stringify({
  binarySha256: executableSha256,
  containment: containment.kind,
  outputDigest: createHash("sha256").update(output.join("")).digest("hex"),
  outputEvents: output.length,
  provider: "codex-app-server",
  status: outcome.outcome,
})}\n`);
