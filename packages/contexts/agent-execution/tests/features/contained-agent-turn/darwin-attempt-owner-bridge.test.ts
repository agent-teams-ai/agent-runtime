import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { Duplex } from "node:stream";
import type { DarwinNativeWorkspaceSelection, DarwinNativeRetainedWorkspaceOwners } from "../../../src/features/contained-agent-turn/adapters/outbound/filesystem/darwin-attempt-workspace-backend.ts";
import {
  decodeDarwinAttemptOwnerRequest, decodeDarwinAttemptOwnerEvent, DarwinAttemptOwnerEventReader,
  type DarwinAttemptOwnerEvent, type DarwinNativeFinalLaunchData,
} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/darwin-attempt-owner-protocol.js";
import {
  DarwinAttemptOwnerEvents, bindDarwinAttemptOwnerBridge,
} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/darwin-attempt-owner-bridge.js";

type Bridge = ReturnType<typeof bindDarwinAttemptOwnerBridge>;
const bindSyntheticOwners = (bridge: Bridge): void => {
  bridge.bindRetainedOwners(completion => Object.freeze({
    launchRoute: async () => completion, artifactResult: async () => completion,
    workspace: async () => completion, privateMaterial: async () => completion,
    output: async () => completion,
  }));
};
const readyBridge = async (bridge: Bridge): Promise<void> => {await bridge.ready; bindSyntheticOwners(bridge);};

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
  const payload = options.payload ?? (kind === "HELLO" ? Buffer.concat([namespace, manifest, Buffer.alloc(32, 7)]) : Buffer.alloc(0));
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

test("direct-child and stream observations preserve birth and wait without claiming writer exclusion", () => {
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

test("retained factory is never invoked before HELLO and failed admission is burned", async () => {
  const endpoint = new Duplex({read() {}, write(_chunk, _encoding, callback) {callback();}});
  const bridge = bindDarwinAttemptOwnerBridge(endpoint);
  let calls = 0;
  const factory = () => {calls++; throw new Error("unexpected factory execution");};
  assert.throws(() => bridge.bindRetainedOwners(factory), /requires authenticated HELLO/u);
  assert.throws(() => bridge.bindRetainedOwners(factory), /already consumed/u);
  await assert.rejects(bridge.ready, /requires authenticated HELLO/u);
  assert.equal(calls, 0);
  assert.equal(endpoint.destroyed, true);
});

test("retained settlement burns before callback execution and callback rejection closes the bridge", async () => {
  const endpoint = new Duplex({read() {}, write(_chunk, _encoding, callback) {callback();}});
  const bridge = bindDarwinAttemptOwnerBridge(endpoint);
  endpoint.push(hello()); await bridge.ready;
  let calls = 0;
  let reject!: (error: Error) => void;
  bridge.bindRetainedOwners(completion => ({
    launchRoute: () => {calls++; return new Promise((_resolve, _reject) => {reject = _reject;});},
    artifactResult: async () => {calls++; return completion;},
    workspace: async () => completion, privateMaterial: async () => completion,
    output: async () => completion,
  }));
  const first = bridge.settleLaunchRoute();
  await assert.rejects(bridge.settleLaunchRoute(), /already consumed/u);
  assert.equal(calls, 1);
  reject(new Error("owner action failed"));
  await assert.rejects(first, /owner action failed/u);
  await assert.rejects(bridge.settleArtifactResult(), /owner action failed/u);
  assert.equal(calls, 1);
  assert.equal(endpoint.destroyed, true);
});

test("retained factory callbacks settle with only the issued capability and reject a copied completion", async () => {
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
  const bridge = bindDarwinAttemptOwnerBridge(endpoint);
  endpoint.push(hello()); await bridge.ready;
  let factoryCalls = 0;
  bridge.bindRetainedOwners(completion => {
    factoryCalls++;
    const genuine = async () => {calls++; return completion;};
    return {launchRoute: genuine, artifactResult: genuine, workspace: genuine,
      privateMaterial: async () => {calls++; return {...completion};}, output: async () => completion};
  });
  await bridge.settleLaunchRoute();
  await bridge.settleArtifactResult(); await bridge.settleWorkspace();
  assert.equal(factoryCalls, 1); assert.equal(calls, 3);
  assert.deepEqual(commands, ["SETTLE_LAUNCH_ROUTE", "SETTLE_ARTIFACT_RESULT", "SETTLE_WORKSPACE"]);
  await assert.rejects(bridge.settlePrivateMaterial(), /issued capability/u);
  assert.equal(calls, 4);
  assert.deepEqual(commands, ["SETTLE_LAUNCH_ROUTE", "SETTLE_ARTIFACT_RESULT", "SETTLE_WORKSPACE"]);
  assert.equal(bridge.execution(), undefined);
});


test("native workspace selection rejects clones before reading caller callbacks", async () => {
  const {selectDarwinAttemptWorkspaceBackend} = await import("../../../dist/features/contained-agent-turn/adapters/outbound/filesystem/darwin-attempt-workspace-backend.js");
  let reads = 0;
  const records = { get creation() { reads++; throw new Error("must not read"); } } as unknown as DarwinNativeRetainedWorkspaceOwners;
  for (const selection of [{}, Object.create(null), Object.freeze({ native: true })]) {
    assert.throws(() => selectDarwinAttemptWorkspaceBackend(selection as DarwinNativeWorkspaceSelection, records), /foreign/u);
  }
  assert.equal(reads, 0);
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
  // Every transaction gets a new sequence and unchanged actual release record.
  // The durable journal sequence is not rewritten for a read-only replay.
  for (let transaction = 1; transaction <= 3; transaction++) {
    const sequence = retained.sequence + transaction;
    events.accept(decoded(nativeEvent("CLOSED_READ", 10 + transaction, {
      sequence, command: "READ_CLOSED_WORKSPACE", phase: 8, workspace: 3,
      flags: 23, code: 17, child: true, image: 2, payload: ticket,
    })));
    assert.ok(events.retainedClosed()?.payload.equals(ticket));
  }
  assert.throws(() => events.accept(decoded(nativeEvent("CLOSED_READ", 14, {
    sequence: retained.sequence + 3, command: "READ_CLOSED_WORKSPACE", phase: 8,
    workspace: 3, flags: 23, code: 17, child: true, image: 2, payload: ticket,
  }))), /fresh bounded closed read/u);
  assert.equal(events.retainedClosed(), undefined);
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
  const bridge = bindDarwinAttemptOwnerBridge(endpoint);
  const starting = bridge.start(); const cutting = bridge.cutoff();
  endpoint.push(hello()); await readyBridge(bridge);
  await assert.rejects(starting, /cut off/u); await cutting;
  await assert.rejects(bridge.start(), /cut off/u);
  assert.deepEqual(commands, ["CUTOFF"]);
  bridge.lost();
});

test("bridge materializes and verifies a complete destination tree through bounded native frames", async () => {
  const commands: string[] = [];
  const inventory: Buffer[] = [];
  const contents = new Map<number, Buffer[]>();
  let serial = 1;
  let phase = 2, flags = 0, workspace = 0;
  let ticket = Buffer.alloc(0);
  const endpoint = new Duplex({
    read() {},
    write(chunk: Buffer, _encoding, callback) {
      try {
        const request = decodeDarwinAttemptOwnerRequest(chunk.subarray(0, number("FRAME_BYTES")));
        const payload = chunk.subarray(number("FRAME_BYTES"));
        commands.push(request.command);
        assert.equal(payload.length, request.argument);
        if (request.command === "MATERIALIZE_ENTRY") {inventory.push(Buffer.from(payload));}
        if (request.command === "MATERIALIZE_CHUNK") {
          const ordinal = payload.readUInt32BE(0), chunks = contents.get(ordinal) ?? [];
          assert.equal(payload.readUInt32BE(4), chunks.reduce((sum, bytes) => sum + bytes.length, 0));
          chunks.push(Buffer.from(payload.subarray(8))); contents.set(ordinal, chunks);
        }
        if (request.command === "READ_TREE" || request.command === "READ_CLOSED_WORKSPACE" || request.command === "QUERY_CLOSED_WORKSPACE") {
          for (const entry of inventory) {
            const ordinal = entry.readUInt32BE(0);
            const event = nativeEvent("TREE_ENTRY", ++serial, { sequence: request.sequence, phase, flags, workspace, payload: entry });
            event.writeBigUInt64BE(1n, number("EVENT_DEVICE_OFFSET"));
            event.writeBigUInt64BE(BigInt(300 + ordinal), number("EVENT_INODE_OFFSET"));
            this.push(event);
            let offset = 0;
            for (const bytes of contents.get(ordinal) ?? []) {
              const data = Buffer.alloc(8 + bytes.length); data.writeUInt32BE(ordinal, 0); data.writeUInt32BE(offset, 4); bytes.copy(data, 8);
              this.push(nativeEvent("TREE_CHUNK", ++serial, { sequence: request.sequence, phase, flags, workspace, payload: data })); offset += bytes.length;
            }
          }
          const end = Buffer.alloc(24); end.writeUInt32BE(0o40700, 0); end.writeBigUInt64BE(10n, 8); end.writeBigUInt64BE(11n, 16);
          this.push(nativeEvent("TREE_END", ++serial, { sequence: request.sequence, phase, flags, workspace, payload: end }));
        }
        this.push(nativeEvent(request.command === "READ_CLOSED_WORKSPACE" ? "CLOSED_READ" : "STATUS", ++serial, { sequence: request.sequence, command: request.command, phase, flags, workspace, payload: request.command === "READ_CLOSED_WORKSPACE" ? ticket : Buffer.alloc(0) })); callback();
      } catch (error) {callback(error as Error);}
    },
  });
  const bridge = bindDarwinAttemptOwnerBridge(endpoint);
  endpoint.push(hello()); await readyBridge(bridge);
  const bytes = Buffer.alloc(20000, 42), digest = createHash("sha256").update(bytes).digest("hex");
  const entries = [{ kind: "directory" as const, relativePath: "empty", mode: 0o700 },
    { kind: "file" as const, relativePath: "file", mode: 0o640, size: bytes.length, digest }];
  const treeDigest = createHash("sha256").update(JSON.stringify([["directory", "empty", 0o700], ["file", "file", 0o640, bytes.length, digest]])).digest("hex");
  const source = { entries, files: [{ ...entries[1]!, relativePath: "file", mode: 0o640, size: bytes.length, digest, bytes }], treeDigest,
    rootIdentity: { dev: 2n, ino: 12n, mode: 0o40700n, ctimeNs: 0n, mtimeNs: 0n } };
  const destination = await bridge.materializeComplete(source, { maxDepth: 32, maxEntries: 4096, maxFileBytes: 8388608, maxTotalBytes: 33554432 });
  assert.equal(destination.treeDigest, treeDigest); assert.equal(destination.entries.length, 2);
  assert.equal(destination.rootIdentity.ino, 200n); assert.equal(destination.rootIdentity.ctimeNs, 10n);
  assert.deepEqual(destination.files[0]!.bytes, bytes);
  assert.deepEqual(commands, ["MATERIALIZE_BEGIN", "MATERIALIZE_ENTRY", "MATERIALIZE_ENTRY", "MATERIALIZE_CHUNK", "MATERIALIZE_CHUNK", "MATERIALIZE_FINISH", "READ_TREE"]);
  const before = commands.length;
  await assert.rejects(bridge.materializeComplete(source, { maxDepth: 32, maxEntries: 4096, maxFileBytes: 8388608, maxTotalBytes: 33554432 }), /already consumed/u);
  assert.equal(commands.length, before);
  phase = 6; flags = 8; await bridge.cutoff();
  let sequence = commands.length;
  flags = 12; endpoint.push(nativeEvent("STREAMS", ++serial, { sequence, phase, flags }));
  for (workspace = 1; workspace <= 3; workspace++) {
    endpoint.push(nativeEvent("STATUS", ++serial, { sequence, phase, flags, workspace }));
  }
  workspace = 3;
  const queried = await bridge.queryClosedWorkspace();
  sequence = commands.length;
  assert.equal(queried.treeDigest, treeDigest);
  assert.equal(bridge.retainedClosed(), undefined);
  await assert.rejects(bridge.readClosedWorkspace(), /grant unavailable/u);
  phase = 7;
  endpoint.push(nativeEvent("STATUS", ++serial, { sequence, phase, flags, workspace }));
  phase = 8; ticket = Buffer.alloc(number("CLOSED_RECORD_BYTES")); ticket.write("ae-owner-intent-v1");
  binding.copy(ticket, number("RECORD_BINDING_OFFSET")); launch.copy(ticket, number("RECORD_LAUNCH_OFFSET"));
  const put = (name: string, field: number): void => {ticket.writeUInt32BE(field, number(`RECORD_${name}_OFFSET`));};
  put("PHASE", 8); put("WORKSPACE", 3); put("SEQUENCE", sequence); put("SETTLEMENTS", 15);
  put("CUTOFF", 1); put("STREAMS", 1); put("EXIT_CODE", 0xffff_ffff); put("REVISION", serial + 2);
  ticket.writeBigUInt64BE(1n, number("RECORD_WORKSPACE_DEVICE_OFFSET")); ticket.writeBigUInt64BE(200n, number("RECORD_WORKSPACE_INODE_OFFSET"));
  createHash("sha256").update(ticket.subarray(0, number("RECORD_HASH_OFFSET"))).digest().copy(ticket, number("RECORD_HASH_OFFSET"));
  endpoint.push(nativeEvent("RELEASED", ++serial, { sequence, phase, flags, workspace, payload: ticket }));
  // Yield only to the synthetic stream reader, not to an external process.
  await new Promise<void>(resolve => {setImmediate(resolve); });
  const observedClosed = await bridge.readClosedWorkspace();
  assert.equal(commands.at(-1), "READ_CLOSED_WORKSPACE");
  assert.equal(observedClosed.tree.treeDigest, treeDigest);
  assert.ok(observedClosed.event.payload.equals(ticket));
  assert.deepEqual(observedClosed.tree.files[0]!.bytes, bytes);
  const beforeReplay = commands.length;
  const replayed = await bridge.readClosedWorkspace();
  assert.equal(commands.length, beforeReplay + 1);
  assert.equal(replayed.tree.treeDigest, treeDigest);
  assert.ok(replayed.event.sequence > observedClosed.event.sequence);
  assert.ok(replayed.event.payload.equals(ticket));
  endpoint.push(null);
  await new Promise<void>(resolve => {setImmediate(resolve);});
  assert.equal(bridge.retainedClosed(), undefined);
  await assert.rejects(bridge.readClosedWorkspace(), /grant unavailable/u);
});

test("START preserves retained directory epoch while cutoff invalidates it", async () => {
  let serial = 1;
  const endpoint = new Duplex({read() {}, write(chunk: Buffer, _encoding, callback) {
    const request = decodeDarwinAttemptOwnerRequest(chunk);
    this.push(nativeEvent("STATUS", ++serial, {sequence: request.sequence, command: request.command,
      phase: 3, flags: request.command === "CUTOFF" ? 8 : 0})); callback();
  }});
  const bridge = bindDarwinAttemptOwnerBridge(endpoint);
  try {
    endpoint.push(hello()); await readyBridge(bridge);
    bridge.assertObservationCurrent(0);
    await bridge.start();
    bridge.assertObservationCurrent(0);
    const cutting = bridge.cutoff();
    assert.throws(() => bridge.assertObservationCurrent(0), /no longer current/u);
    await cutting;
    assert.equal(bridge.execution(), undefined);
  } finally {bridge.lost();}
});

test("observation and material completion retain the epoch accepted with their native response", async () => {
  const config = Buffer.from("model = \"gpt-5\"\n");
  const catalog = readFileSync(new URL("../../fixtures/codex-native-broker-0.153.4/models.json", import.meta.url));
  const installationId = "01234567-89ab-4cde-8012-3456789abcde";
  const payload = (material: boolean, revision: number): Buffer => {
    const bytes = Buffer.alloc(material ? 8520 : 5244);
    const text = (offset: number, value: string): void => {bytes.writeUInt32BE(Buffer.byteLength(value), offset); bytes.write(value, offset + 4);};
    text(0, "operation"); bytes.writeUInt32BE(70001, 1028); bytes.writeUInt32BE(revision, 1032);
    const fact = (offset: number, path: string, ino: bigint, mode: number): void => {
      text(offset, path); bytes.writeBigUInt64BE(1n, offset + 1028); bytes.writeBigUInt64BE(ino, offset + 1036);
      bytes.writeUInt32BE(70001, offset + 1044); bytes.writeUInt32BE(mode, offset + 1048);
    };
    ["/root/private", "/root/private/codex-home", "/root/private/tmp", "/root/workspace"].forEach((path, index) =>
      fact(1036 + index * 1052, path, index === 3 ? 200n : BigInt(index + 2), 0o700));
    if (material) {
      [config, catalog, Buffer.from(installationId)].forEach((content, index) => {
        const offset = 5244 + index * 1092;
        fact(offset, `/root/private/codex-home/${["config.toml", "models.json", "installation_id"][index]}`, BigInt(index + 300), index === 2 ? 0o644 : 0o600);
        bytes.writeUInt32BE(1, offset + 1052); bytes.writeUInt32BE(content.length, offset + 1056);
        createHash("sha256").update(content).digest().copy(bytes, offset + 1060);
      });
    }
    return bytes;
  };
  for (const material of [false, true]) {
    let serial = 1;
    let bridge!: ReturnType<typeof bindDarwinAttemptOwnerBridge>;
    const endpoint = new Duplex({read() {}, write(chunk: Buffer, _encoding, callback) {
      const request = decodeDarwinAttemptOwnerRequest(chunk.subarray(0, number("FRAME_BYTES")));
      if (request.command === "READ_OBSERVATION" || request.command === "MATERIAL_FINISH") {
        const revision = serial + 2;
        this.push(nativeEvent(material ? "MATERIAL_RESULT" : "OBSERVATION", ++serial,
          {sequence: request.sequence, command: request.command, payload: payload(material, revision)}));
      } else {
        this.push(nativeEvent("STATUS", ++serial, {sequence: request.sequence, command: request.command}));
      }
      callback();
    }});
    bridge = bindDarwinAttemptOwnerBridge(endpoint);
    const original = Buffer.prototype.readUInt32BE;
    let advanced = false;
    try {
      endpoint.push(hello()); await readyBridge(bridge);
      Buffer.prototype.readUInt32BE = function(offset = 0): number {
        if (!advanced && offset === 0 && this.length === (material ? 8520 : 5244)) {
          advanced = true; bridge.revokeAdmission();
        }
        return original.call(this, offset);
      };
      const result = material
        ? await bridge.installCodexMaterial({config, catalog, installationId})
        : await bridge.readLaunchObservation();
      assert.equal(advanced, true);
      assert.equal(result.generation, 0);
      assert.throws(() => bridge.assertObservationCurrent(result.generation), /no longer current/u);
    } finally {Buffer.prototype.readUInt32BE = original; bridge.lost();}
  }
});


test("final native capture snapshots finite data once and burns refused or uncertain admission", async () => {
  for (const refuse of [false, true]) {
    let transmitted: Buffer | undefined;
    const endpoint = new Duplex({read() {}, write(chunk: Buffer, _encoding, callback) {
      const request = decodeDarwinAttemptOwnerRequest(chunk.subarray(0, number("FRAME_BYTES")));
      assert.equal(request.command, "BIND_FINAL_LAUNCH");
      transmitted = Buffer.from(chunk.subarray(number("FRAME_BYTES")));
      const response = nativeEvent(refuse ? "REFUSED" : "STATUS", 2, {sequence: request.sequence, command: request.command});
      if (refuse) {response.writeUInt32BE(0, number("EVENT_RESULT_OFFSET"));}
      this.push(response); callback();
    }});
    const bridge = bindDarwinAttemptOwnerBridge(endpoint);
    try {
      endpoint.push(hello()); await readyBridge(bridge);
      const hash = "a".repeat(64);
      const input: DarwinNativeFinalLaunchData = {home: "/private/owner/private", codexHome: "/private/owner/private/codex-home",
        tmpDir: "/private/owner/private/tmp", localCapability: hash, port: 32123,
        preparedSha256: hash, profileSha256: hash, configSha256: hash, catalogSha256: hash,
        installationSha256: hash, fingerprintSha256: hash, materialSha256: hash, executableSha256: hash, argumentsSha256: hash};
      const capturing = bridge.captureFinalLaunch(input);
      Object.assign(input, {localCapability: "b".repeat(64), port: 43210});
      if (refuse) {await assert.rejects(capturing, /refused/u);} else {await capturing;}
      assert.ok(transmitted); assert.equal(transmitted.length, number("FINAL_LAUNCH_BYTES"));
      assert.equal(transmitted.readUInt32BE(4), 32123);
      assert.equal(transmitted.subarray(8 + 3 * 1028 + 4, 8 + 3 * 1028 + 68).toString(), hash);
      await assert.rejects(bridge.captureFinalLaunch(input), /already consumed/u);
      if (refuse) {await assert.rejects(bridge.start(), /refused/u);}
    } finally {bridge.lost();}
  }
});

test("native session input snapshots bounded writes, orders EOF and rejects post-cutoff input", async () => {
  let serial = 1;
  const observed: Array<{command: string; bytes: Buffer}> = [];
  const endpoint = new Duplex({read() {}, write(chunk: Buffer, _encoding, callback) {
    const request = decodeDarwinAttemptOwnerRequest(chunk.subarray(0, number("FRAME_BYTES")));
    observed.push({command: request.command, bytes: Buffer.from(chunk.subarray(number("FRAME_BYTES")))});
    setImmediate(() => {
      this.push(nativeEvent("STATUS", ++serial, {sequence: request.sequence, command: request.command,
        phase: 3, flags: request.command === "CUTOFF" ? 8 : 0})); callback();
    });
  }});
  const bridge = bindDarwinAttemptOwnerBridge(endpoint);
  try {
    endpoint.push(hello()); await readyBridge(bridge);
    await assert.rejects(bridge.writeInput(Buffer.from("early")), /closed/u);
    await bridge.start();
    const bytes = Buffer.alloc(20000, 42);
    const write = bridge.writeInput(bytes); bytes.fill(0);
    const second = bridge.writeInput(Buffer.from("last"));
    const closing = bridge.closeInput();
    await assert.rejects(bridge.writeInput(Buffer.from("late")), /closed/u);
    await Promise.all([write, second, closing]);
    assert.deepEqual(observed.map(x => x.command), ["START_ONCE", "WRITE_INPUT", "WRITE_INPUT", "WRITE_INPUT", "CLOSE_INPUT"]);
    assert.deepEqual(observed.slice(1, 4).map(x => x.bytes.length), [16384, 3616, 4]);
    assert.ok(observed[1]!.bytes.every(byte => byte === 42));
    assert.ok(observed[2]!.bytes.every(byte => byte === 42));
    assert.equal(observed[3]!.bytes.toString(), "last");
    await bridge.cutoff();
    await assert.rejects(bridge.writeInput(Buffer.from("cutoff")), /closed/u);
  } finally {bridge.lost();}
});

function processBridge() {
  let serial = 1, sequence = 0;
  const observed: string[] = [];
  const endpoint = new Duplex({read() {}, write(chunk: Buffer, _encoding, callback) {
    const request = decodeDarwinAttemptOwnerRequest(chunk.subarray(0, number("FRAME_BYTES")));
    sequence = request.sequence; observed.push(request.command);
    if (request.command === "READ_OBSERVATION") {
      const bytes = Buffer.alloc(5244);
      const text = (offset: number, value: string): void => {bytes.writeUInt32BE(Buffer.byteLength(value), offset); bytes.write(value, offset + 4);};
      text(0, "operation"); bytes.writeUInt32BE(70001, 1028); bytes.writeUInt32BE(serial + 2, 1032);
      ["/root/private", "/root/private/codex-home", "/root/private/tmp", "/root/workspace"].forEach((path, index) => {
        const offset = 1036 + index * 1052;
        text(offset, path); bytes.writeBigUInt64BE(1n, offset + 1028);
        bytes.writeBigUInt64BE(index === 3 ? 200n : BigInt(index + 2), offset + 1036);
        bytes.writeUInt32BE(70001, offset + 1044); bytes.writeUInt32BE(0o700, offset + 1048);
      });
      this.push(nativeEvent("OBSERVATION", ++serial, {sequence, command: request.command, payload: bytes}));
    } else {
      this.push(nativeEvent("STATUS", ++serial, {sequence, command: request.command, phase: 4, child: true,
        flags: request.command === "START_ONCE" ? 0 : 17, image: request.command === "START_ONCE" ? 0 : 2}));
    }
    callback();
  }});
  const bridge = bindDarwinAttemptOwnerBridge(endpoint);
  const emit = (kind: DarwinAttemptOwnerEvent["kind"], options: Parameters<typeof nativeEvent>[2] = {}): void => {
    endpoint.push(nativeEvent(kind, ++serial, {sequence, phase: 4, child: true, flags: 17, image: 2, ...options}));
  };
  endpoint.push(hello());
  return {bridge, observed, emit};
}

const finalLaunchInput = (): DarwinNativeFinalLaunchData => {
  const digest = "a".repeat(64);
  return {home: "/root/private", codexHome: "/root/private/codex-home", tmpDir: "/root/private/tmp",
    localCapability: digest, port: 32123, preparedSha256: digest, profileSha256: digest,
    configSha256: digest, catalogSha256: digest, installationSha256: digest,
    fingerprintSha256: digest, materialSha256: digest, executableSha256: digest, argumentsSha256: digest};
};

test("final native transport binds once before the sole start and carries IO through EXIT and STREAMS", async () => {
  const {bridge, observed, emit} = processBridge();
  try {
    await readyBridge(bridge);
    await bridge.readLaunchObservation();
    const launchInput = finalLaunchInput();
    await bridge.captureFinalLaunch(launchInput);
    await assert.rejects(bridge.captureFinalLaunch({...launchInput}), /already consumed/u);
    const starting = bridge.startProcess();
    await new Promise(resolve => {setImmediate(resolve);});
    emit("PREEXEC", {flags: 1, image: 0}); emit("IMAGE");
    const process = await starting;
    await assert.rejects(bridge.startProcess(), /already consumed/u);
    await process.write(Buffer.from("request")); await process.closeInput();
    const stdout = process.stdout[Symbol.asyncIterator]();
    emit("STDOUT", {payload: Buffer.from("reply")});
    assert.equal(Buffer.from((await stdout.next()).value!).toString(), "reply");
    emit("EXIT", {phase: 5, flags: 19, code: 0});
    assert.deepEqual(await process.waitForExit(), {code: 0, signal: null});
    emit("STREAMS", {phase: 5, flags: 23, code: 0});
    assert.equal((await stdout.next()).done, true);
    assert.equal(observed.filter(command => command === "BIND_FINAL_LAUNCH").length, 1);
    assert.equal(observed.filter(command => command === "START_ONCE").length, 1);
    assert.deepEqual(observed, ["READ_OBSERVATION", "BIND_FINAL_LAUNCH", "START_ONCE", "WRITE_INPUT", "CLOSE_INPUT"]);
  } finally {bridge.lost();}
});

test("cutoff before final binding proves no native start command is emitted", async () => {
  const {bridge, observed} = processBridge();
  try {
    await readyBridge(bridge); await bridge.readLaunchObservation(); await bridge.cutoff();
    await assert.rejects(bridge.captureFinalLaunch(finalLaunchInput()), /unavailable|closed/u);
    await assert.rejects(bridge.startProcess(), /consumed|cut off|lost|binding unavailable/u);
    assert.equal(observed.filter(command => command === "BIND_FINAL_LAUNCH").length, 1);
    assert.equal(observed.includes("START_ONCE"), false);
  } finally {bridge.lost();}
});

test("cutoff after START_ONCE preserves the authenticated provider IMAGE", async () => {
  const {bridge, observed, emit} = processBridge();
  try {
    await readyBridge(bridge); await bridge.readLaunchObservation();
    const starting = bridge.startProcess();
    await new Promise(resolve => {setImmediate(resolve);});
    await bridge.cutoff();
    emit("PREEXEC", {flags: 1, image: 0}); emit("IMAGE");
    const process = await starting;
    assert.equal(process.workspaceAuthorityPath, "/root/workspace");
    assert.equal(bridge.image()?.kind, "IMAGE");
    assert.deepEqual(observed, ["READ_OBSERVATION", "START_ONCE", "CUTOFF"]);
  } finally {bridge.lost();}
});

test("native process waits for actual image, streams actual bytes and distinguishes exit from drain", async () => {
  const {bridge, observed, emit} = processBridge();
  try {
    await readyBridge(bridge); await bridge.readLaunchObservation();
    const starting = bridge.startProcess(); let started = false;
    void starting.then(() => {started = true; return;});
    await new Promise(resolve => {setImmediate(resolve);});
    assert.equal(started, false);
    emit("PREEXEC", {flags: 1, image: 0}); emit("IMAGE");
    const process = await starting;
    assert.ok(Object.isFrozen(process));
    assert.equal(process.custodyRef, binding.toString("hex"));
    assert.equal(process.workspaceAuthorityPath, "/root/workspace");
    await process.write(Buffer.from("request")); await process.closeInput();
    assert.deepEqual(observed, ["READ_OBSERVATION", "START_ONCE", "WRITE_INPUT", "CLOSE_INPUT"]);
    const stdout = process.stdout[Symbol.asyncIterator](), stderr = process.stderr[Symbol.asyncIterator]();
    emit("STDOUT", {payload: Buffer.from("reply")}); emit("STDERR", {payload: Buffer.from("diagnostic")});
    assert.equal(Buffer.from((await stdout.next()).value!).toString(), "reply");
    assert.equal(Buffer.from((await stderr.next()).value!).toString(), "diagnostic");
    emit("EXIT", {phase: 5, flags: 19, signal: 10});
    assert.deepEqual(await process.waitForExit(), {code: null, signal: "SIGBUS"});
    let drained = false;
    const ending = stdout.next().then(value => {drained = true; return value;});
    await new Promise(resolve => {setImmediate(resolve);}); assert.equal(drained, false);
    emit("STREAMS", {phase: 5, flags: 23, signal: 10});
    assert.equal((await ending).done, true); assert.equal((await stderr.next()).done, true);
    await assert.rejects(process.stdout[Symbol.asyncIterator]().next(), /already consumed/u);
  } finally {bridge.lost();}
});

test("native process channel loss rejects unobserved exit and stream completion", async () => {
  const {bridge, emit} = processBridge();
  try {
    await readyBridge(bridge); await bridge.readLaunchObservation();
    const starting = bridge.startProcess(); await new Promise(resolve => {setImmediate(resolve);});
    emit("PREEXEC", {flags: 1, image: 0}); emit("IMAGE");
    const process = await starting;
    const next = process.stdout[Symbol.asyncIterator]().next(), waitingExit = process.waitForExit();
    bridge.lost();
    await assert.rejects(next, /relinquished/u); await assert.rejects(waitingExit, /relinquished/u);
  } finally {bridge.lost();}
});

test("native start never publishes a process for an exit before provider image", async () => {
  const {bridge, emit} = processBridge();
  try {
    await readyBridge(bridge); await bridge.readLaunchObservation();
    const starting = bridge.startProcess(); await new Promise(resolve => {setImmediate(resolve);});
    emit("EXIT", {phase: 5, flags: 2, image: 0, code: 78});
    await assert.rejects(starting, /before provider image/u);
  } finally {bridge.lost();}
});

test("native process enforces the shared output budget without converting overflow to EOF", async () => {
  const {bridge, emit} = processBridge();
  try {
    await readyBridge(bridge); await bridge.readLaunchObservation();
    const starting = bridge.startProcess(); await new Promise(resolve => {setImmediate(resolve);});
    emit("PREEXEC", {flags: 1, image: 0}); emit("IMAGE");
    const process = await starting;
    const rejected = assert.rejects(process.waitForExit(), /output budget exceeded/u);
    for (let index = 0; index < 513; index++) {
      emit(index % 2 ? "STDERR" : "STDOUT", {payload: Buffer.alloc(16384, index % 256)});
      await new Promise(resolve => {setImmediate(resolve);});
    }
    await rejected;
    await assert.rejects(process.stdout[Symbol.asyncIterator]().next(), /output budget exceeded/u);
  } finally {bridge.lost();}
});
