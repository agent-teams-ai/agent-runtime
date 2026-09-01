import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CLAUDE_AGENT_SDK_HOST_WORKSPACE_CWD,
  CLAUDE_AGENT_SDK_LINUX_X64_TUPLE,
  claudeAgentSdkArguments,
  createClaudeAgentSdkLaunchPlan,
  createClaudeAgentSdkPrivateProjection,
  isClaudeAgentSdkPrivateProjectionUsable,
} from "../../../dist/features/contained-agent-turn/adapters/outbound/claude-agent-sdk/claude-agent-sdk-launch-plan.js";
import {
  captureClaudePrivateDirectoryCustody,
} from "../../../dist/features/contained-agent-turn/adapters/outbound/claude-agent-sdk/claude-private-directory-custody.js";
import {
  delta,
  executablePath,
  input,
  kernelInput,
  kernelProvider,
  privateProjection,
  privateDirectoryCustody,
  privateRoot,
  provider,
  success,
  waitFor,
  workspaceRef,
  type QueryFactory,
} from "../../claude-agent-sdk-contained-turn-provider.support.ts";

test("provider construction captures the verifier on a frozen receiver", async () => {
  let originalCalls = 0;
  let replacementCalls = 0;
  const custody = {
    async assertPrivateDirectory(this: object) {
      assert.equal(Object.isFrozen(this), true);
      assert.equal(Object.getPrototypeOf(this), null);
      assert.notEqual(this, custody);
      originalCalls += 1;
      throw new Error("synthetic private-directory rejection");
    },
  };
  let queryCalls = 0;
  const adapter = provider(() => {
    queryCalls += 1;
    throw new Error("query must remain unavailable");
  }, { privateDirectoryCustody: custody });

  custody.assertPrivateDirectory = async () => { replacementCalls += 1; };
  assert.equal((await adapter.execute(input())).kind, "not_accepted");
  assert.ok(originalCalls > 0);
  assert.equal(replacementCalls, 0);
  assert.equal(queryCalls, 0);
});

test("current-kernel construction cannot be redirected through private verifier state", async () => {
  class MutablePrivateCustody {
    #verify = async (): Promise<void> => { throw new Error("synthetic private-directory rejection"); };

    public async assertPrivateDirectory(path: string): Promise<void> {
      return this.#verify(path);
    }

    public redirect(): void {
      this.#verify = async () => {};
    }
  }
  const custody = new MutablePrivateCustody();
  const options: { privateDirectoryCustody: typeof custody } = { privateDirectoryCustody: custody };
  let queryCalls = 0;
  const adapter = kernelProvider(() => {
    queryCalls += 1;
    throw new Error("query must remain unavailable");
  }, options);

  custody.redirect();
  options.privateDirectoryCustody = new MutablePrivateCustody();
  assert.equal((await adapter.execute(kernelInput() as never)).kind, "indeterminate");
  assert.equal(queryCalls, 0);
});

test("captured verifier cannot be redirected through prototype or nested receiver state", async t => {
  const scenarios = [
    {
      name: "prototype method",
      create() {
        let originalCalls = 0;
        let replacementCalls = 0;
        const authorityName = "__claudePrivateDirectoryAuthority";
        const prototype = {
          async assertPrivateDirectory(this: Record<string, unknown>): Promise<void> {
            originalCalls += 1;
            const authority = this[authorityName];
            if (typeof authority !== "function") {
              throw new Error("synthetic private-directory rejection");
            }
            await authority();
          },
        };
        const custody = Object.create(prototype) as typeof prototype;
        return {
          custody,
          expected: () => ({ originalCalls, replacementCalls }),
          redirect: () => {
            prototype.assertPrivateDirectory = async () => { replacementCalls += 1; };
            // oxlint-disable-next-line no-extend-native -- Exercise the reviewed prototype-pollution attack.
            Object.defineProperty(Object.prototype, authorityName, {
              configurable: true,
              value: async () => { replacementCalls += 1; },
            });
          },
          restore: () => {
            Reflect.deleteProperty(Object.prototype, authorityName);
          },
        };
      },
    },
    {
      name: "nested receiver state",
      create() {
        let originalCalls = 0;
        let replacementCalls = 0;
        const custody = {
          policy: { verify: async () => { throw new Error("synthetic private-directory rejection"); } },
          async assertPrivateDirectory(this: { policy?: { verify: () => Promise<void> } }): Promise<void> {
            originalCalls += 1;
            if (this.policy === undefined) {
              throw new Error("synthetic private-directory rejection");
            }
            await this.policy.verify();
          },
        };
        return {
          custody,
          expected: () => ({ originalCalls, replacementCalls }),
          redirect: () => {
            custody.policy.verify = async () => { replacementCalls += 1; };
          },
          restore: () => {},
        };
      },
    },
  ] as const;

  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const { custody, expected, redirect, restore } = scenario.create();
      const captured = captureClaudePrivateDirectoryCustody(custody);
      try {
        redirect();
        await assert.rejects(
          captured.assertPrivateDirectory(privateRoot),
          /synthetic private-directory rejection/u,
        );
        assert.deepEqual(expected(), { originalCalls: 1, replacementCalls: 0 });
      } finally {
        restore();
      }
    });
  }
});

test("uses only an external frozen private projection while tools remain workspace-bound", async () => {
  let captured: Parameters<Parameters<QueryFactory>[0]["options"]["spawnClaudeCodeProcess"]>[0] | undefined;
  const adapter = provider(queryInput => {
    assert.deepEqual(queryInput.options.env, privateProjection.environment);
    assert.deepEqual(queryInput.options.sandbox.filesystem, {
      allowRead: [CLAUDE_AGENT_SDK_HOST_WORKSPACE_CWD],
      allowWrite: [],
    });
    captured = {
      args: [...claudeAgentSdkArguments("analysis", CLAUDE_AGENT_SDK_HOST_WORKSPACE_CWD)],
      command: executablePath,
      cwd: CLAUDE_AGENT_SDK_HOST_WORKSPACE_CWD,
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
  assert.equal(captured.cwd, CLAUDE_AGENT_SDK_HOST_WORKSPACE_CWD);
  assert.deepEqual(captured.env, privateProjection.environment);

  const plan = await createClaudeAgentSdkLaunchPlan({
    binaryRevision: CLAUDE_AGENT_SDK_LINUX_X64_TUPLE.binaryRevision,
    executablePath,
    executableSha256: CLAUDE_AGENT_SDK_LINUX_X64_TUPLE.executableSha256,
    intentMode: "analysis",
    privateProjection,
    privateDirectoryCustody,
    privateRootPath: privateRoot,
    platformTuple: CLAUDE_AGENT_SDK_LINUX_X64_TUPLE,
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
  assert.equal(await isClaudeAgentSdkPrivateProjectionUsable(
    forwardProjection,
    workspace,
    privateDirectoryCustody,
  ), false);
  await assert.rejects(createClaudeAgentSdkLaunchPlan({
    binaryRevision: CLAUDE_AGENT_SDK_LINUX_X64_TUPLE.binaryRevision,
    executablePath,
    executableSha256: CLAUDE_AGENT_SDK_LINUX_X64_TUPLE.executableSha256,
    intentMode: "analysis",
    privateProjection: forwardProjection,
    privateDirectoryCustody,
    privateRootPath: projection,
    platformTuple: CLAUDE_AGENT_SDK_LINUX_X64_TUPLE,
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
  assert.equal(await isClaudeAgentSdkPrivateProjectionUsable(
    reverseProjection,
    reverseAlias,
    privateDirectoryCustody,
  ), false);
  await assert.rejects(createClaudeAgentSdkLaunchPlan({
    binaryRevision: CLAUDE_AGENT_SDK_LINUX_X64_TUPLE.binaryRevision,
    executablePath,
    executableSha256: CLAUDE_AGENT_SDK_LINUX_X64_TUPLE.executableSha256,
    intentMode: "analysis",
    privateProjection: reverseProjection,
    privateDirectoryCustody,
    privateRootPath: projection,
    platformTuple: CLAUDE_AGENT_SDK_LINUX_X64_TUPLE,
    workspaceRef: reverseAlias,
  }), /disjoint/u);
});

test("emits zero-based cursors with exact continuity", async () => {
  const output: { cursor: number; text: string }[] = [];
  const adapter = provider(() => ({
    close: () => {},
    interrupt: async () => {},
    async *[Symbol.asyncIterator]() { yield delta("A "); yield delta("B "); yield success(); },
  }));
  const outcome = await adapter.execute({ ...input(), emit: async chunk => { output.push(chunk); } });
  assert.equal(outcome.kind, "completed");
  assert.deepEqual(output, [
    { cursor: 0, kind: "assistant", text: "A " },
    { cursor: 1, kind: "assistant", text: "B " },
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
  assert.deepEqual(output[0], { cursor: 0, kind: "assistant", text: "assistant-visible " });
  releaseResult?.();
  const outcome = await outcomePromise;
  assert.equal(outcome.kind, "completed");
  if (outcome.kind === "completed") {
    assert.equal(outcome.outcome, "failed");
  }
  assert.equal(output.length, 3);
  assert.deepEqual(output[1], { cursor: 1, kind: "assistant", text: "<redacted>" });
  assert.equal(output[2]?.kind, "diagnostic");
  assert.ok((output[2]?.text.length ?? 0) < 256);
  assert.doesNotMatch(output[2]?.text ?? "", /private-diagnostic|provider\/config|SDK failure/iu);
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
