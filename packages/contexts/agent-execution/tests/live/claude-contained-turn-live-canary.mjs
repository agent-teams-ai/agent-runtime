import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";

import {
  ClaudeAgentSdkContainedTurnProvider,
  createClaudeAgentSdkEnvironment,
  createClaudeAgentSdkLaunchPlan,
  createStaticHostCustodyLaunchPlanResolver,
  NodeProviderProcessCustody,
} from "../../dist/composition.js";

const requiredEnvironment = name => {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {throw new Error(`missing ${name}`);}
  return value;
};

const canaryRoot = await realpath(requiredEnvironment("AR_CLAUDE_CANARY_ROOT"));
const workspaceRef = await realpath(requiredEnvironment("AR_CLAUDE_CANARY_WORKSPACE"));
const executablePath = await realpath(requiredEnvironment("AR_CLAUDE_BINARY"));
const executableSha256 = requiredEnvironment("AR_CLAUDE_BINARY_SHA256");
const expectedRootMarker = join(canaryRoot, ".agent-runtime-test-sandbox");
const configDirectory = join(workspaceRef, ".claude-agent-runtime");

assert.equal((await lstat(expectedRootMarker)).isFile(), true);
assert.equal(workspaceRef.startsWith(`${canaryRoot}/`), true);
assert.equal(configDirectory.startsWith(`${canaryRoot}/`), true);
assert.equal(createHash("sha256").update(await readFile(executablePath)).digest("hex"), executableSha256);
assert.equal((await lstat(join(configDirectory, ".credentials.json"))).isFile(), true);

const credentialDigest = createHash("sha256")
  .update(await readFile(join(configDirectory, ".credentials.json")))
  .digest("hex");
const providerBinding = Object.freeze({
  adapterRevision: "claude-agent-sdk-contained-turn:0.3.251",
  binaryRevision: "@anthropic-ai/claude-agent-sdk:0.3.251+linux-x64",
  capabilityManifestRevision: "contained-turn:v1:claude-agent-sdk:0.3.251",
  credentialBindingDigest: `sha256:${credentialDigest}`,
  provider: "claude",
  providerRouteRef: "test-route:hosted-linux:claude-subscription",
});
const environment = createClaudeAgentSdkEnvironment(workspaceRef);
const plan = createClaudeAgentSdkLaunchPlan({
  binaryRevision: providerBinding.binaryRevision,
  environment,
  executablePath,
  executableSha256,
  workspaceRef,
});
const custody = new NodeProviderProcessCustody({
  forceKillAfterMs: 5_000,
  launchPlans: createStaticHostCustodyLaunchPlanResolver([{ plan, providerBinding }]),
  terminateAfterMs: 5_000,
});
const provider = new ClaudeAgentSdkContainedTurnProvider({
  cancellationPollMs: 50,
  executablePath,
  interruptGraceMs: 5_000,
  manifest: {
    effectClass: "contained_unmediated_effect",
    providerBinding,
    supportedModes: ["analysis", "workspace-write"],
  },
  processes: custody,
  turnTimeoutMs: 180_000,
});
const attemptId = "attempt:claude-live-canary";
const operationId = "operation:claude-live-canary";
const opened = await custody.open({ attemptId, operationId, providerBinding, workspaceRef });
const output = [];
let outcome;
let containment;
let providerStderr = "";
try {
  outcome = await provider.execute({
    attemptId,
    custody: opened,
    effectId: "effect:claude-live-canary",
    emit: async chunk => {output.push(chunk.text);},
    intent: {
      mode: "analysis",
      prompt: "Reply with exactly AR_CLAUDE_CANARY_OK. Do not invoke tools, spawn agents, or modify files.",
    },
    isCancellationRequested: async () => false,
    operationId,
    workspaceRef,
  });
} finally {
  containment = await custody.requestContainment({ attemptId, custodyRef: opened.custodyRef, operationId });
  const liveProcess = custody.get(opened.custodyRef);
  if (liveProcess !== undefined) {
    for await (const bytes of liveProcess.stderr) {
      providerStderr = `${providerStderr}${Buffer.from(bytes).toString("utf8")}`.slice(-2_000);
    }
  }
}

assert.equal(
  outcome?.kind,
  "completed",
  `Claude canary did not complete: ${JSON.stringify({
    outcome,
    output: output.join("").slice(0, 2_000),
    providerStderr,
  })}`,
);
assert.equal(outcome?.outcome, "succeeded", `Claude canary failed: ${output.join(" | ").slice(0, 2_000)}`);
assert.match(output.join(""), /AR_CLAUDE_CANARY_OK/u);
assert.equal(containment.kind, "contained");
process.stdout.write(`${JSON.stringify({
  binarySha256: executableSha256,
  containment: containment.kind,
  outputDigest: createHash("sha256").update(output.join("")).digest("hex"),
  outputEvents: output.length,
  provider: "claude-agent-sdk",
  status: outcome.outcome,
})}\n`);
