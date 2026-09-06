// Install synthetic observations before dynamically loading the owner fixture.
await import("./native-launch-finalization-fixture.ts");
import assert from "node:assert/strict";
import test from "node:test";
const {committedDispatchProofFixture} = await import("./support/committed-dispatch-proof-fixture.ts");
import type { Preparation, PrepareInput } from "./support/current-owner-preparation-fixture.ts";
const {claimFeature, deferred, openOwner, ownerPreparationFixture, tick} =
  await import("./support/current-owner-preparation-fixture.ts");

for (const provider of ["codex", "claude"] as const) {
  test(`${provider}: omitted preparation preserves legacy execution through the real owner's custody`, async t => {
    for (const extra of [{}, {postClaimPreparation: undefined}]) {
      const fixture = await ownerPreparationFixture(t, provider);
      const {owner} = fixture.create(extra);
      await tick(); assert.deepEqual(fixture.events, []);
      const opened = await openOwner(fixture, owner);
      assert.deepEqual(fixture.events, ["workspace", "launch-record"]);
      assert.equal(fixture.host.starts, 0);
      const pending = owner.custody.start(opened.start);
      await tick();
      assert.deepEqual(fixture.events, ["workspace", "launch-record", "execute", "synthetic-creator"]);
      // The synthetic creator supplies no Host process attestation. End the
      // observation explicitly once forwarding is proven, without a timeout wait.
      await owner.custody.requestContainment(opened.identity);
      assert.equal((await pending).kind, "indeterminate");
      await opened.release(); assert.equal(fixture.host.releases, 1);
    }
  });

  test(`${provider}: snapshots callback once, preserves receiver and exact claim input, and gates kernel execution`, async t => {
    const fixture = await ownerPreparationFixture(t, provider);
    const ready = deferred<{kind: "prepared"}>();
    const entered = deferred<PrepareInput>();
    let calls = 0; const receivers: unknown[] = [];
    const capability: Preparation = {async prepareClaimed(input) {
      receivers.push(this); calls += 1;
      fixture.events.push("prepare-claimed"); entered.resolve(input); return ready.promise;
    }};
    // Binding/calling the callback must not consult user-owned function properties.
    for (const key of ["bind", "call", "apply"]) {
      Object.defineProperty(capability.prepareClaimed, key, {get() {assert.fail(`read callback.${key}`);}});
    }
    const {owner, selected} = fixture.create({postClaimPreparation: capability});
    Object.defineProperty(capability, "prepareClaimed", {get() {assert.fail("callback re-read after construction");}});
    Object.defineProperty(selected, "postClaimPreparation", {get() {assert.fail("option re-read after construction");}});
    await tick(); assert.equal(calls, 0); assert.deepEqual(fixture.events, []);
    const opened = await openOwner(fixture, owner);
    assert.equal(calls, 0);
    const wrong = committedDispatchProofFixture(opened.input, opened.opened, {committedOperationRevision: 2});
    await assert.rejects(owner.custody.start({...opened.start, committedDispatchProof: wrong}), /conflicts/u);
    assert.equal(calls, 0);
    const pending = owner.custody.start(opened.start);
    const received = await Promise.race([entered.promise, pending.then(() => {throw new Error("start settled without preparation");})]);
    assert.deepEqual(receivers, [capability]);
    assert.strictEqual(received.committedDispatchProof, opened.proof);
    assert.equal(received.underlyingCustodyRef, fixture.host.refs.get(opened.identity.attemptId));
    assert.notEqual(received.underlyingCustodyRef, opened.identity.custodyId);
    assert.ok(received.signal instanceof AbortSignal); assert.equal(received.signal.aborted, false);
    await tick(); assert.deepEqual(fixture.events, ["workspace", "launch-record", "prepare-claimed"]);
    await assert.rejects(owner.custody.start(opened.start), /already consumed/u);
    // This branch proves the kernel callback contract with a synthetic executor.
    // Actual Codex provider execution additionally requires the authentic final bundle;
    // native-launch-finalization.test.ts covers both that success and missing-final rejection.
    ready.resolve({kind: "prepared"}); await tick();
    assert.deepEqual(fixture.events, ["workspace", "launch-record", "prepare-claimed", "execute", "synthetic-creator"]);
    assert.equal(calls, 1); assert.equal(received.signal.aborted, false);
    const retainedSignal = received.signal;
    await owner.custody.requestContainment(opened.identity);
    assert.equal((await pending).kind, "indeterminate");
    assert.strictEqual(received.signal, retainedSignal); assert.equal(retainedSignal.aborted, true);
    await opened.release(); assert.equal(fixture.host.releases, 1);
    await assert.rejects(owner.custody.start(opened.start), /already consumed/u);
    assert.equal(calls, 1);
  });

  test(`${provider}: unavailable or rejected preparation prevents execution and keeps cleanup`, async t => {
    for (const reason of ["network", "broker", "journal", "owner", "quarantined", "rejected", "throw"] as const) {
      await t.test(reason, async child => {
        const fixture = await ownerPreparationFixture(child, provider);
        let received: PrepareInput | undefined; let calls = 0;
        const {owner} = fixture.create({postClaimPreparation: {prepareClaimed(input) {
          received = input; calls += 1;
          if (reason === "throw") {throw new Error("synthetic preparation exception");}
          if (reason === "rejected") {return Promise.reject(new Error("synthetic preparation rejection"));}
          return Promise.resolve(reason === "quarantined" ? {kind: "quarantined"} : {kind: "unsupported", reason});
        }}});
        const opened = await openOwner(fixture, owner);
        assert.equal((await owner.custody.start(opened.start)).kind, "indeterminate");
        assert.equal(calls, 1); assert.equal(received?.signal.aborted, true);
        assert.deepEqual(fixture.events, ["workspace", "launch-record"]);
        assert.equal(fixture.host.starts, 0); assert.equal(fixture.host.containments, 1);
        await opened.release(); assert.equal(fixture.host.releases, 1);
        await assert.rejects(owner.custody.start(opened.start), /already consumed/u);
        assert.equal(calls, 1);
      });
    }
  });

  test(`${provider}: malformed, proxy and accessor preparation is rejected without invoking user code`, async t => {
    const fixture = await ownerPreparationFixture(t, provider);
    let userCalls = 0;
    const trap = () => {userCalls += 1; throw new Error("untrusted code invoked");};
    const proxy = (target: object) => new Proxy(target, {get: trap, getPrototypeOf: trap, getOwnPropertyDescriptor: trap, ownKeys: trap});
    const getterCapability = Object.defineProperty({}, "prepareClaimed", {get: trap});
    const revoked = Proxy.revocable({}, {}); revoked.revoke();
    for (const capability of [null, false, 1, "current-owner", {}, [], {prepareClaimed: 1}, getterCapability,
      proxy({prepareClaimed: trap}), revoked.proxy, {prepareClaimed: proxy(trap)},
      Object.create({prepareClaimed: trap}), Object.create(proxy({}))]) {
      assert.throws(() => fixture.construct({...fixture.options, postClaimPreparation: capability}), /post-claim preparation/u);
    }
    const getterOption = Object.defineProperty({...fixture.options}, "postClaimPreparation", {get: trap});
    for (const options of [getterOption, proxy(fixture.options), Object.create(getterOption)]) {
      assert.throws(() => fixture.construct(options), /post-claim preparation/u);
    }
    assert.equal(userCalls, 0); assert.deepEqual(fixture.events, []); assert.equal(fixture.host.reserves, 0);
  });

  test(`${provider}: actual owner callback follows acknowledged kernel claim; prevention, lost ack and replay never prepare`, async t => {
    for (const mode of ["acknowledged", "prevented", "lost-ack"] as const) {
      await t.test(mode, async child => {
        const fixture = await ownerPreparationFixture(child, provider);
        let calls = 0; let received: PrepareInput | undefined; let claimedAtCallback = false; let abortedAtCallback = true;
        const {owner} = fixture.create({postClaimPreparation: {async prepareClaimed(input) {
          calls += 1; fixture.events.push("prepare-claimed"); received = input;
          claimedAtCallback = flow.kernel.current()?.dispatch.kind === "claimed";
          abortedAtCallback = input.signal.aborted;
          return {kind: "unsupported", reason: "network"};
        }}});
        const flow = claimFeature(fixture, owner, mode);
        await flow.feature.submit.execute(flow.submission);
        assert.equal(calls, mode === "acknowledged" ? 1 : 0);
        if (mode === "acknowledged") {
          assert.ok(received); assert.equal(claimedAtCallback, true); assert.equal(abortedAtCallback, false);
          assert.deepEqual(received.committedDispatchProof, flow.proof());
          assert.equal(received.underlyingCustodyRef, fixture.host.refs.get(received.committedDispatchProof.attemptId));
        }
        assert.equal(flow.kernel.providerCalls.value, 0); assert.equal(fixture.host.starts, 0);
        const ordering = fixture.events.filter(event => event.startsWith("claim-") || event === "prepare-claimed");
        assert.deepEqual(ordering, mode === "acknowledged"
          ? ["claim-requested", "claim-acknowledged", "prepare-claimed"] : mode === "lost-ack" ? ["claim-requested"] : []);
        await flow.feature.submit.execute(flow.submission);
        assert.equal(calls, mode === "acknowledged" ? 1 : 0); assert.equal(flow.kernel.providerCalls.value, 0);
        assert.ok(fixture.host.releases > 0 || flow.kernel.current()?.terminal.kind === "open",
          "uncertain closure remains nonterminal instead of inventing cleanup");
      });
    }
  });

  test(`${provider}: durable cancellation aborts the retained Host preparation signal and late ready cannot execute`, async t => {
    const fixture = await ownerPreparationFixture(t, provider);
    const entered = deferred<PrepareInput>(); const ready = deferred<{kind: "prepared"}>();
    let calls = 0;
    const {owner} = fixture.create({postClaimPreparation: {async prepareClaimed(input) {
      calls += 1; entered.resolve(input); return ready.promise;
    }}});
    const flow = claimFeature(fixture, owner);
    const submission = flow.feature.submit.execute(flow.submission);
    const received = await Promise.race([entered.promise, submission.then(() => {throw new Error("submission settled without preparation");})]);
    assert.equal(flow.kernel.current()?.dispatch.kind, "claimed");
    assert.equal(received.signal.aborted, false); assert.equal(flow.kernel.providerCalls.value, 0);
    const signal = received.signal;
    let aborted = 0; signal.addEventListener("abort", () => {aborted += 1;}, {once: true});
    const cancelled = await flow.feature.cancel.execute({operationId: received.committedDispatchProof.operationId,
      scope: flow.submission.scope});
    assert.equal(cancelled.status, "observed"); assert.equal(flow.kernel.current()?.cancellation.kind, "requested");
    assert.strictEqual(received.signal, signal); assert.equal(signal.aborted, true); assert.equal(aborted, 1);
    assert.ok(fixture.host.containments > 0);
    ready.resolve({kind: "prepared"}); await submission;
    assert.equal(calls, 1); assert.equal(flow.kernel.providerCalls.value, 0); assert.equal(fixture.host.starts, 0);
  });
}
