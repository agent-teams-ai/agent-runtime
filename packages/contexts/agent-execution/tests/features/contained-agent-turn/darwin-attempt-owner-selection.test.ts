import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { Duplex } from "node:stream";
import { test } from "node:test";
import type { NativePreparedAttemptBinding } from "../../../src/features/contained-agent-turn/adapters/outbound/filesystem/darwin-attempt-workspace-backend.ts";

const native = new URL("../../../src/features/contained-agent-turn/adapters/outbound/host-custody/native/", import.meta.url);
const header = readFileSync(new URL("darwin-attempt-owner-protocol.h", native), "utf8");
const value = (name: string): number => {
  const match = new RegExp(`^#define AE_${name} (\\d+)$`, "mu").exec(header);
  assert.ok(match?.[1]); return Number(match[1]);
};
const prepared = Object.freeze({ operationId: "operation", scope: Object.freeze({ tenantId: "tenant", projectId: "project" }),
  workspaceId: "workspace", attemptId: "actual-attempt", custodyId: "custody", executionGenerationId: "generation",
  writerFence: "fence", preparationToken: "preparation" }) as unknown as NativePreparedAttemptBinding;

// Dependency substitution in this synthetic test only: exact backend/bridge
// source is loaded unchanged. No native process, socket or OS qualification is
// simulated as genuine authority. Tests establish private receiver ordering,
// same-object selection, payload retention and uncertainty behavior only.
async function exercise(mode: "normal" | "refused" | "foreign" | "material" | "material_corrupt") {
  const manifest = Buffer.alloc(value("MANIFEST_BYTES"));
  manifest.writeUInt32BE(1001, 16); manifest.writeUInt32BE(1002, 20);
  createHash("sha256").update(prepared.operationId).digest().copy(manifest, 48);
  createHash("sha256").update(prepared.scope.tenantId).update(Buffer.alloc(1)).update(prepared.scope.projectId).digest().copy(manifest, 80);
  const namespace = Buffer.from(`attempt-${"a".repeat(32)}`);
  const launch = createHash("sha256").update(manifest).digest();
  const binding = createHash("sha256").update(createHash("sha256").update(manifest.subarray(48, 304)).digest()).update(namespace).update(Buffer.alloc(1)).digest();
  let serial = 0;
  const response = (kind: string, sequence = 0, command = 0, payload: Buffer = Buffer.alloc(0)): Buffer => {
    const frame = Buffer.alloc(value("EVENT_BYTES"));
    frame.writeUInt32BE(value("EVENT_MAGIC"), 0); frame.writeUInt32BE(value("VERSION"), 4);
    frame.writeUInt32BE(value(`EVENT_${kind}`), 8); frame.writeUInt32BE(sequence, 12);
    binding.copy(frame, 16); launch.copy(frame, 48);
    frame.writeUInt32BE(2, value("EVENT_PHASE_OFFSET"));
    frame.writeUInt32BE(0xffff_ffff, value("EVENT_EXIT_CODE_OFFSET"));
    frame.writeUInt32BE(payload.length, value("EVENT_LENGTH_OFFSET"));
    const offset = value("EVENT_OWNER_OFFSET");
    frame.writeUInt32BE(40, offset); frame.writeUInt32BE(process.pid, offset + 4); frame.writeUInt32BE(40, offset + 8);
    frame.writeBigUInt64BE(100n, offset + 16); frame.writeBigUInt64BE(1n, offset + 32); frame.writeBigUInt64BE(40n, offset + 40);
    frame.writeBigUInt64BE(1n, value("EVENT_WORKSPACE_DEVICE_OFFSET")); frame.writeBigUInt64BE(200n, value("EVENT_WORKSPACE_INODE_OFFSET"));
    frame.writeUInt32BE(++serial, value("EVENT_SERIAL_OFFSET")); frame.writeUInt32BE(serial, value("EVENT_REVISION_OFFSET"));
    frame.writeUInt32BE(command, value("EVENT_COMMAND_OFFSET"));
    frame.writeUInt32BE(kind === "REFUSED" ? 0 : 1, value("EVENT_RESULT_OFFSET"));
    return Buffer.concat([frame, payload]);
  };
  const config = Buffer.from("model = \"gpt-5\"\n");
  const catalog = readFileSync(new URL("../../fixtures/codex-native-broker-0.153.4/models.json", import.meta.url));
  const installationId = "01234567-89ab-4cde-8012-3456789abcde";
  const observationPayload = (material: boolean): Buffer => {
    const bytes = Buffer.alloc(material ? 8520 : 5244);
    const text = (offset: number, input: string): void => {bytes.writeUInt32BE(Buffer.byteLength(input), offset); bytes.write(input, offset + 4);};
    text(0, "operation"); bytes.writeUInt32BE(70001, 1028); bytes.writeUInt32BE(serial + 1, 1032);
    const fact = (offset: number, path: string, ino: bigint, permissions: number): void => {
      text(offset, path); bytes.writeBigUInt64BE(1n, offset + 1028); bytes.writeBigUInt64BE(ino, offset + 1036);
      bytes.writeUInt32BE(70001, offset + 1044); bytes.writeUInt32BE(permissions, offset + 1048);
    };
    ["/root/private", "/root/private/codex-home", "/root/private/tmp", "/root/workspace"].forEach((path, index) =>
      fact(1036 + index * 1052, path, index === 3 ? 200n : BigInt(index + 2), 0o700));
    if (material) {
      [config, catalog, Buffer.from(installationId)].forEach((content, index) => {
        const offset = 5244 + index * 1092;
        fact(offset, "/root/private/codex-home/" + ["config.toml", "models.json", "installation_id"][index], BigInt(index + 300), index === 2 ? 0o644 : 0o600);
        bytes.writeUInt32BE(1, offset + 1052); bytes.writeUInt32BE(content.length, offset + 1056);
        createHash("sha256").update(content).digest().copy(bytes, offset + 1060);
      });
    }
    if (material && mode === "material_corrupt") {bytes[6304] = bytes[6304]! ^ 1;}
    return bytes;
  };
  const requests: { kind: number; bytes: Buffer }[] = [];
  let endpoint: Duplex | undefined;
  const retainEndpoint = (socket: Duplex): void => {endpoint = socket;};
  class SyntheticSocket extends Duplex {
    constructor() {super(); retainEndpoint(this); queueMicrotask(() => this.push(response("HELLO", 0, 0, Buffer.concat([namespace, manifest]))));}
    override _read(): void {}
    override _write(frame: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
      const kind = frame.readUInt32BE(8), sequence = frame.readUInt32BE(12);
      const bytes = Buffer.from(frame.subarray(value("FRAME_BYTES")));
      assert.equal(bytes.length, frame.readUInt32BE(value("ARGUMENT_OFFSET")));
      requests.push({ kind, bytes });
      if (kind === value("READ_OBSERVATION") || kind === value("MATERIAL_FINISH")) {
        const material = kind === value("MATERIAL_FINISH");
        this.push(response(material ? "MATERIAL_RESULT" : "OBSERVATION", sequence, kind, observationPayload(material)));
        callback(); return;
      }
      this.push(response(mode === "refused" ? "REFUSED" : "STATUS", sequence, kind)); callback();
    }
  }
  const key = Symbol.for("darwin-selection-test-dependencies");
  const globals = globalThis as unknown as Record<symbol, unknown>;
  globals[key] = { Socket: SyntheticSocket, readFileSync, fstatSync: (fd: number) => {assert.equal(fd, 8); return { isSocket: () => true };} };
  const hooks = registerHooks({
    resolve(specifier, context, next) {
      if (specifier === "node:net" || specifier === "node:fs") {return { url: `test-dependency:${mode}:${specifier}`, shortCircuit: true };}
      return next(specifier, context);
    },
    load(url, context, next) {
      if (!url.startsWith("test-dependency:")) {return next(url, context);}
      const names = url.endsWith("node:net") ? ["Socket"] : ["readFileSync", "fstatSync"];
      return { format: "module", shortCircuit: true,
        source: names.map(name => `export const ${name}=globalThis[Symbol.for("darwin-selection-test-dependencies")].${name};`).join("\n") };
    },
  });
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  const oldArgv = process.argv, uid = process.getuid, gid = process.getgid;
  try {
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    process.argv = ["synthetic-host", "--darwin-attempt-owner-bridge"];
    process.getuid = () => 1001; process.getgid = () => 1002;
    const backend = await import(new URL(`../../../src/features/contained-agent-turn/adapters/outbound/filesystem/darwin-attempt-workspace-backend.ts?${mode}`, import.meta.url).href) as typeof import("../../../src/features/contained-agent-turn/adapters/outbound/filesystem/darwin-attempt-workspace-backend.ts");
    const complete = async () => ({ binding: binding.toString("hex"), launch: launch.toString("hex"), namespace: namespace.toString(), workspaceDev: "1", workspaceIno: "200" });
    const consumers = { launchRoute: complete, artifactResult: complete, workspace: complete, privateMaterial: complete, output: async () => {} };
    const { selection, attemptAuthority } = await backend.captureRootDarwinAttemptWorkspace(consumers);
    assert.deepEqual(Reflect.ownKeys(selection), []);
    await assert.rejects(backend.captureRootDarwinAttemptWorkspace(consumers), /already consumed/u);
    if (mode === "refused") {
      await assert.rejects(attemptAuthority.bindPreparedAttempt(prepared), /refused/u);
      await assert.rejects(attemptAuthority.bindPreparedAttempt(prepared), /already consumed/u);
      assert.equal(requests.length, 1); return;
    }
    const bindingOnce = attemptAuthority.bindPreparedAttempt(prepared);
    await assert.rejects(attemptAuthority.bindPreparedAttempt(prepared), /already consumed/u);
    await bindingOnce;
    const proof = Object.freeze({ purpose: "contained_turn_committed_dispatch_v1", version: 1, operationId: prepared.operationId,
      attemptId: prepared.attemptId, custodyId: prepared.custodyId, executionGenerationId: prepared.executionGenerationId,
      workspaceId: prepared.workspaceId, preparationToken: prepared.preparationToken, tenantId: prepared.scope.tenantId,
      projectId: prepared.scope.projectId, proofDigest: "a".repeat(64) }) as unknown as Parameters<typeof attemptAuthority.confirmCommittedClaim>[0];
    if (mode === "foreign") {
      await assert.rejects(attemptAuthority.confirmCommittedClaim(Object.freeze({ ...proof, projectId: "foreign" })), /does not bind/u);
      await assert.rejects(attemptAuthority.confirmCommittedClaim(proof), /already consumed/u);
      assert.equal(requests.length, 1); return;
    }
    await attemptAuthority.confirmCommittedClaim(proof);
    await assert.rejects(attemptAuthority.confirmCommittedClaim(proof), /already consumed/u);
    assert.deepEqual(requests.map(request => request.kind), [value("BIND_PREPARED"), value("CONFIRM_CLAIM")]);
    assert.equal(requests[0]!.bytes.length, value("PREPARED_BYTES"));
    assert.ok(requests[1]!.bytes.subarray(0, value("PREPARED_BYTES")).equals(requests[0]!.bytes));
    assert.deepEqual(JSON.parse(requests[1]!.bytes.subarray(value("PREPARED_BYTES")).toString()), proof);
    if (mode === "material_corrupt") {
      await assert.rejects(backend.installDarwinNativeCodexMaterial(selection, {config, catalog, installationId}), /readback differs/u);
      const count = requests.length;
      await assert.rejects(backend.installDarwinNativeCodexMaterial(selection, {config, catalog, installationId}), /already consumed/u);
      assert.equal(requests.length, count); return;
    }
    if (mode === "material") {
      const old = await backend.readDarwinNativeLaunchObservation(selection);
      assert.equal(backend.inspectDarwinNativeLaunchObservation(old).workspace.ino, 200n);
      assert.throws(() => backend.inspectDarwinNativeLaunchObservation({...old}), /foreign/u);
      const source = Buffer.from(config);
      const installed = backend.installDarwinNativeCodexMaterial(selection, {config: source, catalog, installationId});
      source.fill(0);
      assert.throws(() => backend.assertDarwinNativeLaunchObservationCurrent(old), /no longer current/u);
      const material = await installed;
      const facts = backend.inspectDarwinNativeCodexMaterial(material);
      assert.equal(facts.config.sha256, createHash("sha256").update(config).digest("hex"));
      const configChunks = requests.filter(request => request.kind === value("MATERIAL_CHUNK") && request.bytes.readUInt32BE(0) === 0);
      assert.deepEqual(Buffer.concat(configChunks.map(request => request.bytes.subarray(8))), config);
      assert.throws(() => backend.inspectDarwinNativeCodexMaterial({...material}), /foreign/u);
      let inputReads = 0;
      const input = {get config() {inputReads++; throw new Error("foreign selection input read");}} as unknown as Parameters<typeof backend.installDarwinNativeCodexMaterial>[1];
      await assert.rejects(backend.installDarwinNativeCodexMaterial({...selection}, input), /foreign/u);
      assert.equal(inputReads, 0);
      await backend.readDarwinNativeLaunchObservation(selection);
      assert.throws(() => backend.assertDarwinNativeCodexMaterialCurrent(material), /no longer current/u);
      const count = requests.length;
      await assert.rejects(backend.installDarwinNativeCodexMaterial(selection, {config, catalog, installationId}), /already consumed/u);
      assert.equal(requests.length, count);
    }
    let reads = 0;
    const retained = { get creation() {reads++; throw new Error("selection clone read callbacks");} } as unknown as Parameters<typeof backend.selectDarwinAttemptWorkspaceBackend>[1];
    assert.throws(() => backend.selectDarwinAttemptWorkspaceBackend({ ...selection }, retained), /foreign/u);
    assert.equal(reads, 0);
  } finally {
    endpoint?.destroy(); hooks.deregister(); delete globals[key];
    Object.defineProperty(process, "platform", platform); process.argv = oldArgv;
    if (uid) {process.getuid = uid;} else {delete process.getuid;}
    if (gid) {process.getgid = gid;} else {delete process.getgid;}
  }
}
test("root-captured private receiver binds actual tuple once and sends full committed proof data", async () => exercise("normal"));
test("a refused binding remains burned and cannot repeat preparation on the channel", async () => exercise("refused"));

test("a foreign committed tuple poisons the receiver without transmitting a claim", async () => exercise("foreign"));

test("issued material snapshots bytes and rejects capability clones, stale generations and repeated installation", async () => exercise("material"));

test("material readback mismatch poisons installation and forbids replay", async () => exercise("material_corrupt"));
