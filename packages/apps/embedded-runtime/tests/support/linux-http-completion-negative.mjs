import assert from "node:assert/strict";
import {mock, test} from "node:test";

const deferred = () => Promise.withResolvers();
let active;
const composition = "../../dist/composition/";

mock.module("@agent-teams/agent-execution/composition", {exports: {
  createDockerCodexHostKernelOwner(options) {
    active.preparation = options.preparation;
    return {
      custody: Object.fromEntries(["open", "start", "completionBoundary", "attestExecutionClosure", "ensurePhysicalContainment", "queryPhysicalContainment", "requestPhysicalContainment", "requestContainment", "releaseReservation", "releaseRetiredReservation", "attestContainment", "queryContainmentAttestation"].map(name => [name, async () => ({kind: "proved"})])),
      provider: {execute: () => active.providerResult.promise},
      dispose() {active.events.push("host-dispose");},
    };
  },
  createDockerCodexNativeBrokerFinalizer() {
    return {
      routeAdmission: {},
      execute() {
        active.events.push("finalizer-entered");
        return active.receipt.promise;
      },
      finishClaimed() {},
      cutoff() {active.events.push("finalizer-cutoff");},
    };
  },
  readContainedTurnSelectedRouteAdmission() {},
  createDockerLinuxExclusiveRouteAdmission() {return {};},
  createNodeHostHttpConnection() {
    return {bindAcceptedSocket() {return {}; }};
  },
  createNodeHostHttpListener() {
    const state = active;
    return {
      async open(accept) {
        state.accept = accept;
        return {address: {address: "127.0.0.1", port: 12345}};
      },
      async settleAccepted() {
        state.events.push("settle-entered");
        state.settleEntered.resolve();
        await state.accepted;
        state.events.push("settle-returned");
        return {state: "settled"};
      },
      observe() {return {consumerWorkPending: false};},
      async close() {
        await state.accepted;
        state.events.push("physical-close");
        return {state: "closed"};
      },
    };
  },
  hostHttpAbortOperations: {
    aborted: signal => signal.aborted,
    abort: controller => controller.abort(),
    subscribe(signal, callback) {
      signal.addEventListener("abort", callback);
      return {signal, callback};
    },
    remove({signal, callback}) {
      signal.removeEventListener("abort", callback);
    },
  },
}});

mock.module("@agent-teams/runtime-security/composition", {exports: {
  createNodeEd25519ProviderProcessEgressAuthorizationV2Candidate() {
    return {hostEgressVerifierV2: {signingKey: {publicKeyDigest: `sha256:${"b".repeat(64)}`}}, dispose() {}};
  },
}});
mock.module(new URL(`${composition}contained-turn-current-egress-owners.js`, import.meta.url),
  {exports: {
    createContainedTurnCurrentEgressOwners() {return {dispose() {}};},
  }});
mock.module(new URL(`${composition}contained-turn-http-egress-authorities.js`, import.meta.url),
  {exports: {
    bindContainedTurnHttpEgressAuthorities() {return {dispose() {}};},
    composeContainedTurnHttpEgressSession() {return {};},
  }});

const {createLinuxCodexContainedTurnOwner} = await import(
  `${composition}linux-codex-contained-turn-owner.js`);

async function fixture(t) {
  const state = {
    events: [], providerResult: deferred(), receipt: deferred(),
    settleEntered: deferred(),
  };
  active = state;
  const kernel = {
    operationId: "operation:test", attemptId: "attempt:test",
    custodyId: "custody:test", authorityVectorDigest: "authority:test",
  };
  const scope = {
    operationId: kernel.operationId, tenantId: "tenant:test",
    projectId: "project:test", scopeDigest: `sha256:${"a".repeat(64)}`,
  };
  const selected = {
    preparation: {
      subjectFacts: {scopeSha256: "a".repeat(64)},
      engineIdentity() {}, openLifecycle() {}, openResourceJournal() {},
      resources: {consumption: {prepare() {}}},
    },
    route: {binding: {...kernel}, engine: {inspect() {}}, nsenter: {}, nft: {}},
    currentAuthority: {operation: {scope, providerId: "codex"}},
    signer: {scope, hostReservationId: kernel.custodyId},
    authorities: {},
    broker: {
      ids: {}, resolver: {}, evidence: {}, clock: {},
      providerAccessSnapshot: {...scope},
    },
    nativeFiles: {install() {}, bindRoot() {}, cutoff() {}, async quiesce() {}, snapshot() {return {binding: "unbound", closed: false};}},
    connection: {limits: {deadline: 100, closureDeadline: 200}},
  };
  const owner = createLinuxCodexContainedTurnOwner({}, {
    imageInitLock: {}, cleanupMilliseconds: 100,
    select() {return selected;},
  });
  t.after(() => owner.dispose());
  const prepared = state.preparation({kernel});
  const listener = prepared.resources.listenerFor("127.0.0.1");
  await listener.open(prepared.resources.accept, new AbortController());
  state.accepted = state.accept({}, new AbortController().signal);
  const execution = owner.provider.execute({custodyId: kernel.custodyId});
  // Attach a rejection observer before releasing any deferred operation.
  void execution.catch(() => {});
  return {...state, listener, execution, owner};
}

test("HTTP completion negative joins", {concurrency: false}, async parent => {
  await parent.test("late reconcile_required preserves provider result but blocks composite closure", async t => {
    const f = await fixture(t);
    let returned = false;
    void f.execution.then(() => {returned = true; return null;}, () => {returned = true; return null;});
    f.providerResult.resolve({kind: "completed", outcome: "succeeded"});
    await f.settleEntered.promise;
    assert.equal(returned, false, "provider result must wait for receipt accounting");
    assert.deepEqual(f.events, ["finalizer-entered", "settle-entered"]);
    f.receipt.resolve({outcome: "reconcile_required"});
    await f.execution;
    await assert.rejects(f.owner.custody.attestContainment({custodyId: "custody:test"}), {
      name: "TypeError", message: "Docker HTTP request settlement is unproven",
    });
    assert.ok(f.events.includes("settle-returned"));
  });

  await parent.test("physical closure does not discharge semantic debt", async t => {
    const f = await fixture(t);
    f.receipt.resolve({outcome: "reconcile_required"});
    await f.accepted;
    assert.deepEqual(await f.listener.close(), {state: "closed"});
    f.providerResult.resolve({kind: "completed", outcome: "succeeded"});
    await f.execution;
    await assert.rejects(f.owner.custody.attestContainment({custodyId: "custody:test"}), {
      name: "TypeError", message: "Docker HTTP request settlement is unproven",
    });
    assert.ok(f.events.indexOf("physical-close") < f.events.indexOf("settle-entered"));
    assert.ok(f.events.includes("settle-returned"),
      "a settled callback and closed transport must not erase request debt");
  });

  await parent.test("cancelled result remains prompt while late debt blocks both composite gates", async t => {
    const f = await fixture(t);
    const cancelled = {kind: "completed", outcome: "cancelled"};
    f.providerResult.resolve(cancelled);
    try {
      // A microtask barrier makes an accidental wait fail without a timer.
      const pending = Symbol("still pending");
      const observed = await Promise.race([
        f.execution,
        Promise.resolve().then(() => null).then(() => null).then(() => pending),
      ]);
      assert.strictEqual(observed, cancelled);
      assert.equal(f.events.includes("settle-entered"), false);
    } finally {
      f.receipt.resolve({outcome: "reconcile_required"});
      await f.accepted;
    }
    assert.strictEqual(await f.execution, cancelled);
    for (const method of ["attestContainment", "queryContainmentAttestation"]) {
      await assert.rejects(f.owner.custody[method]({custodyId: "custody:test"}), /settlement is unproven/);
    }
  });
});
