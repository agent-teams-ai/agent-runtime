import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { Duplex } from "node:stream";
import { createDarwinAttemptWorkspaceBackend } from "../../../src/features/contained-agent-turn/adapters/outbound/filesystem/darwin-attempt-workspace-backend.ts";
import { createWorkspaceClosureRecord } from "../../../src/features/contained-agent-turn/adapters/outbound/filesystem/contained-turn-workspace-state.ts";
import {
  decodeDarwinAttemptOwnerRequest, decodeDarwinAttemptOwnerEvent, DarwinAttemptOwnerEventReader,
  type DarwinAttemptOwnerEvent,
} from "../../../src/features/contained-agent-turn/adapters/outbound/host-custody/darwin-attempt-owner-protocol.ts";
import {
  DarwinAttemptOwnerEvents, bindDarwinAttemptOwnerBridge,
} from "../../../src/features/contained-agent-turn/adapters/outbound/host-custody/darwin-attempt-owner-bridge.ts";

const header = readFileSync(new URL("../../../src/features/contained-agent-turn/adapters/outbound/host-custody/native/darwin-attempt-owner-protocol.h", import.meta.url), "utf8");
const number = (name: string): number => {
  const match = new RegExp(`^#define AE_${name} (\\d+)$`, "mu").exec(header);
  assert.ok(match?.[1]);
  return Number(match[1]);
};
const manifest = Buffer.alloc(number("MANIFEST_BYTES"));
manifest.fill(1, number("MANIFEST_BINDINGS_OFFSET"), number("MANIFEST_IMAGES_OFFSET"));
const namespace = Buffer.from(`attempt-${"a".repeat(32)}`);
const launch = createHash("sha256").update(manifest).digest();
const scopes = manifest.subarray(number("MANIFEST_BINDINGS_OFFSET"), number("MANIFEST_IMAGES_OFFSET"));
const binding = createHash("sha256").update(createHash("sha256").update(scopes).digest()).update(namespace).update(Buffer.alloc(1)).digest();
const nativeEvent = (kind: DarwinAttemptOwnerEvent["kind"], serial: number, options: Readonly<{
  sequence?: number; command?: string; phase?: number; flags?: number; child?: boolean;
  image?: number; code?: number; signal?: number; workspace?: number; payload?: Buffer;
}> = {}): Buffer => {
  // Synthetic vectors exercise only framing/state, never native authority.
  const frame = Buffer.alloc(number("EVENT_BYTES"));
  const put = (offset: number, value: number): void => {frame.writeUInt32BE(value, offset);};
  const field = (name: string, value: number): void => put(number(`EVENT_${name}_OFFSET`), value);
  put(0, number("EVENT_MAGIC")); put(4, number("VERSION")); put(8, number(`EVENT_${kind}`)); put(12, options.sequence ?? 0);
  binding.copy(frame, 16); launch.copy(frame, 48);
  field("SERIAL", serial); field("REVISION", serial + 1); field("PHASE", options.phase ?? 2);
  field("WORKSPACE", options.workspace ?? 0); field("RESULT", 1); field("FLAGS", options.flags ?? 0);
  field("EXIT_CODE", options.code ?? 0xffff_ffff); field("EXIT_SIGNAL", options.signal ?? 0);
  field("COMMAND", options.command ? number(options.command) : 0);
  const birth = (offset: number, pid: number, ppid: number, seconds: bigint, image: number): void => {
    put(offset, pid); put(offset + 4, ppid); put(offset + 8, pid); put(offset + 12, image);
    frame.writeBigUInt64BE(seconds, offset + 16); frame.writeBigUInt64BE(123n, offset + 24);
    frame.writeBigUInt64BE(1n, offset + 32); frame.writeBigUInt64BE(BigInt(pid + image), offset + 40);
  };
  birth(number("EVENT_OWNER_OFFSET"), 40, 30, 100n, 0);
  if (options.child) {birth(number("EVENT_CHILD_OFFSET"), 50, 40, 101n, options.image ?? 0);}
  frame.writeBigUInt64BE(1n, number("EVENT_WORKSPACE_DEVICE_OFFSET"));
  frame.writeBigUInt64BE(200n, number("EVENT_WORKSPACE_INODE_OFFSET"));
  if ((options.flags ?? 0) & 1) {frame.fill(3, number("EVENT_ATTESTATION_OFFSET"));}
  const payload = options.payload ?? (kind === "HELLO" ? Buffer.concat([namespace, manifest]) : Buffer.alloc(0));
  field("LENGTH", payload.length);
  return Buffer.concat([frame, payload]);
};
const decoded = (bytes: Buffer): DarwinAttemptOwnerEvent => decodeDarwinAttemptOwnerEvent(
  bytes.subarray(0, number("EVENT_BYTES")), bytes.subarray(number("EVENT_BYTES")));
const hello = () => nativeEvent("HELLO", 1);
const preexec = () => nativeEvent("PREEXEC", 2, { child: true, phase: 4, flags: 1 });
const image = () => nativeEvent("IMAGE", 3, { child: true, phase: 4, image: 2, flags: 17 });
const exit = () => nativeEvent("EXIT", 4, { child: true, phase: 5, image: 2, flags: 19, code: 17 });
const streams = () => nativeEvent("STREAMS", 5, { child: true, phase: 5, image: 2, flags: 23, code: 17 });

test("finite event framing handles every split, coalescing, oversize and lost payload", () => {
  const bytes = Buffer.concat([hello(), preexec(), image(), exit(), streams()]);
  for (let split = 1; split < bytes.length; split++) {
    const reader = new DarwinAttemptOwnerEventReader();
    const events = [...reader.push(bytes.subarray(0, split)), ...reader.push(bytes.subarray(split))];
    assert.deepEqual(events.map((event) => event.kind), ["HELLO", "PREEXEC", "IMAGE", "EXIT", "STREAMS"]);
    reader.end();
    assert.throws(() => reader.push(hello()));
  }
  for (let length = 1; length < hello().length; length++) {
    const reader = new DarwinAttemptOwnerEventReader(); reader.push(hello().subarray(0, length));
    assert.throws(() => reader.end());
  }
  const oversized = hello(); oversized.writeUInt32BE(0xffff_ffff, number("EVENT_LENGTH_OFFSET"));
  const reader = new DarwinAttemptOwnerEventReader();
  assert.throws(() => reader.push(oversized)); assert.throws(() => reader.push(hello()));
  const surplus = nativeEvent("STATUS", 2, { payload: Buffer.from("extra") });
  assert.throws(() => decoded(surplus));
});

test("physical observations need the same child birth, native wait and stream EOF but no artifact barrier", () => {
  const events = new DarwinAttemptOwnerEvents();
  for (const bytes of [hello(), preexec(), image(), exit()]) {events.accept(decoded(bytes));}
  assert.equal(events.execution(), undefined);
  events.accept(decoded(streams()));
  assert.equal(events.execution()?.exit.exitCode, 17);
  assert.equal(events.execution()?.exit.exitSignal, 0);
  assert.equal(events.execution()?.streams.workspace, 0);
  assert.equal(events.binding().workspaceIno, "200");
  assert.equal(events.retainedClosed(), undefined);
  events.lost(); assert.equal(events.execution(), undefined);
  assert.throws(() => events.binding());
});

test("replayed, foreign, early stream, missing preexec and changed birth events poison observations", () => {
  for (const mutate of [
    (bytes: Buffer) => bytes.writeUInt32BE(1, number("EVENT_SERIAL_OFFSET")),
    (bytes: Buffer) => {bytes[16] = 5;},
    (bytes: Buffer) => bytes.writeBigUInt64BE(999n, number("EVENT_WORKSPACE_INODE_OFFSET")),
    (bytes: Buffer) => bytes.writeUInt32BE(9, number("EVENT_PHASE_OFFSET")),
  ]) {
    const state = new DarwinAttemptOwnerEvents(); state.accept(decoded(hello()));
    const bytes = preexec(); mutate(bytes);
    assert.throws(() => state.accept(decoded(bytes))); assert.equal(state.execution(), undefined);
    assert.throws(() => state.accept(decoded(preexec())));
  }
  const early = new DarwinAttemptOwnerEvents(); early.accept(decoded(hello()));
  assert.throws(() => early.accept(decoded(nativeEvent("STREAMS", 2, { phase: 5, flags: 6 }))));
  const missing = new DarwinAttemptOwnerEvents(); missing.accept(decoded(hello()));
  assert.throws(() => missing.accept(decoded(nativeEvent("IMAGE", 2, { phase: 4, flags: 17, child: true, image: 2 }))));
  const changed = new DarwinAttemptOwnerEvents(); changed.accept(decoded(hello())); changed.accept(decoded(preexec()));
  const bytes = image(); bytes.writeBigUInt64BE(102n, number("EVENT_CHILD_OFFSET") + 16);
  assert.throws(() => changed.accept(decoded(bytes)));
});

test("retained callbacks are invoked by the bridge; foreign settlement is never transmitted", async () => {
  const commands: string[] = [];
  let serial = 1;
  const endpoint = new Duplex({
    read() {},
    write(chunk: Buffer, _encoding, callback) {
      const request = decodeDarwinAttemptOwnerRequest(chunk); commands.push(request.command);
      this.push(nativeEvent("STATUS", ++serial, { sequence: request.sequence, command: request.command }));
      callback();
    },
  });
  let calls = 0;
  const completion = async () => {
    calls++;
    return { binding: binding.toString("hex"), launch: launch.toString("hex"), namespace: `attempt-${"a".repeat(32)}`, workspaceDev: "1", workspaceIno: "200" };
  };
  const bridge = bindDarwinAttemptOwnerBridge(endpoint, {
    launchRoute: completion, artifactResult: completion, workspace: completion,
    privateMaterial: async () => ({ ...await completion(), workspaceIno: "201" }), output: async () => {},
  });
  endpoint.push(hello()); await bridge.ready;
  await bridge.settleLaunchRoute();
  assert.equal(calls, 1); assert.deepEqual(commands, ["SETTLE_LAUNCH_ROUTE"]);
  await assert.rejects(bridge.settlePrivateMaterial(), /foreign/u);
  assert.equal(calls, 2); assert.deepEqual(commands, ["SETTLE_LAUNCH_ROUTE"]);
  assert.equal(bridge.execution(), undefined);
});


test("native workspace backend preserves original record identity and passes fixed bytes to the existing owners", async () => {
  let serial = 2;
  let workspace = 0;
  const commands: string[] = [];
  const endpoint = new Duplex({
    read() {},
    write(chunk: Buffer, _encoding, callback) {
      const request = decodeDarwinAttemptOwnerRequest(chunk); commands.push(request.command);
      if (request.command === "WORKSPACE_FREEZE") {workspace = 1;}
      if (request.command === "WORKSPACE_CLEANUP") {workspace = 2;}
      if (request.command === "WORKSPACE_CLOSE") {workspace = 3;}
      const artifact = request.command === "READ_ARTIFACT_SLOT";
      const reply = nativeEvent(artifact ? "ARTIFACT" : "STATUS", ++serial, {
        sequence: request.sequence, command: request.command, phase: 6, flags: 12, workspace,
        payload: artifact ? Buffer.from(`slot-${request.argument}`) : Buffer.alloc(0),
      });
      if (artifact) {
        reply.writeUInt32BE(request.argument, number("EVENT_SLOT_OFFSET"));
        reply.writeUInt32BE(0o600, number("EVENT_MODE_OFFSET"));
        reply.writeBigUInt64BE(1n, number("EVENT_DEVICE_OFFSET"));
        reply.writeBigUInt64BE(BigInt(300 + request.argument), number("EVENT_INODE_OFFSET"));
      }
      this.push(reply); callback();
    },
  });
  const complete = async () => ({ binding: binding.toString("hex"), launch: launch.toString("hex"),
    namespace: namespace.toString(), workspaceDev: "1", workspaceIno: "200" });
  const bridge = bindDarwinAttemptOwnerBridge(endpoint, { launchRoute: complete, artifactResult: complete,
    workspace: complete, privateMaterial: complete, output: async () => {} });
  endpoint.push(hello()); await bridge.ready;
  endpoint.push(nativeEvent("STREAMS", 2, { phase: 6, flags: 12 }));
  const creation = { schemaVersion: 1, operationId: "operation", workspaceName: `operation-${"a".repeat(64)}`,
    materializationDigest: "c".repeat(64), rootIdentity: { dev: "1", ino: "200" }, scope: { projectId: "p", tenantId: "t" } } as const;
  const sealed = { schemaVersion: 2, operationId: creation.operationId, workspaceName: creation.workspaceName,
    rootIdentity: creation.rootIdentity, scope: creation.scope, manifestDigest: "d".repeat(64), treeDigest: "e".repeat(64) } as const;
  const closed = createWorkspaceClosureRecord(sealed.workspaceName, sealed);
  let readbacks = 0;
  const readClosed = async () => {
    readbacks++;
    return { ...await complete(), dev: "1", ino: "200", record: Buffer.alloc(0) };
  };
  const backend = createDarwinAttemptWorkspaceBackend(bridge, { creation: async () => creation,
    seal: async () => sealed, closure: async () => closed, readClosed });
  const slots = await backend.freeze();
  assert.deepEqual(slots.map((slot) => [slot.slot, slot.mode, slot.payload.toString()]), [[0, 0o600, "slot-0"], [1, 0o600, "slot-1"]]);
  assert.ok(slots.every((slot) => slot.workspaceIno === creation.rootIdentity.ino));
  await backend.cleanup(); await backend.close(); await backend.acknowledgeClosure();
  assert.deepEqual(commands, ["WORKSPACE_FREEZE", "READ_ARTIFACT_SLOT", "READ_ARTIFACT_SLOT", "SETTLE_ARTIFACT_RESULT",
    "WORKSPACE_CLEANUP", "WORKSPACE_CLOSE", "SETTLE_WORKSPACE"]);
  await assert.rejects(backend.readClosed(), /no successfully closed/u);
  assert.equal(readbacks, 0); // Neither disk state nor helper exit creates a replay capability.
  const foreign = createDarwinAttemptWorkspaceBackend(bridge, { creation: async () => ({ ...creation, rootIdentity: { dev: "1", ino: "201" } }),
    seal: async () => sealed, closure: async () => closed, readClosed });
  const before = commands.length;
  await assert.rejects(foreign.freeze(), /original creation inode/u);
  assert.equal(commands.length, before);
  bridge.lost();
});


test("closed replay requires the exact successful release ticket and rejects torn or mismatched records", () => {
  const ticket = Buffer.alloc(number("CLOSED_RECORD_BYTES"));
  ticket.write("ae-owner-intent-v1"); binding.copy(ticket, number("RECORD_BINDING_OFFSET")); launch.copy(ticket, number("RECORD_LAUNCH_OFFSET"));
  const put = (name: string, value: number): void => {ticket.writeUInt32BE(value, number(`RECORD_${name}_OFFSET`));};
  put("PHASE", 8); put("WORKSPACE", 3); put("SETTLEMENTS", 15); put("STREAMS", 1); put("REAPED", 1);
  put("PREEXEC", 1); put("EXIT_CODE", 17); put("REVISION", 11); put("BIRTH_ATTEMPTED", 1);
  ticket.writeBigUInt64BE(1n, number("RECORD_WORKSPACE_DEVICE_OFFSET"));
  ticket.writeBigUInt64BE(200n, number("RECORD_WORKSPACE_INODE_OFFSET"));
  const hash = (): void => {createHash("sha256").update(ticket.subarray(0, number("RECORD_HASH_OFFSET"))).digest().copy(ticket, number("RECORD_HASH_OFFSET"));};
  hash();
  const release = () => nativeEvent("RELEASED", 10, { phase: 8, workspace: 3, flags: 23, code: 17, child: true, image: 2, payload: ticket });
  const events = new DarwinAttemptOwnerEvents();
  for (const bytes of [hello(), preexec(), image(), exit(), streams()]) {events.accept(decoded(bytes));}
  for (let workspace = 1; workspace <= 3; workspace++) {
    events.accept(decoded(nativeEvent("STATUS", workspace + 5, { phase: 5, workspace, flags: 23, code: 17, child: true, image: 2 })));
  }
  events.accept(decoded(nativeEvent("STATUS", 9, { phase: 7, workspace: 3, flags: 23, code: 17, child: true, image: 2 })));
  events.accept(decoded(release()));
  const retained = events.retainedClosed(); assert.ok(retained);
  assert.ok(retained.payload.equals(ticket));
  retained.payload.fill(0); assert.ok(events.retainedClosed()?.payload.equals(ticket));
  ticket[100] = 1; assert.throws(() => decoded(release()), /torn/u);
  ticket[100] = 0; put("PENDING", number("DISPOSE_ONCE")); hash();
  assert.throws(() => decoded(release()), /unresolved/u);
  put("PENDING", 0); ticket.writeBigUInt64BE(201n, number("RECORD_WORKSPACE_INODE_OFFSET")); hash();
  assert.throws(() => decoded(release()), /retained owner/u);
});

test("Host cutoff latches before a waiting START and never queues a later launch", async () => {
  const commands: string[] = [];
  const endpoint = new Duplex({ read() {}, write(chunk: Buffer, _encoding, callback) {
    const request = decodeDarwinAttemptOwnerRequest(chunk); commands.push(request.command);
    this.push(nativeEvent("STATUS", 2, { sequence: request.sequence, command: request.command, phase: 6, flags: 8 })); callback();
  } });
  const completion = async () => ({ binding: binding.toString("hex"), launch: launch.toString("hex"),
    namespace: namespace.toString(), workspaceDev: "1", workspaceIno: "200" });
  const bridge = bindDarwinAttemptOwnerBridge(endpoint, { launchRoute: completion, artifactResult: completion,
    workspace: completion, privateMaterial: completion, output: async () => {} });
  const starting = bridge.start(); const cutting = bridge.cutoff();
  endpoint.push(hello());
  await assert.rejects(starting, /cut off/u); await cutting;
  await assert.rejects(bridge.start(), /cut off/u);
  assert.deepEqual(commands, ["CUTOFF"]);
  bridge.lost();
});
