import assert from "node:assert/strict";
import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {test} from "node:test";
import {createNodeOrdinaryProcess} from "../../../dist/features/contained-agent-turn/adapters/outbound/ordinary-process/node-ordinary-process.js";
import {openOrdinaryChannel} from "../../../dist/features/contained-agent-turn/adapters/outbound/ordinary-channel/ordinary-byte-channel.js";
import {OrdinaryJsonLineFraming} from "../../../dist/features/contained-agent-turn/adapters/outbound/ordinary-codex/ordinary-framing.js";
import type {OrdinaryTransport} from "../../../dist/features/contained-agent-turn/application/ordinary-ports.js";

const binding = {operationId: "operation:synthetic", attemptId: "attempt:synthetic", executionProfile: "user-session-v1", capabilityManifestRevision: "ordinary-codex-macos-arm64-0.153.4-v1"} as const;
/** The consumer side of the channel: one framing pass over the bytes, as the Codex binding does it. */
const framing = (transport: OrdinaryTransport) => new OrdinaryJsonLineFraming(openOrdinaryChannel(transport), 262_144);
const drain = async (transport: OrdinaryTransport): Promise<unknown[]> => {
  const reader = framing(transport); const messages: unknown[] = [];
  for (;;) {const message = await reader.read(performance.now() + 5000); if (message === undefined) {return messages;} messages.push(message);}
};
const claim = (reservationId: string) => ({...binding, kind: "dispatch_claim" as const, claimId: "claim:synthetic", committedRevision: 2, preparationDigest: "a".repeat(64), reservationId});

test("ordinary owned current-user process drains, closes once, and rejects another launch", {skip: process.platform !== "darwin" || process.getuid?.() === 0}, async () => {
  const root = await mkdtemp(join(tmpdir(), "ordinary-process-TEST-"));
  try {
    const observations: string[] = [];
    const processOwner = createNodeOrdinaryProcess({record: event => {observations.push(event.kind);}, prepareLaunch: async () => ({executable: "/bin/cat", arguments: [], cwd: root, environment: {PATH: "/usr/bin:/bin"}})});
    const reservation = await processOwner.reserve({binding, workspace: {workspaceId: "workspace:synthetic", cwd: root, homeDirectory: root},
      credential: {materializationId: "material:synthetic", generation: 1, environment: {}, brokerEndpoint: "http://127.0.0.1:1"}, deadline: performance.now() + 5000});
    const transport = await reservation.start(claim(reservation.reservationId), new AbortController().signal);
    const reader = framing(transport);
    await reader.write('{"synthetic":true}\n');
    await reader.closeInput();
    const output: unknown[] = [];
    for (;;) {const message = await reader.read(performance.now() + 5000); if (message === undefined) {break;} output.push(message);}
    assert.deepEqual(output, [{synthetic: true}]);
    const receipts = await reservation.close(1);
    assert.ok(Array.isArray(receipts));
    assert.equal(receipts[1].groupEmptyObserved, true);
    assert.equal(receipts[0].finalSequence, 1);
    assert.deepEqual(observations, ["launch_requested", "started", "exited", "closed"]);
    assert.equal(await reservation.close(1), receipts);
    await assert.rejects(reservation.start(claim(reservation.reservationId), new AbortController().signal), /ORDINARY_PROCESS_UNCONFIRMED/u);
  } finally { await rm(root, {recursive: true, force: true}); }
});

test("ordinary reservation refuses a claim for a different preparation before spawn", {skip: process.platform !== "darwin" || process.getuid?.() === 0}, async () => {
  const root = await mkdtemp(join(tmpdir(), "ordinary-process-claim-TEST-"));
  try {
    const owner = createNodeOrdinaryProcess({prepareLaunch: async () => ({executable: "/missing/synthetic-executable", arguments: [], cwd: root, environment: {}})});
    const reservation = await owner.reserve({binding, workspace: {workspaceId: "workspace:synthetic", cwd: root, homeDirectory: root},
      credential: {materializationId: "material:synthetic", generation: 1, environment: {}, brokerEndpoint: "http://127.0.0.1:1"}, deadline: performance.now() + 5000});
    await assert.rejects(reservation.start(claim("another-reservation"), new AbortController().signal), /ORDINARY_PROCESS_UNCONFIRMED/u);
    assert.deepEqual(await reservation.close(0), {kind: "not_started", reservationId: reservation.reservationId});
  } finally { await rm(root, {recursive: true, force: true}); }
});

test("closing an unstarted reservation permanently fences later start", {skip: process.platform !== "darwin" || process.getuid?.() === 0}, async () => {
  const root = await mkdtemp(join(tmpdir(), "ordinary-process-fence-TEST-"));
  try {
    const owner = createNodeOrdinaryProcess({prepareLaunch: async () => ({executable: "/bin/cat", arguments: [], cwd: root, environment: {}})});
    const reservation = await owner.reserve({binding, workspace: {workspaceId: "workspace:synthetic", cwd: root, homeDirectory: root}, credential: {materializationId: "material:synthetic", generation: 1, environment: {}, brokerEndpoint: "http://127.0.0.1:1"}, deadline: performance.now() + 5000});
    assert.deepEqual(await reservation.close(0), {kind: "not_started", reservationId: reservation.reservationId});
    await assert.rejects(reservation.start(claim(reservation.reservationId), new AbortController().signal));
  } finally {await rm(root, {recursive: true, force: true});}
});

test("malformed UTF8 is rejected rather than rewritten into protocol data or a drain receipt", {skip: process.platform !== "darwin" || process.getuid?.() === 0}, async () => {
  const root = await mkdtemp(join(tmpdir(), "ordinary-process-utf8-TEST-"));
  try {
    const owner = createNodeOrdinaryProcess({prepareLaunch: async () => ({executable: process.execPath, arguments: ["-e", "process.stdout.write(Buffer.from([0xff,10]));"], cwd: root, environment: {}})});
    const reservation = await owner.reserve({binding, workspace: {workspaceId: "workspace:synthetic", cwd: root, homeDirectory: root}, credential: {materializationId: "material:synthetic", generation: 1, environment: {}, brokerEndpoint: "http://127.0.0.1:1"}, deadline: performance.now() + 5000});
    const transport = await reservation.start(claim(reservation.reservationId), new AbortController().signal);
    await assert.rejects(drain(transport));
    await assert.rejects(reservation.close(0));
  } finally {await rm(root, {recursive: true, force: true});}
});


test("provided process journal rejection fences spawn and leaves truthful unstarted cleanup", {skip: process.platform !== "darwin" || process.getuid?.() === 0}, async () => {
  const root = await mkdtemp(join(tmpdir(), "ordinary-process-journal-TEST-"));
  try {
    const owner = createNodeOrdinaryProcess({record: () => {throw new Error("synthetic journal unavailable");}, prepareLaunch: async () => ({executable: "/bin/cat", arguments: [], cwd: root, environment: {}})});
    const reservation = await owner.reserve({binding, workspace: {workspaceId: "workspace:synthetic", cwd: root, homeDirectory: root}, credential: {materializationId: "material:synthetic", generation: 1, environment: {}, brokerEndpoint: "http://127.0.0.1:1"}, deadline: performance.now() + 5000});
    await assert.rejects(reservation.start(claim(reservation.reservationId), new AbortController().signal));
    assert.deepEqual(await reservation.close(0), {kind: "not_started", reservationId: reservation.reservationId});
  } finally {await rm(root, {recursive: true, force: true});}
});

test("asynchronous journal acknowledgement prevents provider spawn", {skip: process.platform !== "darwin" || process.getuid?.() === 0}, async () => {
  const root = await mkdtemp(join(tmpdir(), "ordinary-process-fence-TEST-"));
  try {
    const owner = createNodeOrdinaryProcess({record: async () => {throw new Error("journal rejected");}, prepareLaunch: async () => ({executable: "/bin/cat", arguments: [], cwd: root, environment: {}})});
    const reservation = await owner.reserve({binding, workspace: {workspaceId: "workspace:synthetic", cwd: root, homeDirectory: root}, credential: {materializationId: "material:synthetic", generation: 1, environment: {}, brokerEndpoint: "http://127.0.0.1:1"}, deadline: performance.now() + 5000});
    await assert.rejects(reservation.start(claim(reservation.reservationId), new AbortController().signal));
    assert.deepEqual(await reservation.close(0), {kind: "not_started", reservationId: reservation.reservationId});
  } finally {await rm(root, {recursive: true, force: true});}
});

test("Linux ordinary reservation refuses before preparing a provider launch", {skip: process.platform !== "linux"}, async () => {
  const owner = createNodeOrdinaryProcess({prepareLaunch: async () => {throw new Error("must not prepare launch");}});
  await assert.rejects(owner.reserve({binding, workspace: {workspaceId: "test", cwd: "/synthetic-TEST", homeDirectory: "/synthetic-TEST"}, credential: {materializationId: "test", generation: 1, environment: {}, brokerEndpoint: "http://127.0.0.1:1"}, deadline: performance.now() + 5000}), /ORDINARY_PROCESS_UNCONFIRMED/);
});

test("bounded close rejection retries observed group closure and memoizes success without spawning", async t => {
  const childProcess = await import("node:child_process");
  const {syncBuiltinESMExports} = await import("node:module");
  const {PassThrough} = await import("node:stream");
  const child = new childProcess.ChildProcess();
  child.pid = 424242;
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", {...originalPlatform, value: "darwin"});
  t.mock.method(process, "getuid", () => 1000);
  let empty = false; let spawns = 0;
  t.mock.method(childProcess.default, "spawn", () => {spawns += 1; return child;});
  t.mock.method(process, "kill", (_pid: number, signal?: NodeJS.Signals | number) => {
    assert.equal(signal, 0);
    if (empty) {throw Object.assign(new Error("TEST group absent"), {code: "ESRCH"});}
    return true;
  });
  syncBuiltinESMExports();
  t.after(() => {Object.defineProperty(process, "platform", originalPlatform); t.mock.restoreAll(); syncBuiltinESMExports();});
  const observations: string[] = [];
  const owner = createNodeOrdinaryProcess({record: event => {observations.push(event.kind);}, prepareLaunch: async () => ({executable: "/TEST/never-executed", arguments: [], cwd: "/TEST", environment: {}})});
  const reservation = await owner.reserve({binding, workspace: {workspaceId: "workspace:synthetic", cwd: "/TEST", homeDirectory: "/TEST"}, credential: {materializationId: "material:synthetic", generation: 1, environment: {}, brokerEndpoint: "http://127.0.0.1:1"}, deadline: performance.now() + 5000});
  const transport = await reservation.start(claim(reservation.reservationId), new AbortController().signal);
  child.stdout.emit("end"); child.stderr.emit("end"); child.emit("exit", 0); child.emit("close", 0);
  assert.deepEqual(await drain(transport), []);
  const first = reservation.close(0); assert.equal(first, reservation.close(0));
  await assert.rejects(first, /ORDINARY_PROCESS_UNCONFIRMED/);
  assert.equal(observations.includes("closed"), false);
  empty = true;
  const retry = reservation.close(0); assert.equal(retry, reservation.close(0));
  const receipts = await retry; assert.ok(Array.isArray(receipts));
  assert.equal(await reservation.close(0), receipts); assert.equal(spawns, 1);
  assert.deepEqual(observations, ["launch_requested", "started", "exited", "unconfirmed", "closed"]);
});

test("timed out close cannot certify a discarded fragment after late EOF", async t => {
  const childProcess = await import("node:child_process");
  const {syncBuiltinESMExports} = await import("node:module");
  const {PassThrough} = await import("node:stream");
  const child = new childProcess.ChildProcess();
  child.pid = 424242;
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", {...originalPlatform, value: "darwin"});
  t.mock.method(process, "getuid", () => 1000);
  let empty = false; let spawns = 0;
  t.mock.method(childProcess.default, "spawn", () => {spawns += 1; return child;});
  t.mock.method(process, "kill", (_pid: number, signal?: NodeJS.Signals | number) => {
    assert.equal(signal, 0);
    if (empty) {throw Object.assign(new Error("TEST group absent"), {code: "ESRCH"});}
    return true;
  });
  syncBuiltinESMExports();
  t.after(() => {Object.defineProperty(process, "platform", originalPlatform); t.mock.restoreAll(); syncBuiltinESMExports();});
  const observations: string[] = [];
  const owner = createNodeOrdinaryProcess({record: event => {observations.push(event.kind);}, prepareLaunch: async () => ({executable: "/TEST/never-executed", arguments: [], cwd: "/TEST", environment: {}})});
  const reservation = await owner.reserve({binding, workspace: {workspaceId: "workspace:synthetic", cwd: "/TEST", homeDirectory: "/TEST"}, credential: {materializationId: "material:synthetic", generation: 1, environment: {}, brokerEndpoint: "http://127.0.0.1:1"}, deadline: performance.now() + 5000});
  await reservation.start(claim(reservation.reservationId), new AbortController().signal);
  child.stdout.emit("data", Buffer.from("unterminated"));
  child.emit("exit", 0);
  const first = reservation.close(0); assert.equal(first, reservation.close(0));
  await assert.rejects(first, /ORDINARY_PROCESS_UNCONFIRMED/);
  assert.equal(observations.includes("closed"), false);
  empty = true;
  child.stdout.emit("end"); child.stderr.emit("end"); child.emit("close", 0);
  const retry = reservation.close(0); assert.equal(retry, reservation.close(0));
  await assert.rejects(retry, /ORDINARY_PROCESS_UNCONFIRMED/);
  await assert.rejects(reservation.close(0), /ORDINARY_PROCESS_UNCONFIRMED/);
  assert.equal(spawns, 1);
  assert.equal(observations.includes("closed"), false);
});

for (const boundary of ["cancelled", "journal", "spawn"] as const) {
  test(`ordinary ${boundary} boundary distinguishes dispatch attempt from proven no spawn`, async t => {
    const childProcess = await import("node:child_process");
    const {syncBuiltinESMExports} = await import("node:module");
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", {...platform, value: "darwin"});
    t.mock.method(process, "getuid", () => 1000);
    let spawns = 0;
    t.mock.method(childProcess.default, "spawn", () => {spawns += 1; throw new Error("TEST spawn boundary unknown");});
    syncBuiltinESMExports();
    t.after(() => {Object.defineProperty(process, "platform", platform); t.mock.restoreAll(); syncBuiltinESMExports();});
    const owner = createNodeOrdinaryProcess({
      prepareLaunch: async () => ({executable: "/TEST/never-executed", arguments: [], cwd: "/TEST", environment: {}}),
      record: () => {if (boundary === "journal") {throw new Error("TEST journal unavailable");}},
    });
    const reservation = await owner.reserve({binding, workspace: {workspaceId: "workspace:synthetic", cwd: "/TEST", homeDirectory: "/TEST"}, credential: {materializationId: "material:synthetic", generation: 1, environment: {}, brokerEndpoint: "http://127.0.0.1:1"}, deadline: performance.now() + 5000});
    const controller = new AbortController(); if (boundary === "cancelled") {controller.abort();}
    await assert.rejects(reservation.start(claim(reservation.reservationId), controller.signal));
    if (boundary === "spawn") {
      await assert.rejects(reservation.close(0)); await assert.rejects(reservation.close(0));
      assert.equal(spawns, 1);
    } else {
      assert.deepEqual(await reservation.close(0), {kind: "not_started", reservationId: reservation.reservationId});
      assert.equal(spawns, 0);
    }
  });
}

for (const overflow of ['chunk', 'line', 'partial', 'stderr'] as const) {
  test(`discarded ${overflow} output permanently prevents drain certification`, async t => {
    const childProcess = await import('node:child_process');
    const {syncBuiltinESMExports} = await import('node:module');
    const {PassThrough} = await import('node:stream');
    const child = new childProcess.ChildProcess();
    child.pid = 424242;
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', {...platform, value: 'darwin'});
    t.mock.method(process, 'getuid', () => 1000);
    t.mock.method(childProcess.default, 'spawn', () => child);
    t.mock.method(process, 'kill', () => {throw Object.assign(new Error('TEST group absent'), {code: 'ESRCH'});});
    syncBuiltinESMExports();
    t.after(() => {Object.defineProperty(process, 'platform', platform); t.mock.restoreAll(); syncBuiltinESMExports();});
    const observations: string[] = [];
    const owner = createNodeOrdinaryProcess({record: event => {observations.push(event.kind);}, prepareLaunch: async () => ({executable: '/TEST/never-executed', arguments: [], cwd: '/TEST', environment: {}})});
    const reservation = await owner.reserve({binding, workspace: {workspaceId: 'workspace:synthetic', cwd: '/TEST', homeDirectory: '/TEST'}, credential: {materializationId: 'material:synthetic', generation: 1, environment: {}, brokerEndpoint: 'http://127.0.0.1:1'}, deadline: performance.now() + 5000});
    const transport = await reservation.start(claim(reservation.reservationId), new AbortController().signal);
    if (overflow === 'stderr') {child.stderr.emit('data', Buffer.alloc(1_048_577, 97));}
    else {
      const bytes = overflow === 'chunk' ? Buffer.alloc(1_048_577, 97)
        : Buffer.from(`{"t":"${'x'.repeat(262_137)}"}${overflow === 'line' ? '\n' : ''}`);
      child.stdout.emit('data', bytes);
    }
    child.stdout.emit('end'); child.stderr.emit('end'); child.emit('exit', 0); child.emit('close', 0);
    await assert.rejects(drain(transport), overflow === 'line' || overflow === 'partial' ? /exceeds the configured bound/u : /ORDINARY_PROCESS_UNCONFIRMED/u);
    await assert.rejects(reservation.close(0), /ORDINARY_PROCESS_UNCONFIRMED/);
    await assert.rejects(reservation.close(0), /ORDINARY_PROCESS_UNCONFIRMED/);
    assert.equal(observations.includes('closed'), false);
  });
}

async function mockedProcess(t: import("node:test").TestContext) {
  const childProcess = await import("node:child_process");
  const {syncBuiltinESMExports} = await import("node:module");
  const {PassThrough} = await import("node:stream");
  const child = new childProcess.ChildProcess();
  child.pid = 424242;
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", {...platform, value: "darwin"});
  t.mock.method(process, "getuid", () => 1000);
  const observed = {spawns: 0, signals: [] as (string | number | undefined)[]};
  t.mock.method(childProcess.default, "spawn", () => {observed.spawns += 1; return child;});
  t.mock.method(process, "kill", (_pid: number, signal?: string | number) => {observed.signals.push(signal); throw Object.assign(new Error("TEST group absent"), {code: "ESRCH"});});
  syncBuiltinESMExports();
  t.after(() => {Object.defineProperty(process, "platform", platform); t.mock.restoreAll(); syncBuiltinESMExports();});
  const owner = createNodeOrdinaryProcess({prepareLaunch: async () => ({executable: "/TEST/never-executed", arguments: [], cwd: "/TEST", environment: {}})});
  const reservation = await owner.reserve({binding, workspace: {workspaceId: "workspace:synthetic", cwd: "/TEST", homeDirectory: "/TEST"}, credential: {materializationId: "material:synthetic", generation: 1, environment: {}, brokerEndpoint: "http://127.0.0.1:1"}, deadline: performance.now() + 5000});
  const controller = new AbortController();
  const transport = await reservation.start(claim(reservation.reservationId), controller.signal);
  const finish = () => {child.stdout.emit("end"); child.stderr.emit("end"); child.emit("exit", 0); child.emit("close", 0);};
  return {child, reservation, transport, finish, controller, observed};
}

test("stdout and stderr share one 1 MiB budget", async t => {
  const {child, reservation, transport, finish} = await mockedProcess(t);
  child.stdout.emit("data", Buffer.alloc(600_000, 32)); child.stderr.emit("data", Buffer.alloc(500_000, 97)); finish();
  await assert.rejects(drain(transport), /ORDINARY_PROCESS_UNCONFIRMED/u);
  await assert.rejects(reservation.close(0), /ORDINARY_PROCESS_UNCONFIRMED/u);
});

test("malformed UTF8 on stderr is fatal and consumed stderr bytes are zeroed", async t => {
  const {child, reservation, transport, finish} = await mockedProcess(t);
  const text = Buffer.from("synthetic stderr text"); child.stderr.emit("data", text);
  assert.ok(text.every(byte => byte === 0));
  child.stderr.emit("data", Buffer.from([0xff])); finish();
  await assert.rejects(drain(transport), /ORDINARY_PROCESS_UNCONFIRMED/u);
  await assert.rejects(reservation.close(0), /ORDINARY_PROCESS_UNCONFIRMED/u);
});

test("an unterminated tail at EOF is refused and cannot certify a drain", async t => {
  const {child, reservation, transport, finish} = await mockedProcess(t);
  child.stdout.emit("data", Buffer.from('{"complete":true}\n{"tail":')); finish();
  await assert.rejects(drain(transport), /unterminated/u);
  await assert.rejects(reservation.close(0), /ORDINARY_PROCESS_UNCONFIRMED/u);
});

test("unread complete messages at close make the drain invalid", async t => {
  const {child, reservation, finish} = await mockedProcess(t);
  child.stdout.emit("data", Buffer.from('{"unread":true}\n')); finish();
  await assert.rejects(reservation.close(0), /ORDINARY_PROCESS_UNCONFIRMED/u);
});

test("a drain without a clean framing EOF is invalid even when both streams closed", async t => {
  const {reservation, finish} = await mockedProcess(t);
  finish();
  await assert.rejects(reservation.close(0), /ORDINARY_PROCESS_UNCONFIRMED/u);
});

test("duplicate decoded keys are refused in the single framing pass and block drain certification", async t => {
  const {child, reservation, transport, finish} = await mockedProcess(t);
  child.stdout.emit("data", Buffer.from('{"a":1,"\\u0061":2}\n')); finish();
  await assert.rejects(drain(transport));
  await assert.rejects(reservation.close(0), /ORDINARY_PROCESS_UNCONFIRMED/u);
});

test("CR is stripped and empty lines are skipped before a clean drain is certified", async t => {
  const {child, reservation, transport, finish} = await mockedProcess(t);
  child.stdout.emit("data", Buffer.from('\r\n{"a":1}\r\n\n\n')); child.stdout.emit("data", Buffer.from('{"b":2}\n')); finish();
  assert.deepEqual(await drain(transport), [{a: 1}, {b: 2}]);
  const receipts = await reservation.close(2);
  assert.ok(Array.isArray(receipts)); assert.equal(receipts[0].finalSequence, 2);
});

test("the channel carries non-confidential launch facts and never the environment", async t => {
  const {transport, finish} = await mockedProcess(t);
  const {launch} = openOrdinaryChannel(transport);
  assert.deepEqual({...launch, deadline: typeof launch.deadline}, {binding, workspaceId: "workspace:synthetic", cwd: "/TEST", homeDirectory: "/TEST", deadline: "number",
    credential: {brokerEndpoint: "http://127.0.0.1:1", materializationId: "material:synthetic", generation: 1}});
  finish();
});

test("a second start before close is refused and never spawns again", async t => {
  const {reservation, controller, observed, finish} = await mockedProcess(t);
  await assert.rejects(reservation.start(claim(reservation.reservationId), controller.signal), /ORDINARY_PROCESS_UNCONFIRMED/u);
  assert.equal(observed.spawns, 1);
  finish();
  await reservation.close(0).catch(() => {});
});

test("after the leader exit is observed, abort, overflow and close never signal the group", async t => {
  const {child, reservation, controller, observed} = await mockedProcess(t);
  child.emit("exit", 0);
  controller.abort();
  child.stdout.emit("data", Buffer.alloc(1_048_577, 32));
  child.stdout.emit("end"); child.stderr.emit("end"); child.emit("close", 0);
  await assert.rejects(reservation.close(0), /ORDINARY_PROCESS_UNCONFIRMED/u);
  assert.deepEqual(observed.signals.filter(signal => signal !== 0), []);
});

test("an oversized write is refused before it reaches the child", {timeout: 5000}, async t => {
  const {transport, finish} = await mockedProcess(t);
  await assert.rejects(openOrdinaryChannel(transport).write(new Uint8Array(262_145)), /ORDINARY_PROCESS_UNCONFIRMED/u);
  finish();
});
