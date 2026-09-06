import assert from "node:assert/strict";
import test from "node:test";
import {createDockerCodexCurrentKernelOwner} from "../../../dist/features/contained-agent-turn/composition/docker-codex-current-kernel-owner.js";
import {connectionFixture, installProtocol, secret} from "./support/docker-codex-kernel-fixture.ts";
import {deferred, tick} from "./support/docker-provider-process-fixture.ts";

test("Docker current-kernel owner feeds actual acknowledged bridge IO to real Codex mapping", async t => {
  const f = await connectionFixture(); t.after(() => f.contain());
  const requests = installProtocol(f); const before = [...f.events]; const owner = f.owner();
  assert.deepEqual(f.events, before, "construction performs no IO");
  assert.equal(owner.provider.adapterSnapshot.binaryRevision, f.options.plan.binaryRevision);
  assert.deepEqual(await owner.provider.execute(f.input), {kind: "completed", outcome: "succeeded"});
  assert.equal(f.delegatedStarts(), 1);
  assert.deepEqual(requests, ["initialize", "initialized", "config/read", "permissionProfile/list", "thread/start", "turn/start"]);
  assert.ok(f.output.some(chunk => chunk.kind === "assistant" && chunk.text.includes("bounded")));
  assert.ok(!JSON.stringify(f.output).includes(secret));
  assert.deepEqual(f.output.map(chunk => chunk.cursor), f.output.map((_chunk, index) => index));
  assert.equal(f.events.filter(event => event === "provider-exec").length, 1);
  assert.equal(f.channel.readers, 1); assert.equal(f.engine.running, true, "protocol success is not physical containment");
  assert.equal((await owner.provider.execute(f.input)).kind, "indeterminate");
  assert.throws(() => f.owner(), /unused actual launch/u, "actual launch cannot be replayed by a new owner");
  assert.equal(f.delegatedStarts(), 1);
  assert.equal((await f.contain()).kind, "closed");
});

for (const stage of ["host-handshake", "provider-exec"] as const) {
  test(`Docker ${stage} acknowledgement delays protocol publication and concurrent attempt reuse`, async t => {
    const f = await connectionFixture(); t.after(() => f.contain());
    const requests = installProtocol(f); const respond = f.channel.onMessage!;
    const reached = deferred(); let release!: () => void;
    f.channel.onMessage = message => {
      if (message.kind === stage) {release = () => {void respond(message);}; reached.resolve();} else {return respond(message);}
    };
    const owner = f.owner(); const pending = owner.provider.execute(f.input); await reached.promise;
    assert.deepEqual(requests, []); assert.equal(f.delegatedStarts(), 1);
    assert.equal((await owner.provider.execute(f.input)).kind, "indeterminate");
    assert.deepEqual(requests, []); release();
    assert.deepEqual(await pending, {kind: "completed", outcome: "succeeded"});
  });
}

for (const failure of ["rejected", "ready-timeout", "exec-timeout"] as const) {
  test(`Docker async ${failure} is indeterminate without protocol, respawn or finality`, async t => {
    const f = await connectionFixture(); t.after(() => f.contain());
    f.options.process.init = {...f.options.process.init, readyTimeoutMs: 40, acknowledgementTimeoutMs: 40};
    f.channel.onMessage = message => {
      if (failure === "ready-timeout") {return;}
      if (message.kind === "provider-exec") {
        if (failure === "rejected") {f.channel.push({kind: "provider-exec-ack", observation: "not-started", requestId: message.requestId});}
        return;
      }
      f.channel.respond(message);
    };
    const owner = f.owner();
    assert.equal((await owner.provider.execute(f.input)).kind, "indeterminate");
    assert.equal((await owner.provider.execute(f.input)).kind, "indeterminate");
    assert.equal(f.delegatedStarts(), 1); assert.deepEqual(f.output, []);
    assert.equal(f.events.includes("provider-input"), false);
    assert.ok(f.events.filter(event => event === "provider-exec").length <= 1);
    assert.equal(f.engine.running, true); assert.equal((await f.contain()).kind, "closed");
  });
}

for (const cancellation of ["call-abort", "durable-cancellation", "dispose"] as const) {
  test(`${cancellation} during asynchronous Docker start never initializes Codex`, async t => {
    const f = await connectionFixture(); t.after(() => f.contain());
    const requests = installProtocol(f); const respond = f.channel.onMessage!; const reached = deferred();
    let release!: () => void; let cancelled = false;
    const controller = new AbortController(); f.options.process.call = {...f.options.process.call, signal: controller.signal};
    f.channel.onMessage = message => {
      if (message.kind === "provider-exec") {release = () => {void respond(message);}; reached.resolve();} else {return respond(message);}
    };
    const owner = f.owner(); const pending = owner.provider.execute({...f.input, isCancellationRequested: async () => cancelled});
    await reached.promise;
    if (cancellation === "call-abort") {controller.abort();}
    if (cancellation === "durable-cancellation") {cancelled = true;}
    if (cancellation === "dispose") {owner.dispose();}
    release(); assert.equal((await pending).kind, "indeterminate"); await tick();
    assert.deepEqual(requests, []); assert.deepEqual(f.output, []);
    assert.equal(f.events.filter(event => event === "provider-exec").length, 1);
    assert.equal((await owner.provider.execute(f.input)).kind, "indeterminate");
    assert.equal((await f.contain()).kind, "closed");
  });
}

test("all retained attempt identities, credentials, workspace and prompt are bound exactly", async t => {
  const rows = ["operationId", "attemptId", "custodyId", "effectId", "workspaceId", "authorityVectorDigest"];
  const accessFields = ["credentialBindingDigest", "credentialBindingRef", "credentialGeneration", "providerRouteRef",
    "accessRef", "ownerAuthorityDigest", "providerAccountRef", "tenantId", "projectId", "revision"];
  for (const field of [...rows, ...accessFields, "prompt", "binaryRevision"]) {
    await t.test(field, async () => {
      const f = await connectionFixture(); t.after(() => f.contain()); const owner = f.owner();
      let input = {...f.input};
      if (rows.includes(field)) {input = {...input, [field]: "substituted"};}
      else if (accessFields.includes(field)) {input = {...input, providerAccessSnapshot: {...input.providerAccessSnapshot,
        [field]: field === "credentialGeneration" || field === "revision" ? 2 : "substituted"}};}
      else if (field === "prompt") {input = {...input, intent: {...input.intent, prompt: "substituted"}};}
      else {input = {...input, adapterSnapshot: {...input.adapterSnapshot, binaryRevision: "substituted"}};}
      assert.equal((await owner.provider.execute(input)).kind, "indeterminate");
      assert.equal(f.delegatedStarts(), 0); assert.equal(f.events.includes("host-handshake"), false);
    });
  }
});

test("copied launch and wrong retained Docker authority cannot impersonate actual custody", async t => {
  for (const field of ["copy", "authority", "workspace", "generation", "launch-attempt", "inventory", "plan"]) {
    await t.test(field, async () => {
      const f = await connectionFixture(); t.after(() => f.contain()); const options = {...f.options, process: {...f.options.process}};
      if (field === "copy") {options.process.launch = {...options.process.launch};}
      if (field === "authority") {options.process.expected = {...options.process.expected,
        authority: {...options.process.expected.authority, containerId: "b".repeat(64)}};}
      if (field === "workspace") {options.process.expected = {...options.process.expected, workspaceAuthorityPath: "/substituted"};}
      if (field === "generation") {options.process.expected = {...options.process.expected, generation: "substituted"};}
      if (field === "launch-attempt") {options.attempt = {...options.attempt, attemptId: "attempt:substituted" as never};}
      if (field === "inventory") {options.credentialOutputInventory = {...options.credentialOutputInventory, credentialGeneration: 2};}
      if (field === "plan") {options.plan = {...options.plan};}
      let owner: ReturnType<typeof createDockerCodexCurrentKernelOwner>;
      try {owner = createDockerCodexCurrentKernelOwner(options);} catch (error) {assert.ok(error instanceof TypeError); return;}
      assert.equal((await owner.provider.execute(f.input)).kind, "indeterminate");
      assert.equal(f.events.includes("host-handshake"), false);
      assert.equal(f.events.includes("provider-input"), false);
    });
  }
});

// Actual issued broker material selects the existing native protocol validator.
// The network and provider responses remain synthetic in this component test.
test("Docker Codex consumes the native broker launch through the same protocol", async t => {
  const {brokerFixture} = await import("../../fixtures/codex-native-broker-0.153.4/fixture.ts");
  const native = brokerFixture(t); const f = await connectionFixture(native); t.after(() => f.contain());
  const requests = installProtocol(f); const owner = f.owner();
  assert.deepEqual(await owner.provider.execute(f.input), {kind: "completed", outcome: "succeeded"});
  assert.ok(requests.includes("turn/start"));
  assert.equal(f.events.filter(event => event === "provider-exec").length, 1);
  assert.equal((await f.contain()).kind, "closed");
});
