import assert from "node:assert/strict";
import {StringDecoder} from "node:string_decoder";
import {nativeBrokerConfig, fixtureEndpoint} from "../../../../contexts/agent-execution/tests/fixtures/codex-native-broker-0.153.4/fixture.ts";
import {rehashNativeLayers} from "../../../../contexts/agent-execution/tests/fixtures/codex-native-config-0.153.4/fixture.ts";
import {agentMessage, emitAgentStarted, emitAgentCompleted, generatedTurn} from "../../../../contexts/agent-execution/tests/codex-app-server-test-messages.mjs";
import {codexTurnSandboxPolicy} from "../../../../contexts/agent-execution/dist/features/contained-agent-turn/adapters/outbound/codex-app-server/codex-app-server-permission-boundary.js";

// Synthetic external protocol peer. Completion requires a real request through
// the operation listener. This does not characterize or qualify a provider binary.
export const installJoinedPeer = ({docker, network, boundary, recipe, events}) => {
  const decoder = new StringDecoder("utf8");
  let exec; let pending = ""; let queue = Promise.resolve(); let failure;
  let requests = 0; let brokerRequests = 0;
  const emit = message => docker.push({kind: "provider-output", requestId: exec.requestId,
    stream: "stdout", bytesBase64: Buffer.from(JSON.stringify(message) + "\n").toString("base64")});
  const processRequest = async request => {
    requests++; events.push(`peer-method:${request.method}`);
    const home = exec.environment.find(entry => entry.name === "CODEX_HOME")?.value;
    assert.ok(home);
    if (request.method === "initialized") {return;}
    if (request.method === "initialize") {
      emit({id: request.id, result: {codexHome: home, platformFamily: "unix", platformOs: "linux",
        userAgent: "agent-runtime/0.153.4 (Ubuntu 24.4.0; x86_64) unknown (agent-runtime; codex-app-server-contained-turn:0.153.4+native-permission-config-v2)"}}); return;
    }
    assert.equal(request.params.cwd, "/workspace");
    if (request.method === "config/read") {
      const config = JSON.parse(JSON.stringify(nativeBrokerConfig(home, boundary.intentMode)).replaceAll(fixtureEndpoint, recipe().endpoint));
      rehashNativeLayers(config);
      emit({id: request.id, result: config}); return;
    }
    if (request.method === "permissionProfile/list") {
      emit({id: request.id, result: {data: [{allowed: true, description: null, id: boundary.permissionProfileId}], nextCursor: null}}); return;
    }
    if (request.method === "thread/start") {
      emit({id: request.id, result: {thread: {id: "thread:test"},
        activePermissionProfile: {extends: boundary.permissionProfile.extends, id: boundary.permissionProfileId},
        approvalPolicy: "never", cwd: "/workspace", sandbox: codexTurnSandboxPolicy(boundary.intentMode, boundary.workspaceRef)}}); return;
    }
    assert.equal(request.method, "turn/start", "unexpected protocol request");
    assert.equal(brokerRequests++, 0, "one broker attempt, no automatic retries");
    const capability = exec.environment.find(entry => entry.name === "AR_PRIVATE_BROKER_CAPABILITY")?.value;
    assert.ok(capability);
    const body = JSON.stringify({model: "gpt-5.4", input: [{text: "synthetic joined transport"}], stream: true});
    const result = await network.request(`${recipe().endpoint}/responses`, 5000, {method: "POST", body,
      headers: {authorization: `Bearer ${capability}`, "content-type": "application/json", accept: "text/event-stream",
        version: "0.153.4", "user-agent": "synthetic-codex/0.153.4", originator: "codex_cli_rs", "content-length": String(Buffer.byteLength(body)), connection: "close"}});
    assert.equal(result.error, undefined, `broker transport failed: ${result.code ?? "no-code"}`);
    assert.equal(result.status, 200, "broker must accept before peer completion");
    assert.ok(result.text.length > 0, "broker response must be consumed"); events.push("broker-response");
    const turn = "turn:joined"; const item = "item:joined"; const text = "bounded synthetic output";
    emit({id: request.id, result: {turn: generatedTurn(turn, "inProgress")}});
    emit({method: "turn/started", params: {threadId: "thread:test", turn: generatedTurn(turn, "inProgress")}});
    emitAgentStarted({emit}, turn, item);
    emit({method: "item/agentMessage/delta", params: {threadId: "thread:test", turnId: turn, itemId: item, delta: text}});
    emitAgentCompleted({emit}, turn, item, text);
    emit({method: "turn/completed", params: {threadId: "thread:test", turn: generatedTurn(turn, "completed", null, [agentMessage(item, text)])}});
  };
  docker.consumeProtocol((message, push) => {
    if (message.kind === "provider-exec") {
      assert.equal(exec, undefined); assert.ok(recipe()); exec = message;
      push({kind: "provider-exec-ack", observation: "started", requestId: message.requestId});
      assert.ok(message.observationBinding, "Host must request bound instance observation");
      push({kind: "provider-instance", binding: message.observationBinding,
        childInstanceId: "1".repeat(64), initInstanceId: "2".repeat(64), pid: 41,
        executableSha256: message.executableSha256, handshakeNonce: message.handshakeNonce,
        launchFingerprintSha256: message.launchFingerprintSha256, requestId: message.requestId,
        executableMapping: {kind: "linux-procfs-exe-v1", scope: "spawn-observation",
          device: "1", inode: "41", startTimeTicks: "100"}});
      return;
    }
    if (message.kind === "provider-input-eof") {
      queue = queue.then(() => {
        if (failure) {return null;}
        push({kind: "provider-observation", observation: "root-exited", exitCode: 0, signal: null,
          requestId: exec.requestId, treeEmptyClaim: "not-claimed"});
        push({kind: "provider-drain-complete", requestId: exec.requestId, rootExit: "observed",
          stderr: "eof", stdout: "eof", outerContainmentClaim: "unproven"});
        docker.endProtocol();
        return null;
      }).catch(error => {failure = error;}); return;
    }
    if (message.kind !== "provider-input") {return;}
    pending += decoder.write(Buffer.from(message.bytesBase64, "base64"));
    assert.ok(Buffer.byteLength(pending) <= 131072);
    let end;
    while ((end = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, end); pending = pending.slice(end + 1);
      queue = queue.then(() => {if (!failure) {return processRequest(JSON.parse(line));} return null;}).catch(error => {failure = error; events.push(`peer-failure:${error.message}`);});
    }
  });
  return {async verify() {await queue; if (failure) {throw failure;} assert.equal(brokerRequests, 1, `peer requests=${requests}, bufferedBytes=${Buffer.byteLength(pending)}`); assert.ok(requests >= 5);}};
};
