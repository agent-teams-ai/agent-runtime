import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  decodeDarwinNativeLaunchData, type DarwinAttemptOwnerEvent, encodeDarwinNativeFinalLaunchData,
  darwinNativeArgumentsSha256, type DarwinNativeFinalLaunchData,
  decodeDarwinAttemptOwnerRequest, encodeDarwinAttemptOwnerRequest,
  DarwinAttemptOwnerFrameReader, darwinAttemptOwnerFrameBytes,
} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/darwin-attempt-owner-protocol.js";

const native = fileURLToPath(new URL("../../../src/features/contained-agent-turn/adapters/outbound/host-custody/native/", import.meta.url));
const start = { command: "START_ONCE", sequence: 1, binding: "01".repeat(32), launch: "02".repeat(32), argument: 0 } as const;
const commands = ["START_ONCE", "CUTOFF", "READ_STATUS", "SETTLE_LAUNCH_ROUTE",
  "SETTLE_ARTIFACT_RESULT", "WORKSPACE_FREEZE", "WORKSPACE_CLEANUP", "WORKSPACE_CLOSE",
  "SETTLE_WORKSPACE", "SETTLE_PRIVATE", "DISPOSE_ONCE", "READ_CLOSED_WORKSPACE",
  "MATERIALIZE_BEGIN", "MATERIALIZE_ENTRY", "MATERIALIZE_CHUNK", "MATERIALIZE_FINISH", "COMMIT_CREATION", "READ_TREE", "BIND_PREPARED", "CONFIRM_CLAIM", "READ_OBSERVATION", "MATERIAL_BEGIN", "MATERIAL_CHUNK", "MATERIAL_FINISH", "BIND_FINAL_LAUNCH", "WRITE_INPUT", "CLOSE_INPUT", "QUERY_CLOSED_WORKSPACE"] as const;
const argumentFor = (command: typeof commands[number]): number => ({ MATERIALIZE_BEGIN: 16, MATERIALIZE_ENTRY: 25, MATERIALIZE_CHUNK: 9, COMMIT_CREATION: 3116, BIND_PREPARED: 9252, CONFIRM_CLAIM: 9253, MATERIAL_BEGIN: 44, MATERIAL_CHUNK: 9, BIND_FINAL_LAUNCH: 5436, WRITE_INPUT: 1 } as Partial<Record<typeof commands[number], number>>)[command] ?? 0;

test("all finite commands roundtrip exact owned source", () => {
  for (const command of commands) {
    const input = { ...start, command, argument: argumentFor(command) };
    assert.deepEqual(decodeDarwinAttemptOwnerRequest(encodeDarwinAttemptOwnerRequest(input)), input);
  }
});

test("shape validation rejects paths, PIDs, duplicate-equivalent extra fields and accessors", () => {
  for (const extra of [{ pid: 1 }, { path: "/tmp" }, { trusted: true }, { uid: 501 }]) {
    assert.throws(() => encodeDarwinAttemptOwnerRequest({ ...start, ...extra }));
  }
  let reads = 0;
  const accessor = { ...start, get sequence() { reads++; return 1; } };
  assert.throws(() => encodeDarwinAttemptOwnerRequest(accessor));
  assert.equal(reads, 0);
  for (const sequence of [0, -1, 0x1_0000_0000, NaN, 1.5]) {
    assert.throws(() => encodeDarwinAttemptOwnerRequest({ ...start, sequence }));
  }
  for (const binding of ["", "0".repeat(63), "A".repeat(64), "g".repeat(64)]) {
    assert.throws(() => encodeDarwinAttemptOwnerRequest({ ...start, binding }));
  }
  assert.throws(() => encodeDarwinAttemptOwnerRequest({ ...start, argument: 1 }));
  const retired = encodeDarwinAttemptOwnerRequest(start);
  retired.writeUInt32BE(11, 8);
  assert.throws(() => decodeDarwinAttemptOwnerRequest(retired));
  assert.throws(() => encodeDarwinAttemptOwnerRequest({ ...start, command: "MATERIALIZE_ENTRY", argument: 24 }));
  assert.throws(() => encodeDarwinAttemptOwnerRequest({ ...start, command: "MATERIALIZE_CHUNK", argument: 16393 }));
});

test("all truncations, reserved data, concatenated frames and channel loss reject", () => {
  const frame = encodeDarwinAttemptOwnerRequest(start);
  for (let length = 0; length < frame.length; length++) {
    assert.throws(() => decodeDarwinAttemptOwnerRequest(frame.subarray(0, length)));
    const reader = new DarwinAttemptOwnerFrameReader();
    if (length) {assert.equal(reader.push(frame.subarray(0, length)), undefined);}
    assert.throws(() => reader.end());
    assert.throws(() => reader.push(frame));
  }
  const tooMuch = new DarwinAttemptOwnerFrameReader();
  assert.throws(() => tooMuch.push(Buffer.concat([frame, frame])));
  assert.throws(() => tooMuch.push(frame));
  const reader = new DarwinAttemptOwnerFrameReader();
  assert.equal(reader.push(frame.subarray(0, 1)), undefined);
  assert.deepEqual(reader.push(frame.subarray(1)), start);
  reader.end();
  assert.throws(() => reader.push(frame));
  assert.equal(frame.length, darwinAttemptOwnerFrameBytes);
  const invalid = Buffer.from(frame); invalid[invalid.length - 1] = 1;
  assert.throws(() => decodeDarwinAttemptOwnerRequest(invalid));
});

test("portable C pure state/protocol harness uses the exact TS wire vectors", () => {
  const temporary = mkdtempSync(join(tmpdir(), "darwin-owner-protocol-"));
  try {
    const vectors = commands.map((command) => [...encodeDarwinAttemptOwnerRequest({ ...start, command, argument: argumentFor(command) })]);
    writeFileSync(join(temporary, "vectors.h"), `static const unsigned char vectors[][AE_FRAME_BYTES]={${vectors.map((v) => `{${v.join(",")}}`).join(",")}};\n`);
    const executable = join(temporary, "protocol-harness");
    const args = ["-std=c11", "-Wall", "-Wextra", "-Werror", "-pedantic", "-I", native, "-I", temporary,
      join(native, "darwin-attempt-owner-state.c"), join(native, "darwin-attempt-owner-admission.c"), join(native, "darwin-attempt-owner-tree.c"), join(native, "darwin-attempt-owner-material.c"), join(native, "darwin-attempt-owner-probes.c"),
      fileURLToPath(new URL("./darwin-attempt-owner-protocol-harness.c", import.meta.url)), "-o", executable];
    const compile = spawnSync("cc", args, { encoding: "utf8" });
    console.log(JSON.stringify({ command: ["cc", ...args], stdout: compile.stdout, stderr: compile.stderr, exit: compile.status }));
    assert.ifError(compile.error);
    assert.equal(compile.status, 0, compile.stderr);
    const run = spawnSync(executable, [], { encoding: "utf8" });
    console.log(JSON.stringify({ command: [executable], stdout: run.stdout, stderr: run.stderr, exit: run.status }));
    assert.ifError(run.error);
    assert.equal(run.status, 0, run.stderr);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});

test("launch observation data rejects foreign identity, generation, aliases and noncanonical paths", () => {
  const payload = Buffer.alloc(5244);
  const text = (offset: number, value: string): void => {
    payload.fill(0, offset, offset + 1028);
    payload.writeUInt32BE(Buffer.byteLength(value), offset); payload.write(value, offset + 4);
  };
  text(0, "operation"); payload.writeUInt32BE(70001, 1028); payload.writeUInt32BE(7, 1032);
  const paths = ["/root/private", "/root/private/codex-home", "/root/private/tmp", "/root/workspace"];
  for (const [index, path] of paths.entries()) {
    const offset = 1036 + index * 1052;
    text(offset, path); payload.writeBigUInt64BE(1n, offset + 1028);
    payload.writeBigUInt64BE(BigInt(index + 2), offset + 1036);
    payload.writeUInt32BE(70001, offset + 1044); payload.writeUInt32BE(0o700, offset + 1048);
  }
  // Pure decoder fixture; this does not issue an observation capability.
  const event = {kind: "OBSERVATION", revision: 7, workspaceDev: "1", workspaceIno: "5", payload} as DarwinAttemptOwnerEvent;
  const observed = decodeDarwinNativeLaunchData(event);
  assert.equal(observed.codexHome.path, paths[1]); assert.equal(observed.workspace.ino, 5n);
  assert.ok(Object.isFrozen(observed)); assert.ok(Object.isFrozen(observed.workspace));
  assert.throws(() => decodeDarwinNativeLaunchData({...event, revision: 8}));
  assert.throws(() => decodeDarwinNativeLaunchData({...event, workspaceIno: "6"}));
  text(2088, "/root/private/../codex-home");
  assert.throws(() => decodeDarwinNativeLaunchData(event));
  text(2088, paths[1]!); payload.writeBigUInt64BE(2n, 2088 + 1036);
  assert.throws(() => decodeDarwinNativeLaunchData(event));
});

test("fixed native peer addon rejects caller-shaped packets on unsupported hosts", {skip: process.platform !== "linux"}, () => {
  const temporary = mkdtempSync(join(tmpdir(), "darwin-peer-reject-"));
  try {
    const output = join(temporary, "peer.node");
    const argv = ["-std=c11", "-Wall", "-Wextra", "-Werror", "-fPIC", "-shared", "-DAE_HOST_PEER_ADDON",
      "-I", "/usr/include/node", join(native, "darwin-attempt-owner-main.c"), "-o", output];
    const started = performance.now();
    const compiled = spawnSync("cc", argv, {encoding: "utf8"});
    console.log(JSON.stringify({argv: ["cc", ...argv], exit: compiled.status, elapsedMs: performance.now() - started,
      stdout: compiled.stdout, stderr: compiled.stderr}));
    assert.equal(compiled.status, 0, compiled.stderr);
    const script = `const assert=require('node:assert/strict'); const loaded={exports:{}}; process.dlopen(loaded, process.argv[1]); const peer=loaded.exports;
      for(const packet of [undefined, {}, Buffer.alloc(8272), Buffer.alloc(8272, 255)]) {
        assert.throws(()=>peer.verifyRootPeer(packet), /native root peer verification refused/);
      }`;
    const checkedAt = performance.now();
    const checked = spawnSync(process.execPath, ["-e", script, output], {encoding: "utf8"});
    console.log(JSON.stringify({argv: [process.execPath, "-e", script, output], exit: checked.status,
      elapsedMs: performance.now() - checkedAt, stdout: checked.stdout, stderr: checked.stderr}));
    assert.equal(checked.status, 0, checked.stderr);
  } finally {rmSync(temporary, {recursive: true, force: true});}
});


test("finite final capture rejects environment extensions, accessors and malformed local authority data", () => {
  const hash = "a".repeat(64);
  const input: DarwinNativeFinalLaunchData = {home: "/private/a", codexHome: "/private/a/codex-home", tmpDir: "/private/a/tmp",
    localCapability: hash, port: 12345, preparedSha256: hash, profileSha256: hash,
    configSha256: hash, catalogSha256: hash, installationSha256: hash, fingerprintSha256: hash,
    materialSha256: hash, executableSha256: hash, argumentsSha256: hash};
  for (const changed of [{port: 0}, {port: 65536}, {port: 1.5}, {localCapability: "SECRET"},
    {home: "/private/../outside"}, {codexHome: "/private/a\0outside"}, {tmpDir: "/"},
    {profileSha256: "0"}, {environment: {DYLD_INSERT_LIBRARIES: "/foreign"}}]) {
    assert.throws(() => encodeDarwinNativeFinalLaunchData({...input, ...changed}));
  }
  let reads = 0;
  assert.throws(() => encodeDarwinNativeFinalLaunchData({...input, get home() {reads++; return "/private/a";}}));
  assert.equal(reads, 0);
  assert.notEqual(darwinNativeArgumentsSha256("/provider", ["ab", "c"]), darwinNativeArgumentsSha256("/provider", ["a", "bc"]));
  assert.throws(() => darwinNativeArgumentsSha256("/provider", Array<string>(8).fill("a")));
});


test("native input pump preserves partial writes, explicit EOF and timeout uncertainty", () => {
  const temporary = mkdtempSync(join(tmpdir(), "darwin-input-"));
  try {
    const child = readFileSync(join(native, "darwin-attempt-owner-child.c"), "utf8");
    const zero = child.slice(child.indexOf("static void secure_zero("), child.indexOf("static uint64_t now_ms("));
    const functions = child.slice(child.indexOf("static void feed_input("), child.indexOf("static void drain("));
    assert.ok(zero.includes("volatile uint8_t *bytes=buffer"));
    assert.ok(functions.includes("static int capture_input("));
    const source = join(temporary, "input.c"), executable = join(temporary, "input");
    writeFileSync(source, `
#define _POSIX_C_SOURCE 200809L
#include "darwin-attempt-owner-state.h"
#include <assert.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <fcntl.h>
#include <errno.h>
${zero}
typedef struct { ae_state state; } custody;
typedef struct { custody custody; size_t input_length; uint8_t *input_bytes; } ae_bootstrap;
typedef struct {
  ae_bootstrap *boot; int input,reaped,stream_unknown;
  size_t input_used,write_used,write_length;
  uint64_t write_deadline; uint32_t input_command;
  uint8_t write_bytes[AE_STREAM_CHUNK_BYTES];
} owner;
static uint64_t clock_value=1;
static unsigned acknowledgements=0;
static uint64_t now_ms(void) { return clock_value; }
static int close_one(int *fd) { int value=*fd; *fd=-1; return value<0 || close(value)==0; }
static void quarantine(owner *o) { o->boot->custody.state.phase=AE_QUARANTINED; o->boot->custody.state.cutoff=1; }
static int ae_native_persist(void *unused,const ae_state *s) { (void)unused; (void)s; return 1; }
static int event(owner *o,uint32_t kind,uint32_t command,ae_result result,const void *artifact,uint32_t slot,const uint8_t *bytes,size_t length) {
  (void)o; (void)artifact; (void)slot; (void)bytes;
  assert(kind==AE_EVENT_STATUS && result==AE_ACCEPTED && length==0);
  assert(command==AE_WRITE_INPUT || command==AE_CLOSE_INPUT); acknowledgements++; return 1;
}
${functions}
int main(void) {
  int pair[2]; assert(pipe(pair)==0);
  assert(fcntl(pair[0],F_SETFL,O_NONBLOCK)==0 && fcntl(pair[1],F_SETFL,O_NONBLOCK)==0);
  ae_bootstrap b={0}; b.input_bytes=malloc(3); assert(b.input_bytes); memcpy(b.input_bytes,"abc",3); b.input_length=3;
  owner o={0}; o.boot=&b; o.input=pair[1];
  b.custody.state.phase=AE_CHILD_OWNED; b.custody.state.pending_effect=AE_WRITE_INPUT;
  uint8_t data[AE_STREAM_CHUNK_BYTES]; memset(data,42,sizeof(data));
  assert(capture_input(&o,AE_WRITE_INPUT,data,sizeof(data)));
  memset(data,0,sizeof(data));
  feed_input(&o); assert(acknowledgements==0 && o.input>=0);
  uint8_t received[AE_STREAM_CHUNK_BYTES+3]; size_t used=0;
  for (unsigned i=0;i<1000 && (o.input_command || used<sizeof(received));i++) {
    feed_input(&o);
    ssize_t n=read(pair[0],received+used,sizeof(received)-used);
    if (n>0) used+=(size_t)n;
  }
  assert(used==sizeof(received) && acknowledgements==1 && !o.stream_unknown);
  assert(!memcmp(received,"abc",3));
  for (size_t i=3;i<used;i++) assert(received[i]==42);
  assert(o.input>=0 && !b.input_bytes);
  b.custody.state.pending_effect=AE_CLOSE_INPUT;
  assert(capture_input(&o,AE_CLOSE_INPUT,NULL,0)); feed_input(&o);
  assert(o.input==-1 && acknowledgements==2 && read(pair[0],received,1)==0);
  assert(close(pair[0])==0);
  assert(pipe(pair)==0); o.input=pair[1];
  b.custody.state.pending_effect=AE_WRITE_INPUT;
  assert(capture_input(&o,AE_WRITE_INPUT,data,1));
  clock_value=o.write_deadline; feed_input(&o);
  assert(o.stream_unknown && b.custody.state.phase==AE_QUARANTINED && acknowledgements==2);
  feed_input(&o); assert(o.input==-1); assert(close(pair[0])==0);
  return 0;
}
`);
    const argv = ["-std=c11", "-Wall", "-Wextra", "-Werror", "-pedantic", "-I", native,
      join(native, "darwin-attempt-owner-state.c"), source, "-o", executable];
    const compile = spawnSync("cc", argv, { encoding: "utf8" });
    console.log(JSON.stringify({ argv: ["cc", ...argv], exit: compile.status, stderr: compile.stderr }));
    assert.equal(compile.status, 0, compile.stderr);
    const run = spawnSync(executable, [], { encoding: "utf8", timeout: 5000 });
    console.log(JSON.stringify({ argv: [executable], exit: run.status, stderr: run.stderr }));
    assert.equal(run.status, 0, run.stderr);
  } finally {rmSync(temporary, { recursive: true, force: true });}
});

test("Darwin ACL predicates reject ACEs and API uncertainty while accepting validated empty ACLs", () => {
  const temporary = mkdtempSync(join(tmpdir(), "darwin-acl-predicate-"));
  try {
    const cases = [["admission", "empty_acl"], ["namespace", "acl_empty"],
      ["tree", "supported_metadata"], ["material", "metadata"]] as const;
    for (const [file, name] of cases) {
      const source = readFileSync(join(native, `darwin-attempt-owner-${file}.c`), "utf8");
      const metadata = file === "tree" || file === "material";
      const begin = source.indexOf(`static int ${metadata ? "supported_xattrs" : name}(`);
      const predicateBegin = source.indexOf(`static int ${name}(`, begin);
      const end = source.indexOf("\n}", predicateBegin);
      assert.ok(begin >= 0 && end > begin);
      let predicate = source.slice(begin, end + 2);
      if (file === "tree") {
        predicate = predicate.split("#else")[0]!
          .replaceAll("#ifdef __APPLE__\n", "")
          .replace("#endif\nstatic int supported_metadata", "static int supported_metadata") + "}";
      }
      const harness = join(temporary, `${file}.c`), executable = join(temporary, file);
      writeFileSync(harness, `
#include <assert.h>
#include <errno.h>
#include <stddef.h>
#include <string.h>
#include <sys/types.h>
typedef void *acl_t;
typedef void *acl_entry_t;
#define ACL_TYPE_EXTENDED 1
#define ACL_FIRST_ENTRY 0
static int mode=0,freed=0,queried=0;
static acl_t acl_get_fd_np(int fd,int type) {
  assert(fd==9 && type==ACL_TYPE_EXTENDED);
  if (mode==1) { errno=EBADF; return NULL; } return &mode;
}
static int acl_valid(acl_t acl) { assert(acl==&mode); return mode==2 ? -1 : 0; }
static int acl_get_entry(acl_t acl,int index,acl_entry_t *entry) {
  assert(acl==&mode && index==ACL_FIRST_ENTRY); queried++;
  if (mode==3) { *entry=&mode; return 0; }
  errno=mode==4 ? EIO : EINVAL; return -1;
}
static int acl_free(acl_t acl) { assert(acl==&mode); freed++; errno=ERANGE; return mode==5 ? -1 : 0; }
${metadata ? "struct stat { unsigned st_flags; }; static ssize_t flistxattr(int fd,void *bytes,size_t length,int options) { (void)fd; (void)bytes; (void)length; (void)options; return 0; }" : ""}
${predicate}
int main(void) {
  ${metadata ? "struct stat st={0};" : ""}
  for (mode=0;mode<6;mode++) {
    freed=0; queried=0;
    int result=${name}(9${metadata ? ",&st" : ""});
    assert(result==(mode==0));
    assert(freed==(mode==1 ? 0 : 1));
    assert(queried==(mode==1 || mode==2 ? 0 : 1));
  }
  return 0;
}
`);
      const argv = ["-std=c11", "-Wall", "-Wextra", "-Werror", "-pedantic", harness, "-o", executable];
      const compile = spawnSync("cc", argv, { encoding: "utf8" });
      console.log(JSON.stringify({ argv: ["cc", ...argv], exit: compile.status, stderr: compile.stderr }));
      assert.equal(compile.status, 0, compile.stderr);
      const run = spawnSync(executable, [], { encoding: "utf8" });
      console.log(JSON.stringify({ argv: [executable], exit: run.status, stderr: run.stderr }));
      assert.equal(run.status, 0, run.stderr);
    }
  } finally {rmSync(temporary, { recursive: true, force: true });}
});
