import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {test} from "node:test";
import {createStrictHttpEgressBroker} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/egress/strict-http-egress-broker.js";
import type {HttpEgressBrokerPorts} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/egress/http-egress-ports.js";
import {bytes, createEgressFixture, SECRET_MARKER} from "./http-egress-test-fixture.ts";

const zero = (value: Uint8Array): boolean => value.every(byte => byte === 0);
const never = (): Promise<never> => new Promise(() => {});

for (const stage of ["authorize", "render", "observe-before", "provisional", "resolve", "observe-ready", "final"] as const) {
  for (const stop of ["deadline", "cancel"] as const) {
    test(`${stage} is bounded by ${stop}, closes custody and never dispatches`, {timeout: 2_000}, async () => {
      const controller = new AbortController();
      const fixture = createEgressFixture({signal: controller.signal});
      let reached = false; let observations = 0; let finishes = 0;
      const retained: Uint8Array[] = []; let projection: Uint8Array | undefined;
      const credential = bytes(`Bearer ${SECRET_MARKER}`);
      const stall = (): Promise<never> => {reached = true;
        if (stop === "cancel") {queueMicrotask(() => controller.abort());} return never();};
      const ports: HttpEgressBrokerPorts = {...fixture.ports,
      guard: {...fixture.ports.guard, finish: (lease, disposition) => {
          finishes += 1; assert.equal(disposition, undefined); return fixture.ports.guard.finish(lease, disposition);
        }},
        clock: {now: () => 0, within: async (deadline, action, signal) => {
          assert.ok(deadline === fixture.operation.limits.deadline || deadline === fixture.operation.limits.closureDeadline);
          let timer: ReturnType<typeof setTimeout> | undefined;
          let abort: (() => void) | undefined;
          try {return await Promise.race([action(), new Promise<never>((_resolve, reject) => {
            abort = () => reject(new Error("synthetic cancellation"));
            signal?.addEventListener("abort", abort, {once: true});
            if (signal?.aborted) {abort();}
            timer = setTimeout(() => reject(new Error("synthetic deadline")), 25);
          })]);} finally {clearTimeout(timer); if (abort !== undefined) {signal?.removeEventListener("abort", abort);}}
        }},
        evidence: {...fixture.ports.evidence, digest: parts => {
          retained.push(...parts);
          if (parts.length === 1 && parts[0]?.[0] === 0) {projection = parts[0];}
          return fixture.ports.evidence.digest(parts);
        }},
        materializer: {render: stage === "render" ? stall : async () => [{name: "authorization", valueBytes: credential}]},
        providerAccess: {...fixture.ports.providerAccess,
          authorize: stage === "authorize" ? stall : fixture.ports.providerAccess.authorize,
          observe: input => {observations += 1;
            return (stage === "observe-before" && observations === 1 || stage === "observe-ready" && observations === 2)
              ? stall() : fixture.ports.providerAccess.observe(input);
          }},
        resolver: {resolve: stage === "resolve" ? stall : fixture.ports.resolver.resolve},
        runtimeSecurity: {...fixture.ports.runtimeSecurity,
          requestProvisional: stage === "provisional" ? stall : fixture.ports.runtimeSecurity.requestProvisional,
          authorizeFirstApplicationByte: stage === "final" ? stall : fixture.ports.runtimeSecurity.authorizeFirstApplicationByte},
      };
      const receipt = await createStrictHttpEgressBroker(ports).execute(fixture.operation);
      assert.equal(reached, true); assert.equal(finishes, 1);
      assert.notEqual(receipt.outcome, "completed");
      if (stop === "cancel") {assert.equal(receipt.outcome, "cancelled");}
      assert.equal(receipt.firstByteState, "not_sent"); assert.equal(receipt.upstreamRequestBytes, 0);
      assert.equal(fixture.observations.dispatches, 0);
      const opened = stage === "observe-ready" || stage === "final";
      assert.equal(fixture.observations.opens, opened ? 1 : 0);
      assert.equal(fixture.observations.closes, opened ? 1 : 0);
      assert.equal(receipt.inboundClosure, "closed");
      assert.equal(fixture.observations.receipts.length, 1);
      assert.equal(JSON.stringify(receipt).includes(SECRET_MARKER), false);
      assert.ok(retained[3] !== undefined && zero(retained[3])); // adopted inbound body
      if (stage !== "authorize" && stage !== "render") {assert.ok(zero(credential));}
      if (projection !== undefined) {assert.ok(zero(projection));}
    });
  }
}

for (const shape of ["sparse", "null", "iterator", "accessor", "nested", "proxy", "buffer-property"] as const) {
  for (const late of [false, true]) {
    test(`${late ? "late" : "immediate"} ${shape} materialization clears all reachable credential buffers`, async () => {
      const fixture = createEgressFixture(); const first = bytes(SECRET_MARKER); const last = bytes(SECRET_MARKER);
      let reads = 0;
      const fields: unknown[] = [{name: "authorization", valueBytes: first}, {name: "other", valueBytes: last}];
      if (shape === "sparse") {delete fields[0]; fields[2] = {valueBytes: first};}
      if (shape === "null") {fields.unshift(null);}
      if (shape === "iterator") {Object.defineProperty(fields, Symbol.iterator, {value: () => {reads += 1; throw new Error("iterator");}});}
      if (shape === "accessor") {Object.defineProperty(fields, "0", {get: () => {reads += 1; throw new Error("accessor");}});
        fields[2] = {valueBytes: first};}
      if (shape === "nested") {fields[0] = {hidden: {first}, self: fields};}
      if (shape === "proxy") {fields.unshift(new Proxy({}, {ownKeys: () => {reads += 1; throw new Error("proxy");}}));}
      if (shape === "buffer-property") {fields[0] = {valueBytes: first}; fields.length = 1;
        Object.defineProperty(first, "nested", {value: last});}
      let release: ((value: unknown) => void) | undefined;
      let rendering = false;
      const ports: HttpEgressBrokerPorts = {...fixture.ports,
        materializer: {render: () => {rendering = true; return (late ? new Promise<unknown>(resolve => {release = resolve;})
          : Promise.resolve(fields)) as ReturnType<HttpEgressBrokerPorts["materializer"]["render"]>;}},
        clock: {...fixture.ports.clock, within: async (deadline, action, signal) => {
          const pending = action();
          if (late && rendering && deadline === fixture.operation.limits.deadline) {throw new Error("synthetic deadline");}
          signal?.throwIfAborted(); return await pending;
        }},
      };
      const receipt = await createStrictHttpEgressBroker(ports).execute(fixture.operation);
      if (late) {assert.ok(release !== undefined); release(fields); await new Promise(resolve => {setImmediate(resolve);});}
      assert.notEqual(receipt.outcome, "completed"); assert.equal(fixture.observations.dispatches, 0);
      assert.equal(reads, 0); assert.ok(zero(first)); assert.ok(zero(last));
      assert.equal(fixture.observations.receipts.length, 1);
    });
  }
}

// A separate process captures a faulting byte intrinsic before module initialization,
// so the injected cleanup exception cannot contaminate other suites.
for (const fault of ["body", "dispose"] as const) {
test(`${fault} cleanup exceptions cannot bypass finish or independent buffer clearing and evidence is honest`, () => {
  const broker = new URL("../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/egress/strict-http-egress-broker.js", import.meta.url).href;
  const fixtureUrl = new URL("./http-egress-test-fixture.ts", import.meta.url).href;
  execFileSync(process.execPath, [...process.execArgv, "--input-type=module", "-e", `
    import assert from 'node:assert/strict';
    const original = Uint8Array.prototype.fill;
    let target; let failures = 0; let faultActive = false;
    Uint8Array.prototype.fill = function(...args) {
      if (faultActive && this === target) {failures++; throw new Error('synthetic cleanup fault');}
      return Reflect.apply(original, this, args);
    };
    const {createStrictHttpEgressBroker} = await import(${JSON.stringify(broker)});
    const {createEgressFixture, bytes} = await import(${JSON.stringify(fixtureUrl)});
    const fixture = createEgressFixture(); let finishes = 0; let disposition;
    const retained = []; let projection; const secret = bytes('Bearer synthetic-secret');
    const ports = {...fixture.ports,
      materializer: {render: async () => [{name: 'authorization', valueBytes: secret}]},
      evidence: {...fixture.ports.evidence, digest: parts => {
        retained.push(...parts);
        if (parts.length === 1 && parts[0].length > 16 && parts[0][0] === 0) projection = parts[0];
        if (${JSON.stringify(fault)} === "body" && target === undefined) target = parts.at(-1);
        return fixture.ports.evidence.digest(parts);
      }},
      transport: {beginOpen: input => {
        const attempt = fixture.ports.transport.beginOpen(input);
        return {...attempt, ready: async () => {
          const session = await attempt.ready();
          return {...session, dispatch: (consume, signal) => session.dispatch(() => {
            const wire = consume(); if (${JSON.stringify(fault)} === "dispose") target = wire;
            return wire;
          }, signal)};
        }};
      }},
      guard: {...fixture.ports.guard, finish: (lease, result) => {
        finishes++; disposition = result; fixture.ports.guard.finish(lease, result);
      }}
    };
    const operation = {...fixture.operation, connection: {...fixture.operation.connection, close: async reason => {
      faultActive = true; return fixture.operation.connection.close(reason);
    }}};
    const receipt = await createStrictHttpEgressBroker(ports).execute(operation);
    assert.ok(failures > 0); assert.equal(finishes, 1); assert.equal(disposition, undefined);
    assert.equal(receipt.outcome, 'reconcile_required'); assert.equal(receipt.anomalyCode, 'closure_unproved');
    assert.equal(fixture.observations.receipts.length, 1);
    assert.equal(fixture.observations.receipts[0].outcome, 'reconcile_required');
    assert.ok(secret.every(byte => byte === 0));
    assert.ok(projection !== undefined && projection.every(byte => byte === 0));
    if (${JSON.stringify(fault)} === "dispose") assert.ok(retained[3].every(byte => byte === 0));
    assert.equal(fixture.observations.closes, 1);
    assert.equal(fixture.observations.dispatches, 1);
  `], {stdio: "pipe"});
});
}

test("a final grant arriving after timeout cannot resurrect a closed attempt", {timeout: 2_000}, async () => {
  const fixture = createEgressFixture(); let finalStarted = false; let finishes = 0;
  let release: (() => void) | undefined;
  const ports: HttpEgressBrokerPorts = {...fixture.ports,
    guard: {...fixture.ports.guard, finish: (lease, disposition) => {
      finishes += 1; return fixture.ports.guard.finish(lease, disposition);
    }},
    runtimeSecurity: {...fixture.ports.runtimeSecurity, authorizeFirstApplicationByte: async input => {
      finalStarted = true;
      const outcome = await fixture.ports.runtimeSecurity.authorizeFirstApplicationByte(input);
      return new Promise(resolve => {release = () => {resolve(outcome);};});
    }},
    clock: {...fixture.ports.clock, within: async (deadline, action) => {
      const pending = action();
      if (finalStarted && deadline === fixture.operation.limits.deadline) {throw new Error("synthetic deadline");}
      return await pending;
    }},
  };
  const receipt = await createStrictHttpEgressBroker(ports).execute(fixture.operation);
  assert.equal(receipt.anomalyCode, "final_timeout"); assert.equal(receipt.upstreamClosure, "closed");
  assert.ok(release !== undefined); release(); await new Promise(resolve => {setImmediate(resolve);});
  assert.equal(fixture.observations.dispatches, 0); assert.equal(fixture.observations.opens, 1);
  assert.equal(fixture.observations.closes, 1); assert.equal(fixture.observations.receipts.length, 1);
  assert.equal(finishes, 1);
});
