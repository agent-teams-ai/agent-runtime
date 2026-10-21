import assert from "node:assert/strict";
import {mkdtemp, realpath, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test, {after} from "node:test";
import {assemblyFor, entriesOf} from "@get-modular/assembly";
import {checkNamespaces, checkWiring, guardHandles, isolate, smoke, type WiringOracle} from "@get-modular/conformance";
import {constructInteractiveSessionHost, createInteractiveSessionHost} from "../../../dist/composition/interactive-session-host.js";
import {composeInteractiveSessionHost, interactiveHostModules} from "../../../dist/composition/interactive-session-host.root.js";
import {hostModule, type InteractiveHostCapabilities} from "../../../dist/features/interactive-session-runtime/internal.js";
import {storeInput, providerInput, authorityInput, custodyInput, contextInput, ownershipInput} from "../../../dist/features/interactive-session-runtime/composition/interactive-session-runtime.inputs.js";
import {fixture, ref} from "./support.ts";
import {registerHostContractSuite} from "./host-contract-suite.ts";

const handles = guardHandles();

// Keep the observed registration site in this source file, as required by CI custody.
registerHostContractSuite((name, body) => test(name, body));

const oracle: WiringOracle = {providers: {
  "agent-runtime/interactive-host/host": "agent-runtime/interactive-host/host/default",
  "agent-runtime/interactive-host/store": "agent-runtime/interactive-host/store/input",
  "agent-runtime/interactive-host/provider": "agent-runtime/interactive-host/provider/input",
  "agent-runtime/interactive-host/authority": "agent-runtime/interactive-host/authority/input",
  "agent-runtime/interactive-host/custody": "agent-runtime/interactive-host/custody/input",
  "agent-runtime/interactive-host/context": "agent-runtime/interactive-host/context/input",
  "agent-runtime/interactive-host/ownership": "agent-runtime/interactive-host/ownership/input",
}, roots: ["agent-runtime/interactive-host/host/default"]};

test("current Assembly root has exact independent wiring and namespace identities", async () => {
  const prepared = await composeInteractiveSessionHost(assemblyFor<InteractiveHostCapabilities>());
  assert.equal(prepared.status, "prepared"); if (prepared.status !== "prepared") {return;}
  const declarations = [...entriesOf(interactiveHostModules), storeInput, providerInput, authorityInput, custodyInput, contextInput, ownershipInput].map(entry => entry.declaration);
  checkWiring(prepared.composition, [oracle], {declarations});
  checkNamespaces({namespace: "agent-runtime", declarations});
});

test("actual module isolates, owns cleanup, and refuses an independently foreign scope", async () => {
  const f = fixture();
  await using isolated = await isolate(hostModule, {dependencies: {...f.ports, ownership: f.ownership}});
  assert.throws(() => isolated.instance.bindAccess({...ref, tenantId: "TEST-foreign"}));
  const api = isolated.instance.bindAccess(ref);
  assert.equal((await api.open(ref, "TEST-open", "TEST-config", ["TEST-mcp"])).status, "accepted");
  assert.equal(Object.hasOwn(isolated.instance.control, "cleanup"), false);
  await isolated.instance.dispose(); assert.deepEqual(f.counts(), {opens: 1, closes: 1, released: 1});
});

test("production root smoke closes success, failure and cancellation through the same scoped module", async () => {
  const f = fixture();
  const steps = await smoke({api: assemblyFor<InteractiveHostCapabilities>(), compose: composeInteractiveSessionHost, inputs: {
    store: {"agent-runtime/interactive-host/store": f.ports.store}, provider: {"agent-runtime/interactive-host/provider": f.ports.provider},
    authority: {"agent-runtime/interactive-host/authority": f.ports.authority}, custody: {"agent-runtime/interactive-host/custody": f.ports.custody},
    context: {"agent-runtime/interactive-host/context": f.ports.context}, ownership: {"agent-runtime/interactive-host/ownership": f.ownership},
  }});
  assert.ok(steps.every(step => step.report.complete && step.problem === undefined));
});

test("uncertain cleanup keeps Host ownership, fences new effects and retries only unfinished evidence", async () => {
  const f = fixture(); const host = await constructInteractiveSessionHost(f.ports, f.ownership); const api = host.bindAccess(ref);
  await api.open(ref, "TEST-open", "TEST-config", []); f.cleanup(false);
  await assert.rejects(host.dispose(), /cleanup_incomplete/);
  assert.deepEqual(f.counts(), {opens: 1, closes: 1, released: 0});
  assert.equal((await api.submit(ref, {commandId: "TEST-input", inputId: "TEST-input", content: "TEST"})).status, "unavailable");
  f.cleanup(true); await host.dispose(); await host.dispose();
  assert.deepEqual(f.counts(), {opens: 1, closes: 1, released: 1});
});

for (const failure of ["unknown", "throw"] as const) {
  test(`disposal attempts every retained session when the first cleanup is ${failure}`, async t => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "TEST-interactive-host-all-owned-")));
    const f = fixture(); const second = {...ref, sessionId: "TEST-second-session"};
    const physicallyClosed: string[] = []; let disposing = false; let confirmed = false;
    const ports = {...f.ports,
      store: {...f.store, read: async (...args: Parameters<typeof f.store.read>) => {
        if (disposing && !confirmed && failure === "throw" && args[0].sessionId === ref.sessionId) {throw new Error("TEST-first-cleanup-store-failure");}
        return f.store.read(...args);
      }},
      provider: {open: async (...args: Parameters<typeof f.ports.provider.open>) => {
        const opened = await f.ports.provider.open(...args);
        return {...opened, driver: {...opened.driver, close: async () => {
          physicallyClosed.push(args[0].sessionId); return opened.driver.close();
        }}};
      }},
      custody: {close: async (...args: Parameters<typeof f.ports.custody.close>) => {
        if (!confirmed && args[0].sessionId === ref.sessionId) {return {outputDrained: false, resourcesStopped: false};}
        return f.ports.custody.close(...args);
      }},
    };
    const host = await createInteractiveSessionHost({...ports, privateRoot: directory});
    t.after(async () => {confirmed = true; await host.dispose(); await rm(directory, {recursive: true, force: true});});
    const api = host.bindAccess(ref);
    assert.equal((await api.open(ref, "TEST-first-open", "TEST-config", [])).status, "accepted");
    assert.equal((await api.open(second, "TEST-second-open", "TEST-config", [])).status, "accepted");
    disposing = true;
    await assert.rejects(host.dispose());
    assert.equal(physicallyClosed.filter(id => id === second.sessionId).length, 1);
    assert.equal((await api.read(second))!.status, "closed");
    assert.equal((await api.close(second)).status, "unavailable");
    await assert.rejects(createInteractiveSessionHost({...ports, privateRoot: directory}), /factory_failed/);
    confirmed = true; await host.dispose(); await host.dispose();
    assert.equal((await api.read(ref))!.status, "closed");
    assert.equal(physicallyClosed.filter(id => id === second.sessionId).length, 1);
    const next = await createInteractiveSessionHost({...ports, privateRoot: directory}); await next.dispose();
  });
}

test("compatible closed checkpoint restores a new generation and old authority never reaches the driver", async () => {
  const f = fixture(); const first = await constructInteractiveSessionHost(f.ports, f.ownership); const api = first.bindAccess(ref);
  await api.open(ref, "TEST-open", "TEST-config", []); await first.control.checkpoint(ref); await api.close(ref); await first.dispose();
  const restored = await constructInteractiveSessionHost(f.ports, f.ownership); const next = restored.bindAccess(ref);
  assert.equal((await next.open(ref, "TEST-open", "TEST-config", [])).status, "duplicate");
  assert.equal((await next.restore(ref, "TEST-restore", "TEST-config")).status, "accepted");
  const generation2 = {...ref, generation: 2};
  assert.equal((await next.read(generation2))!.status, "ready");
  assert.deepEqual(f.configs[1], {...generation2, configRevision: "TEST-config", requiredCapabilities: [], checkpointRef: "TEST-checkpoint-ref"});
  assert.equal((await next.submit(ref, {commandId: "TEST-old", inputId: "TEST-old", content: "TEST"})).status, "stale");
  await restored.dispose(); assert.equal(f.counts().released, 2);
});

test("lost owner cannot replay; exact-generation custody retires logical/grant debt before closure", async () => {
  const f = fixture(); const original = await constructInteractiveSessionHost(f.ports, f.ownership);
  await original.bindAccess(ref).open(ref, "TEST-open", "TEST-config", []);
  // Reconstructed Host deliberately has no local provider handle, using the same durable store.
  const recovery = fixture(f.shared); const host = await constructInteractiveSessionHost(recovery.ports, recovery.ownership);
  const api = host.bindAccess(ref); await host.control.recover(ref);
  assert.equal((await api.close(ref)).status, "unknown"); assert.equal(recovery.counts().opens, 0);
  recovery.proof(true);
  assert.equal((await api.close(ref)).status, "accepted");
  assert.equal((await api.read(ref))!.status, "closed"); assert.equal(recovery.counts().opens, 0);
  await host.dispose(); await original.dispose();
});

test("real existing descriptor custody refuses a second Host and releases only after disposal", async t => {
  const created = await mkdtemp(join(tmpdir(), "TEST-interactive-host-")); const directory = await realpath(created);
  t.after(() => rm(directory, {recursive: true, force: true}));
  const f = fixture();
  if (created !== directory) {await assert.rejects(createInteractiveSessionHost({...f.ports, privateRoot: created}), /factory_failed/);}
  const host = await createInteractiveSessionHost({...f.ports, privateRoot: directory});
  await assert.rejects(createInteractiveSessionHost({...f.ports, privateRoot: directory}), /factory_failed/);
  await host.dispose(); const next = await createInteractiveSessionHost({...f.ports, privateRoot: directory}); await next.dispose();
});

for (const phase of ["authorization", "store-create"] as const) {
  test(`disposal joins a first open held in ${phase} and retains uncertain late cleanup debt`, async () => {
    const f = fixture(); const arrived = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
    const ports = {...f.ports,
      authority: {authorize: async (...args: Parameters<typeof f.ports.authority.authorize>) => {
        if (phase === "authorization" && args[0] === "open") {arrived.resolve(); await release.promise;}
        return f.ports.authority.authorize(...args);
      }},
      store: {...f.store, create: async (...args: Parameters<typeof f.store.create>) => {
        if (phase === "store-create") {arrived.resolve(); await release.promise;}
        return f.store.create(...args);
      }},
    };
    const host = await constructInteractiveSessionHost(ports, f.ownership); const api = host.bindAccess(ref);
    const opening = api.open(ref, "TEST-held-open", "TEST-config", []); await arrived.promise;
    let disposed = false; const disposal = host.dispose().then(() => disposed = true);
    await new Promise<void>(resolve => {setImmediate(resolve);});
    assert.equal(disposed, false); assert.equal(f.counts().released, 0);
    assert.throws(() => host.bindAccess(ref)); release.resolve();
    assert.equal((await opening).status, "unknown");
    await assert.rejects(disposal, /cleanup_incomplete/);
    assert.deepEqual(f.counts(), {opens: 0, closes: 0, released: 0});
    f.proof(true); await host.dispose();
    assert.equal((await api.read(ref))!.status, "closed"); assert.equal(f.counts().released, 1);
  });
}

test("disposal joins a held restore and cleans the late next generation before releasing ownership", async () => {
  const f = fixture(); const arrived = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
  const ports = {...f.ports, authority: {authorize: async (...args: Parameters<typeof f.ports.authority.authorize>) => {
    if (args[0] === "restore") {arrived.resolve(); await release.promise;}
    return f.ports.authority.authorize(...args);
  }}};
  const host = await constructInteractiveSessionHost(ports, f.ownership); const api = host.bindAccess(ref);
  await api.open(ref, "TEST-first", "TEST-config", []); await host.control.checkpoint(ref); await api.close(ref);
  const restoring = api.restore(ref, "TEST-held-restore", "TEST-config"); await arrived.promise;
  f.proof(true); const disposal = host.dispose();
  await new Promise<void>(resolve => {setImmediate(resolve);}); assert.equal(f.counts().released, 0);
  release.resolve(); assert.equal((await restoring).status, "unknown"); await disposal;
  assert.equal((await api.read({...ref, generation: 2}))!.status, "closed");
  assert.deepEqual(f.counts(), {opens: 1, closes: 1, released: 1});
});

test("a mutable caller reference cannot replace the captured provider and cleanup identity", async () => {
  const f = fixture(); const arrived = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
  const ports = {...f.ports, authority: {authorize: async (...args: Parameters<typeof f.ports.authority.authorize>) => {
    if (args[0] === "open") {arrived.resolve(); await release.promise;}
    return f.ports.authority.authorize(...args);
  }}};
  const host = await constructInteractiveSessionHost(ports, f.ownership); const api = host.bindAccess(ref); const caller = {...ref};
  const opening = api.open(caller, "TEST-mutable-open", "TEST-config", []); await arrived.promise;
  caller.generation = 99; caller.sessionId = "TEST-phantom"; release.resolve();
  assert.equal((await opening).status, "accepted"); await host.dispose();
  assert.equal((await api.read(ref))!.status, "closed"); assert.deepEqual(f.counts(), {opens: 1, closes: 1, released: 1});
});

after(() => handles.check());
