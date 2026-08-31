import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  claudeAgentSdkArguments,
  createClaudeAgentSdkLaunchPlan,
  createClaudeAgentSdkPrivateProjection,
  isClaudeAgentSdkPrivateProjectionUsable,
} from "../dist/features/contained-agent-turn/adapters/outbound/claude-agent-sdk/claude-agent-sdk-launch-plan.js";
import {
  binding,
  delta,
  executablePath,
  input,
  privateProjection,
  privateRoot,
  provider,
  success,
  waitFor,
  workspaceRef,
  type QueryFactory,
} from "./claude-agent-sdk-contained-turn-provider.support.ts";

test("uses only an external frozen private projection while tools remain workspace-bound", async () => {
  let captured: Parameters<Parameters<QueryFactory>[0]["options"]["spawnClaudeCodeProcess"]>[0] | undefined;
  const adapter = provider(queryInput => {
    assert.deepEqual(queryInput.options.env, privateProjection.environment);
    assert.deepEqual(queryInput.options.sandbox.filesystem, { allowRead: [workspaceRef], allowWrite: [] });
    captured = {
      args: [...claudeAgentSdkArguments("analysis", workspaceRef)],
      command: executablePath,
      cwd: workspaceRef,
      env: { ...privateProjection.environment },
      signal: new AbortController().signal,
    };
    queryInput.options.spawnClaudeCodeProcess(captured);
    return {
      close: () => {},
      interrupt: async () => {},
      async *[Symbol.asyncIterator]() { yield success(); },
    };
  });
  assert.equal((await adapter.execute(input())).kind, "completed");
  assert.ok(captured);
  assert.equal(captured.cwd, workspaceRef);
  assert.deepEqual(captured.env, privateProjection.environment);

  const plan = await createClaudeAgentSdkLaunchPlan({
    binaryRevision: binding.binaryRevision,
    executablePath,
    executableSha256: "0".repeat(64),
    intentMode: "analysis",
    privateProjection,
    privateRootPath: privateRoot,
    workspaceRef,
  });
  assert.equal(plan.environment, privateProjection.environment);
  assert.deepEqual(plan.arguments, captured.args);
  assert.throws(() => createClaudeAgentSdkPrivateProjection({
    configRoot: `${workspaceRef}/config`,
    homeRoot: "/tmp/private/home",
    projectionRef: "bad",
    tempRoot: "/tmp/private/tmp",
    workspaceRef,
  }), /disjoint/u);
});

test("rejects forward and reverse symlink aliases between private roots and the workspace", async t => {
  const root = await mkdtemp(join(tmpdir(), "ar-claude-alias-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const workspace = join(root, "workspace");
  const projection = join(root, "projection");
  await Promise.all([
    mkdir(workspace, { mode: 0o700 }),
    mkdir(join(projection, "config"), { mode: 0o700, recursive: true }),
    mkdir(join(projection, "home"), { mode: 0o700, recursive: true }),
    mkdir(join(projection, "tmp"), { mode: 0o700, recursive: true }),
  ]);

  const forwardAlias = join(root, "config-alias");
  await symlink(workspace, forwardAlias, "dir");
  const forwardProjection = createClaudeAgentSdkPrivateProjection({
    configRoot: forwardAlias,
    homeRoot: join(projection, "home"),
    projectionRef: "projection:forward-alias",
    tempRoot: join(projection, "tmp"),
    workspaceRef: workspace,
  });
  assert.equal(await isClaudeAgentSdkPrivateProjectionUsable(forwardProjection, workspace), false);
  await assert.rejects(createClaudeAgentSdkLaunchPlan({
    binaryRevision: binding.binaryRevision,
    executablePath,
    executableSha256: "0".repeat(64),
    intentMode: "analysis",
    privateProjection: forwardProjection,
    privateRootPath: projection,
    workspaceRef: workspace,
  }), /disjoint/u);

  const reverseAlias = join(root, "workspace-alias");
  await symlink(projection, reverseAlias, "dir");
  const reverseProjection = createClaudeAgentSdkPrivateProjection({
    configRoot: join(projection, "config"),
    homeRoot: join(projection, "home"),
    projectionRef: "projection:reverse-alias",
    tempRoot: join(projection, "tmp"),
    workspaceRef: reverseAlias,
  });
  assert.equal(await isClaudeAgentSdkPrivateProjectionUsable(reverseProjection, reverseAlias), false);
  await assert.rejects(createClaudeAgentSdkLaunchPlan({
    binaryRevision: binding.binaryRevision,
    executablePath,
    executableSha256: "0".repeat(64),
    intentMode: "analysis",
    privateProjection: reverseProjection,
    privateRootPath: projection,
    workspaceRef: reverseAlias,
  }), /disjoint/u);
});

test("emits zero-based cursors with exact continuity", async () => {
  const output: { cursor: number; text: string }[] = [];
  const adapter = provider(() => ({
    close: () => {},
    interrupt: async () => {},
    async *[Symbol.asyncIterator]() { yield delta("A"); yield delta("B"); yield success(); },
  }));
  const outcome = await adapter.execute({ ...input(), emit: async chunk => { output.push(chunk); } });
  assert.equal(outcome.kind, "completed");
  assert.deepEqual(output, [
    { cursor: 0, kind: "assistant", text: "A" },
    { cursor: 1, kind: "assistant", text: "B" },
  ]);
});

test("treats duplicate terminal results as ambiguous", async () => {
  const adapter = provider(() => ({
    close: () => {},
    interrupt: async () => {},
    async *[Symbol.asyncIterator]() { yield success("one"); yield success("two"); },
  }));
  assert.equal((await adapter.execute(input())).kind, "ambiguous");
});

test("treats a missing terminal result as ambiguous", async () => {
  const adapter = provider(() => ({
    close: () => {},
    interrupt: async () => {},
    async *[Symbol.asyncIterator]() { yield { type: "system" }; },
  }));
  assert.equal((await adapter.execute(input())).kind, "ambiguous");
});

test("treats iterator failure after a result as ambiguous", async () => {
  const adapter = provider(() => ({
    close: () => {},
    interrupt: async () => {},
    async *[Symbol.asyncIterator]() {
      yield success();
      throw new Error("/private/account credential-secret");
    },
  }));
  assert.equal((await adapter.execute(input())).kind, "ambiguous");
});

test("closes admission for callbacks after the terminal result", async () => {
  const output: string[] = [];
  const adapter = provider(() => ({
    close: () => {},
    interrupt: async () => {},
    async *[Symbol.asyncIterator]() { yield success(); yield delta("LATE_SECRET"); },
  }));
  const outcome = await adapter.execute({ ...input(), emit: async chunk => { output.push(chunk.text); } });
  assert.equal(outcome.kind, "ambiguous");
  assert.deepEqual(output, []);
});

test("emits only bounded typed diagnostics with redacted digests", async () => {
  const output: string[] = [];
  const secret = "sk-ant-abcdefghijklmnopqrstuvwxyz0123456789";
  const adapter = provider(() => ({
    close: () => {},
    interrupt: async () => {},
    async *[Symbol.asyncIterator]() {
      yield {
        errors: [`account@example.com /private/account ${secret} ${"x".repeat(50_000)}`],
        is_error: true,
        session_id: "session:error",
        subtype: "error_during_execution",
        type: "result",
        uuid: "result:error",
      };
    },
  }));
  const outcome = await adapter.execute({ ...input(), emit: async chunk => { output.push(chunk.text); } });
  assert.equal(outcome.kind, "completed");
  if (outcome.kind === "completed") {
    assert.equal(outcome.outcome, "failed");
  }
  assert.equal(output.length, 1);
  assert.ok((output[0]?.length ?? 0) < 256);
  assert.match(output[0] ?? "", /CLAUDE_EXECUTION_ERROR/u);
  assert.doesNotMatch(output[0] ?? "", /account|private|sk-ant|xxxxx/iu);
});

test("never emits the raw result of an error-marked success subtype", async () => {
  const output: { kind: string; text: string }[] = [];
  const credential = "sk-ant-synthetic-private-credential-0123456789";
  const privatePath = "/private/accounts/claude/.credentials.json";
  const adapter = provider(() => ({
    close: () => {},
    interrupt: async () => {},
    async *[Symbol.asyncIterator]() {
      yield {
        is_error: true,
        result: `authentication failed for ${credential} at ${privatePath}`,
        session_id: "session:error-success",
        subtype: "success",
        type: "result",
        uuid: "result:error-success",
      };
    },
  }));
  const outcome = await adapter.execute({ ...input(), emit: async chunk => { output.push(chunk); } });
  assert.equal(outcome.kind, "completed");
  if (outcome.kind === "completed") {
    assert.equal(outcome.outcome, "failed");
  }
  assert.equal(output.length, 1);
  assert.equal(output[0]?.kind, "diagnostic");
  assert.ok((output[0]?.text.length ?? 0) < 256);
  assert.match(output[0]?.text ?? "", /CLAUDE_RESULT_ERROR/u);
  assert.doesNotMatch(output[0]?.text ?? "", /sk-ant|credential|private|accounts/iu);
});

test("preserves non-error success fallback and streamed-output controls", async () => {
  const fallback: string[] = [];
  const fallbackOutcome = await provider(() => ({
    close: () => {},
    interrupt: async () => {},
    async *[Symbol.asyncIterator]() { yield success("fallback"); },
  })).execute({ ...input(), emit: async chunk => { fallback.push(chunk.text); } });
  assert.equal(fallbackOutcome.kind, "completed");
  if (fallbackOutcome.kind === "completed") {
    assert.equal(fallbackOutcome.outcome, "succeeded");
  }
  assert.deepEqual(fallback, ["OK"]);

  const streamedOutput: string[] = [];
  const streamedOutcome = await provider(() => ({
    close: () => {},
    interrupt: async () => {},
    async *[Symbol.asyncIterator]() { yield delta("STREAMED_OK"); yield success("streamed"); },
  })).execute({ ...input(), emit: async chunk => { streamedOutput.push(chunk.text); } });
  assert.equal(streamedOutcome.kind, "completed");
  if (streamedOutcome.kind === "completed") {
    assert.equal(streamedOutcome.outcome, "succeeded");
  }
  assert.deepEqual(streamedOutput, ["STREAMED_OK"]);
});

test("streams intentional assistant text incrementally while redacting a later error result", async () => {
  const output: { kind: string; text: string }[] = [];
  const intentionalAssistantText = "assistant-visible sk-ant-intentional-output-0123456789";
  const rawDiagnostic = "SDK failure for sk-ant-private-diagnostic-9876543210 at /private/provider/config";
  let releaseResult: (() => void) | undefined;
  const resultGate = new Promise<void>(resolve => { releaseResult = resolve; });
  const adapter = provider(() => ({
    close: () => {},
    interrupt: async () => {},
    async *[Symbol.asyncIterator]() {
      yield delta(intentionalAssistantText);
      await resultGate;
      yield {
        is_error: true,
        result: rawDiagnostic,
        session_id: "session:stream-error",
        subtype: "success",
        type: "result",
        uuid: "result:stream-error",
      };
    },
  }));
  let settled = false;
  const outcomePromise = adapter.execute({ ...input(), emit: async chunk => { output.push(chunk); } });
  void outcomePromise.then(() => { settled = true; return settled; });
  await waitFor(() => output.length === 1);
  assert.equal(settled, false);
  assert.deepEqual(output[0], { cursor: 0, kind: "assistant", text: intentionalAssistantText });
  releaseResult?.();
  const outcome = await outcomePromise;
  assert.equal(outcome.kind, "completed");
  if (outcome.kind === "completed") {
    assert.equal(outcome.outcome, "failed");
  }
  assert.equal(output.length, 2);
  assert.equal(output[1]?.kind, "diagnostic");
  assert.ok((output[1]?.text.length ?? 0) < 256);
  assert.doesNotMatch(output[1]?.text ?? "", /private-diagnostic|provider\/config|SDK failure/iu);
});

test("rejects a malformed assistant stream envelope without emitting its diagnostic-shaped field", async () => {
  const output: string[] = [];
  const adapter = provider(() => ({
    close: () => {},
    interrupt: async () => {},
    async *[Symbol.asyncIterator]() {
      yield {
        event: {
          delta: { text: { diagnostic: "sk-ant-malformed-private-diagnostic" }, type: "text_delta" },
          type: "content_block_delta",
        },
        parent_tool_use_id: null,
        session_id: "session:malformed",
        type: "stream_event",
        uuid: "stream:malformed",
      };
      yield success("after-malformed");
    },
  }));
  const outcome = await adapter.execute({ ...input(), emit: async chunk => { output.push(chunk.text); } });
  assert.equal(outcome.kind, "ambiguous");
  assert.deepEqual(output, []);
});
