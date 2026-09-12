import assert from "node:assert/strict";
import test from "node:test";
import {CodexAppServerContainedTurnProvider} from "../../../dist/features/contained-agent-turn/adapters/outbound/codex-app-server/codex-app-server-contained-turn-provider.js";
import {boundary, exactConfigResult, manifest, syntheticPrivateRoot, syntheticTmp, syntheticWorkspace}
  from "../../codex-app-server-contained-turn-provider-fixture.ts";
import {generatedTurn} from "../../codex-app-server-test-messages.mjs";
import {fixture, tick} from "./support/docker-provider-process-fixture.ts";

// The existing Codex consumer reads the real bridge's registry. Only protocol
// replies are synthetic; this neither changes Codex nor starts a provider.
test("existing Codex provider consumes Docker stdin/stdout/stderr/exit through its process registry", async t => {
  for (const [completion, prompt] of [["drained", "Inspect this disposable fixture."],
    ["disconnected", "Inspect this disposable fixture."], ["nonzero", "Inspect this disposable fixture."],
    ["drained", "x".repeat(50_000)], ["drained", "\u0000".repeat(65_536)]] as const) {
    await t.test(`${completion} ${Buffer.byteLength(prompt)} prompt bytes`, async () => {
      const f = fixture();
      (f.launchInput.create as {workspaceSource: string}).workspaceSource = syntheticWorkspace;
      const provider = new CodexAppServerContainedTurnProvider({boundary, manifest, processes: f.registry.processes,
        privateRootPath: syntheticPrivateRoot, tmpDir: syntheticTmp, requestTimeoutMs: 200, turnTimeoutMs: 500});
      await tick(); assert.deepEqual(f.events, [], "consumer construction remains effect-free");
      const a = await f.launch(); t.after(() => a.contain());
      const requests: string[] = []; let inputBuffer = Buffer.alloc(0);
      const emit = (message: unknown) => f.channel.outputBytes("stdout", `${JSON.stringify(message)}\n`);
      f.channel.onMessage = message => {
        f.channel.respond(message);
        if (message.kind === "provider-input-eof") {
          // Acknowledge the input write before the synthetic child exits.
          setImmediate(() => {f.channel.rootExit(completion === "nonzero" ? 7 : 0);
            if (completion === "disconnected") {f.channel.end();} else {f.channel.drain();}});
        }
        if (message.kind !== "provider-input") {return;}
        inputBuffer = Buffer.concat([inputBuffer, Buffer.from(message.bytesBase64, "base64")]);
        if (inputBuffer.at(-1) !== 10) {return;}
        const request = JSON.parse(inputBuffer.toString().trim()); inputBuffer = Buffer.alloc(0);
        requests.push(request.method);
        if (request.method === "initialize") {emit({id: request.id, result: {codexHome: boundary.codexHome,
          platformFamily: "unix", platformOs: "linux", userAgent: "agent-runtime/0.153.4 (Ubuntu 24.4.0; x86_64) unknown (agent-runtime; codex-app-server-contained-turn:0.153.4+native-permission-config-v2)"}});}
        if (request.method === "config/read") {emit({id: request.id, result: exactConfigResult()});}
        if (request.method === "permissionProfile/list") {emit({id: request.id,
          result: {data: [{allowed: true, description: null, id: boundary.permissionProfileId}], nextCursor: null}});}
        if (request.method === "thread/start") {emit({id: request.id, result: {thread: {id: "thread:test"},
          activePermissionProfile: {extends: boundary.permissionProfile.extends, id: boundary.permissionProfileId},
          approvalPolicy: "never", cwd: boundary.workspaceRef, sandbox: {networkAccess: false, type: "readOnly"}}});}
        if (request.method === "turn/start") {
          assert.equal(request.params.input[0].text, prompt);
          f.channel.outputBytes("stderr", "synthetic diagnostic");
          emit({id: request.id, result: {turn: generatedTurn("turn:test", "inProgress")}});
          emit({method: "turn/started", params: {threadId: "thread:test", turn: generatedTurn("turn:test", "inProgress")}});
          emit({method: "turn/completed", params: {threadId: "thread:test", turn: generatedTurn("turn:test", "completed")}});
        }
      };
      const process = await f.registry.open(a.input);
      const outcome = await provider.execute({attemptId: a.launched.key.attemptId,
        operationId: a.launched.key.operationId, effectId: "effect:synthetic", custody: {custodyRef: process.custodyRef},
        workspaceRef: syntheticWorkspace, intent: {mode: "analysis", prompt},
        emit: async () => {}, isCancellationRequested: async () => false});
      assert.equal(outcome.kind, completion === "drained" ? "completed" : "ambiguous");
      if (outcome.kind === "completed") {assert.equal(outcome.outcome, "succeeded");}
      assert.deepEqual(requests, ["initialize", "initialized", "config/read", "permissionProfile/list", "thread/start", "turn/start"]);
      assert.equal(f.events.filter(event => event === "provider-exec").length, 1);
      assert.equal(f.events.filter(event => event === "provider-input-eof").length, 1);
      assert.equal(f.channel.readers, 1); assert.equal(f.engine.running, true);
      assert.equal((await a.contain()).kind, "closed");
    });
  }
});
