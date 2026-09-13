import assert from "node:assert/strict";
import test from "node:test";
import {installJoinedPeer} from "../support/linux-joined-peer.mjs";

for (const text of ['data: {"error":"synthetic upstream failure"}\n\n', 'data:', '']) {
  test(`joined peer rejects unexpected upstream body ${JSON.stringify(text)}`, async () => {
    let consume;
    const frames = [];
    const events = [];
    let attempts = 0;
    const docker = {consumeProtocol(callback) {consume = callback;}, push(frame) {frames.push(frame);}};
    const peer = installJoinedPeer({docker, events, boundary: {}, recipe: () => ({endpoint: "http://test.invalid"}),
      network: {async request() {attempts++; return {status: 200, text};}}});
    consume({kind: "provider-exec", requestId: "test-request", observationBinding: {generation: "test"},
      environment: [{name: "CODEX_HOME", value: "/synthetic-home"},
        {name: "AR_PRIVATE_BROKER_CAPABILITY", value: "synthetic-test-capability"}]}, docker.push);
    consume({kind: "provider-input", bytesBase64: Buffer.from(JSON.stringify({id: 1, method: "turn/start",
      params: {cwd: "/workspace"}}) + "\n").toString("base64")}, docker.push);
    await assert.rejects(peer.verify(), /exact synthetic upstream body must be consumed/u);
    assert.equal(attempts, 1);
    assert.equal(frames.filter(frame => frame.kind === "provider-output").length, 0);
    assert.equal(events.includes("broker-response"), false);
  });
}
