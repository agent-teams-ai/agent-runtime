import assert from "node:assert/strict";
import test from "node:test";
import {connectionFixture, installProtocol} from "./support/docker-codex-kernel-fixture.ts";

for (const mode of ["false-before-open", "revoked-after-owner", "revoked-after-spawn", "active", "omitted"] as const) {
  test(`Docker Codex retains observation guard through both capture layers: ${mode}`, {timeout: 5_000}, async t => {
    const f = await connectionFixture(); t.after(() => f.contain());
    const requests = installProtocol(f); let calls = 0; let active = mode !== "false-before-open";
    const original: typeof f.options.process.init & {isObservationActive?: () => boolean} = {...f.options.process.init,
      ...(mode === "omitted" ? {} : {isObservationActive(): boolean {
        assert.equal(this, original, "callback retains original supplied options receiver");
        calls += 1; return active;
      }})};
    f.options.process.init = original;
    if (mode === "revoked-after-spawn") {
      const respond = f.channel.onMessage!;
      f.channel.onMessage = message => {if (message.kind === "provider-exec") {active = false;} return respond(message);};
    }
    const owner = f.owner();
    if (mode === "revoked-after-owner") {active = false;}
    const result = await owner.provider.execute(f.input);
    if (mode === "active" || mode === "omitted") {
      assert.deepEqual(result, {kind: "completed", outcome: "succeeded"});
      assert.ok(requests.includes("turn/start"));
    } else {
      assert.equal(result.kind, "indeterminate"); assert.deepEqual(requests, []);
      assert.equal(f.events.filter(event => event === "provider-exec").length, mode === "revoked-after-spawn" ? 1 : 0);
      assert.deepEqual(f.output, []);
    }
    assert.equal(mode === "omitted" ? calls === 0 : calls > 0, true);
  });
}
